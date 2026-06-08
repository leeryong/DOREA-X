# Backend Main Entry Point

import asyncio
from contextlib import asynccontextmanager
from datetime import datetime
import uuid
import time
import traceback
from pathlib import Path

from fastapi import FastAPI, Request, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.exceptions import RequestValidationError
from fastapi.staticfiles import StaticFiles
from fastapi.responses import JSONResponse

from api import auth, chats, files, folders, users, ollama, admin_queue, knowledge_dbs, queue
from api import mcp as mcp_api
from api import settings as settings_api
from api.auth import get_password_hash
from config import settings
from models.database import AccountStatus, ChatMessage, SessionLocal, User, UserRole, create_tables, get_engine
from services.enrichment_queue import enrichment_queue
from services.enrichment_service import process_enrichment_queue_item
from services.processing_queue import processing_queue
from services.ollama_runtime import get_ai_runtime_config, keep_ollama_model_warm
from services.sidecar_runtime import prewarm_analysis_sidecars


# DOREA-XP 기본 임베딩 모델. RAG 임베딩 파이프라인이 의존한다.
_DEFAULT_EMBEDDING_MODEL = "bge-m3"


async def _ensure_default_embedding_model() -> None:
    """
    첫 부팅 시 Ollama에 bge-m3가 설치돼 있는지 확인하고, 없으면 백그라운드로 pull한다.
    이 작업은 startup을 막지 않는다 (asyncio.create_task로 실행). 다운로드 ~1.2GB.
    """
    import httpx

    ollama_url = settings.ollama_url.rstrip("/")
    timeout = httpx.Timeout(connect=5.0, read=30.0, write=10.0, pool=5.0)

    # 1) Ollama가 올라올 때까지 잠깐 대기 (compose 의존성 의존도가 낮으므로)
    for _ in range(10):
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                resp = await client.get(f"{ollama_url}/api/tags")
                if resp.status_code == 200:
                    tags = resp.json().get("models", []) or []
                    names = {(m.get("name") or "").split(":")[0].lower() for m in tags}
                    if _DEFAULT_EMBEDDING_MODEL in names:
                        print(f"[Bootstrap] Embedding model '{_DEFAULT_EMBEDDING_MODEL}' already installed in Ollama")
                        return
                    break  # tags 조회 성공했고 모델만 없는 상태 → pull 진행
        except Exception:
            await asyncio.sleep(3)
    else:
        print(f"[Bootstrap] Ollama not reachable for embedding model check; skipping auto-pull")
        return

    # 2) bge-m3 pull (streaming response)
    print(f"[Bootstrap] Embedding model '{_DEFAULT_EMBEDDING_MODEL}' not found in Ollama, pulling in background (~1.2GB)...")
    try:
        pull_timeout = httpx.Timeout(connect=10.0, read=None, write=None, pool=10.0)
        async with httpx.AsyncClient(timeout=pull_timeout) as client:
            async with client.stream(
                "POST",
                f"{ollama_url}/api/pull",
                json={"model": _DEFAULT_EMBEDDING_MODEL},
            ) as pull_resp:
                if pull_resp.status_code != 200:
                    body = await pull_resp.aread()
                    print(f"[Bootstrap] Embedding model pull failed: HTTP {pull_resp.status_code} {body[:200]!r}")
                    return
                # 진행 메시지는 너무 많아 마지막 status만 로그
                last_status = ""
                async for line in pull_resp.aiter_lines():
                    if not line:
                        continue
                    try:
                        import json as _json
                        data = _json.loads(line)
                        last_status = data.get("status", "") or last_status
                    except Exception:
                        pass
        print(f"[Bootstrap] Embedding model '{_DEFAULT_EMBEDDING_MODEL}' pull complete: {last_status}")
    except Exception as e:
        print(f"[Bootstrap] Embedding model auto-pull failed (non-blocking): {e}")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """앱 생명주기 관리"""
    # Startup
    get_engine()
    create_tables()

    admin_pw = settings.admin_initial_password
    if not admin_pw:
        raise RuntimeError("ADMIN_INITIAL_PASSWORD must be set")

    db = SessionLocal()
    try:
        admin_user = db.query(User).filter(User.username == "admin").first()
        if not admin_user:
            admin_user = User(
                username="admin",
                email="admin@local.invalid",
                hashed_password=get_password_hash(admin_pw),
                role=UserRole.SUPER_ADMIN,
                status=AccountStatus.ACTIVE,
                is_email_verified=True,
            )
            db.add(admin_user)
            db.commit()
            print("✅ Seeded admin user")
    finally:
        db.close()

    # Seed KISTI-MCP fixed catalog entry (DOREA-XP: only KISTI-MCP is exposed)
    try:
        from models.database import McpServer
        seed_db = SessionLocal()
        try:
            existing_names = {row.name for row in seed_db.query(McpServer.name).all()}

            _kisti_env_keys = [
                "SCIENCEON_API_KEY", "SCIENCEON_CLIENT_ID", "SCIENCEON_MAC_ADDRESS",
                "NTIS_API_KEY", "DataON_ResearchData_API_KEY", "DataON_ResearchDataMetadata_API_KEY",
            ]

            if "kisti-mcp" not in existing_names:
                seed_db.add(McpServer(
                    name="kisti-mcp",
                    display_name="KISTI 학술정보",
                    description="KISTI 학술정보 검색 MCP — 논문, 특허, 보고서, 동향 검색 (API 키 필요)",
                    server_type="mcp",
                    transport="streamable-http",
                    endpoint_url="http://dorea-x-mcp-service:8002",
                    enabled=False,
                    is_default=False,
                    sort_order=1,
                    icon="plug",
                    config_json={
                        "command": "uvx",
                        "args": ["kisti-mcp"],
                        "env_keys": _kisti_env_keys,
                        "timeout_seconds": 30,
                    },
                ))
                seed_db.commit()
                print("✅ Seeded KISTI-MCP catalog entry")
            else:
                kisti = seed_db.query(McpServer).filter(McpServer.name == "kisti-mcp").first()
                if kisti and (kisti.display_name != "KISTI 학술정보"
                              or (kisti.config_json or {}).get("env_keys") != _kisti_env_keys):
                    kisti.display_name = "KISTI 학술정보"
                    kisti.description = "KISTI 학술정보 검색 MCP — 논문, 특허, 보고서, 동향 검색 (API 키 필요)"
                    kisti.config_json = {
                        "command": "uvx",
                        "args": ["kisti-mcp"],
                        "env_keys": _kisti_env_keys,
                        "timeout_seconds": 30,
                    }
                    seed_db.commit()
                    print("✅ Patched kisti-mcp config")
        finally:
            seed_db.close()
    except Exception as e:
        print(f"[Startup] KISTI-MCP catalog seed failed (non-blocking): {e}")

    # MCP 서버 자동 활성화: secret 키가 1개라도 있으면 enabled=True, 전부 없으면 False
    # (DOREA-XP는 사용자가 enabled를 직접 토글하는 UI를 두지 않으므로 secret 기준으로 결정)
    try:
        from models.database import McpServer
        from api.mcp import _is_secret_configured
        auto_db = SessionLocal()
        try:
            changed = 0
            for srv in auto_db.query(McpServer).filter(McpServer.server_type == "mcp").all():
                any_ready = _is_secret_configured(auto_db, srv)
                if any_ready and not srv.enabled:
                    srv.enabled = True
                    changed += 1
                    print(f"  → MCP '{srv.name}' auto-enabled (secrets present)")
                elif not any_ready and srv.enabled:
                    srv.enabled = False
                    changed += 1
                    print(f"  → MCP '{srv.name}' auto-disabled (no secrets)")
            if changed:
                auto_db.commit()
        finally:
            auto_db.close()
    except Exception as e:
        print(f"[Startup] MCP auto-enable check failed (non-blocking): {e}")

    # 처리 상태 복구: 서버 재시작 시 ANALYZING/CONVERTING 상태로 남은 고아 파일 → QUEUED 복구
    # (단일 워커이므로 startup 시 ANALYZING/CONVERTING은 모두 비정상 종료 고아)
    try:
        from models.database import PDFFile, FileStatus
        heal_db = SessionLocal()
        try:
            stale_files = heal_db.query(PDFFile).filter(
                PDFFile.status.in_([FileStatus.ANALYZING, FileStatus.CONVERTING])
            ).all()
            for f in stale_files:
                prev = f.status.value
                f.status = FileStatus.QUEUED
                f.error_code = None
                f.error_message = None
                print(f"[Startup] Self-heal: {f.id} {prev} → queued (orphan recovery)")
            if stale_files:
                heal_db.commit()
                print(f"[Startup] Self-healed {len(stale_files)} stale file(s) → queued")
        finally:
            heal_db.close()
    except Exception as e:
        print(f"[Startup] Stale processing recovery failed (non-blocking): {e}")

    # 처리 큐 워커 시작 + DB에서 QUEUED 복구
    await processing_queue.recover_from_db()
    await processing_queue.start_worker()
    await enrichment_queue.recover_from_db()
    await enrichment_queue.start_worker(process_enrichment_queue_item)

    if settings.keep_analysis_sidecars_warm:
        # opendataloader는 docker-compose profile 로 분리돼 있어 기본 부팅에서는 안 떠있다.
        # backend가 docker.sock으로 띄우는 동안 최대 5분 blocking 가능 → uvicorn startup
        # 자체가 hang 되어 nginx가 502를 반환하는 케이스가 보고됨.
        # 백그라운드 태스크로 떼어내서 startup을 막지 않도록 처리.
        async def _prewarm_sidecars():
            try:
                await prewarm_analysis_sidecars()
                print("[Startup] Analysis sidecars warmed: opendataloader")
            except Exception as e:
                print(f"[Startup] Analysis sidecar warm-up failed (non-blocking): {e}")
        asyncio.create_task(_prewarm_sidecars())

    # 첫 부팅 시 Ollama에 기본 임베딩 모델(bge-m3)이 없으면 백그라운드로 pull.
    # 모델이 없으면 RAG 임베딩이 실패하므로 사용자 손이 안 가도록 자동 처리.
    asyncio.create_task(_ensure_default_embedding_model())

    # 임베딩 상태 복구: "processing" 상태로 남아있는 파일 → "failed"로 전환 (orphan 정리)
    try:
        from models.database import PDFFile
        cleanup_db = SessionLocal()
        try:
            stuck_files = cleanup_db.query(PDFFile).filter(
                PDFFile.embedding_status == "processing"
            ).all()
            for f in stuck_files:
                f.embedding_status = "failed"
                print(f"[Startup] Reset stuck embedding: {f.id} processing → failed")
            if stuck_files:
                cleanup_db.commit()
                print(f"[Startup] Reset {len(stuck_files)} stuck embedding(s)")
        finally:
            cleanup_db.close()
    except Exception as e:
        print(f"[Startup] Embedding orphan cleanup failed (non-blocking): {e}")
    
    # Orphan attachment cleanup: delete uploaded-but-unsent attachment files older than TTL
    ORPHAN_ATTACHMENT_TTL_HOURS = 24  # files older than 24h and not in any message
    try:
        import re as _re
        attachments_base = Path("/app/DATABASE/attachments/sessions")
        if attachments_base.exists():
            cleanup_db = SessionLocal()
            try:
                # Gather all attachment IDs referenced in sent messages
                all_messages = cleanup_db.query(ChatMessage.content).filter(
                    ChatMessage.content.like("%attachment://%")
                ).all()
                referenced_ids = set()
                for (content,) in all_messages:
                    if content:
                        referenced_ids.update(_re.findall(r'attachment://([A-Za-z0-9_-]+)', content))

                now = time.time()
                ttl_seconds = ORPHAN_ATTACHMENT_TTL_HOURS * 3600
                scanned = 0
                deleted = 0
                for session_dir in attachments_base.iterdir():
                    if not session_dir.is_dir():
                        continue
                    for att_file in session_dir.iterdir():
                        if not att_file.is_file():
                            continue
                        scanned += 1
                        # Extract attachment_id from filename: "{id}_{original_name}"
                        att_id = att_file.name.split("_", 1)[0]
                        if att_id in referenced_ids:
                            continue  # Referenced by a sent message — keep
                        # Check file age
                        file_age = now - att_file.stat().st_mtime
                        if file_age > ttl_seconds:
                            att_file.unlink(missing_ok=True)
                            deleted += 1
                if deleted > 0:
                    print(f"[Startup] Orphan attachment cleanup: scanned={scanned}, deleted={deleted}, retained={scanned - deleted}")
            finally:
                cleanup_db.close()
    except Exception as e:
        print(f"[Startup] Orphan attachment cleanup failed (non-blocking): {e}")

    # Push enabled MCP server configs to mcp-service (non-blocking)
    # Reuse the canonical implementation from api.mcp to avoid key-format drift
    try:
        from api.mcp import _push_mcp_config_to_service

        mcp_db = SessionLocal()
        try:
            await _push_mcp_config_to_service(mcp_db)
            print("✅ Pushed MCP server configs to mcp-service")
        finally:
            mcp_db.close()
    except Exception as e:
        print(f"[Startup] MCP server configure failed (non-blocking): {e}")

    async def _ollama_keepalive_loop():
        while True:
            try:
                await asyncio.sleep(max(30, int(settings.ollama_keepalive_interval_seconds)))

                loop_db = SessionLocal()
                try:
                    model_type, ollama_model = get_ai_runtime_config(loop_db)
                finally:
                    loop_db.close()

                if model_type == "ollama" and ollama_model:
                    await keep_ollama_model_warm(ollama_model, settings.ollama_keepalive_duration)
            except asyncio.CancelledError:
                break
            except Exception as e:
                print(f"[OllamaRuntime] keepalive loop error (non-blocking): {e}")

    try:
        runtime_db = SessionLocal()
        try:
            model_type, ollama_model = get_ai_runtime_config(runtime_db)
        finally:
            runtime_db.close()

        if model_type == "ollama" and ollama_model:
            await keep_ollama_model_warm(ollama_model, settings.ollama_keepalive_duration)
    except Exception as e:
        print(f"[OllamaRuntime] startup warmup failed (non-blocking): {e}")

    ollama_keepalive_task = asyncio.create_task(_ollama_keepalive_loop())

    print(f"✅ {settings.app_name} v{settings.app_version} 시작!")
    yield

    ollama_keepalive_task.cancel()

    try:
        await enrichment_queue.stop_worker()
    except Exception as e:
        print(f"[Shutdown] Enrichment queue stop failed: {e}")
    # 워커 종료
    await processing_queue.stop_worker()
    print("🛑 서버 종료 중...")


