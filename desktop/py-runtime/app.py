"""
UA Python runtime — the shell's bundled Python, Jenny-shaped.

Spawned and supervised by Jenny's orchestrator (vendored verbatim in
desktop/shell/vendor/jenny). The contract the orchestrator relies on:

  * `GET /health` answers 200 JSON with no authentication — HealthMonitor
    polls it every 3 s and restarts the child after 3 misses.
  * The process reads its port from JENNY_PORT (the orchestrator sets it).

What this runtime adds on top of Jenny's reference server:

  * A capability token. Loopback is not an authorization boundary — any local
    process, and any page the operator visits, can reach 127.0.0.1 — so every
    route except /health requires the token the shell minted for this launch.
    It arrives in MARQUEE_PY_RUNTIME_TOKEN, as a header (X-Marquee-Runtime-Token) on
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
import re
import select
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time
from typing import Any, Optional, List

import captions
import remux
import zoom

import uvicorn
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

VERSION = "0.1.0"
log = logging.getLogger("ua-py-runtime")

# Logging is configured at IMPORT time, not in main(): in development Jenny's
# orchestrator launches `python -m uvicorn app:app --reload`, which never calls
# main(). Anything only main() configured would silently not apply there.
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s", datefmt="%H:%M:%S")
# uvicorn's access log prints the full request target, and the PTY WebSocket
# handshake carries the capability token in its query string. This process's
# stdout is forwarded by Jenny's LogAggregator to a file on disk, so the access
# log would write the token to disk on every terminal open. Off, always — the
# events that matter are logged explicitly below, without the token.
logging.getLogger("uvicorn.access").disabled = True


class _RedactToken(logging.Filter):
    """Belt and braces: scrub `token=<value>` out of any record that slips through."""

    _pattern = re.compile(r"(token=)[^&\s\"']+")

    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.msg, str) and "token=" in record.msg:
            record.msg = self._pattern.sub(r"\1[redacted]", record.msg)
        if record.args:
            record.args = tuple(self._pattern.sub(r"\1[redacted]", a) if isinstance(a, str) and "token=" in a else a for a in record.args)
        return True


# uvicorn's *error* logger (not only access) announces WebSocket handshakes at
# INFO with the full target — the second place the token appeared.
#
# Raising its level here is only a hint, NOT the defence: `uvicorn.run()`
# applies its own dictConfig, which resets the level of every uvicorn logger.
# Observed directly — with this setLevel in place, the handshake line still
# printed at INFO, and what kept the token out of it was the filter below.
# Filters attached to a logger object survive dictConfig; levels do not. So
# the filter is load-bearing and must never be removed as "redundant".
_uv_error = logging.getLogger("uvicorn.error")
_uv_error.setLevel(logging.WARNING)
for _lg in (logging.getLogger(), _uv_error, logging.getLogger("uvicorn")):
    _lg.addFilter(_RedactToken())
    for _h in _lg.handlers:
        _h.addFilter(_RedactToken())

TOKEN = os.environ.get("MARQUEE_PY_RUNTIME_TOKEN", "")


def _port_from_argv(argv: list[str]) -> int | None:
    """`--port N` / `--port=N`, which is what the vendored orchestrator passes
    to the PACKAGED executable (dev mode drives uvicorn directly instead).

    Honouring argv is not optional politeness: Jenny sets JENNY_PORT *and*
    passes --port, and a bundle that reads only the env would keep working by
    luck until someone changed one of them. Pure and tested.
    """
    for index, arg in enumerate(argv):
        if arg == "--port" and index + 1 < len(argv):
            candidate = argv[index + 1]
        elif arg.startswith("--port="):
            candidate = arg.split("=", 1)[1]
        else:
            continue
        try:
            value = int(candidate)
        except ValueError:
            continue
        if 1 <= value <= 65535:
            return value
    return None


def _resolve_port(argv: list[str], env: dict[str, str]) -> int:
    """argv wins over env — it is the more explicit signal from the supervisor."""
    from_argv = _port_from_argv(argv)
    if from_argv is not None:
        return from_argv
    return int(env.get("JENNY_PORT") or env.get("MARQUEE_PY_RUNTIME_PORT") or "18764")


PORT = _resolve_port(sys.argv[1:], dict(os.environ))
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
            "MARQUEE_PY_RUNTIME_TOKEN is not set on this runtime; the shell must mint one before spawning it."
        )
    presented = request.headers.get("x-marquee-runtime-token", "")
    if presented != TOKEN:
        return _unauthorized("missing or wrong X-Marquee-Runtime-Token header")
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
        # The Studio needs to know BEFORE it offers to record whether this
        # runtime can finalise to MP4. None means PyAV is missing.
        "remux": remux.library_versions(),
        "zoom": zoom.library_versions(),
        # None when the optional captions extra is not installed, so the UI can
        # say so instead of offering a button that answers 501.
        "captions": captions.available(),
    }


# ─── /remux ────────────────────────────────────────────────────────────────
#
# Chromium cannot write H.264 into an MP4 (measured — see remux.py), so the
# Studio records H.264/opus Matroska and this turns it into a real MP4 by
# copying the video stream. The source file is never deleted here.

class RemuxRequest(BaseModel):
    source: str = Field(min_length=1)
    # `Optional[str]`, not `str | None`: pydantic EVALUATES model annotations, so
    # PEP 604 unions raise a TypeError on Python 3.9 even under
    # `from __future__ import annotations`. Function and dataclass annotations
    # are fine because nothing evaluates them. This runtime has to start on
    # whatever python3 the operator's machine has.
    output: Optional[str] = None
    audio_bitrate: int = Field(default=160_000, ge=32_000, le=512_000)


@app.post("/remux")
async def remux_recording(req: RemuxRequest) -> dict[str, Any]:
    try:
        # Off the event loop: a long recording would otherwise block /health
        # and the supervisor would restart the runtime mid-finalise.
        result = await asyncio.to_thread(remux.remux_to_mp4, req.source, req.output, req.audio_bitrate)
    except remux.RemuxUnavailable as exc:
        raise HTTPException(status_code=501, detail=str(exc))
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    except HTTPException:
        # Never let the broad handler below re-wrap a deliberate status code as
        # a 500. Verified the hard way: a 422 raised inside this block came back
        # as "500 ... HTTPException: 422: ...", which tells a caller a bad
        # request was a server fault.
        raise
    except Exception as exc:  # a broken container, a full disk — name it, never swallow it
        log.exception("remux failed for %s", req.source)
        raise HTTPException(status_code=500, detail=f"remux failed: {type(exc).__name__}: {exc}")
    return result.as_dict()


class ZoomRequest(BaseModel):
    source: str = Field(min_length=1)
    cursor_track: str = Field(min_length=1, alias="cursorTrack")
    output: Optional[str] = None
    # The DELIVERY size, not the source size. Cropping a 1920x1080 window out of
    # a 4K capture is a 2x zoom at native sharpness; encoding 4K out would cost
    # four times as much for pixels no viewer asked for.
    out_width: int = Field(default=1920, ge=320, le=3840, alias="outWidth")
    out_height: int = Field(default=1080, ge=240, le=2160, alias="outHeight")
    # Delivery shapes by name. The FIRST is primary and gets the plain
    # `.zoomed.mp4`; the rest carry their label. One decode feeds them all,
    # because decoding is the expensive half.
    targets: Optional[List[str]] = None
    # How much of the frame a zoomed shot shows. 0.5 is a 2x zoom.
    zoom_scale: float = Field(default=0.5, gt=0.05, le=1.0, alias="zoomScale")
    audio_bitrate: int = Field(default=160_000, ge=32_000, le=512_000, alias="audioBitrate")
    video_bitrate: int = Field(default=8_000_000, ge=500_000, le=80_000_000, alias="videoBitrate")

    model_config = {"populate_by_name": True}


@app.post("/zoom")
async def zoom_recording(req: ZoomRequest) -> dict[str, Any]:
    """Render a zoomed edit from a take and its cursor track.

    Unlike /remux this genuinely re-encodes every frame, so it is slow —
    measured at roughly 2.5x realtime for a 2560x1440 source. It runs off the
    event loop for the same reason /remux does, and more urgently: a long take
    would otherwise block /health long enough for the supervisor to restart the
    runtime in the middle of the render.
    """
    # Resolve the shapes BEFORE the try block. An HTTPException raised inside it
    # would be caught by the broad handler below and re-wrapped as a 500 —
    # verified: a request for an unknown shape answered 500 with the 422 buried
    # in its message. A bad request must not look like a server fault.
    if req.targets:
        unknown = [t for t in req.targets if t not in zoom.KNOWN_TARGETS]
        if unknown:
            raise HTTPException(
                status_code=422,
                detail=(
                    f"unknown output shape(s): {', '.join(unknown)}. "
                    f"Known shapes are {', '.join(sorted(zoom.KNOWN_TARGETS))}."
                ),
            )
        # Preserve the caller's order — the first is primary — while dropping
        # duplicates, which would collide on one output path.
        seen: List[str] = []
        for label in req.targets:
            if label not in seen:
                seen.append(label)
        targets = tuple(zoom.KNOWN_TARGETS[label] for label in seen)
    else:
        # No shapes named: honour the explicit size, as before.
        targets = (zoom.ZoomTarget("16x9", req.out_width, req.out_height),)

    try:
        result = await asyncio.to_thread(
            zoom.render_zoom,
            req.source,
            req.cursor_track,
            req.output,
            targets=targets,
            zoom_scale=req.zoom_scale,
            audio_bitrate=req.audio_bitrate,
            video_bitrate=req.video_bitrate,
        )
    except zoom.ZoomUnavailable as exc:
        raise HTTPException(status_code=501, detail=str(exc))
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    except HTTPException:
        # Never let the broad handler below re-wrap a deliberate status code as
        # a 500. Verified the hard way: a 422 raised inside this block came back
        # as "500 ... HTTPException: 422: ...", which tells a caller a bad
        # request was a server fault.
        raise
    except Exception as exc:  # a broken container, a full disk — name it, never swallow it
        log.exception("the zoom render failed for %s", req.source)
        raise HTTPException(status_code=500, detail=f"the zoom render failed: {type(exc).__name__}: {exc}")
    return result.as_dict()


@app.post("/zoom/plan")
async def zoom_plan(req: ZoomRequest) -> dict[str, Any]:
    """The keyframes /zoom WOULD use, without rendering anything.

    Cheap and instant, so the UI can show what the edit will do — and how many
    zooms it found — before committing minutes to an encode.
    """
    try:
        track = await asyncio.to_thread(zoom.load_cursor_track, req.cursor_track)
        duration_ms = track.samples[-1].t_ms if track.samples else 0
        plan = zoom.plan_zooms(track.samples, duration_ms, zoom_scale=req.zoom_scale)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    return {
        "cursorTrack": req.cursor_track,
        "display": track.display,
        "samples": len(track.samples),
        "durationMs": duration_ms,
        **plan.as_dict(),
    }


class CaptionRequest(BaseModel):
    source: str = Field(min_length=1)
    # `tiny` by default: measured WORD-PERFECT on real speech at 6.2x realtime,
    # and the smallest download. Bigger models are available for accented or
    # noisy audio at a proportional cost in time.
    model: str = Field(default="tiny")
    # None means detect. Naming the language skips detection and is more
    # reliable on a take that opens with silence.
    language: Optional[str] = None
    formats: Optional[List[str]] = None

    model_config = {"populate_by_name": True, "protected_namespaces": ()}


@app.post("/captions")
async def transcribe_recording(req: CaptionRequest) -> dict[str, Any]:
    """Transcribe a take and write caption files beside it.

    Runs off the event loop like the other long passes: a ten-minute take is
    around ninety seconds of work, which on the event loop would block /health
    long enough for the supervisor to restart the runtime mid-transcription.
    """
    formats = tuple(req.formats) if req.formats else ("srt", "vtt")
    try:
        result = await asyncio.to_thread(
            captions.transcribe,
            req.source,
            model_size=req.model,
            language=req.language,
            formats=formats,
        )
    except captions.CaptionsUnavailable as exc:
        raise HTTPException(status_code=501, detail=str(exc))
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    except HTTPException:
        raise
    except Exception as exc:  # a corrupt take, a failed model download — name it
        log.exception("transcription failed for %s", req.source)
        raise HTTPException(status_code=500, detail=f"transcription failed: {type(exc).__name__}: {exc}")
    return result.as_dict()


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
    log.info("run_code language=%s exit=%s timed_out=%s duration_ms=%d", req.language, proc.returncode, timed_out, round((time.monotonic() - started) * 1000))
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
    cols = int(ws.query_params.get("cols", "120"))
    rows = int(ws.query_params.get("rows", "32"))

    if sys.platform == "win32":
        # ConPTY via pywinpty, in its own module so the verified POSIX path
        # below is untouched. UNVERIFIED on Windows — see winpty_session.py.
        from winpty_session import serve as serve_conpty

        await ws.accept()
        await serve_conpty(ws, argv, cols, rows, WORKSPACE)
        return

    await ws.accept()

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
    if not TOKEN:
        log.warning("MARQUEE_PY_RUNTIME_TOKEN is not set — every route except /health will answer 401")
    log.info("UA Python runtime v%s on 127.0.0.1:%d (workspace %s)", VERSION, PORT, WORKSPACE)
    # access_log=False on purpose: uvicorn's access line prints the full request
    # target, and the WebSocket handshake carries the capability token in its
    # query string. Jenny's LogAggregator forwards this process's stdout to a
    # file on disk, so an access log here would write the token to disk on
    # every PTY open. The events that matter (pty spawned/closed, run_code)
    # are logged explicitly, without the token.
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="info", access_log=False)


if __name__ == "__main__":
    main()
