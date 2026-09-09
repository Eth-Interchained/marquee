"""
The Windows half of /ws/pty.

Kept in its own module, and reached only from a `sys.platform == "win32"`
branch, so the POSIX path in app.py — which is verified end to end — is not
touched by any of this.

**UNVERIFIED ON WINDOWS.** It is written from pywinpty's documented API and
has never been run on Windows by its author. It is here because the honest
alternative was a flat refusal, and this at least *tries* and then says
exactly what broke. Nothing in it reports success it did not observe:

  * no pywinpty installed  -> the socket closes with 4501 and says to install it
  * spawn fails            -> closes with 4502 and the exception text
  * anything else          -> an {"type":"error"} frame with the real message

Treat a green result here as "reported working on Windows by someone who ran
it", never as tested.

Differences from the POSIX path that a reader should know:
  * ConPTY has no `waitpid`; liveness is `proc.isalive()` polling.
  * `PtyProcess.read()` returns **str**, not bytes, and raises EOFError at end
    of stream — so output is encoded to UTF-8 before going on the wire, which
    keeps the client protocol identical (binary frames out).
  * There is no SIGHUP; teardown is `terminate(force=True)`.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from typing import Any

log = logging.getLogger("ua-py-runtime")

# Close codes, matching the POSIX path's vocabulary.
CLOSE_NO_PYWINPTY = 4501
CLOSE_SPAWN_FAILED = 4502

INSTALL_HINT = (
    "A terminal on Windows needs pywinpty, which is not installed in this runtime. "
    "It ships in requirements.txt for win32 — reinstall the runtime's dependencies "
    "(.venv\\Scripts\\pip install -r requirements.txt), or rebuild the bundled runtime."
)


def load_pty_process() -> Any:
    """`winpty.PtyProcess`, or None when pywinpty is unavailable.

    Pure enough to test: the caller decides what to do with None, and the
    absence is reported rather than crashing the socket handler.
    """
    try:
        from winpty import PtyProcess  # type: ignore[import-not-found]
    except ImportError as exc:
        log.warning("pywinpty is not importable: %s", exc)
        return None
    return PtyProcess


async def serve(ws: Any, argv: list[str], cols: int, rows: int, workspace: str) -> None:
    """Runs one ConPTY session over an ALREADY-ACCEPTED websocket.

    The caller has authenticated the token and resolved `argv` from the closed
    program list — this function never chooses what to run.
    """
    pty_process = load_pty_process()
    if pty_process is None:
        await ws.close(code=CLOSE_NO_PYWINPTY, reason="pywinpty is not installed")
        return

    env = {
        **os.environ,
        "TERM": "xterm-256color",
        # ConPTY understands VT sequences; this is what makes colour work in
        # cmd.exe and PowerShell without extra flags.
        "COLORTERM": "truecolor",
    }
    try:
        proc = pty_process.spawn(argv, cwd=workspace, env=env, dimensions=(rows, cols))
    except Exception as exc:  # pywinpty raises its own error types; all are fatal here
        log.error("ConPTY spawn failed for %s: %s", argv, exc)
        await ws.close(code=CLOSE_SPAWN_FAILED, reason=f"could not start {argv[0]}: {exc}"[:120])
        return

    log.info("conpty spawned program=%s pid=%s size=%dx%d", argv[0], getattr(proc, "pid", "?"), cols, rows)
    loop = asyncio.get_running_loop()

    async def pump_output() -> None:
        while True:
            try:
                # read() blocks, so it goes to a thread; EOFError is the normal
                # end of stream, not a failure.
                chunk = await loop.run_in_executor(None, proc.read, 65536)
            except EOFError:
                break
            except Exception as exc:
                log.warning("conpty read failed: %s", exc)
                await _send_error(ws, f"terminal read failed: {exc}")
                break
            if not chunk:
                if not proc.isalive():
                    break
                await asyncio.sleep(0.02)
                continue
            try:
                await ws.send_bytes(chunk.encode("utf8", "replace") if isinstance(chunk, str) else chunk)
            except Exception:
                return
        code = getattr(proc, "exitstatus", None)
        try:
            await ws.send_text(json.dumps({"type": "exit", "code": code if code is not None else 0}))
        except Exception:
            pass

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
                        await _send_error(ws, f"bad control frame: {exc}")
                        continue
                    if ctl.get("type") == "resize":
                        try:
                            proc.setwinsize(int(ctl.get("rows", rows)), int(ctl.get("cols", cols)))
                        except Exception as exc:
                            await _send_error(ws, f"resize failed: {exc}")
                    continue
                data = text
            if data:
                try:
                    proc.write(data.decode("utf8", "replace") if isinstance(data, bytes) else data)
                except Exception as exc:
                    await _send_error(ws, f"terminal write failed: {exc}")
                    break
    finally:
        pump.cancel()
        try:
            if proc.isalive():
                proc.terminate(force=True)
        except Exception as exc:
            log.warning("conpty terminate failed: %s", exc)
        log.info("conpty closed program=%s", argv[0])


async def _send_error(ws: Any, detail: str) -> None:
    """Errors are always named on the wire — a silent terminal is unfixable."""
    try:
        await ws.send_text(json.dumps({"type": "error", "detail": detail}))
    except Exception:
        pass
