from importlib import import_module
import time
from typing import Any, Dict, List, Optional, Tuple

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from api.deps import get_current_user
from models.database import McpServer, User, UserMcpPreference, UserRole, get_db
from services.audit_service import audit_event
from services.mcp_contract import (
    MCP_CONFIG_ALLOWED_COMMANDS,
    MCP_CONFIG_ALLOWED_KEYS,
    MCP_CONFIG_INVALID,
    MCP_EXECUTE_FAILED,
    MCP_FORBIDDEN,
    MCP_SECRET_INVALID,
    MCP_UNAVAILABLE,
    MCP_USER_DISABLED,
)

router = APIRouter(prefix="/api/mcp", tags=["MCP"])


def _get_settings() -> Any:
    config_module = import_module("config")
    return getattr(config_module, "settings")


async def _push_mcp_config_to_service(db: Any):
    """Push all enabled MCP server configs to mcp-service. Fire-and-forget."""
    try:
        import httpx
        from services.mcp_secret import decrypt_secret
        from models.database import SystemSetting

        settings = _get_settings()
        enabled_servers = db.query(McpServer).filter(
            McpServer.enabled.is_(True),
            McpServer.server_type == "mcp",
            McpServer.config_json.isnot(None),
        ).all()

        configure_payload = []
        for srv in enabled_servers:
            cfg = srv.config_json or {}
            env = {}
            for env_key in cfg.get("env_keys", []):
                secret_row = db.query(SystemSetting).filter(
                    SystemSetting.key == f"mcp.secret.{srv.name}.{env_key}"
                ).first()
                if secret_row and secret_row.value:
                    try:
                        env[env_key] = decrypt_secret(secret_row.value)
                    except Exception:
                        pass
            configure_payload.append({
                "name": srv.name,
                "command": cfg.get("command", "uvx"),
                "args": cfg.get("args", []),
                "env": env,
                "timeout_seconds": cfg.get("timeout_seconds", 30),
            })

        async with httpx.AsyncClient(timeout=10) as client:
            await client.post(
                f"{settings.mcp_service_url}/servers/configure",
                json={"servers": configure_payload},
            )
    except Exception as e:
        print(f"[MCP] Config push to mcp-service failed (non-blocking): {e}")


# ========== Basic Rate Limit (v1 guardrail) ==========
# In-memory per-process limiter. Good enough for single-node docker compose.
_RATE_LIMIT_WINDOW_SECONDS: int = 60
_RATE_LIMIT_MAX_CALLS: int = 30
_rate_limit_buckets: Dict[Tuple[int, str], List[float]] = {}


def _enforce_rate_limit(user_id: int, bucket: str):
    now = time.monotonic()
    key = (user_id, bucket)
    timestamps = _rate_limit_buckets.get(key, [])
    cutoff = now - _RATE_LIMIT_WINDOW_SECONDS
    timestamps = [t for t in timestamps if t >= cutoff]
    if len(timestamps) >= _RATE_LIMIT_MAX_CALLS:
        raise HTTPException(
            status_code=429,
            detail={"error_code": "RATE_LIMITED", "message": "요청이 너무 많습니다. 잠시 후 다시 시도해주세요"},
        )
    timestamps.append(now)
    _rate_limit_buckets[key] = timestamps


def _require_admin(user: User):
    if user.role not in (UserRole.ADMIN, UserRole.SUPER_ADMIN):
        raise HTTPException(
            status_code=403,
            detail={"error_code": MCP_FORBIDDEN, "message": "관리자 권한이 필요합니다"},
        )


class McpServerResponse(BaseModel):
    id: int
    name: str
    display_name: str
    description: Optional[str] = None
    server_type: str
    icon: Optional[str] = None
    transport: Optional[str] = None
    endpoint_url: Optional[str] = None
    enabled: bool
    is_default: bool
    sort_order: int
    config_json: Optional[dict] = None
    user_enabled: Optional[bool] = None
    secret_configured: bool = False
    readiness: str = "ready"


class McpServerCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)
    display_name: str = Field(..., min_length=1, max_length=200)
    description: Optional[str] = None
    server_type: str = Field("mcp", pattern="^(mcp|skill)$")
    icon: Optional[str] = None
    transport: Optional[str] = None
    endpoint_url: Optional[str] = None
    enabled: bool = True
    is_default: bool = False
    sort_order: int = 0
    config_json: Optional[dict] = None


class McpServerUpdate(BaseModel):
    display_name: Optional[str] = Field(None, min_length=1, max_length=200)
    description: Optional[str] = None
    server_type: Optional[str] = Field(None, pattern="^(mcp|skill)$")
    icon: Optional[str] = None
    transport: Optional[str] = None
    endpoint_url: Optional[str] = None
    enabled: Optional[bool] = None
    sort_order: Optional[int] = None
    config_json: Optional[dict] = None


class UserMcpPreferenceUpdate(BaseModel):
    enabled: bool


class McpExecuteRequest(BaseModel):
    server_id: int
    tool: str
    arguments: Optional[dict] = None


class McpSecretUpdate(BaseModel):
    """Accept dict of env_key→value pairs (multi-key)."""
    secrets: dict = Field(..., min_length=1)  # {"ENV_KEY": "value", ...}


class McpSecretKeyStatus(BaseModel):
    configured: bool
    masked: Optional[str] = None


class McpSecretStatusResponse(BaseModel):
    configured: bool  # True only if ALL required env_keys have values
    keys: dict = {}  # {"ENV_KEY": McpSecretKeyStatus, ...}


def _normalize_config_json(config: Optional[dict]) -> Optional[dict]:
    """Normalize friendly aliases in admin-pasted config JSON.

    Supported aliases:
    - env (object) -> env_keys (array of keys only)
    - timeout -> timeout_seconds
    """
    if config is None:
        return None
    if not isinstance(config, dict):
        raise HTTPException(
            status_code=400,
            detail={"error_code": MCP_CONFIG_INVALID, "message": "config_json은 객체(JSON object)여야 합니다"},
        )

    normalized = dict(config)

    # Accept client-style env map and convert it to env_keys schema.
    if "env" in normalized:
        env_value = normalized.pop("env")
        inferred_keys: List[str] = []
        if isinstance(env_value, dict):
            inferred_keys = [str(k) for k in env_value.keys() if str(k).strip()]
        elif isinstance(env_value, list):
            inferred_keys = [str(k) for k in env_value if str(k).strip()]

        existing = normalized.get("env_keys")
        existing_keys = existing if isinstance(existing, list) else []
        merged = []
        for key in [*existing_keys, *inferred_keys]:
            if key not in merged:
                merged.append(key)
        if merged:
            normalized["env_keys"] = merged

    # Accept timeout alias.
    if "timeout" in normalized and "timeout_seconds" not in normalized:
        normalized["timeout_seconds"] = normalized.pop("timeout")

    return normalized


def _validate_config_json(config: Optional[dict]) -> None:
    if config is None:
        return

    unknown = set(config.keys()) - MCP_CONFIG_ALLOWED_KEYS
    if unknown:
        raise HTTPException(
            status_code=400,
            detail={
                "error_code": MCP_CONFIG_INVALID,
                "message": f"허용되지 않는 설정 키: {', '.join(sorted(unknown))}",
            },
        )

    if "command" in config:
        if config["command"] not in MCP_CONFIG_ALLOWED_COMMANDS:
            raise HTTPException(
                status_code=400,
                detail={
                    "error_code": MCP_CONFIG_INVALID,
                    "message": f"허용되지 않는 명령어: {config['command']}",
                },
            )

    if "args" in config and not isinstance(config["args"], list):
        raise HTTPException(
            status_code=400,
            detail={
                "error_code": MCP_CONFIG_INVALID,
                "message": "args는 문자열 배열이어야 합니다",
            },
        )


