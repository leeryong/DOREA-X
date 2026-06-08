"""
MCP Service - Runtime manager for MCP servers via uvx.
Manages subprocess lifecycle and routes tool calls.
"""
import asyncio
import json
import logging
import os
import signal
import sys
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

logging.basicConfig(level=logging.INFO, format="[mcp-service] %(message)s")
logger = logging.getLogger(__name__)

app = FastAPI(title="DOREA-X MCP Service", version="1.0.0")


# ========== Models ==========

class ServerConfig(BaseModel):
    name: str
    command: str = "uvx"
    args: List[str] = Field(default_factory=list)
    env: Dict[str, str] = Field(default_factory=dict)
    timeout_seconds: int = 30

class ConfigureRequest(BaseModel):
    servers: List[ServerConfig]

class ExecuteRequest(BaseModel):
    server_name: str
    tool: str
    arguments: Dict[str, Any] = Field(default_factory=dict)

class ToolInfo(BaseModel):
    name: str
    description: str = ""
    server_name: str
    input_schema: Optional[dict] = None


# ========== MCP Server Process Manager ==========

class McpServerProcess:
    """Manages a single MCP server subprocess via stdio."""

    def __init__(self, config: ServerConfig):
        self.config = config
        self.process: Optional[asyncio.subprocess.Process] = None
        self.tools: List[dict] = []
        self.status: str = "stopped"  # stopped, starting, ready, error
        self.error_message: Optional[str] = None
        self._request_id: int = 0
        self._pending: Dict[int, asyncio.Future] = {}
        self._reader_task: Optional[asyncio.Task] = None
        self._lock = asyncio.Lock()

    def _next_id(self) -> int:
        self._request_id += 1
        return self._request_id

    async def start(self):
        """Start the MCP server subprocess."""
        async with self._lock:
            if self.status == "ready":
                return
            self.status = "starting"
            self.error_message = None
            try:
                cmd = [self.config.command] + self.config.args
                env = {**os.environ, **self.config.env}
                logger.info(f"Starting MCP server '{self.config.name}': {' '.join(cmd)}")

                self.process = await asyncio.create_subprocess_exec(
                    *cmd,
                    stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    env=env,
                )

                # Start stdout reader
                self._reader_task = asyncio.create_task(self._read_stdout())

                # Initialize MCP protocol
                await self._initialize()
                # List tools
                await self._list_tools()

                self.status = "ready"
                logger.info(f"MCP server '{self.config.name}' ready with {len(self.tools)} tools")
            except Exception as e:
                self.status = "error"
                self.error_message = str(e)
                logger.error(f"Failed to start MCP server '{self.config.name}': {e}")

    async def stop(self):
        """Stop the subprocess."""
        async with self._lock:
            if self.process and self.process.returncode is None:
                self.process.terminate()
                try:
                    await asyncio.wait_for(self.process.wait(), timeout=5)
                except asyncio.TimeoutError:
                    self.process.kill()
            if self._reader_task:
                self._reader_task.cancel()
            self.status = "stopped"
            self.tools = []

    async def _send_request(self, method: str, params: Optional[dict] = None) -> Any:
        """Send JSON-RPC request and wait for response."""
        if not self.process or not self.process.stdin:
            raise RuntimeError("Process not running")

        req_id = self._next_id()
        request = {"jsonrpc": "2.0", "id": req_id, "method": method}
        if params:
            request["params"] = params

        future = asyncio.get_event_loop().create_future()
        self._pending[req_id] = future

        data = json.dumps(request) + "\n"
        self.process.stdin.write(data.encode())
        await self.process.stdin.drain()

        try:
            result = await asyncio.wait_for(future, timeout=self.config.timeout_seconds)
            return result
        except asyncio.TimeoutError:
            self._pending.pop(req_id, None)
            raise RuntimeError(f"Timeout waiting for response to {method}")

    async def _read_stdout(self):
        """Continuously read JSON-RPC responses from stdout."""
        try:
            while self.process and self.process.stdout:
                line = await self.process.stdout.readline()
                if not line:
                    break
                try:
                    msg = json.loads(line.decode().strip())
                    req_id = msg.get("id")
                    if req_id and req_id in self._pending:
                        future = self._pending.pop(req_id)
                        if "error" in msg:
                            future.set_exception(RuntimeError(json.dumps(msg["error"])))
                        else:
                            future.set_result(msg.get("result"))
                except (json.JSONDecodeError, Exception):
                    continue
        except asyncio.CancelledError:
            pass
        except Exception as e:
            logger.error(f"Reader error for '{self.config.name}': {e}")
            self.status = "error"
            self.error_message = str(e)

    async def _initialize(self):
        """Send MCP initialize request."""
        result = await self._send_request("initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "dorea-x-mcp-service", "version": "1.0.0"},
        })
        # Send initialized notification
        notif = {"jsonrpc": "2.0", "method": "notifications/initialized"}
        if not self.process or not self.process.stdin:
            raise RuntimeError("Process not running")
        self.process.stdin.write((json.dumps(notif) + "\n").encode())
        await self.process.stdin.drain()
        return result

    async def _list_tools(self):
        """Fetch available tools from the server."""
        result = await self._send_request("tools/list", {})
        self.tools = result.get("tools", []) if result else []

    async def call_tool(self, tool_name: str, arguments: dict) -> Any:
        """Execute a tool call."""
        if self.status != "ready":
            raise RuntimeError(f"Server '{self.config.name}' is not ready (status: {self.status})")
        result = await self._send_request("tools/call", {
            "name": tool_name,
            "arguments": arguments,
        })
        return result


