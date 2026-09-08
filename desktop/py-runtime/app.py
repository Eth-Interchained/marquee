"""
UA Python runtime — the shell's bundled Python, Jenny-shaped.

Spawned and supervised by Jenny's orchestrator (vendored verbatim in
desktop/ua-shell/vendor/jenny). The contract the orchestrator relies on:

  * `GET /health` answers 200 JSON with no authentication — HealthMonitor
    polls it every 3 s and restarts the child after 3 misses.
  * The process reads its port from JENNY_PORT (the orchestrator sets it).

What this runtime adds on top of Jenny's reference server:

  * A capability token. Loopback is not an authorization boundary — any local
    process, and any page the operator visits, can reach 127.0.0.1 — so every
    route except /health requires the token the shell minted for this launch.
    It arrives in UA_PY_RUNTIME_TOKEN, as a header (X-UA-Runtime-Token) on
    HTTP and as ?token= on the WebSocket handshake (browsers cannot set
    headers on WebSocket upgrades; the shell's proxy adds the query string
    server-side, so the page never holds the token).
  * `/ws/pty` — a REAL pseudo-terminal (stdlib `pty`), not a log viewer. The
    bundled Python is the terminal server, so the shell needs no native Node
    addon for the terminal. `$SHELL`, `python3 -i`, `node` are just argv.
  * `/run_code` — one-shot Python/Node execution with a wall-clock timeout and
    an output cap, in the shape of agent-runtime's tool contract.

Every refusal names itself: the status, what was missing, and what to do.
"""

from __future__ import annotations

import asyncio
import fcntl
import json
import logging
import os
import platform
import pty
import select
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time
from typing import Any, Optional

import uvicorn
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

VERSION = "0.1.0"
log = logging.getLogger("ua-py-runtime")

TOKEN = os.environ.get("UA_PY_RUNTIME_TOKEN", "")
PORT = int(os.environ.get("JENNY_PORT") or os.environ.get("UA_PY_RUNTIME_PORT") or "18764")
WORKSPACE = os.environ.get("JENNY_WORKSPACE_DIR") or os.getcwd()

# Programs the PTY may launch. A closed list, not a free string: the terminal
# is a shell, but WHICH shell is the shell's decision, not the page's.
def _default_shell() -> str:
    if sys.platform == "win32":
        return os.environ.get("COMSPEC", "cmd.exe")
    return os.environ.get("SHELL") or "/bin/bash"


PROGRAMS: dict[str, list[str]] = {
    "shell": [_default_shell()],
    "python": [sys.executable, "-i", "-q"] if sys.executable else ["python3", "-i", "-q"],
    "node": ["node"],
}

app = FastAPI(title="UA Python runtime", version=VERSION, docs_url=None, redoc_url=None)


def _unauthorized(detail: str) -> JSONResponse:
    return JSONResponse(status_code=401, content={"error": "unauthorized", "detail": detail})


@app.middleware("http")
async def require_token(request: Request, call_next):  # type: ignore[no-untyped-def]
    if request.url.path == "/health":
        return await call_next(request)
    if not TOKEN:
        # Refuse loudly rather than run open: an ungated runtime on loopback is
        # a shell for anything on this machine.
        return _unauthorized(
            "UA_PY_RUNTIME_TOKEN is not set on this runtime; the shell must mint one before spawning it."
        )
    presented = request.headers.get("x-ua-runtime-token", "")
    if presented != TOKEN:
        return _unauthorized("missing or wrong X-UA-Runtime-Token header")
    return await call_next(request)


@app.get("/health")
async def health() -> dict[str, Any]:
    return {
        "status": "healthy",
        "runtime": "ua-py-runtime",
        "version": VERSION,
        "python": platform.python_version(),
        "platform": sys.platform,
        "gated": bool(TOKEN),
        "programs": sorted(PROGRAMS),
        "pty": sys.platform != "win32",
    }


# ─── /run_code ─────────────────────────────────────────────────────────────

class RunCodeRequest(BaseModel):
    language: str = Field(pattern="^(python|node)$")
    code: str
    timeout_seconds: float = Field(default=30, ge=0.1, le=600)
    max_output_bytes: int = Field(default=200_000, ge=1_024, le=5_000_000)


@app.post("/run_code")
async def run_code(req: RunCodeRequest) -> dict[str, Any]:
    suffix = ".py" if req.language == "python" else ".js"
    with tempfile.NamedTemporaryFile("w", suffix=suffix, delete=False, dir=tempfile.gettempdir()) as f:
        f.write(req.code)
        path = f.name
    cmd = [sys.executable or "python3", path] if req.language == "python" else ["node", path]
    started = time.monotonic()
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            cwd=WORKSPACE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env={**os.environ, "PYTHONUNBUFFERED": "1"},
        )
    except FileNotFoundError as exc:
        os.unlink(path)
        raise HTTPException(status_code=422, detail=f"{cmd[0]} is not on PATH for this runtime: {exc}")
    timed_out = False
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout=req.timeout_seconds)
    except asyncio.TimeoutError:
        timed_out = True
        proc.kill()
        out, err = await proc.communicate()
    finally:
        try:
            os.unlink(path)
        except OSError as exc:
            log.warning("could not remove temp file %s: %s", path, exc)
    cap = req.max_output_bytes
    truncated = len(out) > cap or len(err) > cap
    return {
        "language": req.language,
        "exit_code": proc.returncode,
        "timed_out": timed_out,
        "duration_ms": round((time.monotonic() - started) * 1000),
        "stdout": out[:cap].decode("utf8", "replace"),
        "stderr": err[:cap].decode("utf8", "replace"),
        "truncated": truncated,
    }