def _is_secret_configured(db: Any, server: McpServer) -> bool:
    """True if at least one env_key has a valid secret stored."""
    from models.database import SystemSetting
    from services.mcp_secret import decrypt_secret

    config = server.config_json or {}
    env_keys = config.get("env_keys", [])
    if not env_keys:
        return False
    for env_key in env_keys:
        key = f"mcp.secret.{server.name}.{env_key}"
        row = db.query(SystemSetting).filter(SystemSetting.key == key).first()
        if row and row.value:
            try:
                decrypt_secret(row.value)
                return True
            except Exception:
                continue
    return False


def _all_secrets_configured(db: Any, server: McpServer) -> bool:
    """True only if ALL env_keys have valid secrets."""
    from models.database import SystemSetting
    from services.mcp_secret import decrypt_secret

    config = server.config_json or {}
    env_keys = config.get("env_keys", [])
    if not env_keys:
        return True  # no secrets required
    for env_key in env_keys:
        key = f"mcp.secret.{server.name}.{env_key}"
        row = db.query(SystemSetting).filter(SystemSetting.key == key).first()
        if not row or not row.value:
            return False
        try:
            decrypt_secret(row.value)
        except Exception:
            return False
    return True


def _requires_secret(server: McpServer) -> bool:
    config = server.config_json or {}
    env_keys = config.get("env_keys")
    return bool(env_keys)


def _compute_readiness(server: McpServer, secret_configured: bool) -> str:
    if not server.enabled:
        return "disabled"
    if _requires_secret(server) and not secret_configured:
        return "not_ready"
    return "ready"


def _to_server_response(db: Any, server: McpServer, user_enabled: Optional[bool] = None) -> McpServerResponse:
    secret_configured = _is_secret_configured(db, server)
    return McpServerResponse(
        id=server.id,
        name=server.name,
        display_name=server.display_name,
        description=server.description,
        server_type=server.server_type,
        icon=server.icon,
        transport=server.transport,
        endpoint_url=server.endpoint_url,
        config_json=server.config_json,
        enabled=server.enabled,
        is_default=server.is_default,
        sort_order=server.sort_order,
        user_enabled=user_enabled,
        secret_configured=secret_configured,
        readiness=_compute_readiness(server, secret_configured),
    )