# ========== Global Server Registry ==========

_servers: Dict[str, McpServerProcess] = {}


# ========== Endpoints ==========

@app.get("/health")
async def health():
    server_statuses = {}
    for name, srv in _servers.items():
        server_statuses[name] = {
            "status": srv.status,
            "tools_count": len(srv.tools),
            "error": srv.error_message,
        }
    return {
        "status": "ok",
        "servers": server_statuses,
    }


@app.get("/catalog")
async def catalog():
    tools = []
    for name, srv in _servers.items():
        if srv.status == "ready":
            for t in srv.tools:
                tools.append({
                    "name": t.get("name", ""),
                    "description": t.get("description", ""),
                    "server_name": name,
                    "input_schema": t.get("inputSchema"),
                })
    return {"tools": tools}


@app.post("/execute")
async def execute(req: ExecuteRequest):
    srv = _servers.get(req.server_name)
    if not srv:
        raise HTTPException(404, detail={"error_code": "MCP_SERVER_NOT_FOUND", "message": f"Server '{req.server_name}' not found"})
    if srv.status != "ready":
        raise HTTPException(503, detail={"error_code": "MCP_NOT_READY", "message": f"Server '{req.server_name}' is not ready (status: {srv.status})"})
    try:
        result = await srv.call_tool(req.tool, req.arguments)
        return {"success": True, "data": result}
    except Exception as e:
        raise HTTPException(500, detail={"error_code": "MCP_EXECUTE_FAILED", "message": str(e)})


@app.post("/servers/configure")
async def configure_servers(req: ConfigureRequest):
    """Configure and start MCP servers. Called by backend on startup or config change."""
    # Stop servers no longer in config
    current_names = {s.name for s in req.servers}
    for name in list(_servers.keys()):
        if name not in current_names:
            await _servers[name].stop()
            del _servers[name]

    # Start/update servers
    for sc in req.servers:
        if sc.name in _servers:
            existing = _servers[sc.name]
            # Restart if config changed
            if (existing.config.command != sc.command or
                existing.config.args != sc.args or
                existing.config.env != sc.env):
                await existing.stop()
                _servers[sc.name] = McpServerProcess(sc)
                await _servers[sc.name].start()
        else:
            _servers[sc.name] = McpServerProcess(sc)
            await _servers[sc.name].start()

    return {"configured": list(_servers.keys())}


@app.on_event("shutdown")
async def shutdown():
    for srv in _servers.values():
        await srv.stop()
