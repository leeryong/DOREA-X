# System Settings Routes (Admin)

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel, Field
from typing import Optional, Literal
import httpx
import re

from api.deps import get_current_user
from models.database import get_db, User, UserRole, SystemSetting
from config import settings as app_settings
from services.embedding_service import (
    DEFAULT_EMBEDDING_MODEL,
    get_available_embedding_model_names,
    is_embedding_model_available,
    is_supported_embedding_model,
    resolve_embedding_model,
)
from services.ollama_runtime import keep_ollama_model_warm, unload_ollama_model

router = APIRouter(prefix="/api/settings", tags=["Settings"])


def _require_admin(user: User):
    if user.role not in (UserRole.ADMIN, UserRole.SUPER_ADMIN):
        raise HTTPException(
            status_code=403,
            detail={"error_code": "SETTINGS_FORBIDDEN", "message": "관리자 권한이 필요합니다"},
        )


def _get_setting(db: Session, key: str, default: str, description: str | None = None) -> str:
    row = db.query(SystemSetting).filter(SystemSetting.key == key).first()
    if not row:
        row = SystemSetting(key=key, value=str(default), description=description)
        db.add(row)
        db.commit()
    return row.value


def _find_setting(db: Session, key: str) -> str | None:
    row = db.query(SystemSetting).filter(SystemSetting.key == key).first()
    if not row:
        return None
    return row.value


def _set_setting(db: Session, key: str, value: str, updated_by: int | None = None, description: str | None = None):
    row = db.query(SystemSetting).filter(SystemSetting.key == key).first()
    if not row:
        row = SystemSetting(key=key, value=value, description=description, updated_by=updated_by)
        db.add(row)
    else:
        row.value = value
        row.updated_by = updated_by
        if description is not None:
            row.description = description
    db.commit()


def _parse_bool(value: str) -> bool:
    return str(value).strip().lower() in {"1", "true", "yes", "y", "on"}


class DocumentAnalysisSystemSettings(BaseModel):
    provider: Literal["opendataloader"] = Field("opendataloader")
    opendataloader_use_ocr: bool = Field(True)
    opendataloader_ocr_language: str = Field("ko", min_length=2, max_length=10)
    opendataloader_kids_merge: bool = Field(False, description="분석 처리 시 Kids 컴포넌트를 하나의 세그먼트로 처리합니다")


class DocumentAnalysisSystemSettingsUpdate(BaseModel):
    opendataloader_use_ocr: bool | None = None
    opendataloader_ocr_language: str | None = Field(None, min_length=2, max_length=10)
    opendataloader_kids_merge: bool | None = None


