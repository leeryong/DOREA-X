# Ollama API Routes (Model Management)

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from typing import List, Optional
import httpx
import json

from api.deps import get_current_user
from models.database import User, UserRole, get_db, SystemSetting
from sqlalchemy.orm import Session
from config import settings
from services.ollama_runtime import keep_ollama_model_warm, unload_ollama_model

router = APIRouter(prefix="/api/ollama", tags=["Ollama"])


def _require_admin(user: User):
    if user.role not in (UserRole.ADMIN, UserRole.SUPER_ADMIN):
        raise HTTPException(
            status_code=403,
            detail={"error_code": "OLLAMA_FORBIDDEN", "message": "관리자 권한이 필요합니다"},
        )


class OllamaModelInfo(BaseModel):
    name: str
    size: Optional[int] = None
    digest: Optional[str] = None
    modified_at: Optional[str] = None
    vision: bool = False  # whether the model supports image input (from /api/show capabilities)


class OllamaModelsResponse(BaseModel):
    models: List[OllamaModelInfo]


class OllamaPullRequest(BaseModel):
    model: str


class OllamaPullStatus(BaseModel):
    status: str
    digest: Optional[str] = None
    total: Optional[int] = None
    completed: Optional[int] = None


class OllamaRuntimeRequest(BaseModel):
    model: str


class OllamaRuntimeResponse(BaseModel):
    ok: bool
    model: str
    action: str


async def _get_model_vision(client: httpx.AsyncClient, model_name: str) -> bool:
    """개별 모델의 vision 지원 여부를 /api/show로 조회 (실패 시 False)"""
    try:
        resp = await client.post(
            f"{settings.ollama_url}/api/show",
            json={"model": model_name},
        )
        resp.raise_for_status()
        capabilities = resp.json().get("capabilities", [])
        return "vision" in capabilities
    except Exception:
        return False


@router.get("/models", response_model=OllamaModelsResponse)
async def list_ollama_models(
    current_user: User = Depends(get_current_user),
):
    """
    Ollama에 설치된 모델 목록 조회 (vision capability 포함)
    """
    _require_admin(current_user)
    
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.get(f"{settings.ollama_url}/api/tags")
            response.raise_for_status()
            data = response.json()
            
            raw_models = data.get("models", [])
            
            # 각 모델의 vision 지원 여부를 병렬 조회
            import asyncio
            vision_tasks = [
                _get_model_vision(client, m.get("name", ""))
                for m in raw_models
            ]
            vision_results = await asyncio.gather(*vision_tasks)
            
            models = []
            for model, is_vision in zip(raw_models, vision_results):
                models.append(OllamaModelInfo(
                    name=model.get("name", ""),
                    size=model.get("size"),
                    digest=model.get("digest"),
                    modified_at=model.get("modified_at"),
                    vision=is_vision,
                ))
            
            return OllamaModelsResponse(models=models)
            
    except httpx.ConnectError:
        raise HTTPException(
            status_code=503,
            detail={"error_code": "OLLAMA_UNAVAILABLE", "message": "Ollama 서비스에 연결할 수 없습니다"}
        )
    except httpx.HTTPStatusError as e:
        raise HTTPException(
            status_code=502,
            detail={"error_code": "OLLAMA_ERROR", "message": f"Ollama 오류: {e.response.status_code}"}
        )
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail={"error_code": "OLLAMA_ERROR", "message": f"Ollama 통신 오류: {str(e)}"}
        )


