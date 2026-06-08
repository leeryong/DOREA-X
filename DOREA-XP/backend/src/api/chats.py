# Chat Session & Message Routes

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form
from fastapi.responses import FileResponse as FastAPIFileResponse, StreamingResponse
from sqlalchemy.orm import Session
from typing import Any, List, Optional
from datetime import datetime, timedelta
from pydantic import BaseModel
from pathlib import Path
import uuid
import shutil
import re
import base64
import mimetypes
import json

from models.database import get_db, User, ChatSession, ChatMessage, PDFFile, SystemSetting, UserSettings, McpServer, UserMcpPreference
from schemas.api_schemas import ChatSessionCreateRequest, ChatSessionResponse, ChatMessageRequest, ChatModelSelection
from api.deps import get_current_user
from services.ai_service import get_ai_service
from config import settings as app_settings

router = APIRouter(prefix="/api/chats", tags=["Chats"])


# Vision capability: resolved centrally in settings.py
from api.settings import _is_openai_vision_model, _check_ollama_vision_capable, _check_ollama_model_exists, _normalize_ai_provider, _provider_label, _is_supported_claude_model, _is_supported_openai_chat_model

# Attachment constraints
MAX_ATTACHMENTS_PER_MESSAGE = 5
MAX_ATTACHMENT_SIZE_BYTES = 5 * 1024 * 1024  # 5MB
ALLOWED_IMAGE_MIMES = {"image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"}

SESSION_DEFAULT_TITLE = "새 대화"
SESSION_PASTED_TITLE_PREFIX = "[Pasted ~"
_LEGACY_DATETIME_TITLE_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$")
_AUTO_TITLE_MIN_TOTAL_MESSAGES = 4
_AUTO_TITLE_MIN_USER_MESSAGES = 2
_AUTO_TITLE_MAX_CONTEXT_MESSAGES = 12
_EVIDENCE_REQUEST_PATTERN = re.compile(
    r"(근거|출처|인용|참고문헌|citation|source|reference|관련도|어디서|출전)",
    re.IGNORECASE,
)
_EVIDENCE_LINE_PATTERN = re.compile(
    r"^\s*(?:[-*]\s*)?(?:\*\*\s*)?(?:근거|출처|근거/출처|evidence|source|citation)\s*[:：]",
    re.IGNORECASE,
)
_ATTACHMENT_TOKEN_PATTERN = re.compile(r'\s*attachment://[A-Za-z0-9_-]+')


def _normalize_inline_text(text: Optional[str]) -> str:
    if not text:
        return ""
    without_attachments = _ATTACHMENT_TOKEN_PATTERN.sub(" ", text)
    return re.sub(r"\s+", " ", without_attachments).strip()


def _requests_evidence_in_user_prompt(user_text: Optional[str]) -> bool:
    if not user_text:
        return False
    return bool(_EVIDENCE_REQUEST_PATTERN.search(user_text))


def _strip_non_rag_evidence_footer(content: str, user_text: Optional[str], rag_used: bool) -> str:
    """
    RAG가 꺼진 요청에서, 사용자가 근거/출처를 명시적으로 요구하지 않은 경우
    답변 말미의 고정 라벨(근거:/출처:) 블록을 제거한다.
    """
    if rag_used or _requests_evidence_in_user_prompt(user_text):
        return content

    lines = content.splitlines()
    if not lines:
        return content

    tail = len(lines) - 1
    while tail >= 0 and not lines[tail].strip():
        tail -= 1
    if tail < 0:
        return content

    if not _EVIDENCE_LINE_PATTERN.match(lines[tail] or ""):
        return content

    start = tail
    while start - 1 >= 0:
        prev = lines[start - 1]
        if not prev.strip() or _EVIDENCE_LINE_PATTERN.match(prev or ""):
            start -= 1
            continue
        break

    trimmed = lines[:start]
    while trimmed and not trimmed[-1].strip():
        trimmed.pop()
    return "\n".join(trimmed)


def _is_auto_title_candidate(session_name: Optional[str]) -> bool:
    title = (session_name or "").strip()
    if not title:
        return True
    if title == SESSION_DEFAULT_TITLE:
        return True
    if _LEGACY_DATETIME_TITLE_PATTERN.fullmatch(title):
        return True
    if title.startswith(SESSION_PASTED_TITLE_PREFIX) and title.endswith(" lines]"):
        return True
    return False


def _sse_event(event_type: str, payload: dict[str, Any]) -> str:
    return f"event: {event_type}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"


def _build_agent_status_payload(
    *,
    status: str,
    message: str,
    stage: Optional[str] = None,
    label: Optional[str] = None,
    tool_name: Optional[str] = None,
    server_name: Optional[str] = None,
    rag_used: Optional[bool] = None,
    rag_sources: Optional[List[dict[str, Any]]] = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "type": "agent_status",
        "status": status,
        "message": message,
    }
    if stage:
        payload["stage"] = stage
    if label:
        payload["label"] = label
    if tool_name:
        payload["tool_name"] = tool_name
    if server_name:
        payload["server_name"] = server_name
    if rag_used is not None:
        payload["rag_used"] = rag_used
    if rag_sources is not None:
        payload["rag_sources"] = _serialize_rag_sources(rag_sources)
    return payload


def _serialize_rag_source(source: dict[str, Any]) -> dict[str, Any]:
    return {
        "file_id": source.get("file_id"),
        "filename": source.get("filename", ""),
        "page": source.get("page"),
        "score": source.get("score"),
        "segment_type": source.get("segment_type", ""),
        "seg_id": source.get("seg_id", ""),
    }


def _serialize_rag_sources(sources: Optional[List[dict[str, Any]]]) -> list[dict[str, Any]]:
    return [_serialize_rag_source(source) for source in (sources or []) if isinstance(source, dict)]

