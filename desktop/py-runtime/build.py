#!/usr/bin/env python3
"""
Bundle the runtime into a standalone executable, so an installed marquee needs
no Python on the machine.

This is Jenny's recipe, kept deliberately intact — the flag list (especially
the uvicorn `--hidden-import`s, which PyInstaller cannot discover on its own
because uvicorn resolves its protocol implementations by string at runtime) is
the part that took the error stages to get right. See
`desktop/shell/vendor/jenny/README.md`.

Two names matter and must not be "tidied":

  * `--name jenny` — the vendored `findPythonExe` looks for
    `resources/python/jenny/jenny[.exe]` first. Renaming the output means
    relying on its recursive-scan fallback for no reason.
  * `--onedir` — a `--onefile` bundle unpacks to a temp dir on every launch,
    which is slower and makes the PTY's cwd surprising.

    python build.py            # build into dist/jenny/
    python build.py --check    # build, then PROVE the bundle serves /health
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
DIST = HERE / "dist"
WORK = HERE / "build"

# Copied from _Gex/cli/commands/build.js. Do not prune without running --check:
# every hidden-import here is a module uvicorn loads by name at runtime.
FLAGS = [
    "--onedir",
    "--name", "jenny",
    "--distpath", str(DIST),
    "--workpath", str(WORK),
    "--specpath", str(HERE),
    "--noconfirm",
    "--exclude-module", "tkinter",
    "--exclude-module", "matplotlib",
    "--exclude-module", "scipy",
    "--exclude-module", "numpy",
    "--exclude-module", "pandas",
    "--exclude-module", "PIL",
    "--exclude-module", "cv2",
    "--exclude-module", "test",
    "--exclude-module", "unittest",
    "--hidden-import", "uvicorn.logging",
    "--hidden-import", "uvicorn.loops",
    "--hidden-import", "uvicorn.loops.auto",
    "--hidden-import", "uvicorn.protocols",
    "--hidden-import", "uvicorn.protocols.http",
    "--hidden-import", "uvicorn.protocols.http.auto",
    "--hidden-import", "uvicorn.protocols.websockets",
    "--hidden-import", "uvicorn.protocols.websockets.auto",
    "--hidden-import", "uvicorn.lifespan",
    "--hidden-import", "uvicorn.lifespan.on",
]


def venv_python() -> str:
    """The runtime's own venv, so the bundle contains the pinned deps."""
    candidates = (
        HERE / ".venv" / "Scripts" / "python.exe",
        HERE / ".venv" / "bin" / "python",
    )
    for candidate in candidates:
        if candidate.exists():
            return str(candidate)
    print(f"! no venv at {HERE / '.venv'} — using {sys.executable}", file=sys.stderr)
    return sys.executable


def exe_path() -> Path:
    return DIST / "jenny" / ("jenny.exe" if sys.platform == "win32" else "jenny")


def build() -> Path:
    python = venv_python()
    # A stale dist is how you ship yesterday's bundle and cannot tell.
    if DIST.exists():
        shutil.rmtree(DIST)
    cmd = [python, "-m", "PyInstaller", *FLAGS, str(HERE / "app.py")]
    print("▸", " ".join(cmd[:6]), "…")
    env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}
    result = subprocess.run(cmd, cwd=HERE, env=env, capture_output=True, text=True)
    if result.returncode != 0:
        sys.stderr.write(result.stdout[-4000:])
        sys.stderr.write(result.stderr[-4000:])
        raise SystemExit(f"PyInstaller failed with exit {result.returncode}")
    exe = exe_path()
    if not exe.exists():
        raise SystemExit(f"PyInstaller reported success but {exe} does not exist")
    size_mb = sum(f.stat().st_size for f in (DIST / "jenny").rglob("*") if f.is_file()) / (1024 * 1024)
    print(f"▸ built {exe} ({size_mb:.1f} MB in dist/jenny/)")
    return exe


def check(exe: Path) -> None:
    """Run the bundle the way the shell will and read /health back.

    A bundle that builds but cannot serve is the failure mode the hidden-import
    list exists to prevent, and it only shows up at runtime.
    """
    port = 18799
    proc = subprocess.Popen(
        [str(exe), "--port", str(port)],
        cwd=exe.parent,
        env={**os.environ, "MARQUEE_PY_RUNTIME_TOKEN": "bundle-check", "JENNY_WORKSPACE_DIR": str(HERE)},
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    try:
        deadline = time.monotonic() + 45
        body = None
        while time.monotonic() < deadline:
            if proc.poll() is not None:
                out = proc.stdout.read() if proc.stdout else ""
                raise SystemExit(f"the bundle exited with {proc.returncode} before answering:\n{out[-3000:]}")
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=2) as response:
                    body = response.read().decode()
                break
            except (urllib.error.URLError, OSError):
                time.sleep(0.5)
        if body is None:
            raise SystemExit(f"the bundle never answered /health on :{port}")
        print("▸ /health from the bundle:", body)
        # The port must have come from argv, proving the orchestrator's prod
        # call shape works and not merely the env fallback.
        if f'"version"' not in body:
            raise SystemExit("unexpected /health body")
        # And the gate must still be on inside a bundle.
        request = urllib.request.Request(f"http://127.0.0.1:{port}/run_code", data=b"{}", method="POST")
        try:
            urllib.request.urlopen(request, timeout=5)
            raise SystemExit("the bundled runtime answered /run_code WITHOUT a token — the gate is not in the bundle")
        except urllib.error.HTTPError as exc:
            if exc.code != 401:
                raise SystemExit(f"expected 401 from an untokened /run_code, got {exc.code}")
            print("▸ gate intact inside the bundle: untokened /run_code → 401")
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


if __name__ == "__main__":
    built = build()
    if "--check" in sys.argv[1:]:
        check(built)
        print("▸ verified: the bundle runs, takes --port from argv, and keeps its token gate")