@router.post("/pull")
async def pull_ollama_model(
    request: OllamaPullRequest,
    current_user: User = Depends(get_current_user),
):
    """
    Ollama 모델 다운로드 (SSE 스트리밍으로 진행률 반환)
    """
    _require_admin(current_user)
    
    model_name = request.model.strip()
    if not model_name:
        raise HTTPException(
            status_code=400,
            detail={"error_code": "OLLAMA_INVALID_MODEL", "message": "모델 이름을 입력해주세요"}
        )
    
    async def stream_pull():
        try:
            async with httpx.AsyncClient(timeout=None) as client:
                async with client.stream(
                    "POST",
                    f"{settings.ollama_url}/api/pull",
                    json={"name": model_name, "stream": True},
                ) as response:
                    if response.status_code != 200:
                        error_data = {
                            "status": "error",
                            "error": f"Ollama 오류: {response.status_code}"
                        }
                        yield f"data: {json.dumps(error_data)}\n\n"
                        return
                    
                    async for line in response.aiter_lines():
                        if line:
                            try:
                                data = json.loads(line)
                                # Ollama pull response format:
                                # {"status": "pulling manifest"}
                                # {"status": "downloading", "digest": "...", "total": 123, "completed": 45}
                                # {"status": "success"}
                                yield f"data: {json.dumps(data)}\n\n"
                            except json.JSONDecodeError:
                                pass
                                
        except httpx.ConnectError:
            error_data = {"status": "error", "error": "Ollama 서비스에 연결할 수 없습니다"}
            yield f"data: {json.dumps(error_data)}\n\n"
        except Exception as e:
            error_data = {"status": "error", "error": str(e)}
            yield f"data: {json.dumps(error_data)}\n\n"
    
    return StreamingResponse(
        stream_pull(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        }
    )


@router.delete("/models/{model_name:path}")
async def delete_ollama_model(
    model_name: str,
    current_user: User = Depends(get_current_user),
):
    """
    Ollama 모델 삭제
    """
    _require_admin(current_user)
    
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            # Ollama uses DELETE with JSON body
            response = await client.request(
                "DELETE",
                f"{settings.ollama_url}/api/delete",
                json={"name": model_name}
            )
            
            if response.status_code == 404:
                raise HTTPException(
                    status_code=404,
                    detail={"error_code": "OLLAMA_MODEL_NOT_FOUND", "message": "모델을 찾을 수 없습니다"}
                )
            
            response.raise_for_status()
            return {"message": f"모델 '{model_name}'이 삭제되었습니다"}
            
    except httpx.ConnectError:
        raise HTTPException(
            status_code=503,
            detail={"error_code": "OLLAMA_UNAVAILABLE", "message": "Ollama 서비스에 연결할 수 없습니다"}
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail={"error_code": "OLLAMA_ERROR", "message": f"Ollama 통신 오류: {str(e)}"}
        )


@router.get("/status")
async def check_ollama_status(
    current_user: User = Depends(get_current_user),
):
    """
    Ollama 서비스 상태 확인
    """
    _require_admin(current_user)
    
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(f"{settings.ollama_url}/api/tags")
            response.raise_for_status()
            return {"status": "online", "url": settings.ollama_url}
    except:
        return {"status": "offline", "url": settings.ollama_url}


@router.post("/runtime/keep-alive", response_model=OllamaRuntimeResponse)
async def keep_alive_ollama_model(
    payload: OllamaRuntimeRequest,
    current_user: User = Depends(get_current_user),
):
    _require_admin(current_user)

    model = payload.model.strip()
    if not model:
        raise HTTPException(
            status_code=400,
            detail={"error_code": "OLLAMA_INVALID_MODEL", "message": "모델 이름을 입력해주세요"},
        )

    ok = await keep_ollama_model_warm(model, settings.ollama_keepalive_duration)
    if not ok:
        raise HTTPException(
            status_code=503,
            detail={"error_code": "OLLAMA_KEEPALIVE_FAILED", "message": "모델 keep-alive 호출에 실패했습니다"},
        )

    return OllamaRuntimeResponse(ok=True, model=model, action="keep-alive")


@router.post("/runtime/unload", response_model=OllamaRuntimeResponse)
async def unload_ollama_runtime(
    payload: Optional[OllamaRuntimeRequest] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _require_admin(current_user)

    model = ""
    if payload and payload.model:
        model = payload.model.strip()
    if not model:
        row = db.query(SystemSetting).filter(SystemSetting.key == "ai.ollama.model").first()
        model = (row.value if row else "").strip()

    if not model:
        raise HTTPException(
            status_code=400,
            detail={"error_code": "OLLAMA_MODEL_NOT_CONFIGURED", "message": "해제할 Ollama 모델이 없습니다"},
        )

    ok = await unload_ollama_model(model)
    if not ok:
        raise HTTPException(
            status_code=503,
            detail={"error_code": "OLLAMA_UNLOAD_FAILED", "message": "모델 unload 호출에 실패했습니다"},
        )

    return OllamaRuntimeResponse(ok=True, model=model, action="unload")
