# py-runtime — the shell's bundled Python

Spawned and supervised by Jenny's orchestrator (`desktop/shell/vendor/jenny`,
copied verbatim from `aiassistsecure/_Gex` branch `jenny`). Jenny's contract is
two lines long and this runtime honours it: read the port from `JENNY_PORT`, and
answer `GET /health` with 200 JSON so the health monitor can restart us.

## Routes

| route | auth | what |
|---|---|---|
| `GET /health` | none | liveness for the orchestrator |
| `POST /run_code` | `X-Marquee-Runtime-Token` | one-shot python/node with timeout + output cap |
| `WS /ws/pty?token=&program=shell\|python\|node&cols=&rows=` | `?token=` | a real PTY streamed as binary frames |

Every other route is 401 with a reason. No token configured → 401 on everything
but `/health`, on purpose: an ungated runtime on loopback is a shell for anything
on the machine.

## Dev

```bash
python3 -m venv .venv && . .venv/bin/activate && pip install -r requirements.txt
MARQUEE_PY_RUNTIME_TOKEN=dev JENNY_PORT=18764 python app.py
# or the shape the packaged exe is started with:
MARQUEE_PY_RUNTIME_TOKEN=dev python app.py --port 18764
```

Tests (stdlib only — this gets bundled, so it carries no test dependency):

```bash
.venv/bin/python -m unittest discover -s . -p 'test_*.py'
```

## Bundling

```bash
.venv/bin/python build.py --check
```

Jenny's recipe, kept intact: `--onedir --name jenny`, plus the uvicorn
`--hidden-import`s PyInstaller cannot discover on its own (uvicorn resolves its
protocol implementations by string at runtime). The name and the layout are not
cosmetic — `resources/python/jenny/jenny[.exe]` is the *first* path the
vendored `findPythonExe` checks, and `desktop/shell/test/packaging.test.ts`
asserts the electron-builder `extraResources` mapping still lands there.

`--check` runs the bundle the way the shell will and reads `/health` back,
then confirms an untokened `/run_code` is still 401 — a bundle that builds but
cannot serve, or that loses its gate, is the failure the hidden-import list
exists to prevent and it only appears at runtime.

## Windows

`/ws/pty` uses ConPTY through `pywinpty` (`winpty_session.py`;
platform-conditional in `requirements.txt`). **That path has never been run on
Windows** — it is written from pywinpty's documented API. It is wired instead
of refused because it names what breaks rather than guessing: no pywinpty
closes with 4501 and says to install it, a failed spawn closes with 4502 and
the exception text, and anything later arrives as an `{"type":"error"}` frame.
Treat a green result as "someone ran it on Windows", never as tested.

`/run_code` and `/health` work everywhere.
