# py-runtime — the shell's bundled Python

Spawned and supervised by Jenny's orchestrator (`desktop/ua-shell/vendor/jenny`,
copied verbatim from `aiassistsecure/_Gex` branch `jenny`). Jenny's contract is
two lines long and this runtime honours it: read the port from `JENNY_PORT`, and
answer `GET /health` with 200 JSON so the health monitor can restart us.

## Routes

| route | auth | what |
|---|---|---|
| `GET /health` | none | liveness for the orchestrator |
| `POST /run_code` | `X-UA-Runtime-Token` | one-shot python/node with timeout + output cap |
| `WS /ws/pty?token=&program=shell\|python\|node&cols=&rows=` | `?token=` | a real PTY streamed as binary frames |

Every other route is 401 with a reason. No token configured → 401 on everything
but `/health`, on purpose: an ungated runtime on loopback is a shell for anything
on the machine.

## Dev

```bash
python3 -m venv .venv && . .venv/bin/activate && pip install -r requirements.txt
UA_PY_RUNTIME_TOKEN=dev JENNY_PORT=18764 python app.py
```

Prod is the Jenny recipe: PyInstaller `--onedir --name jenny` → `resources/python/jenny/jenny[.exe]`,
`asarUnpack: resources/python/**`. The flag list lives in `_Gex/cli/commands/build.js`; copy it exactly.

## Windows
`/ws/pty` refuses with close code 4501 until `pywinpty` is wired. `/run_code` and `/health` work everywhere.
