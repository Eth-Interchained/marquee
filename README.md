<div align="center">

# marquee

**The whole broadcast studio in a browser you own.**

Screen or game · a camera in the corner · a real terminal · **record it to MP4** · go live to your own server · and receipts for everything that happened on air.

</div>

---

## The idea

Every creator tool splits the same way: the pixels are yours, the nervous system is rented. Your overlay is hosted by someone else, your alerts route through their cloud, your multi-destination fan-out is a subscription tier, and the record of what went out on your stream is a row in a database you cannot read.

marquee is the other arrangement. The compositor runs in your browser. The ingest server is a single binary on your VPS. The terminal is a real pseudo-terminal from the Python that ships inside the app. And every on-air event — a source added, a scene saved, a recording started and saved and finalised, a go-live, a stream end — is an append-only, hash-chained document in a local [NEDB](https://github.com/Eth-Interchained/nedb) store, so *what happened on my stream* is a question you can answer with proof instead of a screenshot.

**Lineage, stated plainly:** marquee is a fork of [UA Social Browser](https://github.com/aiassistsecure/ua-social-browser) and keeps its shell wholesale — per-workspace session isolation, UA profiles, live in-shell sign-in, and the human-approved publishing path. That is deliberate. A creator streams *and* posts, from the same identities, on the same machine. The Studio, recording, the Terminal, Go Live and the receipts are what marquee adds on top.

## What's in it

| | |
| --- | --- |
| **Studio** | Screen or game capture through the shell's own source picker, your camera in a draggable corner (rect / rounded / circle, mirrored), a WebAudio mixer with live meters. One canvas — it is the preview *and* the broadcast; there is no second render path to disagree with what you see. |
| **Record** | The primary act. The canvas plus the mix goes to disk in your Videos folder, one chunk per second — nothing is buffered in the page, so an hour-long take costs the renderer nothing and a crash costs the tail, not the take. Then the bundled Python finalises it to a real **MP4** by *copying* the H.264 stream: no second generation of loss, ~24x realtime. Chromium will hand you the right codec or the right container but never both, so marquee records H.264/opus Matroska and remuxes — and a take is never deleted, not on abort, not on a failed finalise. |
| **Go Live** | The canvas plus the mix leaves as **one** WebRTC stream over WHIP to a [mediamtx](https://github.com/bluenviron/mediamtx) you run. That server serves HLS/WebRTC viewers and fans out to Twitch / YouTube / Kick with one ffmpeg tee. Your machine uploads once. |
| **Terminal** | A real PTY — colours, cursor, `vim`, `htop` — served by the Python bundled inside the app. Shell, a Python REPL, or Node. No native Node addon, so no rebuild-per-Electron-version ladder. |
| **Receipts** | Every on-air event is a document chained to what caused it. `trace` walks the causes and the effects; the store's Merkle head and `verify()` come back with every write. Scenes are versioned documents. |
| **Social** | Inherited and intact: AI drafts, a human approves, and the post leaves through the session *you* are signed into. Twelve networks. No server-held token, no bot account. |

## The rules the code actually enforces

1. **Nothing on air is unrecorded, and nothing recorded is silent.** A receipt that fails to write shows up as a visible notice. The ledger never blocks the stream, and the stream never escapes the ledger quietly.
2. **The page never holds a capability.** The bundled Python refuses every route but `/health` without a per-launch token, and that token lives in the shell and its loopback proxy — never in a renderer. Loopback is not an authorization boundary.
3. **A screen is never guessed.** `getDisplayMedia()` is answered with exactly the one source you picked, once, and an unarmed request is refused with the reason. Broadcasting the wrong window is worse than not broadcasting.
4. **No approval, no post.** Edit an approved draft and the sign-off clears, because it was on that exact text — and on that exact picture.
5. **No fake success.** No shell attached, no ingest server, no `pywinpty` on Windows: each answers with its own reason. Nothing ever reports something that did not happen.

What it will not become: a bulk poster, a scraper, an engagement farm, or a stealth automation kit.

## How it fits together

```
┌──────────────────────────────────────────────────────────────────┐
│  shell  (Electron — the browser, the publisher, the runtime host)│
│                                                                  │
│  ┌────────────────────┐   ┌────────────────────────────────────┐ │
│  │ Workspace view     │   │ Privileged page                    │ │
│  │ x.com, signed in   │   │ Studio · Terminal · drafts · AI    │ │
│  │ isolated session   │   │ window.marqueeShell injected here  │ │
│  └────────────────────┘   └────────────────────────────────────┘ │
│         │                        │              │                │
│         └─ session bridge ───────┤              └─ /runtime/* ──┐ │
└──────────────────────────────────┼──────────────────────────────┼─┘
                                   │                             │
              ┌────────────────────▼────────┐   ┌────────────────▼────────────┐
              │ api-server                  │   │ py-runtime (bundled Python) │
              │ approvals · scheduler · AI  │   │ /ws/pty · /run_code         │
              │ receipts + ledger (NEDB)    │   │ token-gated, loopback only  │
              └─────────────────────────────┘   └─────────────────────────────┘
                                   │
                    canvas ──WHIP──▼── mediamtx (your VPS) ──▶ HLS · WebRTC · RTMP fan-out
```

Each workspace is a separate browsing identity: its own cookie jar, profile directory, User-Agent and Client Hints, timezone. Workspaces cannot see each other's sessions, and the active identity is always in the toolbar — you should never be unsure which account you are about to post from, or stream as.

## Repository map

| Path | What lives there |
| --- | --- |
| `desktop/shell` | The Electron shell: workspace contexts, UA metadata, toolbar, publisher adapters, session bridge, the Python-runtime host, the screen-capture broker |
| `desktop/shell/vendor/jenny` | Jenny's Python orchestrator, **copied verbatim** (sha256 pinned) — spawn, health-poll, backoff restart, log rotation. Never edited; wrapped |
| `desktop/py-runtime` | The bundled Python: `/health`, token-gated `/run_code`, `/ws/pty` |
| `artifacts/studio` | The renderer: Studio, Terminal, network view, AI composer, review queue, UA profiles |
| `artifacts/api-server` | Approvals, scheduler, AI proxy, and the append-only ledger + Studio receipts |
| `deploy/mediamtx` | Ingest config (WHIP in → HLS/WebRTC out) and `fanout.py` (one ffmpeg tee → the platforms) |
| `lib/api-spec` | The OpenAPI contract — the single source of truth |
| `lib/api-client-react`, `lib/api-zod` | Generated client hooks and validators. **Never edit by hand** |

The contract comes first: change `lib/api-spec/openapi.yaml`, run codegen, and both sides move together.

## Quick start

```bash
pnpm install
pnpm --filter @marquee/api-spec run codegen   # after any OpenAPI change
pnpm run typecheck                            # libs + every artifact + the shell

# the bundled Python (the Terminal). Once per checkout.
(cd desktop/py-runtime && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt)

# build the two halves the shell hosts, then run the real thing
PORT=5173 BASE_PATH=/ pnpm --filter @marquee/studio run build
pnpm --filter @marquee/api-server run build
pnpm --filter @marquee/shell run start
```

`AIASSIST_API_KEY` is needed for the AI features; copy `.env.example`. The key is read only by the API server and never reaches a renderer.

Going live needs mediamtx on a host you control — ports, Cloudflare caveats (WebRTC media cannot ride the orange cloud), TURN, and the fan-out env file are all in [DEPLOY.md](./DEPLOY.md).

## Trying it without the desktop shell

The web surface is a development surface, and it says so rather than faking:

- **Terminal**: "No runtime to connect to", with the reason from `/runtime/health`. There is no shell, so there is no Python.
- **Studio**: works, using the browser's own share picker instead of ours. Browser audio only comes with a Chrome *tab* share — the panel says that too.
- **Network view**: an explicit "runs in the desktop shell" state, not a mocked feed.
- **Publishing**: `503`. There is no session to post through.

Everything else — drafting, approving, scheduling, the ledger, receipts, integrity — works there.

## The ledger

State and receipts are append-only `nedb-engine` documents, scoped by tenant id. Nothing is overwritten in place:

```bash
curl localhost:8080/api/browser/integrity                      # verified, sequence, head
curl 'localhost:8080/api/studio/events?workspaceId=<ws>'       # what happened on air, newest first
curl localhost:8080/api/studio/events/<id>/trace               # its causes, and its effects
```

Single-tenant — one person, one machine — with a tenant key on every document, so multi-tenant is a change of resolver rather than a migration. `MARQUEE_TENANCY_MODE=multi` requires an auth layer to supply the tenant; there is deliberately no fallback, because a silent one would leak one account's workspaces into another's.

## Honest status

**Verified on real systems:** the shell boots and runs headless end to end (Jenny spawns the Python runtime, health goes green, a real PTY answers through the cookie-gated proxy, a Python REPL evaluates, the Studio composites at 60 fps, `desktopCapturer` enumerates displays). Recording end to end from the live compositor: a 1920x1080 take written to `~/Videos/marquee`, finalised through the runtime, and confirmed with **ffprobe** (not the library that wrote it) as `QuickTime / MOV`, `h264`, 4.957 s, 149 frames, 30.06 fps average, full decode pass with zero errors. WHIP publish against a real mediamtx: `201` + SDP answer, ICE connected, session publishing, `DELETE` tears it down. RTMP fan-out end to end: publish → tee → a second live path serving a real HLS playlist with real segments. The X publishing adapter posted for real from the macOS shell on 2026-09-02.

**Not verified yet:** a browser WHIP publish to a public VPS (real frames from the Studio to real viewers), macOS and Windows shell behaviour for the new sections, `pywinpty` for a Windows PTY, and packaging the Python bundle into the installers. The composer selectors for LinkedIn, Facebook, Threads, Bluesky, Mastodon and Tumblr are written from how those products work and have not each had a real post yet — when a selector drifts the attempt fails loudly rather than reporting a post that did not happen.

## License

GNU General Public License v3.0 or later — see [LICENSE](./LICENSE).

If you distribute a modified version, your changes stay free software too. That is deliberate: a tool whose whole premise is that a person stays in control of what goes out — on air or in a post — should not be quietly forked into an autopilot behind a closed door.

© Interchained LLC