@router.get("/servers", response_model=List[McpServerResponse])
async def list_mcp_servers(
    server_type: Optional[str] = Query(None, pattern="^(mcp|skill)$"),
    db: Any = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _require_admin(current_user)

    query = db.query(McpServer)
    if server_type is not None:
        query = query.filter(McpServer.server_type == server_type)

    servers = query.order_by(McpServer.sort_order.asc()).all()
    return [_to_server_response(db, server) for server in servers]




@router.get("/servers/me", response_model=List[McpServerResponse])
async def list_my_mcp_servers(
    db: Any = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    servers = (
        db.query(McpServer)
        .filter(McpServer.enabled.is_(True))
        .order_by(McpServer.sort_order.asc())
        .all()
    )

    if not servers:
        return []

    server_ids = [server.id for server in servers]
    preferences = (
        db.query(UserMcpPreference)
        .filter(
            UserMcpPreference.user_id == current_user.id,
            UserMcpPreference.mcp_server_id.in_(server_ids),
        )
        .all()
    )
    pref_map = {pref.mcp_server_id: pref.enabled for pref in preferences}

    return [_to_server_response(db, server, user_enabled=pref_map.get(server.id, True)) for server in servers]


@router.put("/preferences/{server_id}", response_model=McpServerResponse)
async def update_user_mcp_preference(
    server_id: int,
    payload: UserMcpPreferenceUpdate,
    db: Any = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    _enforce_rate_limit(current_user.id, "mcp_preference")
    server = (
        db.query(McpServer)
        .filter(McpServer.id == server_id, McpServer.enabled.is_(True))
        .first()
    )
    if not server:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "MCP_NOT_FOUND", "message": "MCP 서버를 찾을 수 없습니다"},
        )

    preference = (
        db.query(UserMcpPreference)
        .filter(
            UserMcpPreference.user_id == current_user.id,
            UserMcpPreference.mcp_server_id == server_id,
        )
        .first()
    )

    if preference:
        preference.enabled = payload.enabled
    else:
        preference = UserMcpPreference(
            user_id=current_user.id,
            mcp_server_id=server_id,
            enabled=payload.enabled,
        )
        db.add(preference)

    db.commit()
    audit_event(
        "mcp",
        "MCP_USER_TOGGLE",
        current_user.id,
        {"server_id": server_id, "enabled": payload.enabled},
    )
    return _to_server_response(db, server, user_enabled=payload.enabled)


@router.post("/execute")
async def execute_mcp_tool(
    payload: McpExecuteRequest,
    db: Any = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Execute MCP tool if server/user gates pass."""

    _enforce_rate_limit(current_user.id, "mcp_execute")

    server = (
        db.query(McpServer)
        .filter(McpServer.id == payload.server_id, McpServer.enabled.is_(True))
        .first()
    )
    if not server:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "MCP_NOT_FOUND", "message": "MCP 서버를 찾을 수 없습니다"},
        )

    preference = (
        db.query(UserMcpPreference)
        .filter(
            UserMcpPreference.user_id == current_user.id,
            UserMcpPreference.mcp_server_id == server.id,
        )
        .first()
    )
    user_enabled = preference.enabled if preference is not None else True
    if not user_enabled:
        audit_event(
            "mcp",
            "MCP_EXECUTE_ATTEMPT_DENIED",
            current_user.id,
            {"server_id": payload.server_id, "tool": payload.tool, "error_code": MCP_USER_DISABLED},
        )
        raise HTTPException(
            status_code=403,
            detail={"error_code": MCP_USER_DISABLED, "message": "사용자 설정에서 비활성화된 MCP/Skill 입니다"},
        )

    from services.mcp_client import get_mcp_client

    client = get_mcp_client()
    result = await client.execute(server_name=server.name, tool=payload.tool, arguments=payload.arguments or {})
    if not result.success:
        error_code = result.error.error_code if result.error else MCP_EXECUTE_FAILED
        message = result.error.message if result.error else "MCP 도구 실행 실패"
        audit_event(
            "mcp",
            "MCP_EXECUTE_FAILED",
            current_user.id,
            {"server_id": payload.server_id, "tool": payload.tool, "error_code": error_code},
        )
        raise HTTPException(status_code=502, detail={"error_code": error_code, "message": message})

    audit_event(
        "mcp",
        "MCP_EXECUTE_SUCCESS",
        current_user.id,
        {"server_id": payload.server_id, "tool": payload.tool},
    )
    return result.data


@router.put("/servers/{server_id}/secret")
async def update_mcp_secret(
    server_id: int,
    payload: McpSecretUpdate,
    db: Any = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Save multiple env secrets: payload.secrets = {"ENV_KEY": "value", ...}"""
    _require_admin(current_user)

    server = db.query(McpServer).filter(McpServer.id == server_id).first()
    if not server:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "MCP_NOT_FOUND", "message": "MCP 서버를 찾을 수 없습니다"},
        )

    # Validate: only accept keys listed in config_json.env_keys
    config = server.config_json or {}
    allowed_keys = set(config.get("env_keys", []))
    if not allowed_keys:
        raise HTTPException(
            status_code=400,
            detail={"error_code": MCP_CONFIG_INVALID, "message": "이 서버는 env_keys가 설정되지 않았습니다"},
        )
    unknown = set(payload.secrets.keys()) - allowed_keys
    if unknown:
        raise HTTPException(
            status_code=400,
            detail={"error_code": MCP_SECRET_INVALID, "message": f"허용되지 않는 키: {', '.join(sorted(unknown))}"},
        )

    from models.database import SystemSetting
    from services.mcp_secret import encrypt_secret

    saved_count = 0
    for env_key, value in payload.secrets.items():
        if not value or not value.strip():
            continue
        db_key = f"mcp.secret.{server.name}.{env_key}"
        encrypted = encrypt_secret(value.strip())
        row = db.query(SystemSetting).filter(SystemSetting.key == db_key).first()
        if row:
            row.value = encrypted
            row.updated_by = current_user.id
        else:
            row = SystemSetting(
                key=db_key,
                value=encrypted,
                description=f"Encrypted {env_key} for MCP: {server.name}",
                updated_by=current_user.id,
            )
            db.add(row)
        saved_count += 1

    db.commit()
    audit_event("mcp", "MCP_SECRET_UPDATE", current_user.id, {
        "server_id": server_id, "server_name": server.name, "keys_updated": saved_count,
    })

    # 키가 1개라도 있으면 자동 활성화, 전부 없으면 자동 비활성화
    # (DOREA-XP는 사용자가 enabled를 직접 토글하는 UI를 두지 않으므로 secret 기준으로 결정)
    any_ready = _is_secret_configured(db, server)
    if any_ready and not server.enabled:
        server.enabled = True
        db.commit()
    elif not any_ready and server.enabled:
        server.enabled = False
        db.commit()

    # Push updated config to mcp-service so it can use the new secrets
    if server.server_type == "mcp":
        await _push_mcp_config_to_service(db)

    return {"message": f"{saved_count}개 키가 저장되었습니다"}