def _build_initial_session_title_from_message(content: str) -> str:
    normalized = _normalize_inline_text(content)
    if not normalized:
        return SESSION_DEFAULT_TITLE

    non_empty_lines = [line for line in content.splitlines() if line.strip()]
    line_count = len(non_empty_lines)
    estimated_lines = max(line_count, max(1, len(normalized) // 80))
    looks_like_pasted = line_count >= 3 or len(normalized) >= 180

    if looks_like_pasted:
        return f"{SESSION_PASTED_TITLE_PREFIX}{estimated_lines} lines]"

    return normalized[:36] + ("…" if len(normalized) > 36 else "")


def _sanitize_generated_title(raw_title: str) -> str:
    title = _normalize_inline_text(raw_title)
    if not title:
        return ""
    title = title.strip('"\'`[]')
    title = title.replace("제목:", "").replace("Title:", "").strip()
    if len(title) > 48:
        title = title[:48].rstrip() + "…"
    return title


async def _maybe_set_initial_session_title(db: Session, session: ChatSession, user_content: str) -> None:
    if getattr(session, "is_title_user_edited", False):
        return
    if not _is_auto_title_candidate(session.session_name):
        return

    next_title = _build_initial_session_title_from_message(user_content)
    if next_title and next_title != (session.session_name or ""):
        session.session_name = next_title
        session.updated_at = datetime.now()
        db.commit()


def _should_generate_summary_title(session: ChatSession, messages: List[ChatMessage]) -> bool:
    if getattr(session, "is_title_user_edited", False):
        return False
    if not _is_auto_title_candidate(session.session_name):
        return False

    total_count = len(messages)
    user_count = sum(1 for m in messages if m.is_user)
    assistant_count = total_count - user_count

    return (
        total_count >= _AUTO_TITLE_MIN_TOTAL_MESSAGES
        and user_count >= _AUTO_TITLE_MIN_USER_MESSAGES
        and assistant_count >= 1
    )


async def _generate_summary_title(db: Session, messages: List[ChatMessage]) -> str:
    recent = messages[-_AUTO_TITLE_MAX_CONTEXT_MESSAGES:]
    dialogue_lines: List[str] = []
    for msg in recent:
        content = _normalize_inline_text(msg.content)
        if not content:
            continue
        role = "사용자" if msg.is_user else "AI"
        dialogue_lines.append(f"{role}: {content[:220]}")

    if not dialogue_lines:
        return ""

    prompt = (
        "아래 대화를 보고 대화기록 목록용 제목을 1개 생성하세요.\n"
        "기준: 첫 질문, 반복 키워드, 대화 목적을 반영\n"
        "제약: 10~24자, 군더더기 금지, 따옴표/번호/설명 없이 제목 한 줄만 출력\n\n"
        "대화:\n"
        + "\n".join(dialogue_lines)
    )

    ai_service = get_ai_service(db)
    result = await ai_service.generate_response(
        messages=[{"role": "user", "content": prompt}],
        context=None,
        rag_active=False,
        persona_custom_markdown=None,
    )
    return _sanitize_generated_title(result.get("content", ""))


async def _maybe_generate_summary_title(db: Session, session: ChatSession) -> None:
    messages = db.query(ChatMessage).filter(
        ChatMessage.session_id == session.id
    ).order_by(ChatMessage.created_at.asc()).all()

    if not _should_generate_summary_title(session, messages):
        return

    generated = await _generate_summary_title(db, messages)
    if not generated:
        return

    if generated != (session.session_name or ""):
        session.session_name = generated
        session.updated_at = datetime.now()
        db.commit()

def _get_user_persona_markdown(user_settings: Optional[UserSettings]) -> str:
    """
    Extract user's custom persona markdown from UserSettings.
    Returns empty string if not set or user_settings is None.
    
    Args:
        user_settings: Pre-fetched UserSettings object (or None)
    """
    val = getattr(user_settings, 'persona_custom_markdown', None) if user_settings else None
    if val:
        return val.strip()
    return ""

def _get_setting(db: Session, key: str, default: str = "") -> str:
    """시스템 설정 값 조회"""
    row = db.query(SystemSetting).filter(SystemSetting.key == key).first()
    return row.value if row else default


def _get_current_ai_config(db: Session, model_override: Optional[ChatModelSelection] = None) -> dict[str, Any]:
    """
    현재 AI 설정을 딕셔너리로 반환
    Returns: {"provider": "OpenAI"|"Ollama", "model": "...", "temperature": float, "max_tokens": int}
    """
    model_type = _normalize_ai_provider(_get_setting(db, "ai.model_type", "ollama"))
    temperature = float(_get_setting(db, "ai.temperature", "0.7"))
    max_tokens = int(_get_setting(db, "ai.max_tokens", "2048"))

    if model_override and model_override.model:
        provider_type = _normalize_ai_provider(model_override.provider)
        return {
            "type": provider_type,
            "provider": _provider_label(provider_type),
            "model": model_override.model.strip(),
            "temperature": temperature,
            "max_tokens": max_tokens,
        }
    
    if model_type == "openai":
        return {
            "type": "openai",
            "provider": "OpenAI",
            "model": _get_setting(db, "ai.openai.model", "gpt-4o"),
            "temperature": temperature,
            "max_tokens": max_tokens
        }
    if model_type == "claude":
        return {
            "type": "claude",
            "provider": "Claude",
            "model": _get_setting(db, "ai.claude.model", ""),
            "temperature": temperature,
            "max_tokens": max_tokens,
        }
    else:
        return {
            "type": "ollama",
            "provider": "Ollama",
            "model": _get_setting(db, "ai.ollama.model", ""),
            "temperature": temperature,
            "max_tokens": max_tokens
        }


async def _is_vision_capable(db: Session, model_override: Optional[ChatModelSelection] = None) -> bool:
    """현재 설정된 모델이 vision을 지원하는지 확인 (Ollama: /api/show 기반, OpenAI: prefix match)"""
    if model_override and model_override.model:
        provider_type = _normalize_ai_provider(model_override.provider)
        if provider_type == "openai":
            return _is_supported_openai_chat_model(model_override.model)
        if provider_type == "claude":
            return _is_supported_claude_model(model_override.model)
        return await _check_ollama_vision_capable(model_override.model)

    model_type = _normalize_ai_provider(_get_setting(db, "ai.model_type", "ollama"))
    
    if model_type == "openai":
        openai_model = _get_setting(db, "ai.openai.model", "gpt-4o")
        return _is_openai_vision_model(openai_model)
    if model_type == "claude":
        claude_model = _get_setting(db, "ai.claude.model", "")
        return _is_supported_claude_model(claude_model)
    else:
        ollama_model = _get_setting(db, "ai.ollama.model", "")
        return await _check_ollama_vision_capable(ollama_model)


async def _apply_model_override(ai_service, db: Session, model_override: Optional[ChatModelSelection]) -> dict[str, Any]:
    ai_config = _get_current_ai_config(db, model_override)
    if not model_override or not model_override.model:
        return ai_config

    provider_type = ai_config["type"]
    model_name = ai_config["model"].strip()

    if provider_type == "openai":
        openai_api_key = _get_setting(db, "ai.openai.api_key", "")
        if not openai_api_key:
            raise HTTPException(status_code=400, detail={"error_code": "CHATS_MODEL_NOT_CONFIGURED", "message": "OpenAI 모델이 설정되지 않았습니다"})
        if not _is_supported_openai_chat_model(model_name):
            raise HTTPException(status_code=400, detail={"error_code": "CHATS_MODEL_NOT_SUPPORTED", "message": f"지원하지 않는 OpenAI 멀티모달 모델입니다: {model_name}"})
        ai_service.model_type = "openai"
        ai_service.openai_api_key = openai_api_key
        ai_service.openai_model = model_name
        return ai_config

    if provider_type == "claude":
        claude_api_key = _get_setting(db, "ai.claude.api_key", "")
        if not claude_api_key:
            raise HTTPException(status_code=400, detail={"error_code": "CHATS_MODEL_NOT_CONFIGURED", "message": "Claude 모델이 설정되지 않았습니다"})
        if not _is_supported_claude_model(model_name):
            raise HTTPException(status_code=400, detail={"error_code": "CHATS_MODEL_NOT_SUPPORTED", "message": f"지원하지 않는 Claude 멀티모달 모델입니다: {model_name}"})
        ai_service.model_type = "claude"
        ai_service.claude_api_key = claude_api_key
        ai_service.claude_model = model_name
        return ai_config

    # vision 여부는 따지지 않는다 — 텍스트 전용 모델도 텍스트 채팅에 사용 가능.
    # 이미지 첨부 시점에만 별도로 vision capability를 검사한다 (_is_vision_capable).
    if not await _check_ollama_model_exists(model_name):
        raise HTTPException(status_code=400, detail={"error_code": "CHATS_MODEL_NOT_SUPPORTED", "message": f"Ollama에 설치되지 않은 모델입니다: {model_name}"})
    ai_service.model_type = "ollama"
    ai_service.ollama_model = model_name
    return ai_config


def _parse_attachment_ids(content: str) -> List[str]:
    """메시지 content에서 attachment://{id} 토큰들을 추출"""
    pattern = r'attachment://([A-Za-z0-9_-]+)'
    matches = re.findall(pattern, content)
    return matches


def _normalize_attachment_reference(raw: Any) -> Optional[dict[str, Any]]:
    if not isinstance(raw, dict):
        return None

    file_id = str(raw.get("file_id") or "").strip()
    if not file_id:
        return None

    segment_ids = []
    for segment_id in raw.get("segment_ids") or []:
        normalized_id = str(segment_id or "").strip()
        if normalized_id:
            segment_ids.append(normalized_id)

    focus_segment_id = str(raw.get("focus_segment_id") or "").strip() or None

    page_value = raw.get("page")
    try:
        page = int(page_value) if page_value is not None else None
    except (TypeError, ValueError):
        page = None

    segment_type = str(raw.get("segment_type") or "").strip() or None

    return {
        "file_id": file_id,
        "segment_ids": segment_ids,
        "focus_segment_id": focus_segment_id,
        "page": page,
        "segment_type": segment_type,
    }


def _get_attachment_metadata_path(session_id: int, attachment_id: str) -> Path:
    attachments_dir = Path(f"/app/DATABASE/attachments/sessions/{session_id}")
    return attachments_dir / f".{attachment_id}.json"


def _load_attachment_metadata(session_id: int, attachment_id: str) -> Optional[dict[str, Any]]:
    metadata_path = _get_attachment_metadata_path(session_id, attachment_id)
    if not metadata_path.exists():
        return None

    try:
        payload = json.loads(metadata_path.read_text(encoding="utf-8"))
    except Exception:
        return None

    if not isinstance(payload, dict):
        return None

    reference = _normalize_attachment_reference(payload.get("reference"))
    if reference:
        payload["reference"] = reference
    else:
        payload.pop("reference", None)
    return payload


def _build_message_attachments(session_id: int, content: str) -> Optional[List[dict[str, Any]]]:
    attachment_ids = _parse_attachment_ids(content)
    if not attachment_ids:
        return None

    attachments_dir = Path(f"/app/DATABASE/attachments/sessions/{session_id}")
    attachments: List[dict[str, Any]] = []

    for attachment_id in attachment_ids:
        matching_files = list(attachments_dir.glob(f"{attachment_id}_*"))
        if not matching_files:
            continue

        file_path = matching_files[0]
        original_filename = file_path.name[len(attachment_id) + 1:]
        mime_type, _ = mimetypes.guess_type(str(file_path))
        if not mime_type:
            mime_type = "application/octet-stream"

        attachment_payload = {
            "attachment_id": attachment_id,
            "filename": original_filename,
            "path": str(file_path),
            "size": file_path.stat().st_size,
            "mime_type": mime_type,
        }

        metadata = _load_attachment_metadata(session_id, attachment_id)
        if metadata:
            attachment_payload.update(metadata)
            attachment_payload["attachment_id"] = attachment_id
            attachment_payload["filename"] = metadata.get("filename") or original_filename
            attachment_payload["path"] = str(file_path)
            attachment_payload["size"] = metadata.get("size") or file_path.stat().st_size
            attachment_payload["mime_type"] = metadata.get("mime_type") or mime_type

        attachments.append(attachment_payload)

    return attachments or None


def _load_attachment_as_base64(session_id: int, attachment_id: str) -> Optional[dict]:
    """
    첨부파일을 로드하여 base64 data URL로 변환
    Returns: {"data_url": "data:image/png;base64,...", "mime_type": "image/png"} or None
    """
    attachments_dir = Path(f"/app/DATABASE/attachments/sessions/{session_id}")
    matching_files = list(attachments_dir.glob(f"{attachment_id}_*"))
    
    if not matching_files:
        return None
    
    file_path = matching_files[0]
    
    # Get mime type
    mime_type, _ = mimetypes.guess_type(str(file_path))
    if not mime_type:
        # Try to infer from extension
        ext = file_path.suffix.lower()
        mime_map = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif"}
        mime_type = mime_map.get(ext, "image/png")
    
    # Validate mime type
    if mime_type not in ALLOWED_IMAGE_MIMES:
        return None
    
    # Check file size
    if file_path.stat().st_size > MAX_ATTACHMENT_SIZE_BYTES:
        return None
    
    # Read and encode
    with open(file_path, "rb") as f:
        data = f.read()
    
    b64 = base64.b64encode(data).decode("utf-8")
    data_url = f"data:{mime_type};base64,{b64}"
    
    return {"data_url": data_url, "mime_type": mime_type}


# 추가 스키마
class SessionRenameRequest(BaseModel):
    session_name: str


class SessionListResponse(BaseModel):
    id: int
    session_name: Optional[str]
    file_id: Optional[str]
    file_name: Optional[str]  # 연결된 파일명
    message_count: int
    created_at: datetime
    updated_at: Optional[datetime]


# ========== 사용자 전체 세션 목록 API ==========

@router.get("/sessions", response_model=List[SessionListResponse])
async def list_all_sessions(
    skip: int = 0,
    limit: int = 50,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """
    사용자의 전체 채팅 세션 목록 (파일 무관)
    """
    sessions = db.query(ChatSession).filter(
        ChatSession.user_id == current_user.id
    ).order_by(ChatSession.updated_at.desc()).offset(skip).limit(limit).all()
    
    result = []
    for s in sessions:
        # 파일명 조회
        file_name = None
        if s.file_id:
            file = db.query(PDFFile).filter(PDFFile.id == s.file_id).first()
            if file:
                file_name = file.original_filename
        
        # 메시지 수 조회
        message_count = db.query(ChatMessage).filter(
            ChatMessage.session_id == s.id
        ).count()
        
        result.append(SessionListResponse(
            id=s.id,
            session_name=s.session_name,
            file_id=s.file_id,
            file_name=file_name,
            message_count=message_count,
            created_at=s.created_at,
            updated_at=s.updated_at
        ))
    
    return result


@router.delete("/sessions/all")
async def delete_all_sessions(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """
    사용자의 전체 채팅 세션 삭제
    """
    deleted = db.query(ChatSession).filter(
        ChatSession.user_id == current_user.id
    ).delete()
    db.commit()
    
    return {"message": f"{deleted}개의 채팅 세션이 삭제되었습니다", "deleted_count": deleted}


@router.patch("/sessions/{session_id}/rename")
async def rename_session(
    session_id: int,
    request: SessionRenameRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """
    채팅 세션 이름 변경
    """
    session = db.query(ChatSession).filter(
        ChatSession.id == session_id,
        ChatSession.user_id == current_user.id
    ).first()
    
    if not session:
        raise HTTPException(status_code=404, detail={"error_code": "CHATS_SESSION_NOT_FOUND", "message": "채팅 세션을 찾을 수 없습니다"})
    
    session.session_name = request.session_name
    session.is_title_user_edited = True
    if not getattr(session, "is_title_user_edited", False):
        session.session_name = SESSION_DEFAULT_TITLE
    session.updated_at = datetime.now()
    db.commit()
    
    return {"message": "세션 이름이 변경되었습니다", "session_name": session.session_name}


# ========== 파일별 세션 목록 API ==========

@router.get("/files/{file_id}", response_model=List[ChatSessionResponse])
async def list_chat_sessions(
    file_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """
    특정 파일의 채팅 세션 목록
    """
    sessions = db.query(ChatSession).filter(
        ChatSession.user_id == current_user.id,
        ChatSession.file_id == file_id
    ).order_by(ChatSession.updated_at.desc()).all()
    
    return [
        ChatSessionResponse(
            id=s.id,
            file_id=s.file_id,
            session_name=s.session_name,
            created_at=s.created_at
        )
        for s in sessions
    ]


@router.get("/sessions/{session_id}/messages", response_model=List[dict])
async def get_chat_messages(
    session_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """
    채팅 메시지 목록 조회
    """
    session = db.query(ChatSession).filter(
        ChatSession.id == session_id,
        ChatSession.user_id == current_user.id
    ).first()
    
    if not session:
        raise HTTPException(status_code=404, detail={"error_code": "CHATS_SESSION_NOT_FOUND", "message": "채팅 세션을 찾을 수 없습니다"})
    
    messages = db.query(ChatMessage).filter(
        ChatMessage.session_id == session_id
    ).order_by(ChatMessage.created_at.asc()).all()
    
    return [
        {
            "id": m.id,
            "content": m.content,
            "is_user": m.is_user,
            "selected_segments": m.selected_segments,
            "attachments": m.attachments,
            "model_used": m.model_used,
            "tokens_used": m.tokens_used,
            "model_metadata": m.model_metadata,
            "created_at": m.created_at.isoformat() if m.created_at else None
        }
        for m in messages
    ]


@router.delete("/sessions/{session_id}/messages")
async def clear_session_messages(
    session_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """
    세션 내 모든 메시지 삭제 (세션 자체는 유지)
    첨부파일도 함께 삭제
    """
    session = db.query(ChatSession).filter(
        ChatSession.id == session_id,
        ChatSession.user_id == current_user.id
    ).first()

    if not session:
        raise HTTPException(status_code=404, detail={"error_code": "CHATS_SESSION_NOT_FOUND", "message": "채팅 세션을 찾을 수 없습니다"})

    deleted = db.query(ChatMessage).filter(
        ChatMessage.session_id == session_id
    ).delete()

    # 첨부파일 폴더 삭제
    attachments_dir = Path(f"/app/DATABASE/attachments/sessions/{session_id}")
    if attachments_dir.exists():
        shutil.rmtree(attachments_dir)

    session.updated_at = datetime.now()
    db.commit()

    return {"message": f"{deleted}개의 메시지가 삭제되었습니다", "deleted_count": deleted}


@router.post("/sessions", response_model=ChatSessionResponse)
async def create_chat_session(
    request: ChatSessionCreateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """
    새 채팅 세션 생성
    """
    # ========== Time-window deduplication guard ==========
    cutoff_time = datetime.now() - timedelta(seconds=2)
    
    if request.file_id is None:
        existing_session = db.query(ChatSession).filter(
            ChatSession.user_id == current_user.id,
            ChatSession.file_id.is_(None),
            ChatSession.created_at >= cutoff_time
        ).first()
    else:
        existing_session = db.query(ChatSession).filter(
            ChatSession.user_id == current_user.id,
            ChatSession.file_id == request.file_id,
            ChatSession.created_at >= cutoff_time
        ).first()
    
    if existing_session:
        age_ms = int((datetime.now() - existing_session.created_at).total_seconds() * 1000)
        print(f"[ChatDedup] Returning existing session {existing_session.id} for user {current_user.id} (created {age_ms}ms ago)")
        return ChatSessionResponse(
            id=existing_session.id,
            file_id=existing_session.file_id,
            session_name=existing_session.session_name,
            created_at=existing_session.created_at
        )
    
    # ========== Create new session ==========
    default_name = SESSION_DEFAULT_TITLE
    
    new_session = ChatSession(
        user_id=current_user.id,
        file_id=request.file_id,
        session_name=request.session_name or default_name
    )
    
    db.add(new_session)
    db.commit()
    db.refresh(new_session)
    
    return ChatSessionResponse(
        id=new_session.id,
        file_id=new_session.file_id,
        session_name=new_session.session_name,
        created_at=new_session.created_at
    )


class ChatMessageStreamRequest(BaseModel):
    content: str
    selected_segments: Optional[List[dict]] = None
    stream: bool = True
    knowledge_db: Optional[str] = None  # "none" | "{kb_id}" — RAG 검색 범위 (지식DB ID)
    mcp_skills: Optional[List[dict]] = None  # [{id, name, display_name, server_type, description}, ...]
    model_override: Optional[ChatModelSelection] = None
    editor_command: Optional[dict] = None  # {type: 'insert'|'rewrite'|'style'|'replace', target_range?, anchor?, revision_hash?, risk_tier?}
    center_panel_mode: Optional[str] = None  # 'document' | 'web' — 현재 센터 패널 모드
    viewing_context: Optional[dict] = None  # {type: 'document', document_name?, current_page?, total_pages?}
    include_document_content: bool = False  # True일 때만 문서 전문 주입 (사용자가 명시적으로 문서 전체 분석 요청 시)


@router.post("/sessions/{session_id}/messages/stream")
async def send_chat_message_stream(
    session_id: int,
    request: ChatMessageStreamRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """
    채팅 메시지 전송 (SSE 스트리밍)
    
    SSE 이벤트 형식:
    - event: start  / data: {"model": "...", "provider": "..."}
    - event: delta  / data: {"delta": "텍스트 조각"}
    - event: done   / data: {"content": "전체 텍스트", "tokens": N, "model": "..."}
    - event: error  / data: {"message": "에러 메시지"}
    """
    session = db.query(ChatSession).filter(
        ChatSession.id == session_id,
        ChatSession.user_id == current_user.id
    ).first()
    
    if not session:
        raise HTTPException(status_code=404, detail={"error_code": "CHATS_SESSION_NOT_FOUND", "message": "채팅 세션을 찾을 수 없습니다"})
    
    # ========== 이미지 첨부 처리 ==========
    attachment_ids = _parse_attachment_ids(request.content)
    images_base64 = []
    
    is_vision = await _is_vision_capable(db, request.model_override)
    
    if attachment_ids:
        if len(attachment_ids) > MAX_ATTACHMENTS_PER_MESSAGE:
            raise HTTPException(
                status_code=400,
                detail={
                    "error_code": "CHATS_TOO_MANY_ATTACHMENTS",
                    "message": f"이미지 첨부는 최대 {MAX_ATTACHMENTS_PER_MESSAGE}개까지 가능합니다."
                }
            )
        
        # 비전 모델일 때만 이미지를 AI에 전송 (메시지 저장은 항상 함)
        if is_vision:
            for att_id in attachment_ids:
                img_data = _load_attachment_as_base64(session_id, att_id)
                if img_data:
                    images_base64.append(img_data)
    
    # 현재 AI 설정 스냅샷 (user 메시지에 requested로 저장)
    ai_service = get_ai_service(db)
    ai_config = await _apply_model_override(ai_service, db, request.model_override)
    
    # 사용자 설정 한 번에 로드 (메모리, 페르소나 등에서 재사용)
    user_settings = db.query(UserSettings).filter(UserSettings.user_id == current_user.id).first()
    
    # 사용자 커스텀 페르소나 추출
    persona_custom_markdown = _get_user_persona_markdown(user_settings)
    
    # 사용자 메시지 저장 (즉시)
    user_message = ChatMessage(
        session_id=session_id,
        content=request.content,
        is_user=True,
        selected_segments=request.selected_segments,
        attachments=_build_message_attachments(session_id, request.content),
        model_metadata={"requested": ai_config}
    )
    db.add(user_message)
    db.commit()
    await _maybe_set_initial_session_title(db, session, request.content)
    
    # 대화 히스토리 구성 (최근 10개 메시지)
    history_messages = db.query(ChatMessage).filter(
        ChatMessage.session_id == session_id
    ).order_by(ChatMessage.created_at.desc()).limit(10).all()
    history_messages = list(reversed(history_messages))
    
    messages_for_ai = []
    for msg in history_messages:
        messages_for_ai.append({
            "role": "user" if msg.is_user else "assistant",
            "content": msg.content
        })
    
    # ========== Intent Detection (pre-compute before heavy I/O) ==========
    _user_msg_lower = request.content.lower()

    # -- Editor Intent --
    # 편집기 패널 열림 여부가 아니라, 사용자가 편집기를 명시적으로 언급했을 때만 편집 의도로 판정한다.
    # '정리해줘', '작성해줘', '넣어줘' 같은 일반 표현은 편집 의도로 취급하지 않는다.
    _EDITOR_KEYWORDS = ['에디터에', '편집기에', '편집창에', '에디터로', '편집기로', '편집창으로']
    _editor_intent = request.editor_command is not None or any(kw in _user_msg_lower for kw in _EDITOR_KEYWORDS)
    _effective_editor_command = request.editor_command or ({'type': 'insert'} if _editor_intent else None)

    # Aggregate: skip expensive searches when intent is clear
    _skip_rag = _editor_intent

    # ========== 사용자의 현재 화면 상태를 컨텍스트로 주입 ==========
    viewing_context_text = None
    if request.viewing_context:
        vc = request.viewing_context
        vc_type = vc.get("type")
        if vc_type == "document":
            doc_name = vc.get("document_name") or "알 수 없는 문서"
            cur_page = vc.get("current_page")
            total_pages = vc.get("total_pages")
            page_info = f" (현재 {cur_page}/{total_pages} 페이지를 보고 있음)" if cur_page and total_pages else ""
            viewing_context_text = f"[사용자 화면 상태] 사용자가 현재 문서 뷰어에서 \"{doc_name}\"{page_info} 을(를) 보고 있습니다."
            
            # 문서 전문 주입: 사용자가 명시적으로 요청한 경우에만 (include_document_content=True)
            doc_id = vc.get("document_id")
            if doc_id and request.include_document_content and not request.selected_segments:
                try:
                    doc_file = db.query(PDFFile).filter(
                        PDFFile.id == doc_id,
                        PDFFile.user_id == current_user.id
                    ).first()
                    if doc_file and doc_file.segments_data:
                        segments = doc_file.segments_data.get("segments", [])
                        if segments:
                            page_texts = {}
                            for seg in segments:
                                text = (seg.get("rag_text") or seg.get("text", "")).strip()
                                if not text:
                                    continue
                                page_num = seg.get("page", 1)
                                if page_num not in page_texts:
                                    page_texts[page_num] = []
                                page_texts[page_num].append(text)
                            
                            if page_texts:
                                doc_content_parts = []
                                for page_num in sorted(page_texts.keys()):
                                    page_content = "\n".join(page_texts[page_num])
                                    doc_content_parts.append(f"[페이지 {page_num}]\n{page_content}")
                                
                                doc_content = "\n\n".join(doc_content_parts)
                                
                                MAX_DOC_CHARS = 20000
                                truncated = ""
                                if len(doc_content) > MAX_DOC_CHARS:
                                    doc_content = doc_content[:MAX_DOC_CHARS]
                                    truncated = "\n\n... (문서가 길어 일부만 포함됨)"
                                
                                viewing_context_text += f"\n\n[현재 문서 전문]{truncated}\n{doc_content}"
                except Exception as e:
                    print(f"[ViewingContext] Failed to load document content: {e}")
    # 선택된 세그먼트를 컨텍스트로 사용
    context = viewing_context_text  # 화면 상태를 컨텍스트 시작에 배치
    rag_used = False
    rag_sources = []
    if request.selected_segments:
        context_parts = []
        total_segments = len(request.selected_segments)
        for seg_index, seg in enumerate(request.selected_segments, start=1):
            if isinstance(seg, dict) and (seg.get("text") or seg.get("raw_text")):
                seg_type = seg.get("type", "Text")
                raw_text = (seg.get("raw_text") or "").strip()
                display_text = (seg.get("text") or "").strip()
                page = seg.get("page")
                page_label = f" (p.{page})" if page else ""
                seg_header = f"[선택된 세그먼트 #{seg_index}/{total_segments}{page_label} — {seg_type}]"

                # 텍스트 계열(Text, List item 등): raw_text와 display_text가 동일하거나 enriched가 없으면 단순 출력
                if not raw_text or raw_text == display_text:
                    context_parts.append(f"{seg_header}\n{display_text or raw_text}")
                else:
                    # Picture, Table, Formula 등: raw_text(원본 추출)와 display_text(AI 설명) 모두 제공
                    context_parts.append(
                        f"{seg_header}\n"
                        f"원본 텍스트:\n{raw_text}\n\n"
                        f"AI 설명:\n{display_text}"
                    )
            elif isinstance(seg, str):
                context_parts.append(f"[선택된 세그먼트 #{seg_index}/{total_segments}]\n{seg}")
        if context_parts:
            segment_text = "\n\n---\n\n".join(context_parts)
            context = (context + "\n\n" + segment_text) if context else segment_text
    
    # ========== MCP / RAG State ==========
    memory_used = False
    llm_tools: Optional[List[dict[str, Any]]] = None
    rag_search_attempted = False

    async def _mcp_execute(server_name: str, tool_name: str, arguments: dict) -> dict:
        from services.mcp_client import get_mcp_client
        client = get_mcp_client()
        result = await client.execute(server_name, tool_name, arguments)
        if result.success:
            if isinstance(result.data, dict):
                return dict(result.data)
            if result.data is None:
                return {}
            return {"result": result.data}
        else:
            return {"error": result.error.message if result.error else "MCP tool execution failed"}

    print(f"[ENDPOINT DEBUG] Creating event_generator for session {session_id}, model_type={ai_service.model_type}, ollama_model={ai_service.ollama_model}")

    async def event_generator():
        nonlocal context, rag_used, rag_sources, rag_search_attempted, llm_tools
        accumulated_content = ""
        final_model = ""
        final_tokens = 0
        tool_audit_results: List[dict[str, Any]] = []

        async def _emit_agent_status(*, status: str, message: str, stage: Optional[str] = None, label: Optional[str] = None, tool_name: Optional[str] = None, server_name: Optional[str] = None, rag_used: Optional[bool] = None, rag_sources: Optional[List[dict[str, Any]]] = None):
            yield _sse_event(
                "agent_status",
                _build_agent_status_payload(
                    status=status,
                    message=message,
                    stage=stage,
                    label=label,
                    tool_name=tool_name,
                    server_name=server_name,
                    rag_used=rag_used,
                    rag_sources=rag_sources,
                ),
            )
        
        try:
            if request.mcp_skills:
                requested_server_names = {
                    str(skill.get("name", "")).strip()
                    for skill in request.mcp_skills
                    if isinstance(skill, dict) and skill.get("name")
                }
                has_skill = any(isinstance(skill, dict) and str(skill.get("server_type", "")).strip() == "skill" for skill in request.mcp_skills)
                has_mcp = any(isinstance(skill, dict) and str(skill.get("server_type", "")).strip() != "skill" for skill in request.mcp_skills)
                status_label = "mcp" if has_mcp else "skill" if has_skill else None

                if requested_server_names:
                    async for event in _emit_agent_status(status="thinking", message="활성화된 MCP/스킬 구성을 확인중입니다...", stage="tool_catalog", label=status_label):
                        yield event
                    try:
                        enabled_servers = (
                            db.query(McpServer)
                            .filter(
                                McpServer.name.in_(list(requested_server_names)),
                                McpServer.enabled.is_(True),
                                McpServer.server_type == "mcp",
                            )
                            .all()
                        )
                        if enabled_servers:
                            server_ids = [server.id for server in enabled_servers]
                            preferences = (
                                db.query(UserMcpPreference)
                                .filter(
                                    UserMcpPreference.user_id == current_user.id,
                                    UserMcpPreference.mcp_server_id.in_(server_ids),
                                )
                                .all()
                            )
                            pref_map = {pref.mcp_server_id: pref.enabled for pref in preferences}
                            allowed_server_names = {
                                server.name
                                for server in enabled_servers
                                if pref_map.get(server.id, True)
                            }

                            if allowed_server_names:
                                from services.mcp_client import get_mcp_client

                                mcp_client = get_mcp_client()
                                catalog_result = await mcp_client.catalog()
                                if catalog_result.success:
                                    catalog_data = catalog_result.data or {}
                                    catalog_tools = catalog_data.get("tools", []) if isinstance(catalog_data, dict) else []
                                    collected_tools: List[dict[str, Any]] = []

                                    for tool in catalog_tools:
                                        if not isinstance(tool, dict):
                                            continue
                                        server_name = str(tool.get("server_name", "")).strip()
                                        tool_name = str(tool.get("name", "")).strip()
                                        if not server_name or not tool_name:
                                            continue
                                        if server_name not in allowed_server_names:
                                            continue

                                        raw_schema = tool.get("input_schema")
                                        parameters = raw_schema if isinstance(raw_schema, dict) else {"type": "object", "properties": {}}
                                        if not isinstance(parameters.get("type"), str):
                                            parameters["type"] = "object"
                                        if parameters.get("type") != "object":
                                            parameters = {"type": "object", "properties": {}}
                                        if not isinstance(parameters.get("properties"), dict):
                                            parameters["properties"] = {}

                                        collected_tools.append(
                                            {
                                                "type": "function",
                                                "function": {
                                                    "name": f"{server_name}__{tool_name}",
                                                    "description": str(tool.get("description", "") or ""),
                                                    "parameters": parameters,
                                                },
                                            }
                                        )

                                    if collected_tools:
                                        llm_tools = collected_tools
                        ready_message = (
                            f"사용 가능한 MCP 도구 {len(llm_tools)}개를 준비했습니다."
                            if llm_tools else
                            "활성화된 도구/스킬 구성을 반영했습니다."
                        )
                        async for event in _emit_agent_status(status="thinking", message=ready_message, stage="tool_catalog_ready", label=status_label):
                            yield event
                    except Exception as catalog_err:
                        print(f"[MCP] Catalog fetch failed (fallback to prompt-only): {catalog_err}")

            if not _skip_rag and request.knowledge_db and request.knowledge_db != "none":
                rag_search_attempted = True
                async for event in _emit_agent_status(status="thinking", message="지식DB에서 관련 문서를 검색중입니다...", stage="rag_search", label="rag"):
                    yield event
                try:
                    kb_id_str = request.knowledge_db
                    if kb_id_str.isdigit():
                        from models.database import KnowledgeDB
                        kb = db.query(KnowledgeDB).filter(
                            KnowledgeDB.id == int(kb_id_str),
                            KnowledgeDB.user_id == current_user.id,
                        ).first()
                        if kb:
                            from services.rag_indexer import search as rag_search
                            rag_results = rag_search(
                                query=request.content,
                                user_id=current_user.id,
                                knowledge_db=f"kb{kb.id}",
                                db=db,
                            )
                            if rag_results:
                                rag_used = True
                                rag_sources = rag_results
                                rag_context_parts = []
                                for r in rag_results:
                                    source_label = f"(출처: {r.get('filename', '알 수 없는 파일')}, p.{r['page']}, 관련도: {round(r['score'] * 100)}%)"
                                    rag_context_parts.append(f"{source_label}\n{r['text']}")
                                rag_context = "\n\n---\n\n".join(rag_context_parts)
                                rag_block = f"[지식 데이터베이스(RAG) 검색 결과]\n{rag_context}"
                                if context:
                                    context = context + "\n\n---\n\n" + rag_block
                                else:
                                    context = rag_block
                                async for event in _emit_agent_status(status="thinking", message=f"지식DB에서 관련 문서 {len(rag_results)}건을 찾았습니다.", stage="rag_ready", label="rag", rag_used=True, rag_sources=rag_results):
                                    yield event
                            else:
                                async for event in _emit_agent_status(status="thinking", message="질문과 충분히 관련된 지식DB 문서를 찾지 못했습니다.", stage="rag_empty", label="rag", rag_used=False, rag_sources=[]):
                                    yield event
                except Exception as rag_err:
                    print(f"[RAG] Search failed (non-blocking): {rag_err}")

            print(f"[CONTEXT DEBUG] include_document_content={request.include_document_content}, selected_segments={len(request.selected_segments) if request.selected_segments else 0}, context_len={len(context) if context else 0}, context_preview={repr(context[:300]) if context else 'None'}")

            combined_tools = llm_tools or []
            synthesis_label = "rag" if rag_used else "memory" if memory_used else None
            async for event in _emit_agent_status(status="thinking", message="수집한 정보를 바탕으로 답변을 정리중입니다...", stage="synthesis", label=synthesis_label):
                yield event
            print(f"[MCP DEBUG] request.mcp_skills={request.mcp_skills}, llm_tools_count={len(combined_tools)}")
            print(f"[STREAM DEBUG] Starting stream for session {session_id}")
            async for chunk in ai_service.generate_response_stream(
                messages_for_ai,
                context,
                images=images_base64,
                mcp_skills=request.mcp_skills,
                editor_command=_effective_editor_command,
                tools=combined_tools,
                mcp_execute_fn=_mcp_execute,
                rag_active=rag_used,
                rag_search_attempted=rag_search_attempted,
                persona_custom_markdown=persona_custom_markdown,
            ):
                event_type = chunk.get("type", "")
                print(f"[STREAM DEBUG] Received chunk: type={event_type}, content_preview={str(chunk)[:100]}")
                
                if event_type == "start":
                    final_model = chunk.get("model", "")
                    yield f"event: start\ndata: {json.dumps(chunk, ensure_ascii=False)}\n\n"
                    
                elif event_type == "delta":
                    accumulated_content += chunk.get("delta", "")
                    yield f"event: delta\ndata: {json.dumps(chunk, ensure_ascii=False)}\n\n"
                    
                elif event_type == "done":
                    accumulated_content = chunk.get("content", accumulated_content)
                    accumulated_content = _strip_non_rag_evidence_footer(
                        accumulated_content,
                        request.content,
                        rag_used,
                    )
                    chunk["content"] = accumulated_content
                    final_tokens = chunk.get("tokens", 0)
                    final_model = chunk.get("model", final_model)
                    # RAG 메타데이터를 done 이벤트에 추가
                    chunk["rag_used"] = rag_used
                    if rag_sources:
                        chunk["rag_sources"] = _serialize_rag_sources(rag_sources)
                    chunk["memory_used"] = memory_used
                    print(f"[STREAM DEBUG] Done - final content length: {len(accumulated_content)}")
                    yield f"event: done\ndata: {json.dumps(chunk, ensure_ascii=False)}\n\n"

                    # ========== Auto-emit edit_proposal after done if editor intent detected ==========
                    if _editor_intent and accumulated_content.strip():
                        proposal_payload = {
                            "type": "edit_proposal",
                            "command": (_effective_editor_command or {}).get("type", "insert"),
                            "content": accumulated_content,
                            "risk_tier": "preview",
                            "revision_hash": (_effective_editor_command or {}).get("revision_hash"),
                        }
                        yield f"event: edit_proposal\ndata: {json.dumps(proposal_payload, ensure_ascii=False)}\n\n"
                elif event_type == "error":
                    print(f"[STREAM DEBUG] Error: {chunk}")
                    yield f"event: error\ndata: {json.dumps(chunk, ensure_ascii=False)}\n\n"
                    return

                elif event_type == "tool_use":
                    yield f"event: tool_use\ndata: {json.dumps(chunk, ensure_ascii=False)}\n\n"

                elif event_type == "tool_result":
                    tool_audit_results.append(
                        {
                            "tool_call_id": chunk.get("tool_call_id"),
                            "server_name": chunk.get("server_name"),
                            "tool_name": chunk.get("tool_name"),
                            "result": chunk.get("result"),
                        }
                    )
                    yield f"event: tool_result\ndata: {json.dumps(chunk, ensure_ascii=False)}\n\n"

                # ========== Editor Proposal Events ==========
                # Forward structured proposal chunks from AI service when editor_command is active
                elif event_type in ("edit_proposal", "rewrite_proposal", "style_proposal", "replace_proposal"):
                    print(f"[STREAM DEBUG] Editor proposal: {event_type}")
                    yield f"event: {event_type}\ndata: {json.dumps(chunk, ensure_ascii=False)}\n\n"
            
            print(f"[STREAM DEBUG] Stream finished, accumulated_content length: {len(accumulated_content)}")
            
            # AI 메시지 DB 저장 (스트림 완료 후)
            if accumulated_content:
                # Build model_metadata for assistant message
                used_config = ai_config.copy()
                used_config["model"] = final_model  # 실제 사용된 모델로 갱신
                
                ai_message = ChatMessage(
                    session_id=session_id,
                    content=accumulated_content,
                    is_user=False,
                    model_used=final_model,
                    tokens_used=final_tokens,
                    model_metadata={
                        "requested": ai_config,
                        "used": used_config,
                        "tokens_used": final_tokens,
                        "rag_used": rag_used,
                        "rag_sources": _serialize_rag_sources(rag_sources),
                        "memory_used": memory_used,
                        "tool_results": tool_audit_results,
                        "hwp_generation": chunk.get("hwp_generation") if isinstance(chunk, dict) else None,
                        "persona": {
                            "default_active": bool((ai_service.persona_default_markdown or "").strip()),
                            "custom_active": bool(persona_custom_markdown),
                        }
                    }
                )
                db.add(ai_message)
                db.commit()
                
                # 세션 업데이트
                session.updated_at = datetime.now()
                db.commit()

                await _maybe_generate_summary_title(db, session)

        except Exception as e:
            print(f"[STREAM DEBUG] Exception: {e}")
            import traceback
            traceback.print_exc()
            error_data = {"type": "error", "message": f"스트리밍 중 오류: {str(e)}"}
            yield f"event: error\ndata: {json.dumps(error_data, ensure_ascii=False)}\n\n"
    
    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no"  # nginx buffering 비활성화
        }
    )


@router.post("/sessions/{session_id}/messages", response_model=dict)
async def send_chat_message(
    session_id: int,
    request: ChatMessageRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """
    채팅 메시지 전송 (비스트리밍 - 레거시)
    - attachment://{id} 토큰이 있으면 이미지를 AI에 전달 (vision 모델 필요)
    - 텍스트만 있으면 기존 방식대로 처리
    """
    session = db.query(ChatSession).filter(
        ChatSession.id == session_id,
        ChatSession.user_id == current_user.id
    ).first()
    
    if not session:
        raise HTTPException(status_code=404, detail={"error_code": "CHATS_SESSION_NOT_FOUND", "message": "채팅 세션을 찾을 수 없습니다"})
    
    # ========== 이미지 첨부 처리 ==========
    attachment_ids = _parse_attachment_ids(request.content)
    images_base64 = []
    
    if attachment_ids:
        # 1) 첨부 개수 제한
        if len(attachment_ids) > MAX_ATTACHMENTS_PER_MESSAGE:
            raise HTTPException(
                status_code=400,
                detail={
                    "error_code": "CHATS_TOO_MANY_ATTACHMENTS",
                    "message": f"이미지 첨부는 최대 {MAX_ATTACHMENTS_PER_MESSAGE}개까지 가능합니다."
                }
            )
        
        # 2) Vision 모델 필수 검사
        if not await _is_vision_capable(db, request.model_override):
            raise HTTPException(
                status_code=400,
                detail={
                    "error_code": "CHATS_VISION_MODEL_REQUIRED",
                    "message": "이미지 첨부 메시지는 비전 모델에서만 지원됩니다. (OpenAI gpt-4o/gpt-4o-mini 또는 Ollama qwen2.5vl:3b/7b)"
                }
            )
        
        # 3) 첨부 파일 로드
        for att_id in attachment_ids:
            img_data = _load_attachment_as_base64(session_id, att_id)
            if img_data:
                images_base64.append(img_data)
        
        # 로드된 이미지가 하나도 없으면 경고 (but 계속 진행)
        if not images_base64 and attachment_ids:
            print(f"[Warning] Could not load any attachments for session {session_id}: {attachment_ids}")
    
    # 현재 AI 설정 스냅샷
    ai_service = get_ai_service(db)
    ai_config = await _apply_model_override(ai_service, db, request.model_override)
    
    # 사용자 설정 한 번에 로드 (메모리, 페르소나 등에서 재사용)
    user_settings = db.query(UserSettings).filter(UserSettings.user_id == current_user.id).first()
    
    # 사용자 커스텀 페르소나 추출
    persona_custom_markdown = _get_user_persona_markdown(user_settings)
    
    # 사용자 메시지 저장
    user_message = ChatMessage(
        session_id=session_id,
        content=request.content,
        is_user=True,
        selected_segments=request.selected_segments,
        attachments=_build_message_attachments(session_id, request.content),
        model_metadata={"requested": ai_config}
    )
    db.add(user_message)
    db.commit()
    await _maybe_set_initial_session_title(db, session, request.content)
    
    # 대화 히스토리 구성 (최근 10개 메시지)
    history_messages = db.query(ChatMessage).filter(
        ChatMessage.session_id == session_id
    ).order_by(ChatMessage.created_at.desc()).limit(10).all()
    
    # 역순으로 정렬 (오래된 것부터)
    history_messages = list(reversed(history_messages))
    
    messages_for_ai = []
    for msg in history_messages:
        messages_for_ai.append({
            "role": "user" if msg.is_user else "assistant",
            "content": msg.content
        })
    
    # 선택된 세그먼트를 컨텍스트로 사용
    context = None
    rag_used_ns = False
    rag_sources_ns = []
    rag_search_attempted_ns = False
    if request.selected_segments:
        context_parts = []
        total_segments = len(request.selected_segments)
        for seg_index, seg in enumerate(request.selected_segments, start=1):
            if isinstance(seg, dict) and seg.get("text"):
                page = seg.get("page")
                seg_type = seg.get("type", "Text")
                page_label = f" (p.{page})" if page else ""
                context_parts.append(f"[선택된 세그먼트 #{seg_index}/{total_segments}{page_label} — {seg_type}]\n{seg['text']}")
            elif isinstance(seg, str):
                context_parts.append(f"[선택된 세그먼트 #{seg_index}/{total_segments}]\n{seg}")
        if context_parts:
            context = "\n\n---\n\n".join(context_parts)
    
    # RAG 검색 (비스트리밍) — KB id 기반
    if request.knowledge_db and request.knowledge_db != "none":
        rag_search_attempted_ns = True
        try:
            kb_id_str = request.knowledge_db
            if kb_id_str.isdigit():
                from models.database import KnowledgeDB
                kb = db.query(KnowledgeDB).filter(
                    KnowledgeDB.id == int(kb_id_str),
                    KnowledgeDB.user_id == current_user.id,
                ).first()
                if kb:
                    from services.rag_indexer import search as rag_search
                    rag_results = rag_search(
                        query=request.content,
                        user_id=current_user.id,
                        knowledge_db=f"kb{kb.id}",
                        db=db,
                    )
                    if rag_results:
                        rag_used_ns = True
                        rag_sources_ns = rag_results
                        # RAG 결과에 출처 메타데이터를 포함하여 LLM이 구분할 수 있도록 포맷
                        rag_context_parts = []
                        for r in rag_results:
                            source_label = f"(출처: {r.get('filename', '알 수 없는 파일')}, p.{r['page']}, 관련도: {round(r['score'] * 100)}%)"
                            rag_context_parts.append(f"{source_label}\n{r['text']}")
                        rag_context = "\n\n---\n\n".join(rag_context_parts)
                        rag_block = f"[지식 데이터베이스(RAG) 검색 결과]\n{rag_context}"
                        if context:
                            context = context + "\n\n---\n\n" + rag_block
                        else:
                            context = rag_block
        except Exception as rag_err:
            print(f"[RAG] Search failed (non-blocking): {rag_err}")
    
    memory_used_ns = False
    # AI 서비스 호출 (이미지가 있으면 함께 전달)
    # 프론트엔드에서 mcpActive 토글이 켜져있을 때만 mcp_skills가 전달됨.

    ai_response = await ai_service.generate_response(
        messages_for_ai,
        context,
        images=images_base64,
        mcp_skills=request.mcp_skills,
        tools=None,
        mcp_execute_fn=None,
        rag_active=rag_used_ns,
        rag_search_attempted=rag_search_attempted_ns,
        persona_custom_markdown=persona_custom_markdown,
    )
    ai_response["content"] = _strip_non_rag_evidence_footer(
        ai_response.get("content", ""),
        request.content,
        rag_used_ns,
    )
    
    # Build model_metadata for assistant message
    used_config = ai_config.copy()
    used_config["model"] = ai_response["model"]  # 실제 사용된 모델로 갱신
    
    # AI 메시지 저장
    ai_message = ChatMessage(
        session_id=session_id,
        content=ai_response["content"],
        is_user=False,
        model_used=ai_response["model"],
        tokens_used=ai_response["tokens"],
        model_metadata={
            "requested": ai_config,
            "used": used_config,
            "tokens_used": ai_response["tokens"],
            "rag_used": rag_used_ns,
            "rag_sources": [
                {"file_id": s["file_id"], "filename": s.get("filename", ""), "page": s["page"], "score": s["score"], "segment_type": s.get("segment_type", ""), "seg_id": s.get("seg_id", "")}
                for s in rag_sources_ns
            ] if rag_sources_ns else [],
            "memory_used": memory_used_ns,
            "hwp_generation": ai_response.get("hwp_generation"),
            "persona": {
                "default_active": bool((ai_service.persona_default_markdown or "").strip()),
                "custom_active": bool(persona_custom_markdown),
            }
        }
    )
    db.add(ai_message)
    db.commit()
    
    # 세션 업데이트
    session.updated_at = datetime.now()
    db.commit()

    await _maybe_generate_summary_title(db, session)
    
    ai_response["rag_used"] = rag_used_ns
    ai_response["memory_used"] = memory_used_ns
    if rag_sources_ns:
        ai_response["rag_sources"] = [
            {"file_id": s["file_id"], "filename": s.get("filename", ""), "page": s["page"], "score": s["score"], "segment_type": s.get("segment_type", ""), "seg_id": s.get("seg_id", "")}
            for s in rag_sources_ns
        ]
    
    return {"message": "메시지 전송 완료", "ai_response": ai_response}


@router.delete("/sessions/{session_id}")
async def delete_chat_session(
    session_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """
    채팅 세션 삭제
    """
    session = db.query(ChatSession).filter(
        ChatSession.id == session_id,
        ChatSession.user_id == current_user.id
    ).first()
    
    if not session:
        raise HTTPException(status_code=404, detail={"error_code": "CHATS_SESSION_NOT_FOUND", "message": "채팅 세션을 찾을 수 없습니다"})
    
    # 첨부파일 폴더 삭제
    attachments_dir = Path(f"/app/DATABASE/attachments/sessions/{session_id}")
    if attachments_dir.exists():
        shutil.rmtree(attachments_dir)
    
    db.delete(session)
    db.commit()
    
    return {"message": "채팅 세션이 삭제되었습니다"}


# ========== 첨부파일 API ==========

@router.post("/sessions/{session_id}/attachments")
async def upload_attachment(
    session_id: int,
    file: UploadFile = File(...),
    metadata: Optional[str] = Form(None),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """
    대화 세션에 첨부파일(이미지) 업로드
    
    업로드 정책:
    - 이미지 MIME 타입만 허용 (image/png, image/jpeg, image/webp, image/gif)
    - 최대 5MB
    - 저장 경로: /app/DATABASE/attachments/sessions/{session_id}/{uuid}_{filename}
    """
    session = db.query(ChatSession).filter(
        ChatSession.id == session_id,
        ChatSession.user_id == current_user.id
    ).first()
    
    if not session:
        raise HTTPException(status_code=404, detail={"error_code": "CHATS_SESSION_NOT_FOUND", "message": "채팅 세션을 찾을 수 없습니다"})
    
    # 1. MIME 타입 검증 (이미지만 허용)
    content_type = (file.content_type or "").lower().split(";")[0].strip()
    if content_type not in ALLOWED_IMAGE_MIMES:
        raise HTTPException(
            status_code=400,
            detail={
                "error_code": "CHATS_INVALID_ATTACHMENT_TYPE",
                "message": f"이미지 파일만 첨부할 수 있습니다. (허용: PNG, JPEG, WebP, GIF)",
                "allowed_mimes": sorted(ALLOWED_IMAGE_MIMES),
            }
        )
    
    # 2. 파일 크기 검증
    content = await file.read()
    if len(content) > MAX_ATTACHMENT_SIZE_BYTES:
        max_mb = MAX_ATTACHMENT_SIZE_BYTES // (1024 * 1024)
        raise HTTPException(
            status_code=413,
            detail={
                "error_code": "CHATS_ATTACHMENT_TOO_LARGE",
                "message": f"첨부 파일 크기가 {max_mb}MB를 초과합니다.",
            }
        )
    
    # 저장 디렉토리 생성
    attachments_dir = Path(f"/app/DATABASE/attachments/sessions/{session_id}")
    attachments_dir.mkdir(parents=True, exist_ok=True)
    
    # 파일 저장
    file_id = str(uuid.uuid4())[:8]
    safe_filename = f"{file_id}_{file.filename}"
    file_path = attachments_dir / safe_filename
    
    with open(file_path, "wb") as f:
        f.write(content)

    attachment_metadata = None
    if metadata:
        try:
            parsed_metadata = json.loads(metadata)
        except json.JSONDecodeError:
            raise HTTPException(status_code=400, detail={"error_code": "CHATS_INVALID_ATTACHMENT_METADATA", "message": "첨부 메타데이터 형식이 올바르지 않습니다"})

        if parsed_metadata is not None and not isinstance(parsed_metadata, dict):
            raise HTTPException(status_code=400, detail={"error_code": "CHATS_INVALID_ATTACHMENT_METADATA", "message": "첨부 메타데이터는 객체여야 합니다"})

        if isinstance(parsed_metadata, dict):
            attachment_metadata = {
                "filename": file.filename,
                "size": len(content),
                "mime_type": content_type,
                "reference": _normalize_attachment_reference(parsed_metadata.get("reference")),
            }
            _get_attachment_metadata_path(session_id, file_id).write_text(
                json.dumps(attachment_metadata, ensure_ascii=False),
                encoding="utf-8",
            )
    
    return {
        "attachment_id": file_id,
        "filename": file.filename,
        "path": str(file_path),
        "size": len(content),
        "mime_type": content_type,
        "reference": attachment_metadata.get("reference") if attachment_metadata else None,
    }


@router.get("/sessions/{session_id}/attachments/{attachment_id}")
async def get_attachment(
    session_id: int,
    attachment_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """
    첨부파일 다운로드
    """
    session = db.query(ChatSession).filter(
        ChatSession.id == session_id,
        ChatSession.user_id == current_user.id
    ).first()
    
    if not session:
        raise HTTPException(status_code=404, detail={"error_code": "CHATS_SESSION_NOT_FOUND", "message": "채팅 세션을 찾을 수 없습니다"})
    
    attachments_dir = Path(f"/app/DATABASE/attachments/sessions/{session_id}")
    
    # attachment_id로 시작하는 파일 찾기
    matching_files = list(attachments_dir.glob(f"{attachment_id}_*"))
    
    if not matching_files:
        raise HTTPException(status_code=404, detail={"error_code": "CHATS_ATTACHMENT_NOT_FOUND", "message": "첨부파일을 찾을 수 없습니다"})
    
    file_path = matching_files[0]
    original_filename = file_path.name[len(attachment_id) + 1:]  # {id}_ 제거
    
    return FastAPIFileResponse(
        path=str(file_path),
        filename=original_filename
    )


@router.delete("/sessions/{session_id}/attachments/{attachment_id}")
async def delete_attachment(
    session_id: int,
    attachment_id: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """
    첨부파일 삭제
    """
    session = db.query(ChatSession).filter(
        ChatSession.id == session_id,
        ChatSession.user_id == current_user.id
    ).first()
    
    if not session:
        raise HTTPException(status_code=404, detail={"error_code": "CHATS_SESSION_NOT_FOUND", "message": "채팅 세션을 찾을 수 없습니다"})
    
    attachments_dir = Path(f"/app/DATABASE/attachments/sessions/{session_id}")
    matching_files = list(attachments_dir.glob(f"{attachment_id}_*"))
    
    if not matching_files:
        raise HTTPException(status_code=404, detail={"error_code": "CHATS_ATTACHMENT_NOT_FOUND", "message": "첨부파일을 찾을 수 없습니다"})
    
    matching_files[0].unlink()
    metadata_path = _get_attachment_metadata_path(session_id, attachment_id)
    if metadata_path.exists():
        metadata_path.unlink()
    
    return {"message": "첨부파일이 삭제되었습니다"}