# ─── /ws/pty ───────────────────────────────────────────────────────────────
#
# Wire protocol (the page ↔ runtime, through the shell's proxy):
#   client → server : raw text frames = keystrokes; JSON text frames starting
#                     with "\x00" = control: {"type":"resize","cols":N,"rows":N}
#   server → client : binary frames = terminal output; JSON text frames =
#                     {"type":"exit","code":N} | {"type":"error","detail":...}

def _set_winsize(fd: int, rows: int, cols: int) -> None:
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


@app.websocket("/ws/pty")
async def ws_pty(ws: WebSocket) -> None:
    token = ws.query_params.get("token", "")
    if not TOKEN or token != TOKEN:
        # 4401: application close code in the 4000-4999 range — "unauthorized".
        await ws.close(code=4401, reason="missing or wrong runtime token")
        return
    program = ws.query_params.get("program", "shell")
    argv = PROGRAMS.get(program)
    if not argv:
        await ws.close(code=4404, reason=f"unknown program '{program}'; allowed: {sorted(PROGRAMS)}")
        return
    if sys.platform == "win32":
        await ws.close(code=4501, reason="PTY on Windows needs pywinpty; not wired yet")
        return

    await ws.accept()
    cols = int(ws.query_params.get("cols", "120"))
    rows = int(ws.query_params.get("rows", "32"))

    pid, fd = pty.fork()
    if pid == 0:
        # Child: become the program. TERM so colors work out of the box.
        env = {**os.environ, "TERM": "xterm-256color", "COLORTERM": "truecolor", "LANG": os.environ.get("LANG", "C.UTF-8")}
        try:
            os.chdir(WORKSPACE)
        except OSError:
            pass
        try:
            os.execvpe(argv[0], argv, env)
        except OSError as exc:  # pragma: no cover — only reachable in the child
            sys.stderr.write(f"exec {argv[0]} failed: {exc}\n")
            os._exit(127)

    _set_winsize(fd, rows, cols)
    os.set_blocking(fd, False)
    loop = asyncio.get_running_loop()
    log.info("pty spawned program=%s pid=%d size=%dx%d", program, pid, cols, rows)

    async def pump_output() -> None:
        try:
            while True:
                r, _, _ = await loop.run_in_executor(None, select.select, [fd], [], [], 0.25)
                if not r:
                    # Poll for exit while idle so a quit shell closes the socket.
                    done, status = os.waitpid(pid, os.WNOHANG)
                    if done == pid:
                        code = os.waitstatus_to_exitcode(status)
                        await ws.send_text(json.dumps({"type": "exit", "code": code}))
                        return
                    continue
                try:
                    data = os.read(fd, 65536)
                except OSError:
                    data = b""
                if not data:
                    _, status = os.waitpid(pid, 0)
                    code = os.waitstatus_to_exitcode(status)
                    await ws.send_text(json.dumps({"type": "exit", "code": code}))
                    return
                await ws.send_bytes(data)
        except (WebSocketDisconnect, RuntimeError):
            return

    pump = asyncio.create_task(pump_output())
    try:
        while not pump.done():
            try:
                msg = await asyncio.wait_for(ws.receive(), timeout=0.5)
            except asyncio.TimeoutError:
                continue
            if msg.get("type") == "websocket.disconnect":
                break
            text = msg.get("text")
            data = msg.get("bytes")
            if text is not None:
                if text.startswith("\x00"):
                    try:
                        ctl = json.loads(text[1:])
                    except json.JSONDecodeError as exc:
                        await ws.send_text(json.dumps({"type": "error", "detail": f"bad control frame: {exc}"}))
                        continue
                    if ctl.get("type") == "resize":
                        _set_winsize(fd, int(ctl.get("rows", rows)), int(ctl.get("cols", cols)))
                    continue
                data = text.encode("utf8")
            if data:
                os.write(fd, data)
    except WebSocketDisconnect:
        pass
    finally:
        pump.cancel()
        try:
            os.kill(pid, signal.SIGHUP)
        except ProcessLookupError:
            pass
        try:
            os.close(fd)
        except OSError:
            pass
        log.info("pty closed program=%s pid=%d", program, pid)


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s", datefmt="%H:%M:%S")
    if not TOKEN:
        log.warning("UA_PY_RUNTIME_TOKEN is not set — every route except /health will answer 401")
    log.info("UA Python runtime v%s on 127.0.0.1:%d (workspace %s)", VERSION, PORT, WORKSPACE)
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="info")


if __name__ == "__main__":
    main()