@router.get("/servers/{server_id}/secret-status", response_model=McpSecretStatusResponse)
async def get_mcp_secret_status(
    server_id: int,
    db: Any = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Return per-key status for all env_keys of this server."""
    _require_admin(current_user)

    server = db.query(McpServer).filter(McpServer.id == server_id).first()
    if not server:
        raise HTTPException(
            status_code=404,
            detail={"error_code": "MCP_NOT_FOUND", "message": "MCP 서버를 찾을 수 없습니다"},
        )

    from models.database import SystemSetting
    from services.mcp_secret import decrypt_secret, mask_secret

    config = server.config_json or {}
    env_keys = config.get("env_keys", [])
    keys_status = {}
    all_configured = True

    for env_key in env_keys:
        db_key = f"mcp.secret.{server.name}.{env_key}"
        row = db.query(SystemSetting).filter(SystemSetting.key == db_key).first()
        if row and row.value:
            try:
                plaintext = decrypt_secret(row.value)
                keys_status[env_key] = {"configured": True, "masked": mask_secret(plaintext)}
                continue
            except Exception:
                pass
        keys_status[env_key] = {"configured": False, "masked": None}
        all_configured = False

    return McpSecretStatusResponse(configured=all_configured, keys=keys_status)


@router.get("/health")
async def mcp_health(
    current_user: User = Depends(get_current_user),
):
    _require_admin(current_user)

    try:
        mcp_client_module = import_module("services.mcp_client")
        get_mcp_client = getattr(mcp_client_module, "get_mcp_client", None)
    except Exception:
        get_mcp_client = None

    if get_mcp_client is None:
        return JSONResponse(
            status_code=503,
            content={
                "success": False,
                "error": {
                    "error_code": MCP_UNAVAILABLE,
                    "message": "MCP 클라이언트가 설정되지 않았습니다",
                },
            },
        )

    try:
        client = get_mcp_client()
        result = await client.health()
        if hasattr(result, "model_dump"):
            result = result.model_dump()
        if isinstance(result, dict):
            if result.get("success") is False:
                return JSONResponse(status_code=503, content=result)
            return result
        return JSONResponse(
            status_code=503,
            content={
                "success": False,
                "error": {
                    "error_code": MCP_UNAVAILABLE,
                    "message": "MCP 헬스체크 응답 형식이 올바르지 않습니다",
                },
            },
        )
    except Exception:
        return JSONResponse(
            status_code=503,
            content={
                "success": False,
                "error": {
                    "error_code": MCP_UNAVAILABLE,
                    "message": "MCP 서비스 상태를 확인할 수 없습니다",
                },
            },
        )
