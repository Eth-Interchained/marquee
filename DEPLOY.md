# Deploying marquee

This project has two halves that ship on different tracks:

| Half | What it is | Where it runs |
| --- | --- | --- |
| **Workspace surface** (`artifacts/studio`, `artifacts/api-server`) | The sidebar UI, the AI endpoints, the review queue, the ledger | Replit today; embedded in the desktop shell in production |
| **Native shell** (`desktop/shell`) | A Chromium desktop browser with per-workspace session isolation, UA profiles, and the session bridge | Built and signed on your own machines |

The Replit artifact is the **development surface** for the shared UI and API. It is
not the shipped product, and it deliberately cannot post to any network — see
[Why publishing fails on the web surface](#why-publishing-fails-on-the-web-surface).

---

## First test run, start to finish

Verified from a **clean clone** on 2026-09-09 (Linux, headless): every command
below in order, then the app boots with the Terminal live and the Studio
compositing.

```bash
git clone https://github.com/Eth-Interchained/marquee.git && cd marquee
pnpm install
pnpm --filter @marquee/api-spec run codegen
pnpm run typecheck

# the bundled Python — the Terminal. Once per checkout.
(cd desktop/py-runtime && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt)

# the two halves the shell hosts
PORT=5173 BASE_PATH=/ pnpm --filter @marquee/studio run build
pnpm --filter @marquee/api-server run build

pnpm --filter @marquee/shell run start
```

**The first `start` is slow and looks stuck — it is downloading Electron
(~282 MB).** `pnpm`'s `onlyBuiltDependencies` allowlist in
`pnpm-workspace.yaml` does not include `electron`, so its postinstall never
runs and the binary is fetched lazily on first use instead. It self-heals;
subsequent launches are immediate. If you would rather pay that cost during
`pnpm install`, add `electron` to that allowlist.

What you should see, in order:

1. Shell log: `API server ready` → `Python runtime healthy` → `Shell ready`,
   with **zero** `"level":"error"` lines.
2. **Terminal** → badge reads `runtime · py 3.x · gated`. If it says
   **UNGATED**, stop and report it — the capability token failed to reach the
   child. A shell prompt opens by itself; `ls --color`, `htop` and `vim` should
   all behave. Resize the window and the shell reflows.
3. **+ Python** → a REPL; `6*7` → 42. **+ Node** → a `>` prompt.
4. **Studio** → `1920×1080 · <n> fps`, a dark canvas with "Screen: no source"
   and a rounded camera box bottom-right. Receipts shows a head and a green
   shield.
5. **Share screen / game** → *marquee's own* picker with thumbnails, not
   Chrome's. On macOS the first attempt will likely show the permission dialog
   instead — that is correct, see §5c.
6. **Camera** → your face, mirrored, in the corner. Drag it; corner-resize
   keeps 16:9; Shape → Circle stays round.
7. **Microphone** → a channel with a moving meter.
8. Everything you do appears in **Receipts** with a sequence number and a cause
   count, and the head changes on every write.

Going live additionally needs an ingest server — §5b, one command.

---

## Running it, in one paragraph

Run `pnpm install`, then `pnpm --filter @marquee/api-spec run codegen` to
generate the client from the OpenAPI contract, and `pnpm run typecheck` to
confirm the tree is sound. Create the Python runtime's venv once
(`cd desktop/py-runtime && python3 -m venv .venv && .venv/bin/pip install -r
requirements.txt`) or the Terminal will report that it has nothing to connect
to. For the development surface, start the two services —
`pnpm --filter @marquee/api-server run dev` (builds and serves the API on
`PORT`, mounted at `/api`) and `pnpm --filter @marquee/studio run
dev` (the Vite dev server for the sidebar UI) — which is all you need for
drafting, approving, scheduling, and the ledger; publishing answers `503` there
because there is no signed-in session to post through. For the real product,
build both halves the shell hosts with `PORT=5173 BASE_PATH=/ pnpm --filter
@marquee/studio run build` and `pnpm --filter @marquee/api-server
run build`, then launch `pnpm --filter @marquee/shell run start`, which
builds the Electron shell, spawns its own API server on loopback, and opens the
browser — this one needs a desktop with a display and will not run in the Replit
container. Set `AIASSIST_API_KEY` before you expect any AI feature to answer.

---

## 1. Prerequisites

- Node 24 and pnpm (already provisioned in the Replit container)
- `AIASSIST_API_KEY` — set as a Replit Secret; it never leaves the API server
- For the native shell: a desktop OS with a display. The shell is a Chromium
  (Electron) application; it cannot run in the Replit container, which has no
  GUI. Everything in it except the browser windows themselves — the session
  bridge, the idempotency ledger, the UA/Client-Hints derivation, the privileged
  origin — is covered by `pnpm --filter @marquee/shell run test`, which does
  run here.

### If the build cannot find a native binary

```
Error: Cannot find module @rollup/rollup-darwin-x64
```

Rollup, esbuild, lightningcss and Tailwind's oxide each ship one compiled binary
per platform, pulled in as an optional dependency. The workspace template this
repo grew out of excluded every non-linux-x64 one, because Replit only runs
linux-x64 — which quietly made the repo unbuildable on the Mac and Windows
machines that package the desktop shell. Those exclusions are gone; pnpm picks
the binary for whatever host it is installing on.

If you are on a checkout from before that change, the old lockfile is still in
your tree and `node_modules` still reflects it:

```bash
git pull
rm -rf node_modules */node_modules **/node_modules
pnpm install
```

## 2. Environment variables

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `AIASSIST_API_KEY` | yes | — | Credential for `api.AiAssist.net`. Server-side only. The former spelling `AIAssIST_API_KEY` is still read as a fallback and logs a deprecation warning on first use; migrate and delete it, because two names for one credential is how an environment ends up with a stale copy nobody notices. |
| `PORT` | injected | `8080` | Assigned per artifact by Replit. Never hard-code it. |
| `NEDB_DATA_DIR` | no | `<cwd>/.data/marquee` | Append-only ledger location. Point it at a persistent volume in the desktop build. |
| `MARQUEE_SESSION_BRIDGE_URL` | no | unset | Loopback address of the native shell's publisher IPC endpoint. **Unset means publishing is disabled.** |
| `MARQUEE_SESSION_BRIDGE_TOKEN` | with the above | unset | Capability token the shell mints at startup. The shell refuses every bridge call without it, so an address on its own also means publishing is disabled. Set by the shell for the API server it starts; never commit it. |
| `MARQUEE_API_ACCESS_TOKEN` | in the shell | unset | When set, every `/api` request must present it in `X-Marquee-Api-Token` and CORS is switched off entirely. The shell mints one for the API server it starts, and reads this variable to pair with an API server you run yourself. Unset on the web surface, which holds no publishing capability. |
| `HOST` | no | `0.0.0.0` | Interface to bind. The shell sets `127.0.0.1`; Replit needs the default so its proxy can reach the artifact. |
| `MARQUEE_TENANCY_MODE` | no | `single` | `single` scopes every document to the `personal` tenant. `multi` requires an auth layer to set `res.locals.tenantId` and returns 401 without one. |
| `MARQUEE_SCHEDULER_INTERVAL_MS` | no | `30000` | How often the scheduler looks for scheduled posts that are due. `0` switches automatic dispatch off; a scheduled post then waits for someone to press Post. Ignored in multi-tenant mode — see [Scheduled dispatch](#6-scheduled-dispatch). |

Read by the native shell only (`desktop/shell`):

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `MARQUEE_WORKSPACE_UI_URL` | no | unset | Load the sidebar from a running dev server instead of the built bundle. Development only. |
| `MARQUEE_WORKSPACE_UI_DIR` | no | `artifacts/studio/dist/public` | Built sidebar to serve from the shell's privileged origin. |
| `MARQUEE_API_SERVER_ENTRY` | no | `artifacts/api-server/dist/index.mjs` | API server bundle the shell spawns. |
| `MARQUEE_API_SERVER_URL` | no | unset | Use an already-running API server instead of spawning one. That server only publishes if it was itself started with `MARQUEE_SESSION_BRIDGE_URL`. |
| `MARQUEE_SHELL_BRIDGE_PORT` | no | `0` (OS-assigned) | Fix the session bridge port when an externally-run API server needs a stable `MARQUEE_SESSION_BRIDGE_URL`. |
| `MARQUEE_SHELL_PAIRING_FILE` | no | unset | Path to write the bridge address **and its capability token** for an API server you start yourself. Owner-readable only, and off by default. Delete the file once the API server has read it. |
| `MARQUEE_PY_RUNTIME` | no | `1` | `0` starts the shell without the bundled Python runtime (and therefore without the Terminal). A runtime that fails to start never blocks the shell; the Terminal section shows the reason. |
| `MARQUEE_PY_RUNTIME_DIR` | no | `desktop/py-runtime` (checkout) / `resources/python` (packaged) | Where `app.py` lives in development, or where the PyInstaller bundle lives in a packaged build. Jenny's `findPythonExe` locates the executable under it. |

The shell also sets `MARQUEE_PY_RUNTIME_TOKEN` and `JENNY_PORT` for the Python
runtime it spawns — the token only for the instant of the spawn, so no other
child inherits it. Do not set either by hand.

The shell sets `MARQUEE_SESSION_BRIDGE_URL`, `MARQUEE_SESSION_BRIDGE_TOKEN`, `PORT` and
`NEDB_DATA_DIR` for the API server it spawns; do not set those for it by hand.

## 3. Running the workspace surface

```bash
pnpm install
pnpm --filter @marquee/api-spec run codegen   # after any OpenAPI change
pnpm run typecheck                              # libs + all artifacts
```

Both services run as Replit workflows and restart on their own:

- `artifacts/api-server: API Server` → `http://localhost:8080`, mounted at `/api`
- `artifacts/studio: web` → the Vite dev server, preview path `/`

Smoke test the API:

```bash
curl -s localhost:8080/api/healthz
curl -s localhost:8080/api/tenant
curl -s localhost:8080/api/browser/integrity
curl -s "localhost:8080/api/session/status?workspaceId=ws-1"
curl -s localhost:8080/api/schedule/status
```

## 4. Publishing the web surface on Replit

Use the workspace's Publish flow (Autoscale). It deploys the sidebar UI and the
API server. Set `AIASSIST_API_KEY` in the deployment's secrets — deployment
secrets are separate from development secrets. Leave `MARQUEE_SESSION_BRIDGE_URL`
unset in that environment.

The ledger writes to local disk, so an Autoscale deployment treats its store as
ephemeral. Anything you want to keep lives on the desktop build.

## 5. The native shell

The shell lives in `desktop/shell` and is a Chromium browser built on
Electron, not a source-patched Chromium fork. Electron *is* Chromium: its
`session.fromPartition('persist:ua-<workspaceId>')` is a real `BrowserContext`
with its own on-disk profile directory, and CDP `Emulation.setUserAgentOverride`
is the same mechanism a patched build would drive. A fork would add a multi-hour
build and a permanent rebase burden for capabilities already exposed here.

### Build and run

```bash
pnpm install

# the two halves the shell hosts
PORT=5173 BASE_PATH=/ pnpm --filter @marquee/studio run build
pnpm --filter @marquee/api-server run build

# the bundled Python (the Terminal). Once per checkout; the shell finds .venv itself.
(cd desktop/py-runtime && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt)

pnpm --filter @marquee/shell run start   # builds, then launches Electron
```

Without the venv the shell still starts; the Terminal section reports that the
runtime did not come up and names the interpreter it tried. Packaged builds
carry Python inside the app (PyInstaller `--onedir` under `resources/python`,
Jenny's recipe — `desktop/shell/vendor/jenny/README.md`), so end users need
no Python installed.

The UI build needs `PORT` and `BASE_PATH=/`: its Vite config reads both, and the
shell serves the bundle from the root of its own origin.

`pnpm --filter @marquee/shell run test` runs the shell's own suite: the
bridge contract, the idempotency ledger, UA/Client-Hints derivation, the
privileged origin's gate, and workspace-directory parsing. None of it needs a
display.

### What it provides

1. **Workspace isolation** — `src/partition.ts` and `src/workspace-contexts.ts`.
   One partition per workspace, stored under `<userData>/Partitions/`: separate
   cookies, storage, service workers, and cache. The key is
   `persist:ua-<readable>-<digest>`, where the readable part is the sanitised
   workspace id and the digest is taken from the *raw* id — sanitising alone
   would let `team/a` and `team-a` land in one cookie jar, which is a
   cross-account session leak. The main process derives the key; the workspace
   UI is told which partition it got and never reconstructs one.
2. **UA profile application** — `src/ua-metadata.ts`, applied in
   `workspace-contexts.ts`. Per-context `User-Agent` and `Accept-Language` on the
   session (so subresources match), plus `Emulation.setUserAgentOverride` with
   `userAgentMetadata` and `Emulation.setTimezoneOverride` per view (so
   `navigator.userAgentData`, `Date`, and `Intl` agree with the headers). Every
   `Sec-CH-UA*` value is derived from the UA string itself, and a non-Chromium UA
   emits no client hints at all — Safari and Firefox do not send them, and
   inventing them would be a tell.
   *Known limit:* a UA string cannot distinguish Windows 10 from 11, and Chrome
   freezes macOS at `10_15_7`. The hints report what the UA says rather than
   inventing a plausible platform version.
3. **Toolbar indicator** — `src/renderer/toolbar.ts`. The workspace name, the UA
   profile name and label ("Chrome 131 · macOS"), and the timezone stay visible
   whatever is on screen, alongside the workspace tabs.
4. **Privileged sidebar** — `src/ui-server.ts` + `src/preload/`. The workspace UI
   is served from a loopback origin that also proxies `/api` to the API server,
   so the shared UI's relative fetches work unchanged. That origin is gated by a
   random cookie set only in the privileged view's session. That one view gets a
   preload that installs `window.marqueeShell`; workspace surfaces, workspace tabs,
   and the hidden publish window get **no preload at all**, so page content has
   no bridge, no IPC, and no route to the API. The main process also rejects any
   bridge IPC that does not come from the privileged view, and blocks that view
   from navigating off its own origin.
5. **Publisher endpoint** — `src/session-bridge-server.ts`, bound to 127.0.0.1
   and gated by a capability token. The shell starts it *before* the API server
   and passes its address and token as `MARQUEE_SESSION_BRIDGE_URL` and
   `MARQUEE_SESSION_BRIDGE_TOKEN`, which is the only way an API server ever gets
   either.

### The bridge is not "protected by loopback"

The human approval that gates publishing is enforced in the API server. Anything
that can call the bridge directly posts through the operator's live sessions
with no approval at all — and every other process on the machine can reach
127.0.0.1. So the shell mints a 256-bit token at startup and refuses any bridge
request that does not carry it in `X-Marquee-Shell-Token`, before parsing the body
and before the publisher is consulted. Because it is a custom header, a web page
cannot send it either: cross-origin requests either fail preflight (never
approved here) or arrive without it.

The token is never logged and has no default on-disk location. To pair an API
server you start yourself, launch the shell with `MARQUEE_SHELL_PAIRING_FILE=/path`;
it creates that file exclusively and owner-only (`0600`), and warns that the
file is a live capability. Delete it after use. An existing file or a symlink at
that path is refused rather than written through — anything already there could
be someone else's, and the contents can publish through your sessions.

### Nor is the API server behind it

The API server the shell starts inherits that capability, so reaching *it* is as
good as reaching the bridge. Three things close that path:

- it binds `127.0.0.1`, so nothing on the LAN can see it;
- it requires `MARQUEE_API_ACCESS_TOKEN` in `X-Marquee-Api-Token` on every `/api` request,
  and the shell's UI proxy is the only holder — an inbound copy of that header
  is dropped and replaced, so a caller cannot supply its own;
- with the token configured, CORS is off, so no page can call it cross-origin.

Everything inside the shell that talks to the API carries the token: the UI
proxy and the workspace directory the toolbar and publisher read from.

If you point the shell at your own API server with `MARQUEE_API_SERVER_URL`, that
server receives the bridge capability, so gating it is **required**, not
advisory:

- run it with `HOST=127.0.0.1` and a `MARQUEE_API_ACCESS_TOKEN`;
- start the shell with the same `MARQUEE_API_ACCESS_TOKEN`.

Without it the shell refuses to start and tells you why. It will not open the
privileged UI or the bridge onto an ungated API server.

### Approval is read, not asserted

`POST /api/publish` no longer believes the `approval` block in the request —
whoever sends the request writes those fields. It loads the draft from the
ledger and requires that it is there, that a person signed it off, that the
workspace and network match, and that the submitted text is *exactly* the
approved text. An approved draft id is not a licence to post something else.

### How a post goes out

`src/publisher/`. The shell opens the network's composer in a hidden window
inside that workspace's own partition and UA profile, types the approved body,
submits, and waits for the network's own confirmation. Same cookies, same
profile, same session the operator sees in the workspace tab — there is no API
token and no headless impersonation anywhere in this path.

- **Session detection** covers all twelve networks by cookie. Bluesky and
  Mastodon report "cannot tell from cookies" instead of guessing: Bluesky keeps
  its session in local storage, and a Mastodon session belongs to whichever
  instance the workspace uses.
- **Seven networks are driven; five refuse for a stated reason.** X has its own
  adapter; LinkedIn, Facebook, Threads, Bluesky, Mastodon and Tumblr run through
  the shared composer flow in `src/publisher/compose-driver.ts` (probe the page,
  open the composer, type, submit, wait for the network's confirmation).
  Instagram and Pinterest are driven upload-first: the picture goes in before
  the caption, and a post with no attachment is refused. TikTok and YouTube
  refuse because a post there needs a video and an upload wizard this build
  does not drive; Reddit refuses because it needs a community and a title the
  draft model does not carry. Pinterest publishes to whichever board is
  already selected — it does not choose one. A refusal names its
  reason and points at the workspace tab; the draft stays approved.
  *Verified:* X, on 2026-09-02 — one real post from the macOS shell, confirmed
  by X, shown as posted with a live link. *Unverified:* the six shared-composer
  adapters have not been run against a real signed-in account. Selector drift
  surfaces as a loud failure, never as a phantom post, but each deserves one
  real post before it is trusted.
- **Ambiguous outcomes never look like success.** If the post was submitted but
  no confirmation arrived within the deadline, the shell answers `409` and
  records the key as spent, so a retry replays that answer instead of risking a
  duplicate. The operator checks the account; the shell does not guess.
- The publish attempt is bounded at 17s so the shell — not the API server's 20s
  timeout — decides what an unfinished attempt means.

### `window.marqueeShell` (renderer contract)

Typed in `artifacts/studio/src/lib/shell-bridge.ts`:

- `attachSurface(container, options)` — mounts a workspace-isolated Chromium view
- `openInWorkspaceTab(workspaceId, url)` — opens that workspace's tab, or steers
  the one it already has: one tab per workspace, never two views of one session
- `getSessionStatus(workspaceId)` — reports whether that session is signed in

### Session bridge (HTTP contract)

The shell listens on loopback; the API server calls it. Consumed by
`artifacts/api-server/src/lib/session-bridge.ts`.

Every request carries `X-Marquee-Shell-Token`; without it, every route answers `401`
with a `detail` and nothing else happens — including the sign-in route, because
opening a tab in the operator's browser is a real side effect, not a read.

```
GET /session/:workspaceId[?platform=x]
  200 { authenticated: boolean, accountHandle?: string, detail?: string }

POST /signin/:workspaceId
  body (optional) { platform?: string }
  200 { opened: boolean, alreadySignedIn: boolean, detail: string }
  400 { detail }  → the body was sent but could not be read

POST /publish
  body { workspaceId, draftId, platform, body, idempotencyKey }
  200      { postUrl?: string, postId?: string }
  401/403  { detail: string }   → surfaced as "session not signed in"
  4xx/5xx  { detail: string }   → surfaced as "the platform rejected the post"
```

`idempotencyKey` is derived from the draft id plus its approval timestamp, so a
retry after a network stall cannot double-post. The shell keeps the spent keys in
`<userData>/publish-ledger.json` and records only terminal results: a post that
went out, and a post whose outcome could not be confirmed. "Not signed in" is not
terminal — the operator signs in and the same approved draft goes out.

## 5b. Go Live ingest (mediamtx)

The Studio sends ONE WebRTC stream (WHIP) to a mediamtx you run; mediamtx serves
viewers (HLS on :8888, WebRTC/WHEP on :8889) and, when enabled, fans out to
RTMP destinations. Single Go binary, no root, no /etc footprint.

**One command, on the VPS:**

```bash
git clone https://github.com/Eth-Interchained/marquee.git
cd marquee/deploy/mediamtx && bash install.sh
```

It downloads the binary, writes `~/marquee-ingest/mediamtx.yml` with **your
public IP** and a **generated publisher password**, creates
`~/.config/marquee/fanout.env` (0600) for stream keys, starts it in a tmux
session called `marquee-ingest`, **verifies it by reading its own API** (and
refuses to claim success otherwise), and prints exactly what to type into the
Studio. Re-running is safe — it keeps your password and your keys.

Those two generated values are the ones that are wrong by default and fail
*quietly*: an empty `webrtcAdditionalHosts` gives you a clean `201` and then an
ICE timeout, which reads like a broken server rather than a server that never
said where it was.

Two things the script cannot do for you, and says so at the end:

- **open the firewall** — TCP 8889 (WHIP/WHEP), TCP 8888 (HLS), **UDP 8189 (ICE media)**
- **point `live.ne-db.com` at the VPS on a GREY-CLOUD record** — WebRTC media
  cannot ride Cloudflare's proxy; orange cloud gives you a clean handshake and
  then silence.

<details><summary>By hand, if you prefer</summary>

```bash
curl -sSL -o mediamtx.tgz https://github.com/bluenviron/mediamtx/releases/download/v1.21.0/mediamtx_v1.21.0_linux_amd64.tar.gz
tar xzf mediamtx.tgz
cp <checkout>/deploy/mediamtx/mediamtx.yml .
# EDIT: authInternalUsers → marquee password; webrtcAdditionalHosts → ['<VPS public IP>']
#       and the absolute fanout.py path in runOnAvailable
./mediamtx ./mediamtx.yml
```
</details>

In the Studio: Ingest host `https://<grey-cloud-host-or-ip>`, path `marquee/<you>`,
user `marquee`, the password from the yml. The Studio sends **Basic** auth —
verified against v1.21.0: a bare `Bearer <password>` is refused (401).

Firewall: TCP 8889 (WHIP/WHEP), TCP 8888 (HLS), **UDP 8189 (ICE media)**,
TCP 1935 only if you want OBS-style RTMP in. WebRTC media cannot ride
Cloudflare's orange cloud — put the ingest hostname on a grey-cloud record or use
the IP. If a creator's NAT is hostile, add a TURN server to `webrtcICEServers2`
(coturn is free).

### Fan-out to Twitch / YouTube / Kick

One ffmpeg per stream, not one per platform: `deploy/mediamtx/fanout.py` reads
the stream back from mediamtx over loopback RTSP and tees it (`-c:v copy`,
audio → AAC) to every destination in an env file. mediamtx runs it on
`runOnAvailable` for each `marquee/*` path.

```bash
mkdir -p ~/.config/marquee && chmod 700 ~/.config/marquee
cat > ~/.config/marquee/fanout.env <<'EOF'
FANOUT_TWITCH=rtmp://live.twitch.tv/app/live_xxxxxxxx
FANOUT_YOUTUBE=rtmp://a.rtmp.youtube.com/live2/xxxx-xxxx-xxxx-xxxx
# FANOUT_KICK=rtmps://.../app/sk_...
FANOUT_PATHS=marquee/*
EOF
chmod 600 ~/.config/marquee/fanout.env
sudo apt install -y ffmpeg          # or a static build; fanout.py refuses loudly without it
python3 fanout.py marquee/you --print   # shows the exact ffmpeg command, keys redacted
```

Then set the absolute path to `fanout.py` in `mediamtx.yml` (`runOnAvailable`;
`runOnReady` is the deprecated alias in 1.21). Keys live only in that env file;
never in the yml (committed) or the Studio (a page). `onfail=ignore` on each tee
output means one platform rejecting its key does not take the others down. A
path with nothing to do **parks** (the script says why once, then sleeps until
mediamtx ends it) — an early exit would be restarted every 5 s by
`runOnAvailableRestart`.

**RTMP auth quirk (verified):** mediamtx reads RTMP credentials from the URL
**query** — `rtmp://host:1935/marquee/you?user=marquee&pass=…` — not from
`user:pass@host`, which fails with "authentication failed". WHIP is the
opposite (Basic header). Both are written down so nobody re-learns them.

**Proven end to end in the sandbox** with the real binaries: ffmpeg published a
test pattern over RTMP → `marquee/src` ready → `runOnAvailable` ran
`fanout.py` → one ffmpeg tee → `marquee/fanout-out` ready with 2 tracks and
bytes climbing → HLS master playlist 200 (`avc1.64001e,mp4a.40.2`) with readers
attached. Real frames, real segments.

Verified in the sandbox against the real binary with a real WebRTC stack: WHIP
`POST` → 201 + `Location` + SDP answer (H264/opus); bad/no credentials → 401;
ICE connected and the session reached `publish`; DELETE → 200 ends it. **With
`webrtcAdditionalHosts` empty, ICE never connects** ("deadline exceeded while
waiting connection") — that line is the one that matters. Real frames and HLS
segments are proven only by a live publish from the Studio.

## 5c. Capture permissions (macOS, and why there is no "Allow" button for one of them)

The Studio raises a permissions dialog when the OS is in the way, and it can
grant only some of them for you. That asymmetry is the OS's, not a design
choice:

| | Can marquee ask? | What the button does |
| --- | --- | --- |
| Camera | **Yes** — macOS shows its own prompt once | "Allow camera" |
| Microphone | **Yes** | "Allow microphone" |
| **Screen Recording** | **No. There is no API.** | "Open Settings" — deep-links to the Privacy pane |

`systemPreferences.askForMediaAccess` accepts only `'microphone'` and
`'camera'`. Screen recording cannot be requested by an application at all, so a
"click to allow" button for it would leave you waiting for a prompt macOS will
never show. Two consequences worth knowing before you test:

- **A Screen Recording grant applies on the next launch.** Switch marquee on in
  Settings, then quit and reopen it. The dialog says so.
- **An empty source picker is almost always this permission.**
  `desktopCapturer.getSources()` returns `[]` when Screen Recording is off — it
  does not throw — so the Studio re-reads the status and shows the dialog with
  that reason instead of an empty grid.

Windows gates camera and microphone (with `ms-settings:` panes) and has no
screen-capture gate. Linux gates none, and reports `not-applicable` rather than
pretending.

## 5d. Packaging (installers with Python inside)

```bash
pnpm --filter @marquee/shell run package
```

That runs `desktop/py-runtime/build.py --check` (PyInstaller `--onedir --name
jenny`, then it **runs the bundle and reads `/health` back**, and confirms an
untokened `/run_code` is still `401`), builds the shell, and calls
electron-builder. `extraResources` ships the Python bundle, the built UI and
the built API server into `resources/`, so an installed marquee needs no Python
on the machine.

Three things have to agree about one path — `build.py`'s `--name`,
electron-builder's `extraResources.to`, and the **vendored** `findPythonExe`'s
first candidate (`resources/python/jenny/jenny[.exe]`).
`desktop/shell/test/packaging.test.ts` asserts all three, because a drift there
starts fine and then loses the Terminal with an error about a path nobody typed.

**Not yet done:** no installer has actually been built or signed. Code signing
(the Certum cert under Interchained LLC) is not wired into this repo yet.

## 5e. The Terminal on Windows

`/ws/pty` uses ConPTY through `pywinpty`, which is platform-conditional in
`desktop/py-runtime/requirements.txt` so a mac/Linux install never tries to
build it.

**That path has never been run on Windows.** It is written from pywinpty's
documented API. It is wired rather than refused because it names what breaks
instead of guessing: no pywinpty closes the socket with **4501** and the
install hint, a failed spawn closes with **4502** and the exception text, and
anything later arrives as an `{"type":"error"}` frame. Treat a working result
as "someone ran it on Windows", never as tested. `/run_code` and `/health` work
on every platform.

## 6. Scheduled dispatch

An approved draft with a send time goes out on its own, without the app being
open or focused. `src/lib/scheduler.ts` wakes on `MARQUEE_SCHEDULER_INTERVAL_MS`,
finds drafts whose time has passed, and sends them down the same path a manual
press uses — same approval check, same idempotency key, same bridge.

Three properties matter more than the schedule itself:

- **The scheduler never writes the browser state document.** The app owns that
  document; two writers would clobber each other. Outcomes go to a separate
  dispatch log, and the app folds them back into the drafts it holds. That is
  how a post that went out while the app was closed still reads as posted when
  it opens a month later.
- **One attempt per instruction.** A failure is not retried in a loop; the
  reason is recorded and a person decides. Moving a post to a new time is a new
  instruction and earns one more attempt.
- **It is off in multi-tenant mode.** With no authenticated tenant, the
  scheduler has nobody to act for, so scheduled posts wait for a human press.
  `GET /api/schedule/status` says so in `detail` rather than failing quietly.

```
GET  /api/schedule/status       { active, bridgeConfigured, intervalMs, detail }
GET  /api/schedule/dispatches   recent attempts for this tenant (a tail, for looking)
POST /api/schedule/outcomes     { keys: string[] } → outcomes for those exact keys
```

Reconciliation asks by key, not by reading a recent feed — a client that has
been away for a month asks about the handful of drafts it left behind and gets
every one of their outcomes. The tail endpoint is for humans inspecting what
happened.

Automatic dispatch needs the bridge, so on the web surface `active` is `false`
and `bridgeConfigured` is `false`. Nothing is silently queued.

## 7. Why publishing fails on the web surface

Posts leave through **your own signed-in browser session**, never through a
server-held token. With no shell attached, `POST /api/publish` answers `503` and
the draft is marked `failed` with the reason attached. That is the intended
behaviour: a silent success would be a lie about whether something reached an
audience.

## 8. Networks

X is the primary network. Also configured: Instagram, Facebook, Threads,
LinkedIn, Bluesky, Mastodon, Reddit, TikTok, YouTube, Pinterest, Tumblr. Each
carries its own character limit, media rules, thread support, and feed/compose
URLs in `artifacts/studio/src/lib/platforms.ts`. Adding a network
means adding an entry there and to the `platform` enum in
`lib/api-spec/openapi.yaml`, then re-running codegen.

### Signing in (FaceMask)

Accounts are authenticated live, by the operator, inside the shell. `POST
/api/session/signin` asks the shell to open the network's own login page in that
workspace's tab, under the workspace's partition and UA profile. The login view
gets no preload, so the page cannot see this app; the app in turn never reads,
fills, or stores what is typed there, and mints no token of its own. The cookie
the network sets in that partition is the whole of the account.

The response says what happened to the *tab*, not to the account:

```
POST /api/session/signin  { workspaceId, platform? }
  200 { workspaceId, bridgeAvailable, opened, alreadySignedIn, detail }
  400 { error: "workspaceId is required" }
```

`platform` is optional and defaults to the workspace's own network. It exists
because one identity can hold accounts on several networks — the Accounts page
signs each of them in inside the same workspace tab, and reads each back
separately with `GET /api/session/status?workspaceId=…&platform=…`. A session on
one network is no evidence about another, so a badge is never drawn from a
sibling's session.

`GET /api/session/status` also answers *which* account, when it can. The
`accountId` comes from the partition's cookies; `accountHandle` is read from a
live signed-in page for that workspace and arrives with
`handleSource: "session"`. When the handle cannot be read, `handleUnknown`
explains why and the UI shows that instead of a name. The workspace's stored
`accountHandle` label is never used for this — a stored string presented as the
signed-in account is a claim nothing verified.

`opened: true` means a login page is now in front of the operator. Whether they
finished — a human sign-in takes minutes and often a second factor — is answered
only by `GET /api/session/status` reading the session back, which is what the
workspace UI polls after opening one. On the web surface, `bridgeAvailable` is
`false` and the detail says so: there is no session out there to sign into.

Live network views render only inside the native shell. X, Instagram, and the
rest send frame-blocking headers, so the web surface shows an explicit "runs in
the desktop shell" state and an open-in-tab link rather than a fake feed.

## 9. Data and integrity

State is a single append-only `nedb-engine` ledger, scoped by tenant id.
`GET /api/browser/integrity` returns `verified`, `sequence`, and `head`;
`GET /api/browser/export` downloads the full state with its integrity record.
Back up `NEDB_DATA_DIR` — that directory is the product's memory.

`nedb-engine` loads a prebuilt `.node` binding relative to its own directory, so
it is marked external in `artifacts/api-server/build.mjs`. Bundling it produces
`Cannot find module 'nedb-engine-linux-x64-gnu'` at startup.

## 10. Release checklist

- [ ] `pnpm run typecheck` clean
- [ ] `pnpm --filter @marquee/shell run test` green
- [ ] `pnpm --filter @marquee/api-server run test` green — the scheduled
      dispatch suite, which needs no display either
- [ ] `pnpm --filter @marquee/api-spec run codegen` re-run after any spec edit
- [ ] `(cd desktop/py-runtime && .venv/bin/python -m unittest discover -s . -p 'test_*.py')` green
- [ ] `pnpm --filter @marquee/shell run bundle:python` green — it builds the
      PyInstaller bundle and then *runs* it, so a bundle that compiles but
      cannot serve, or that loses its token gate, fails here rather than in an
      installer
- [ ] `node --test deploy/mediamtx/fanout.test.mjs` green (executes the real
      fan-out script; asserts stream keys are never printed)
- [ ] `AIASSIST_API_KEY` present in the target environment
- [ ] `MARQUEE_SESSION_BRIDGE_URL` / `MARQUEE_SESSION_BRIDGE_TOKEN` unset on the web
      surface; on the desktop build, confirmed to be set by the shell rather
      than by hand, and no pairing file left behind
- [ ] Shell launched once per release: two workspaces signed into the same
      network stay signed in as different accounts, and the toolbar names the
      right workspace and UA profile in each
- [ ] Desktop build only: `curl` the API server's port directly and confirm it
      answers `401`, and that it is not reachable from another machine
- [ ] Sign-in verified live: "Sign in" opens the network's own login page in
      that workspace's tab, a second click focuses the same tab rather than
      opening another, and the session badge flips only after the account is
      actually signed in
- [x] Approve → post round-trip verified against one real account on X
      (2026-09-02, macOS shell)
- [ ] Approve → post round-trip verified against one real account per remaining
      network — required before any shared-composer adapter (LinkedIn, Facebook,
      Threads, Bluesky, Mastodon, Tumblr) is described as working
- [ ] Approval revocation verified: editing an approved draft clears the sign-off
- [ ] `NEDB_DATA_DIR` backed up — this now holds `media/`, the uploaded files
      themselves, as well as the ledger
- [ ] Media round-trip checked on at least one driven network: attach, approve,
      post, and confirm the picture is on the post rather than the text alone
