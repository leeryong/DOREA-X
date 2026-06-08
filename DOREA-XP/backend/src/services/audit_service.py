import json
from typing import Any, Dict


_SENSITIVE_KEYS = {
    "password",
    "secret",
    "token",
    "api_key",
    "apikey",
    "authorization",
    "openai_key",
    "personal_api_key",
    "jwt",
}


def mask_secret(value: Any) -> Any:
    if not isinstance(value, str):
        return "***REDACTED***"
    v = value.strip()
    if len(v) <= 8:
        return "***REDACTED***"
    return v[:4] + "****" + v[-4:]


def redact(obj: Any) -> Any:
    """Recursively redact common secret fields from dict/list structures."""

    if isinstance(obj, dict):
        out: Dict[str, Any] = {}
        for k, v in obj.items():
            key = str(k)
            if key.lower() in _SENSITIVE_KEYS or any(s in key.lower() for s in ("secret", "token", "key", "password")):
                out[key] = mask_secret(v)
            else:
                out[key] = redact(v)
        return out
    if isinstance(obj, list):
        return [redact(v) for v in obj]
    return obj


def audit_event(category: str, action: str, user_id: int, details: Any):
    """Structured audit event to stdout (container logs)."""

    payload = {
        "category": category,
        "action": action,
        "user_id": user_id,
        "details": redact(details),
    }
    print("[AUDIT] " + json.dumps(payload, ensure_ascii=True, separators=(",", ":")))
