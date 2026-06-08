"""
MCP Runtime Contract -- Backend <-> mcp-service Communication

Architecture:

    +----------+     /api/mcp/*     +---------+    streamable-http    +--------------+
    | Frontend | -----------------> | Backend | -------------------> | mcp-service  |
    +----------+                    +---------+                      +--------------+

    - Backend is the SOLE caller of mcp-service.
    - Frontend NEVER calls mcp-service directly.
    - All MCP interactions go through backend /api/mcp/* endpoints.
    - v1 scope: catalog listing + per-user tool toggle management.
      Tool execution (/execute) is reserved and gated for future use.
    - Default MCP servers: Fetch + DuckDuckGo (free, no API key required).
"""

from enum import Enum as PyEnum
from typing import Optional, Any, List

from pydantic import BaseModel, Field


# ========== Transport ==========

MCP_TRANSPORT: str = "streamable-http"
"""MCP transport protocol. Only streamable-http is supported in v1."""


# ========== Timeout Policy ==========

MCP_TIMEOUT_SECONDS: int = 30
"""
Default timeout (seconds) for backend -> mcp-service HTTP calls.
Override via settings.mcp_timeout_seconds (env: MCP_TIMEOUT_SECONDS).
"""

MCP_HEALTH_TIMEOUT_SECONDS: int = 5
"""Shorter timeout for /health probes."""


# ========== Endpoint Constants ==========

MCP_ENDPOINT_HEALTH: str = "/health"
"""Health check endpoint. Returns service liveness status."""

MCP_ENDPOINT_CATALOG: str = "/catalog"
"""Lists all available MCP tools from connected servers."""

MCP_ENDPOINT_EXECUTE: str = "/execute"
"""
Reserved endpoint for tool execution. Gated in v1 -- not exposed to users.
Will require explicit admin approval and per-tool access control.
"""


# ========== Error Codes ==========
# Follow the project convention: DOMAIN_SPECIFIC_ERROR (e.g. SETTINGS_FORBIDDEN)

MCP_UNAVAILABLE: str = "MCP_UNAVAILABLE"
"""mcp-service is unreachable or returned a non-200 status."""

MCP_TIMEOUT: str = "MCP_TIMEOUT"
"""mcp-service call exceeded the configured timeout."""

MCP_FORBIDDEN: str = "MCP_FORBIDDEN"
"""User lacks permission for the requested MCP operation (admin-only)."""

MCP_USER_DISABLED: str = "MCP_USER_DISABLED"
"""User has MCP tools feature disabled by admin or self-toggle."""

MCP_EXECUTE_GATED: str = "MCP_EXECUTE_GATED"
"""Tool execution is not available in v1. Reserved for future use."""

MCP_CONFIG_INVALID: str = "MCP_CONFIG_INVALID"
MCP_SECRET_INVALID: str = "MCP_SECRET_INVALID"
MCP_NOT_READY: str = "MCP_NOT_READY"
MCP_EXECUTE_FAILED: str = "MCP_EXECUTE_FAILED"


# ========== Config Schema Guardrail ==========

MCP_CONFIG_ALLOWED_KEYS = {"command", "args", "env_keys", "timeout_seconds", "health_probe_path"}
MCP_CONFIG_ALLOWED_COMMANDS = {"uvx", "npx", "node", "python"}


# ========== Transport Enum ==========

class MCPTransport(PyEnum):
    """Supported MCP transport protocols."""
    STREAMABLE_HTTP = "streamable-http"


# ========== Error Envelope ==========

class MCPErrorDetail(BaseModel):
    """
    Structured error detail for MCP responses.
    Mirrors the project error pattern: {"error_code": "...", "message": "..."}.
    """
    error_code: str = Field(..., description="MCP error code (e.g. MCP_UNAVAILABLE)")
    message: str = Field(..., description="Human-readable error message")


class MCPResponseEnvelope(BaseModel):
    """
    Standard response wrapper for all backend -> mcp-service calls.
    Downstream API routes transform this into appropriate HTTP responses.
    """
    success: bool = Field(..., description="Whether the MCP call succeeded")
    data: Optional[Any] = Field(default=None, description="Response payload on success")
    error: Optional[MCPErrorDetail] = Field(default=None, description="Error detail on failure")


# ========== Catalog Schemas ==========

class MCPToolInfo(BaseModel):
    """
    Single tool entry from mcp-service /catalog response.
    Represents a tool exposed by an MCP server (e.g. Fetch, DuckDuckGo).
    """
    name: str = Field(..., description="Tool name (unique within server)")
    description: str = Field("", description="Human-readable tool description")
    server_name: str = Field(..., description="MCP server that provides this tool")
    input_schema: Optional[dict] = Field(None, description="JSON Schema for tool input parameters")


class MCPCatalogResponse(BaseModel):
    """Full catalog listing returned by mcp-service /catalog."""
    tools: List[MCPToolInfo] = Field(default_factory=list, description="Available MCP tools")


class MCPExecuteRequest(BaseModel):
    server_name: str
    tool: str
    arguments: dict = Field(default_factory=dict)


class MCPExecuteResponse(BaseModel):
    tool: str
    result: Any = None
    error: Optional[str] = None


# ========== Helper Builders ==========

def make_mcp_error(error_code: str, message: str) -> MCPResponseEnvelope:
    """Build a failed MCPResponseEnvelope with structured error detail."""
    return MCPResponseEnvelope(
        success=False,
        error=MCPErrorDetail(error_code=error_code, message=message),
    )


def make_mcp_success(data: Any = None) -> MCPResponseEnvelope:
    """Build a successful MCPResponseEnvelope with optional payload."""
    return MCPResponseEnvelope(
        success=True,
        data=data,
    )
