---
name: The bundled Python runtime and the Terminal
description: Why Jenny's orchestrator is vendored verbatim, how the runtime is gated, and why the terminal is a PTY served by Python rather than a Node addon.
---

The shell runs a second child beside the API server: a Python runtime
(`desktop/py-runtime/app.py`), supervised by Jenny's orchestrator copied
**byte-for-byte** into `desktop/ua-shell/vendor/jenny` from
`aiassistsecure/_Gex` branch `jenny`.

## The vendored files are not ours to edit

`vendor/jenny/orchestrator/*.js` and `vendor/jenny/electron/*.js` are verbatim,
with their sha256 pinned in `vendor/jenny/README.md`.

**Why:** the owner spent the error stages getting that spawn / health-poll /
backoff-restart / log-rotation loop stable, and asked for it to be reused, not
rewritten. A TypeScript "port" would be a new set of bugs wearing old names.

**How to apply:** anything the shell needs that Jenny lacks goes in
`src/python-runtime.ts` *around* the orchestrator — never inside it. The type
declaration `orchestrator/index.d.ts` and the `vendor/jenny/package.json`
(`type: commonjs`, so Node does not parse the .js as ESM) are ours; the .js is
not. If the pins stop matching, someone edited them: revert, then wrap.

## Loopback is not an authorization boundary — for this child too

The runtime refuses every route but `/health` without the token the shell
minted for this launch. The page never holds the token: `/runtime/*` on the
privileged origin is proxied by `ui-server.ts`, which adds the token on the way
out and drops any inbound copy; WebSocket upgrades under `/runtime/ws/*` are
spliced the same way with the token moved into the query string.

**Why:** Jenny's reference runtime binds loopback with CORS `*` and no token,
which is fine for a single-app framework and an open shell for anything on the
machine here.

**How to apply:** the token reaches the child through `process.env` inside
`withRuntimeToken()` — set immediately before `orchestrator.start()`, removed
immediately after, because Jenny spawns with `{ ...process.env }` and takes no
env option. `spawn` runs synchronously inside `start()`, so no other child
(the API server, a workspace surface) ever inherits it. A test asserts the
variable is gone from the parent after spawn.

## The runtime's stdout is a file on disk — never log the token

Found by booting the real shell headless: uvicorn's access log printed the PTY
WebSocket target, `?token=…` included, and Jenny's LogAggregator wrote it to
`.jenny/logs`. Fixed by disabling `uvicorn.access` at IMPORT time in `app.py`.

**Why import time:** in development Jenny launches `python -m uvicorn app:app
--reload`, which never calls `main()`. Anything only `main()` configured
(logging, access_log=False) silently did not apply — the first fix attempt
proved that.

**How to apply:** log the events that matter (`pty spawned`, `run_code`)
explicitly, without the token; grep the shell log for `token=` after any
change to the runtime's logging — the count must not grow.

## The terminal is a PTY served by Python, not node-pty

`/ws/pty` forks a real pseudo-terminal (stdlib `pty`) for one of a closed list
of programs — `shell`, `python`, `node` — and streams bytes to xterm.js.

**Why:** node-pty is a native addon that has to be rebuilt per Electron version
per platform, the ladder that ate a whole KeyStone-Lite night. The bundled
Python already ships with the app, and `pty` is in its standard library, so
the terminal costs zero native Node code. The program list is closed because
the page must not be able to choose argv.

**How to apply:** Windows needs `pywinpty` and is refused with close code 4501
until it is wired — say so in the UI, do not fake a shell. Adding a program
means adding it to `PROGRAMS` in `app.py`, nothing renderer-side.

## A runtime that cannot start costs the Terminal, not the app

`startPythonRuntime` failing is logged and the shell continues; the Terminal
section reads `/runtime/health` and shows the runtime's own reason (503 with
`runtime_unavailable` when there is no runtime, which is also the truthful state
of the web development surface).

**Why:** the operator's accounts and drafts do not depend on Python; refusing to
open the browser because a venv is missing would be the wrong trade.

**How to apply:** `UA_PY_RUNTIME=0` disables it deliberately; `UA_PY_RUNTIME_DIR`
points at a different `app.py`. Dev needs `desktop/py-runtime/.venv` (see its
README); packaged builds carry the PyInstaller bundle under `resources/python`
and Jenny's `findPythonExe` locates it — keep its recursive scan, the CI recipe
and the CLI name the executable differently.