app = FastAPI(
    title=settings.app_name,
    version=settings.app_version,
    docs_url="/docs",
    redoc_url="/redoc",
    lifespan=lifespan,
)

# ========== Error Handling / Request ID ==========

@app.middleware("http")
async def add_request_id(request: Request, call_next):
    request_id = uuid.uuid4().hex
    request.state.request_id = request_id
    start = time.time()

    response = await call_next(request)
    duration_ms = int((time.time() - start) * 1000)
    response.headers["X-Request-ID"] = request_id
    print(f"[REQ] {request.method} {request.url.path} status={response.status_code} ms={duration_ms} request_id={request_id}")
    return response


def _default_error_code(status_code: int) -> str:
    return {
        400: "BAD_REQUEST",
        401: "AUTH_REQUIRED",
        403: "FORBIDDEN",
        404: "NOT_FOUND",
        409: "CONFLICT",
        413: "PAYLOAD_TOO_LARGE",
        422: "VALIDATION_ERROR",
        429: "RATE_LIMITED",
        500: "INTERNAL_SERVER_ERROR",
    }.get(status_code, "HTTP_ERROR")


@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException):
    request_id = getattr(request.state, "request_id", None)

    detail = exc.detail
    if isinstance(detail, dict):
        error_code = detail.get("error_code") or _default_error_code(exc.status_code)
        message = detail.get("message") or detail.get("detail") or "요청 처리 중 오류가 발생했습니다"
        extra = {k: v for k, v in detail.items() if k not in {"error_code", "message", "detail"}}
    else:
        error_code = _default_error_code(exc.status_code)
        message = str(detail) if detail else "요청 처리 중 오류가 발생했습니다"
        # Starlette auth dependency may raise 403 with "Not authenticated"
        if exc.status_code in (401, 403) and message == "Not authenticated":
            error_code = "AUTH_REQUIRED"
            message = "로그인이 필요합니다"
        extra = {}

    if exc.status_code >= 500:
        try:
            print(f"[HTTPError] {request.method} {request.url.path} status={exc.status_code} request_id={request_id} detail={detail}")
        except Exception:
            pass

    payload = {
        "error_code": error_code,
        "message": message,
        "status": exc.status_code,
        "request_id": request_id,
        **extra,
    }

    return JSONResponse(status_code=exc.status_code, content=payload, headers={"X-Request-ID": request_id} if request_id else None)


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    request_id = getattr(request.state, "request_id", None)
    payload = {
        "error_code": "VALIDATION_ERROR",
        "message": "요청 값이 올바르지 않습니다",
        "status": 422,
        "request_id": request_id,
        "details": exc.errors(),
    }
    return JSONResponse(status_code=422, content=payload, headers={"X-Request-ID": request_id} if request_id else None)


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    request_id = getattr(request.state, "request_id", None)
    # Keep a server-side log with request_id for debugging
    print(f"[UnhandledError] {request.method} {request.url.path} request_id={request_id} error={exc}")
    try:
        traceback.print_exception(type(exc), exc, exc.__traceback__)
    except Exception:
        pass

    payload = {
        "error_code": "INTERNAL_SERVER_ERROR",
        "message": "서버 내부 오류가 발생했습니다",
        "status": 500,
        "request_id": request_id,
    }
    return JSONResponse(status_code=500, content=payload, headers={"X-Request-ID": request_id} if request_id else None)

# CORS Middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Include routers (routers already declare /api/* prefix)
app.include_router(auth.router)
app.include_router(files.router)
app.include_router(folders.router)
app.include_router(chats.router)
app.include_router(users.router)
app.include_router(settings_api.router)
app.include_router(ollama.router)
app.include_router(admin_queue.router)
app.include_router(queue.router)
app.include_router(knowledge_dbs.router)
app.include_router(mcp_api.router)

# Static files (optional, legacy)
# Path: project_root/frontend/dist (backend/src/main.py → ../../frontend/dist)
STATIC_DIR = Path(__file__).parent.parent.parent / "frontend" / "dist"
if STATIC_DIR.exists():
    app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")


# Health check
@app.get("/health")
async def health_check():
    return {
        "status": "healthy",
        "app": settings.app_name,
        "version": settings.app_version,
        "environment": settings.environment,
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "main:app",
        host="0.0.0.0",
        port=8000,
        reload=True if settings.environment == "development" else False,
        log_level="info" if settings.environment == "development" else "warning",
    )