@router.get("/system/analysis-provider")
async def get_current_analysis_provider(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """현재 문서 분석 provider 조회 (DOREA-XP는 opendataloader 고정)"""
    return {"provider": "opendataloader"}


@router.get("/system/document-analysis", response_model=DocumentAnalysisSystemSettings)
async def get_system_document_analysis_settings(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _require_admin(current_user)

    opendataloader_use_ocr = _parse_bool(
        _get_setting(db, "document_analysis.opendataloader.ocr.enabled", "true", "Enable OpenDataLoader OCR")
    )
    opendataloader_ocr_language = _get_setting(
        db,
        "document_analysis.opendataloader.ocr.language",
        "ko",
        "OpenDataLoader OCR language (ISO code)",
    )
    opendataloader_kids_merge = _parse_bool(
        _get_setting(db, "document_analysis.opendataloader.kids_merge", "false", "OpenDataLoader kids merge mode")
    )

    return DocumentAnalysisSystemSettings(
        provider="opendataloader",
        opendataloader_use_ocr=opendataloader_use_ocr,
        opendataloader_ocr_language=opendataloader_ocr_language,
        opendataloader_kids_merge=opendataloader_kids_merge,
    )


@router.put("/system/document-analysis", response_model=DocumentAnalysisSystemSettings)
async def update_system_document_analysis_settings(
    payload: DocumentAnalysisSystemSettingsUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _require_admin(current_user)

    allowed_languages = {"ko", "en", "ja", "zh"}

    if payload.opendataloader_use_ocr is not None:
        _set_setting(
            db,
            "document_analysis.opendataloader.ocr.enabled",
            "true" if payload.opendataloader_use_ocr else "false",
            updated_by=current_user.id,
            description="Enable OpenDataLoader OCR",
        )

    if payload.opendataloader_ocr_language is not None:
        lang = payload.opendataloader_ocr_language.strip().lower()
        if lang not in allowed_languages:
            raise HTTPException(
                status_code=400,
                detail={
                    "error_code": "SETTINGS_INVALID_OCR_LANGUAGE",
                    "message": f"지원하지 않는 OpenDataLoader OCR 언어입니다: {lang}",
                    "allowed": sorted(list(allowed_languages)),
                },
            )
        _set_setting(
            db,
            "document_analysis.opendataloader.ocr.language",
            lang,
            updated_by=current_user.id,
            description="OpenDataLoader OCR language (ISO code)",
        )

    if payload.opendataloader_kids_merge is not None:
        _set_setting(
            db,
            "document_analysis.opendataloader.kids_merge",
            "true" if payload.opendataloader_kids_merge else "false",
            updated_by=current_user.id,
            description="OpenDataLoader kids merge mode",
        )

    return await get_system_document_analysis_settings(db=db, current_user=current_user)


# ========== AI Model Settings ==========

AIProvider = Literal["openai", "claude", "ollama"]
EmbeddingModelName = Literal["bge-m3", "text-embedding-3-small", "text-embedding-3-large"]

DEFAULT_OPENAI_MODEL = "gpt-5.4"
DEFAULT_CLAUDE_MODEL = ""
_OPENAI_SELECTOR_PRIORITY = (
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.4-nano",
)


def _normalize_ai_provider(model_type: str | None) -> AIProvider:
    normalized = (model_type or "").strip().lower()
    legacy_map = {
        "paid": "openai",
        "free": "ollama",
    }
    normalized = legacy_map.get(normalized, normalized)
    if normalized == "openai":
        return "openai"
    if normalized == "claude":
        return "claude"
    return "ollama"


def _provider_label(provider: AIProvider) -> str:
    if provider == "openai":
        return "OpenAI"
    if provider == "claude":
        return "Claude"
    return "Ollama"


def _format_openai_model_label(model_name: str) -> str:
    normalized = (model_name or "").strip()
    lower = normalized.lower()
    match = re.fullmatch(r"gpt-(\d+)(?:\.(\d+))?(?:-(mini|nano))?", lower)
    if match:
        major = match.group(1)
        minor = match.group(2)
        tier = match.group(3)
        label = f"GPT-{major}"
        if minor:
            label += f".{minor}"
        if tier:
            label += f" {tier.capitalize()}"
        return label

    reasoning_match = re.fullmatch(r"(o\d)(?:-(mini|nano))?", lower)
    if reasoning_match:
        label = reasoning_match.group(1).upper()
        tier = reasoning_match.group(2)
        if tier:
            label += f" {tier.capitalize()}"
        return label

    if lower == "chatgpt-4o-latest":
        return "ChatGPT-4o Latest"

    return normalized or "(미설정)"


def _format_claude_model_label(model_name: str) -> str:
    normalized = (model_name or "").strip()
    lower = normalized.lower()
    match = re.fullmatch(r"claude-(haiku|sonnet|opus)-(\d+)-(\d{1,2})(?:-\d+)?", lower)
    if match:
        family = match.group(1).capitalize()
        major = match.group(2)
        minor = match.group(3)
        return f"Claude {family} {major}.{minor}"

    latest_match = re.fullmatch(r"claude-(haiku|sonnet|opus)-latest", lower)
    if latest_match:
        return f"Claude {latest_match.group(1).capitalize()} Latest"

    return normalized or "(미설정)"


def _format_provider_model_display_name(provider: AIProvider, model_name: str) -> str:
    if not model_name:
        return f"{_provider_label(provider)} (미설정)"
    if provider == "openai":
        return _format_openai_model_label(model_name)
    if provider == "claude":
        return _format_claude_model_label(model_name)
    return f"Ollama {model_name.strip()}"


class AIModelSettings(BaseModel):
    model_type: AIProvider = "ollama"
    openai_api_key: Optional[str] = None
    openai_model: Optional[str] = DEFAULT_OPENAI_MODEL
    claude_api_key: Optional[str] = None
    claude_model: Optional[str] = DEFAULT_CLAUDE_MODEL or None
    ollama_model: Optional[str] = None
    embedding_model: EmbeddingModelName = DEFAULT_EMBEDDING_MODEL
    available_embedding_models: list[EmbeddingModelName] = Field(default_factory=lambda: [DEFAULT_EMBEDDING_MODEL])
    # Common
    temperature: float = Field(0.7, ge=0.0, le=2.0)
    max_tokens: int = Field(4000, ge=100, le=128000)
    # Persona
    persona_default_markdown: str = ""


class AIModelSettingsUpdate(BaseModel):
    model_type: Optional[AIProvider] = None
    openai_api_key: Optional[str] = None
    openai_model: Optional[str] = None
    claude_api_key: Optional[str] = None
    claude_model: Optional[str] = None
    ollama_model: Optional[str] = None
    embedding_model: Optional[EmbeddingModelName] = None
    temperature: Optional[float] = Field(None, ge=0.0, le=2.0)
    max_tokens: Optional[int] = Field(None, ge=100, le=128000)
    persona_default_markdown: Optional[str] = Field(None, max_length=4000)


class ProviderKeyValidationRequest(BaseModel):
    api_key: str


class ProviderKeyValidationResponse(BaseModel):
    valid: bool
    message: str
    models: list[str] = []


class ChatModelOption(BaseModel):
    type: AIProvider
    provider: str
    model: str
    display_name: str
    configured: bool = True
    vision_capable: bool = True


def _parse_openai_gpt5_version(model_name: str) -> tuple[int, int] | None:
    normalized = (model_name or "").strip().lower()
    if not normalized.startswith("gpt-5"):
        return None

    match = re.match(r"^gpt-(\d+)(?:\.(\d+))?", normalized)
    if not match:
        return None

    major = int(match.group(1))
    minor = int(match.group(2) or 0)
    return (major, minor)


def _is_supported_openai_model(model_name: str) -> bool:
    version = _parse_openai_gpt5_version(model_name)
    if version is None:
        return False
    return version >= (5, 3)


def _is_supported_openai_chat_model(model_name: str) -> bool:
    normalized = (model_name or "").strip().lower()
    if not normalized:
        return False
    if any(token in normalized for token in ("embedding", "audio", "realtime", "transcribe", "tts", "moderation", "search")):
        return False
    if not _is_supported_openai_model(normalized):
        return False
    return _is_openai_vision_model(normalized)


def _sort_openai_selector_models(models: list[str]) -> list[str]:
    deduped: list[str] = []
    seen: set[str] = set()
    for model in models:
        normalized = (model or "").strip()
        if not normalized:
            continue
        model_key = normalized.lower()
        if model_key in seen or not _is_supported_openai_model(model_key):
            continue
        seen.add(model_key)
        deduped.append(normalized)

    priority_map = {name: index for index, name in enumerate(_OPENAI_SELECTOR_PRIORITY)}
    return sorted(
        deduped,
        key=lambda model: (priority_map.get(model.lower(), len(priority_map)), model.lower()),
    )


def _sort_openai_chat_models(models: list[str]) -> list[str]:
    deduped: list[str] = []
    seen: set[str] = set()
    for model in models:
        normalized = (model or "").strip()
        if not normalized:
            continue
        model_key = normalized.lower()
        if model_key in seen or not _is_supported_openai_chat_model(model_key):
            continue
        seen.add(model_key)
        deduped.append(normalized)

    priority_prefixes = (
        "gpt-5.4",
        "gpt-5",
        "gpt-4.1",
        "gpt-4o",
        "o4",
        "o3",
        "o1",
        "chatgpt-4o",
    )

    def _priority(model: str) -> tuple[int, str]:
        lower = model.lower()
        for index, prefix in enumerate(priority_prefixes):
            if lower.startswith(prefix):
                return (index, lower)
        return (len(priority_prefixes), lower)

    return sorted(deduped, key=_priority)


def _is_supported_claude_model(model_name: str) -> bool:
    normalized = (model_name or "").strip().lower()
    if not normalized.startswith("claude"):
        return False
    return any(family in normalized for family in ("haiku", "sonnet", "opus"))


def _claude_family(model_name: str) -> str | None:
    normalized = (model_name or "").strip().lower()
    for family in ("haiku", "sonnet", "opus"):
        if family in normalized:
            return family
    return None


def _claude_model_rank(model_name: str) -> tuple[int, int, int, tuple[int, ...], str]:
    normalized = (model_name or "").strip().lower()
    numeric_parts = tuple(int(part) for part in re.findall(r"\d+", normalized))
    canonical_alias = bool(re.fullmatch(r"claude-(haiku|sonnet|opus)-\d+-\d{1,2}", normalized))
    dated_revision = bool(re.search(r"-20\d{6,}$", normalized))
    return (
        1 if canonical_alias else 0,
        0 if dated_revision else 1,
        1 if "latest" in normalized else 0,
        numeric_parts,
        normalized,
    )


def _sort_claude_selector_models(models: list[str]) -> list[str]:
    grouped: dict[str, list[str]] = {"haiku": [], "sonnet": [], "opus": []}
    seen: set[str] = set()
    for model in models:
        normalized = (model or "").strip()
        if not normalized:
            continue
        model_key = normalized.lower()
        if model_key in seen or not _is_supported_claude_model(model_key):
            continue
        seen.add(model_key)
        family = _claude_family(model_key)
        if family:
            grouped[family].append(normalized)

    selected: list[str] = []
    for family in ("haiku", "sonnet", "opus"):
        candidates = grouped.get(family, [])
        if not candidates:
            continue
        selected.append(max(candidates, key=_claude_model_rank))
    return selected


async def _fetch_openai_chat_models(api_key: str) -> list[str]:
    api_key = (api_key or "").strip()
    if not api_key:
        return []

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            response = await client.get(
                "https://api.openai.com/v1/models",
                headers={"Authorization": f"Bearer {api_key}"},
            )
        if response.status_code != 200:
            return []
        data = response.json()
        return _sort_openai_chat_models([m.get("id", "") for m in data.get("data", []) if isinstance(m, dict)])
    except Exception:
        return []


async def _fetch_claude_chat_models(api_key: str) -> list[str]:
    api_key = (api_key or "").strip()
    if not api_key:
        return []

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            response = await client.get(
                "https://api.anthropic.com/v1/models",
                params={"limit": 100},
                headers={
                    "x-api-key": api_key,
                    "anthropic-version": "2023-06-01",
                    "content-type": "application/json",
                },
            )
        if response.status_code != 200:
            return []
        data = response.json()
        return _sort_claude_selector_models([m.get("id", "") for m in data.get("data", []) if isinstance(m, dict)])
    except Exception:
        return []


async def _fetch_ollama_chat_models() -> list[dict[str, object]]:
    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            response = await client.get(f"{app_settings.ollama_url}/api/tags")
            response.raise_for_status()
            data = response.json()
            raw_models = data.get("models", [])
            import asyncio
            vision_results = await asyncio.gather(*[
                _check_ollama_vision_capable(str(model.get("name", "")).strip())
                for model in raw_models
            ])
    except Exception:
        return []

    available: list[dict[str, object]] = []
    for model, is_vision in zip(raw_models, vision_results):
        name = str(model.get("name", "")).strip()
        if not name or not is_vision:
            continue
        available.append({
            "type": "ollama",
            "provider": "Ollama",
            "model": name,
            "display_name": _format_provider_model_display_name("ollama", name),
            "configured": True,
            "vision_capable": True,
        })
    return available


async def _resolve_chat_model_options(db: Session) -> list[ChatModelOption]:
    openai_api_key = _get_setting(db, "ai.openai.api_key", "", "OpenAI API Key")
    claude_api_key = _get_setting(db, "ai.claude.api_key", "", "Claude API Key")

    import asyncio

    openai_models, claude_models, ollama_models = await asyncio.gather(
        _fetch_openai_chat_models(openai_api_key),
        _fetch_claude_chat_models(claude_api_key),
        _fetch_ollama_chat_models(),
    )

    options: list[ChatModelOption] = []
    for model_name in openai_models:
        options.append(ChatModelOption(
            type="openai",
            provider="OpenAI",
            model=model_name,
            display_name=_format_provider_model_display_name("openai", model_name),
            configured=True,
            vision_capable=True,
        ))

    for model_name in claude_models:
        options.append(ChatModelOption(
            type="claude",
            provider="Claude",
            model=model_name,
            display_name=_format_provider_model_display_name("claude", model_name),
            configured=True,
            vision_capable=True,
        ))

    for model in ollama_models:
        options.append(ChatModelOption(**model))

    return options



@router.get("/system/ai-model", response_model=AIModelSettings)
async def get_ai_model_settings(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """AI 모델 설정 조회"""
    _require_admin(current_user)

    model_type = _normalize_ai_provider(
        _get_setting(db, "ai.model_type", "ollama", "AI model provider (openai/claude/ollama)")
    )
    openai_api_key = _get_setting(db, "ai.openai.api_key", "", "OpenAI API Key")
    openai_model = _get_setting(db, "ai.openai.model", DEFAULT_OPENAI_MODEL, "OpenAI model name")
    claude_api_key = _get_setting(db, "ai.claude.api_key", "", "Claude API Key")
    claude_model = _get_setting(db, "ai.claude.model", DEFAULT_CLAUDE_MODEL, "Claude model name")
    ollama_model = _get_setting(db, "ai.ollama.model", "", "Ollama model name")
    embedding_model = resolve_embedding_model(
        _get_setting(db, "ai.embedding.model", DEFAULT_EMBEDDING_MODEL, "Document embedding model name"),
        openai_api_key,
    )
    temperature = float(_get_setting(db, "ai.temperature", "0.7", "AI temperature"))
    max_tokens = int(_get_setting(db, "ai.max_tokens", "4000", "AI max tokens"))

    persona_default_markdown = _get_setting(db, "ai.persona.default_markdown", "", "Admin default persona markdown")

    return AIModelSettings(
        model_type=model_type,
        openai_api_key=openai_api_key if openai_api_key else None,
        openai_model=openai_model,
        claude_api_key=claude_api_key if claude_api_key else None,
        claude_model=claude_model if claude_model else None,
        ollama_model=ollama_model if ollama_model else None,
        embedding_model=embedding_model,
        available_embedding_models=get_available_embedding_model_names(openai_api_key),
        temperature=temperature,
        max_tokens=max_tokens,
        persona_default_markdown=persona_default_markdown,
    )


@router.put("/system/ai-model", response_model=AIModelSettings)
async def update_ai_model_settings(
    payload: AIModelSettingsUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """AI 모델 설정 저장"""
    _require_admin(current_user)

    prev_model_type = _normalize_ai_provider(
        _get_setting(db, "ai.model_type", "ollama", "AI model provider (openai/claude/ollama)")
    )
    prev_ollama_model = _get_setting(db, "ai.ollama.model", "", "Ollama model name").strip()
    current_openai_api_key = _get_setting(db, "ai.openai.api_key", "", "OpenAI API Key")
    next_openai_api_key = payload.openai_api_key if payload.openai_api_key is not None else current_openai_api_key

    if payload.model_type is not None:
        _set_setting(db, "ai.model_type", payload.model_type, current_user.id, "AI model provider (openai/claude/ollama)")

    if payload.openai_api_key is not None:
        _set_setting(db, "ai.openai.api_key", payload.openai_api_key, current_user.id, "OpenAI API Key")

    if payload.openai_model is not None:
        if not _is_supported_openai_model(payload.openai_model):
            raise HTTPException(
                status_code=400,
                detail={
                    "error_code": "SETTINGS_INVALID_OPENAI_MODEL",
                    "message": f"지원하지 않는 OpenAI 모델입니다: {payload.openai_model}",
                    "allowed": ["gpt-5.3+ multimodal"],
                },
            )
        _set_setting(db, "ai.openai.model", payload.openai_model, current_user.id, "OpenAI model name")

    if payload.claude_api_key is not None:
        _set_setting(db, "ai.claude.api_key", payload.claude_api_key, current_user.id, "Claude API Key")

    if payload.claude_model is not None:
        if payload.claude_model and not _is_supported_claude_model(payload.claude_model):
            raise HTTPException(
                status_code=400,
                detail={
                    "error_code": "SETTINGS_INVALID_CLAUDE_MODEL",
                    "message": f"지원하지 않는 Claude 모델입니다: {payload.claude_model}",
                    "allowed": ["latest haiku", "latest sonnet", "latest opus"],
                },
            )
        _set_setting(db, "ai.claude.model", payload.claude_model, current_user.id, "Claude model name")

    if payload.ollama_model is not None:
        _set_setting(db, "ai.ollama.model", payload.ollama_model, current_user.id, "Ollama model name")

    if payload.embedding_model is not None:
        if not is_supported_embedding_model(payload.embedding_model):
            raise HTTPException(
                status_code=400,
                detail={
                    "error_code": "SETTINGS_INVALID_EMBEDDING_MODEL",
                    "message": f"지원하지 않는 임베딩 모델입니다: {payload.embedding_model}",
                    "allowed": list(get_available_embedding_model_names(next_openai_api_key)),
                },
            )
        if not is_embedding_model_available(payload.embedding_model, next_openai_api_key):
            raise HTTPException(
                status_code=400,
                detail={
                    "error_code": "SETTINGS_EMBEDDING_MODEL_UNAVAILABLE",
                    "message": "OpenAI API Key가 활성화되어야 OpenAI 임베딩 모델을 사용할 수 있습니다",
                    "allowed": list(get_available_embedding_model_names(next_openai_api_key)),
                },
            )
        _set_setting(db, "ai.embedding.model", payload.embedding_model, current_user.id, "Document embedding model name")
    elif payload.openai_api_key is not None:
        resolved_embedding_model = resolve_embedding_model(
            _get_setting(db, "ai.embedding.model", DEFAULT_EMBEDDING_MODEL, "Document embedding model name"),
            next_openai_api_key,
        )
        _set_setting(db, "ai.embedding.model", resolved_embedding_model, current_user.id, "Document embedding model name")

    if payload.temperature is not None:
        _set_setting(db, "ai.temperature", str(payload.temperature), current_user.id, "AI temperature")

    if payload.max_tokens is not None:
        _set_setting(db, "ai.max_tokens", str(payload.max_tokens), current_user.id, "AI max tokens")

    if payload.persona_default_markdown is not None:
        _set_setting(
            db,
            "ai.persona.default_markdown",
            payload.persona_default_markdown.strip(),
            current_user.id,
            "Admin default persona markdown",
        )

    next_model_type = _normalize_ai_provider(
        _get_setting(db, "ai.model_type", "ollama", "AI model provider (openai/claude/ollama)")
    )
    next_ollama_model = _get_setting(db, "ai.ollama.model", "", "Ollama model name").strip()

    # Ollama runtime control (best-effort, non-blocking)
    # - free 선택 시 모델 warm 유지
    # - paid 선택 시 기존 Ollama 모델 unload
    # - free + 모델 변경 시 이전 모델 unload 후 신규 모델 warm
    try:
        if next_model_type == "ollama" and next_ollama_model:
            if prev_ollama_model and prev_ollama_model != next_ollama_model:
                await unload_ollama_model(prev_ollama_model)
            await keep_ollama_model_warm(next_ollama_model, app_settings.ollama_keepalive_duration)
        elif next_model_type != "ollama" and prev_ollama_model:
            await unload_ollama_model(prev_ollama_model)
    except Exception as e:
        print(f"[AIModelSettings] Ollama runtime sync failed (non-blocking): {e}")

    return await get_ai_model_settings(db=db, current_user=current_user)


# ========== Vision Capability Detection ==========

# OpenAI models known to support vision (image input)
# OpenAI API does not expose a capabilities flag, so we use prefix matching.
# Exact-match set: legacy models that support vision but don't match prefixes
_OPENAI_VISION_EXACT = {
    "gpt-4-turbo", "gpt-4-turbo-2024-04-09",
}
# Prefix-match tuple: modern model families where all variants support vision
_OPENAI_VISION_PREFIXES = (
    "gpt-4o",      # gpt-4o, gpt-4o-mini, gpt-4o-2024-*
    "gpt-4.1",     # gpt-4.1, gpt-4.1-mini, gpt-4.1-nano
    "gpt-4.5",     # gpt-4.5-preview, etc.
    "gpt-5",       # gpt-5, gpt-5.2, gpt-5-mini, etc.
    "o1", "o3", "o4",  # o-series reasoning models (vision capable)
    "chatgpt-4o",  # chatgpt-4o-latest
)

def _is_openai_vision_model(model_name: str) -> bool:
    """OpenAI 모델명이 vision을 지원하는지 판별 (prefix + exact match)"""
    if not model_name:
        return False
    model_lower = model_name.lower().strip()
    if model_lower in _OPENAI_VISION_EXACT:
        return True
    return model_lower.startswith(_OPENAI_VISION_PREFIXES)


def _is_claude_vision_model(model_name: str) -> bool:
    return _is_supported_claude_model(model_name)

# Backward-compat alias used by chats.py import
OPENAI_VISION_MODELS = _OPENAI_VISION_EXACT  # kept for reference, not used for checks


async def _check_ollama_vision_capable(model_name: str) -> bool:
    """
    Ollama /api/show를 호출해 모델의 capabilities에 'vision'이 있는지 확인.
    실패 시 False 반환 (fail-safe, non-blocking).
    """
    if not model_name:
        return False
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.post(
                f"{app_settings.ollama_url}/api/show",
                json={"model": model_name},
            )
            resp.raise_for_status()
            data = resp.json()
            capabilities = data.get("capabilities", [])
            return "vision" in capabilities
    except Exception as e:
        print(f"[Vision] Ollama /api/show lookup failed for '{model_name}' (fallback=false): {e}")
        return False


async def _check_ollama_model_exists(model_name: str) -> bool:
    """
    Ollama /api/show 가 200이면 모델이 설치돼 있다고 판단.
    vision 여부와 무관 — 텍스트 전용 모델도 채팅에 쓸 수 있어야 하므로
    채팅 모델 선택 검증에는 이 함수를 쓴다 (vision 검증은 이미지 첨부 시점에만).
    """
    if not model_name:
        return False
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.post(
                f"{app_settings.ollama_url}/api/show",
                json={"model": model_name},
            )
            return resp.status_code == 200
    except Exception as e:
        print(f"[Ollama] /api/show lookup failed for '{model_name}': {e}")
        return False


async def _resolve_vision_capable(model_type: str, openai_model: str, claude_model: str, ollama_model: str) -> bool:
    """현재 설정된 모델의 vision 지원 여부를 provider별로 판별"""
    if model_type == "openai":
        return _is_openai_vision_model(openai_model)
    if model_type == "claude":
        return _is_claude_vision_model(claude_model)
    return await _check_ollama_vision_capable(ollama_model)


class CurrentAIModelResponse(BaseModel):
    type: str  # "openai" | "claude" | "ollama"
    provider: str  # "OpenAI" | "Claude" | "Ollama"
    model: str  # model name
    display_name: str  # e.g., "OpenAI gpt-4o" or "Ollama llama3"
    configured: bool  # whether API key / model is set
    vision_capable: bool = False  # whether the model supports image input


class ChatModelOptionsResponse(BaseModel):
    current: CurrentAIModelResponse
    models: list[ChatModelOption] = []


@router.get("/system/ai-model/current", response_model=CurrentAIModelResponse)
async def get_current_ai_model(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """현재 설정된 AI 모델 정보 조회 (일반 사용자도 접근 가능)"""
    model_type = _normalize_ai_provider(
        _get_setting(db, "ai.model_type", "ollama", "AI model provider (openai/claude/ollama)")
    )
    openai_api_key = _get_setting(db, "ai.openai.api_key", "", "OpenAI API Key")
    openai_model = _get_setting(db, "ai.openai.model", DEFAULT_OPENAI_MODEL, "OpenAI model name")
    claude_api_key = _get_setting(db, "ai.claude.api_key", "", "Claude API Key")
    claude_model = _get_setting(db, "ai.claude.model", DEFAULT_CLAUDE_MODEL, "Claude model name")
    ollama_model = _get_setting(db, "ai.ollama.model", "", "Ollama model name")

    vision = await _resolve_vision_capable(model_type, openai_model, claude_model, ollama_model)

    if model_type == "openai":
        return CurrentAIModelResponse(
            type="openai",
            provider="OpenAI",
            model=openai_model,
            display_name=_format_provider_model_display_name("openai", openai_model),
            configured=bool(openai_api_key),
            vision_capable=vision,
        )
    if model_type == "claude":
        return CurrentAIModelResponse(
            type="claude",
            provider="Claude",
            model=claude_model or "(미설정)",
            display_name=_format_provider_model_display_name("claude", claude_model),
            configured=bool(claude_api_key and claude_model),
            vision_capable=vision,
        )
    return CurrentAIModelResponse(
        type="ollama",
        provider="Ollama",
        model=ollama_model or "(미설정)",
        display_name=_format_provider_model_display_name("ollama", ollama_model),
        configured=bool(ollama_model),
        vision_capable=vision,
    )


@router.get("/system/ai-model/options", response_model=ChatModelOptionsResponse)
async def get_chat_model_options(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    current = await get_current_ai_model(db=db, current_user=current_user)
    options = await _resolve_chat_model_options(db)

    current_key = (current.type, current.model)
    if current.configured and current.vision_capable and not any((option.type, option.model) == current_key for option in options):
        options.insert(0, ChatModelOption(
            type=current.type,
            provider=current.provider,
            model=current.model,
            display_name=current.display_name,
            configured=current.configured,
            vision_capable=current.vision_capable,
        ))

    return ChatModelOptionsResponse(current=current, models=options)


@router.post("/system/ai-model/validate-openai-key", response_model=ProviderKeyValidationResponse)
async def validate_openai_api_key(
    payload: ProviderKeyValidationRequest,
    current_user: User = Depends(get_current_user),
):
    """OpenAI API Key 검증"""
    _require_admin(current_user)

    api_key = payload.api_key.strip()
    if not api_key:
        return ProviderKeyValidationResponse(valid=False, message="API Key를 입력해주세요")

    if not api_key.startswith("sk-"):
        return ProviderKeyValidationResponse(valid=False, message="올바른 OpenAI API Key 형식이 아닙니다")

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            response = await client.get(
                "https://api.openai.com/v1/models",
                headers={"Authorization": f"Bearer {api_key}"}
            )

            if response.status_code == 401:
                return ProviderKeyValidationResponse(valid=False, message="유효하지 않은 API Key입니다")
            
            if response.status_code == 429:
                return ProviderKeyValidationResponse(valid=False, message="API 요청 한도를 초과했습니다")

            if response.status_code != 200:
                return ProviderKeyValidationResponse(valid=False, message=f"OpenAI API 오류: {response.status_code}")

            data = response.json()
            models = _sort_openai_selector_models([m["id"] for m in data.get("data", [])])

            if not models:
                return ProviderKeyValidationResponse(
                    valid=False,
                    message="API Key는 유효하지만 사용할 수 있는 GPT-5.3 이상 멀티모달 모델이 없습니다",
                )
            
            return ProviderKeyValidationResponse(
                valid=True,
                message="API Key가 유효합니다. 사용 가능한 GPT-5.3 이상 멀티모달 모델 목록을 불러왔습니다",
                models=models,
            )

    except httpx.ConnectError:
        return ProviderKeyValidationResponse(valid=False, message="OpenAI API에 연결할 수 없습니다")
    except Exception as e:
        return ProviderKeyValidationResponse(valid=False, message=f"검증 오류: {str(e)}")


@router.post("/system/ai-model/validate-claude-key", response_model=ProviderKeyValidationResponse)
async def validate_claude_api_key(
    payload: ProviderKeyValidationRequest,
    current_user: User = Depends(get_current_user),
):
    """Claude API Key 검증"""
    _require_admin(current_user)

    api_key = payload.api_key.strip()
    if not api_key:
        return ProviderKeyValidationResponse(valid=False, message="API Key를 입력해주세요")

    if not api_key.startswith("sk-ant-"):
        return ProviderKeyValidationResponse(valid=False, message="올바른 Claude API Key 형식이 아닙니다")

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            response = await client.get(
                "https://api.anthropic.com/v1/models",
                params={"limit": 100},
                headers={
                    "x-api-key": api_key,
                    "anthropic-version": "2023-06-01",
                    "content-type": "application/json",
                },
            )

        if response.status_code == 401:
            return ProviderKeyValidationResponse(valid=False, message="유효하지 않은 Claude API Key입니다")
        if response.status_code == 402:
            return ProviderKeyValidationResponse(valid=False, message="Claude API 결제 또는 크레딧 상태를 확인해주세요")
        if response.status_code == 403:
            return ProviderKeyValidationResponse(valid=False, message="Claude API 접근 권한이 없습니다")
        if response.status_code == 429:
            return ProviderKeyValidationResponse(valid=False, message="Claude API 요청 한도를 초과했습니다")
        if response.status_code != 200:
            return ProviderKeyValidationResponse(valid=False, message=f"Claude API 오류: {response.status_code}")

        data = response.json()
        models = _sort_claude_selector_models([m.get("id", "") for m in data.get("data", []) if isinstance(m, dict)])
        if not models:
                return ProviderKeyValidationResponse(
                    valid=False,
                    message="API Key는 유효하지만 사용할 수 있는 최신 Haiku/Sonnet/Opus 모델이 없습니다",
                )

        return ProviderKeyValidationResponse(
            valid=True,
            message="API Key가 유효합니다. 최신 Claude Haiku/Sonnet/Opus 모델 목록을 불러왔습니다",
            models=models,
        )
    except httpx.ConnectError:
        return ProviderKeyValidationResponse(valid=False, message="Claude API에 연결할 수 없습니다")
    except Exception as e:
        return ProviderKeyValidationResponse(valid=False, message=f"검증 오류: {str(e)}")


# ========== RAG Settings ==========

class RAGSettings(BaseModel):
    top_k: int = Field(3, ge=1, le=20, description="검색 결과 수")
    min_similarity: float = Field(0.3, ge=0.0, le=1.0, description="최소 유사도 임계값")
    chunk_size: int = Field(1200, ge=100, le=10000, description="청크 크기 (문자)")
    chunk_overlap: int = Field(180, ge=0, le=2000, description="청크 겹침 (문자)")
    embedding_model: str = Field("", description="임베딩 모델 (읽기전용, AI provider에 따라 자동 결정)")


class RAGSettingsUpdate(BaseModel):
    top_k: Optional[int] = Field(None, ge=1, le=20)
    min_similarity: Optional[float] = Field(None, ge=0.0, le=1.0)
    chunk_size: Optional[int] = Field(None, ge=100, le=10000)
    chunk_overlap: Optional[int] = Field(None, ge=0, le=2000)


@router.get("/system/rag", response_model=RAGSettings)
async def get_rag_settings(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """RAG 설정 조회 (일반 사용자도 읽기 가능)"""
    top_k = int(_get_setting(db, "rag.top_k", "3", "RAG 검색 결과 수"))
    min_similarity = float(_get_setting(db, "rag.min_similarity", "0.3", "RAG 최소 유사도"))
    chunk_size = int(_get_setting(db, "rag.chunk_size", "1200", "RAG 청크 크기"))
    chunk_overlap = int(_get_setting(db, "rag.chunk_overlap", "180", "RAG 청크 겹침"))

    # 임베딩 모델: AI provider 설정에 따라 자동 결정
    from services.embedding_service import get_model_name
    embedding_model = get_model_name()

    return RAGSettings(
        top_k=top_k,
        min_similarity=min_similarity,
        chunk_size=chunk_size,
        chunk_overlap=chunk_overlap,
        embedding_model=embedding_model,
    )


@router.put("/system/rag", response_model=RAGSettings)
async def update_rag_settings(
    payload: RAGSettingsUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """RAG 설정 저장 (관리자 전용)"""
    _require_admin(current_user)

    if payload.top_k is not None:
        _set_setting(db, "rag.top_k", str(payload.top_k), current_user.id, "RAG 검색 결과 수")
    if payload.min_similarity is not None:
        _set_setting(db, "rag.min_similarity", str(payload.min_similarity), current_user.id, "RAG 최소 유사도")
    if payload.chunk_size is not None:
        _set_setting(db, "rag.chunk_size", str(payload.chunk_size), current_user.id, "RAG 청크 크기")
    if payload.chunk_overlap is not None:
        _set_setting(db, "rag.chunk_overlap", str(payload.chunk_overlap), current_user.id, "RAG 청크 겹침")

    return await get_rag_settings(db=db, current_user=current_user)


# ========== Upload Policy (Read-Only) ==========

class UploadPolicyResponse(BaseModel):
    max_file_size_mb: int = Field(100, description="최대 파일 크기 (MB)")
    max_queued_files: int = Field(100, description="사용자당 동시 처리 대기 최대 수")
    max_upload_size_bytes: int = Field(100 * 1024 * 1024, description="최대 파일 크기 (Bytes)")
    max_queued_files_per_user: int = Field(100, description="사용자당 동시 처리 대기 최대 수(호환)")
    allowed_extensions: list[str] = Field(default_factory=list, description="허용 확장자 목록")


@router.get("/system/upload-policy", response_model=UploadPolicyResponse)
async def get_upload_policy(
    current_user: User = Depends(get_current_user),
):
    """업로드 정책 조회 (모든 사용자 읽기 가능, 수정 불가)"""
    from api.files import ALLOWED_EXTENSIONS, MAX_UPLOAD_SIZE_BYTES, MAX_QUEUED_FILES_PER_USER
    return UploadPolicyResponse(
        max_file_size_mb=MAX_UPLOAD_SIZE_BYTES // (1024 * 1024),
        max_queued_files=MAX_QUEUED_FILES_PER_USER,
        max_upload_size_bytes=MAX_UPLOAD_SIZE_BYTES,
        max_queued_files_per_user=MAX_QUEUED_FILES_PER_USER,
        allowed_extensions=sorted(ALLOWED_EXTENSIONS.keys()),
    )


# ========== 사용자별 빠른 메뉴 (Quick Actions) ==========
import json

MAX_QUICK_ACTIONS = 3
MAX_VISIBLE_QUICK_ACTIONS = 3


class QuickActionItem(BaseModel):
    id: str = Field(..., min_length=1, max_length=50, description="고유 ID (예: 'expand')")
    label: str = Field(..., min_length=1, max_length=10, description="버튼 텍스트 (예: '확장')")
    caption: str = Field("", max_length=100, description="설명 (툴팁)")
    prompt: str = Field(..., min_length=1, max_length=500, description="LLM에 보낼 프롬프트")
    visible: bool = Field(True, description="세그먼트 선택 시 버튼 표시 여부")


class QuickActionsResponse(BaseModel):
    actions: list[QuickActionItem] = Field(description="사용자 빠른 메뉴 통합 목록")


class QuickActionsUpdate(BaseModel):
    actions: list[QuickActionItem] = Field(..., max_length=MAX_QUICK_ACTIONS)


DEFAULT_QUICK_ACTIONS = [
    {"id": "summarize", "label": "요약", "caption": "선택한 내용을 요약", "prompt": "선택한 내용을 간결하게 요약해주세요.", "visible": True},
    {"id": "analyze", "label": "분석", "caption": "핵심 포인트 분석", "prompt": "선택한 내용을 분석하고 핵심 포인트를 정리해주세요.", "visible": True},
    {"id": "translate", "label": "번역", "caption": "한국어로 번역", "prompt": "선택한 내용을 한국어로 번역해주세요.", "visible": True},
]


def _normalize_quick_actions(raw_actions: list) -> list[dict]:
    """저장된 quick-actions JSON을 안전한 shape로 정규화"""
    normalized: list[dict] = []
    for raw in raw_actions or []:
        if not isinstance(raw, dict):
            continue
        try:
            item = QuickActionItem(
                id=str(raw.get("id", "")).strip(),
                label=str(raw.get("label", "")).strip(),
                caption=str(raw.get("caption", "")).strip(),
                prompt=str(raw.get("prompt", "")).strip(),
                visible=bool(raw.get("visible", True)),
            )
            normalized.append(item.model_dump())
        except Exception:
            continue
    return normalized


def _cap_visible_quick_actions(actions: list[dict]) -> list[dict]:
    """visible=true를 최대 MAX_VISIBLE_QUICK_ACTIONS로 제한(초과분 false)"""
    visible_count = 0
    result: list[dict] = []
    for action in actions:
        cloned = dict(action)
        if cloned.get("visible"):
            visible_count += 1
            if visible_count > MAX_VISIBLE_QUICK_ACTIONS:
                cloned["visible"] = False
        result.append(cloned)
    return result


@router.get("/user/quick-actions", response_model=QuickActionsResponse)
async def get_quick_actions(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """사용자별 빠른 메뉴 조회"""
    key = f"quick_actions.user_{current_user.id}"
    raw = _get_setting(db, key, "[]", "사용자 빠른 메뉴")
    try:
        parsed = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        parsed = []

    if not isinstance(parsed, list):
        parsed = []

    # old-format 호환: custom-only 저장([id,label,caption,prompt])이면 defaults를 앞에 병합
    is_old_format = len(parsed) > 0 and all(isinstance(a, dict) and "visible" not in a for a in parsed)
    if is_old_format:
        actions = [*DEFAULT_QUICK_ACTIONS, *_normalize_quick_actions(parsed)]
    else:
        actions = _normalize_quick_actions(parsed)

    # 빈 값이면 기본 3개로 초기화
    if not actions:
        actions = [dict(a) for a in DEFAULT_QUICK_ACTIONS]

    # 최대 개수/visible 제한 보정
    actions = actions[:MAX_QUICK_ACTIONS]
    actions = _cap_visible_quick_actions(actions)

    # 정규화/마이그레이션 결과를 저장
    _set_setting(db, key, json.dumps(actions, ensure_ascii=False), current_user.id, "사용자 빠른 메뉴")

    return QuickActionsResponse(
        actions=[QuickActionItem(**a) for a in actions],
    )


@router.put("/user/quick-actions", response_model=QuickActionsResponse)
async def update_quick_actions(
    payload: QuickActionsUpdate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """사용자별 빠른 메뉴 저장 (통합 목록)"""
    if len(payload.actions) > MAX_QUICK_ACTIONS:
        raise HTTPException(
            status_code=400,
            detail={
                "error_code": "SETTINGS_QUICK_ACTIONS_LIMIT",
                "message": f"빠른 메뉴는 최대 {MAX_QUICK_ACTIONS}개까지 저장할 수 있습니다."
            }
        )

    # ID 중복 검사
    ids = [a.id for a in payload.actions]
    if len(ids) != len(set(ids)):
        raise HTTPException(
            status_code=400,
            detail={"error_code": "SETTINGS_QUICK_ACTION_DUPLICATE_ID", "message": "메뉴 ID가 중복됩니다."}
        )

    visible_count = sum(1 for a in payload.actions if a.visible)
    if visible_count > MAX_VISIBLE_QUICK_ACTIONS:
        raise HTTPException(
            status_code=400,
            detail={
                "error_code": "SETTINGS_QUICK_ACTION_VISIBLE_LIMIT",
                "message": f"보이기 메뉴는 최대 {MAX_VISIBLE_QUICK_ACTIONS}개까지 설정할 수 있습니다."
            }
        )

    key = f"quick_actions.user_{current_user.id}"
    data = [a.model_dump() for a in payload.actions]
    _set_setting(db, key, json.dumps(data, ensure_ascii=False), current_user.id, "사용자 빠른 메뉴")

    return QuickActionsResponse(
        actions=[QuickActionItem(**d) for d in data],
    )


@router.post("/user/quick-actions/reset", response_model=QuickActionsResponse)
async def reset_quick_actions(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """사용자 빠른 메뉴를 기본 3개(요약/분석/번역)로 초기화"""
    key = f"quick_actions.user_{current_user.id}"
    actions = [dict(a) for a in DEFAULT_QUICK_ACTIONS]
    _set_setting(db, key, json.dumps(actions, ensure_ascii=False), current_user.id, "사용자 빠른 메뉴")
    return QuickActionsResponse(actions=[QuickActionItem(**a) for a in actions])
