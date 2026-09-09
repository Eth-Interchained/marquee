# AGENTS.md

Handoff notes for whoever picks this up next — human or agent. Read this before
touching anything. `README.md` is the pitch; `DEPLOY.md` is the operational
manual; this file is what a contributor needs in order not to break the thing
that makes the project worth having.

Repo: `https://github.com/aiassistsecure/ua-social-browser` (branch `main`, GPLv3).

---

## 1. What this is

A desktop browser for running social accounts, where **AI drafts, a human
approves, and the post goes out through the operator's own signed-in session**.

The one sentence that governs every design decision: *there is no server-held
token and no bot account anywhere in this system.* A post reaches an audience
because the person who owns the account was signed into it in this browser and
approved that text. If that chain cannot be completed, the app says so and
stops — it never posts by another route and never reports a post it did not
make.

Twelve networks are configured, X is primary. Single-tenant today, with a
tenant key on every stored document so multi-tenant is a resolver change rather
than a migration.

**The Replit repl is a development surface only.** It has no browser sessions,
so publishing there is impossible by construction; the API server says exactly
that instead of pretending. The product is the Electron shell, built and run on
the operator's own machine.

---

## 2. Invariants — do not "simplify" these

These are the load-bearing rules. Each exists because the alternative is a lie
told to someone about their own account.

1. **Publishing only happens through the shell's session bridge.** No server
   posting path, no stored credentials, no API tokens. If the bridge is not
   configured, publish endpoints refuse and explain.
2. **`published` requires the network's own confirmation.** Submitted-but-
   unconfirmed is its own outcome (`409`), is recorded as spent in the ledger,
   and is **never retried automatically** — an automatic retry there is how you
   double-post. A person looks at the account and decides, and `attested`
   records that decision: a status meaning *the operator found the post*, which
   is never collapsed into `published` and always shown with the name of
   whoever claimed it. An operator's word and the network's confirmation are
   evidence of different kinds and must stay distinguishable in the ledger
   forever. `attested` is not `approved` and not `scheduled`, so nothing will
   ever send it again.
3. **Approval is read from stored state, never asserted by the request.**
   Editing an approved draft clears the sign-off, which also makes it
   ineligible for scheduled dispatch.
4. **One idempotency key per instruction**, derived server-side from the draft
   id plus its approval timestamp. Callers may not supply one; the API refuses
   if they try.
5. **One automatic attempt per scheduled instruction.** Re-scheduling is a new
   instruction and earns one more attempt.
6. **One writer per document.** The browser state document belongs to the UI;
   the scheduler reports through the dispatch log instead of writing into it.
7. **Sessions are per workspace and never shared.** Partition key is
   `persist:ua-<sanitised id>-<digest of raw id>` — the digest exists because
   sanitising alone would collide `team/a` with `team-a`, which is a
   cross-account cookie leak.
8. **Page content gets no preload.** Workspace surfaces, workspace tabs, the
   sign-in tab, and the hidden publish window all run without `window.uaShell`.
   Only the privileged UI origin has it, and that origin is cookie-gated.
9. **The app never reads, fills, or stores credentials.** Sign-in is the human
   typing into the network's own page.
10. **No mock data, no silent fallbacks.** Unknown state is reported as unknown
    (Bluesky and Mastodon genuinely cannot be judged from cookies, and say so).
    A fresh install is empty, and nothing can be approved until the operator
    has said who they are.
11. **An approval covers the attachments, not just the words.** The publish
    path compares the submitted media against the stored draft and refuses a
    mismatch — a different picture, a dropped one, or edited alt text is a
    different post. The shell re-hashes every file before uploading it, and a
    post whose attachment cannot be attached fails rather than going out as
    text. Media bytes never enter the state document: the browser state is
    rewritten whole on every edit, so uploads live content-addressed under the
    data directory and drafts carry references.

If a change requires weakening one of these, that is a conversation with the
owner, not a refactor.

---

## 3. Layout

```
artifacts/
  ua-social-browser/   React + Vite workspace UI (the sidebar app)
    src/lib/studio/    Studio compositor: scene graph, canvas renderer, capture, mixer (pure, tested; from Eth-Interchained/marquee)
  api-server/          Express API: state, AI, scheduling, publish gateway
  mockup-sandbox/      Replit-only component preview surface; not part of the product
desktop/
  ua-shell/            Electron shell: the actual browser and the only publisher
    vendor/jenny/      Jenny's Python orchestrator, copied VERBATIM (sha256 pinned) — never edit
    vendor/keystone-lite/  shell-path.ts, verbatim: real user PATH for a GUI-launched app
  py-runtime/          The bundled Python: /health, token-gated /run_code, /ws/pty (a real PTY)
deploy/
  mediamtx/            Go Live ingest config (WHIP in → HLS/WebRTC out; RTMP fan-out commented)
lib/
  api-spec/            openapi.yaml — the contract, and the codegen entrypoint
  api-zod/             generated zod schemas (do not hand-edit)
  api-client-react/    generated react-query hooks (do not hand-edit)
  db/                  template leftover; declared as a dependency, never imported
scripts/               template leftover
.agents/memory/        durable notes for agents (see §12)
```

### The shell, file by file

| File | What it owns |
| --- | --- |
| `src/main.ts` | Startup order: publisher → bridge → API server → UI origin → window |
| `src/config.ts` | Env parsing, pairing rules for an external API server |
| `src/shell-window.ts` | `BaseWindow` + `WebContentsView`s: toolbar, privileged UI, surfaces, tabs |
| `src/workspace-contexts.ts`, `src/partition.ts` | Per-workspace sessions and their keys |
| `src/ua-metadata.ts` | UA string → headers, client hints, timezone (all derived, never invented) |
| `src/ui-server.ts`, `src/preload/` | The privileged loopback origin and its gate; also proxies `/runtime/*` (HTTP + WebSocket upgrades) to the Python runtime, adding its token |
| `src/python-runtime.ts` | Starts the bundled Python through Jenny's verbatim orchestrator; mints nothing itself, wraps the token env-window and the real-PATH fix around it (see `.agents/memory/python-runtime.md`) |
| `src/capture.ts` | Studio screen capture: lists `desktopCapturer` sources for the UI's picker and answers `getDisplayMedia()` on the default session with the ONE source the UI armed — never a guess (see `.agents/memory/studio-capture.md`) |
| `src/session-bridge-server.ts` | Loopback HTTP the API server calls; token-gated |
| `src/publisher/index.ts` | `sessionStatus`, `publish`, `beginSignIn` |
| `src/publisher/adapters.ts` | Per-network cookies, composer config, sign-in URL, refusal reasons |
| `src/publisher/compose-driver.ts` | The shared composer flow and its honesty rules |
| `src/idempotency.ts` | The spent-key ledger on disk |
| `src/publisher/upload.ts` | CDP `DOM.setFileInputFiles`; the only way to fill a file input |
| `src/publisher/approved-media.ts` | Path containment + re-hash before anything is uploaded |

### The API server

Routes (all under `/api`): `/healthz`, `/tenant`, `/browser/state` (GET/PUT),
`/browser/integrity`, `/browser/export`, `/ai/models`, `/ai/suggest`,
`/session/status`, `/session/signin`, `/publish`, `/schedule/status`,
`/schedule/dispatches`, `/schedule/outcomes`, and the Studio's receipts:
`/studio/events` (GET/POST), `/studio/events/{id}/trace`,
`/studio/scenes/{workspaceId}` (GET/PUT) — `src/lib/studio-store.ts`, see
`.agents/memory/studio-receipts.md`.

`src/lib/session-bridge.ts` is the only place that talks to the shell (20s
request timeout). `src/lib/scheduler.ts` runs the clock; `dispatch-claims.ts`
and `dispatch-log.ts` keep one attempt per instruction and keep the scheduler
out of the browser's document.

---

## 4. How the pieces talk

```
workspace UI  ──fetch /api/*──▶  API server  ──loopback + token──▶  shell publisher
     ▲                               │                                    │
     └────── window.uaShell ─────────┘                          workspace session
             (only in the shell)                                (cookies, UA profile)
```

- In the shell, the UI is served from a loopback origin that proxies `/api` to
  the API server, so the UI's relative fetches work unchanged in both places.
- On Replit the UI hits the API server artifact directly at `/api`.
- `window.uaShell` (typed in `artifacts/ua-social-browser/src/lib/shell-bridge.ts`)
  exists only inside the shell: `attachSurface`, `openInWorkspaceTab`,
  `getSessionStatus`. Web-surface code must degrade honestly when it is absent.

---

## 5. Running it

### On Replit (development)

Three workflows, already configured — restart them rather than inventing new ones:

- `artifacts/api-server: API Server`
- `artifacts/ua-social-browser: web`
- `artifacts/mockup-sandbox: Component Preview Server`

Both app services read `PORT` from the environment. The Vite config *throws* if
`PORT` or `BASE_PATH` is missing — that is deliberate, not a bug to patch out.

### On the operator's machine (the real thing)

```bash
pnpm install
PORT=5173 BASE_PATH=/ pnpm --filter @workspace/ua-social-browser run build
pnpm --filter @workspace/api-server run build
pnpm --filter @workspace/ua-shell run start      # builds, then launches Electron
```

The shell mints its own bridge token and API access token at startup and passes
them to the API server it spawns. Nothing needs to be set by hand for the
default path.

### Checks

```bash
pnpm run typecheck                              # whole workspace
pnpm --filter @workspace/ua-shell run test      # 76 tests, no display needed
pnpm --filter @workspace/api-server run test    # 24 tests, scheduled dispatch
```

Both suites are fast and neither needs Electron or a browser. Run them before
you push; they have caught real bugs (a submit phase that ate the whole time
budget, a stale unconfirmed-outcome assumption).

---

## 6. The API contract and codegen

`lib/api-spec/openapi.yaml` is the source of truth. After editing it:

```bash
pnpm --filter @workspace/api-spec run codegen
```

This runs orval into `lib/api-zod` and `lib/api-client-react`, then typechecks
the libs. Never hand-edit generated files.

Naming: orval derives schema names from `operationId`, so `beginSignIn` gives
`BeginSignInBody` / `BeginSignInResponse`. **Give every request body a named
component schema** (`$ref: '#/components/schemas/SignInRequest'`) — an inline
body generates a type that collides with the zod export and fails codegen.

The publish, sign-in, AI, and health routes parse their request bodies — and in
places their own responses — with the generated zod schemas. Keep new routes
doing the same; it is how the spec stays honest rather than decorative.

---

## 7. Publishing, in detail

`POST /api/publish` → `session-bridge.ts` → shell `/publish/:workspaceId` →
`publisher/index.ts`.

The publisher opens the network's composer in a **hidden** window in that
workspace's partition and UA profile, types the approved body, submits, and
waits for the network's own confirmation. The attempt is bounded (shorter than
the API server's 20s timeout) so the shell, not a timeout, decides what an
unfinished attempt means.

**Adapter status — keep this table honest when it changes:**

| Networks | State |
| --- | --- |
| X | Driven through `compose-driver.ts` like the rest, since its own `xSubmit` fell behind the shared flow's honesty rules — see below. **Verified 2026-09-02:** the owner watched one real post land on a real account (`@interchained`) from the macOS shell — the review card flipped to posted and "View it on X" resolved to the live status. One post, one account, one OS; that is the whole of the evidence. |
| LinkedIn, Facebook, Threads, Bluesky, Mastodon, Tumblr | Driven through `compose-driver.ts`. **Selectors written from product knowledge, never run against a real signed-in account.** |
| Instagram, Pinterest | Driven, upload-first: the flow waits for the upload control, attaches, walks any screens in between, and only then types the caption — there is no caption field until an image is in. Both refuse a post with no attachment. Instagram walks crop and filter via `afterAttach`; Pinterest is single-screen. **Selectors unverified, same as the six above.** Pinterest does not model board selection — see `adapters.ts`. |
| TikTok, YouTube | Refuse: a post needs a *video*, and this build drives image composers rather than an encode-and-wizard upload flow. |
| Reddit | Refuses: needs a community and a title the draft model does not carry. |

A refusal names its own reason and points at the workspace tab. There is no
generic `501` any more, and adding a "temporary" one is a regression.

**There are no bespoke adapters left, and that is a rule now, not a tidiness
preference.** X had its own `xSubmit`, written before `compose-driver.ts` grew
the rule that a page bouncing to a login says nothing about whether a post went
out. The shared flow returns `login` there and reports the attempt as
unconfirmed; `xSubmit` tested success as "the editor is gone and we are no
longer on `/compose/`", which a login page satisfies — so it reported a
**phantom post**, on the one adapter anyone had actually verified. A fork does
not just duplicate code; it stops receiving the fixes. Add a network by adding
a `COMPOSERS` entry, never a second submit path.

Two details in `COMPOSERS.x` are load-bearing and were the risk in that
migration: `postLink` must stay scoped inside the toast (the driver's lookup is
document-wide, and an unscoped `a[href*="/status/"]` matches any post in the
timeline behind the composer, so every attempt would "succeed" instantly), and
`login.pathPattern` is deliberately unanchored to match the original test.

Selector drift shows up as a loud failure, never as a phantom post — but **no
adapter should be called working until someone has watched a real post land on
a real account**. X has cleared that bar once (see the table); the other six
have not. Nothing in this repo can prove it, because the container it was
written in has no display and no sessions — verification happens on the
owner's machine and is recorded here afterwards. When you do verify one, update
this table, `README.md`, and `DEPLOY.md § 5` in the same commit.

---

## 8. Live sign-in (FaceMask)

`POST /api/session/signin` → bridge `POST /signin/:workspaceId` →
`publisher.beginSignIn`.

Both the sign-in and the status call take an optional `platform`, defaulting to
the workspace's own network: one identity can hold accounts on several networks,
and each is a separate session that must be read on its own.

- Opens the network's own login page **in that workspace's tab** via
  `ShellWindow.openOrFocusTab`. One tab per workspace: a workspace *is* an
  account, so a second tab is the same session shown twice.
- Returns as soon as the tab is up. A human sign-in takes minutes and often a
  second factor, so blocking on it would time out.
- `opened: true` says something about the *tab*, never about the account.
  Authentication is confirmed only by re-reading the session
  (`GET /api/session/status`). The UI polls it for up to three minutes after
  opening and flips its badge only on that evidence.
- The login view gets no preload, and nothing in this codebase touches the form.
- The Accounts page is the main entry: adding an account registers the row and
  opens that network's login page immediately, and an account's badge is written
  only from a session read — never from a tab having been opened.

`adapters.ts` carries a `signInUrl` per network; that is the only thing sign-in
needs from an adapter.

### Which account is signed in

`sessionStatus` answers this from the session or not at all, in
`publisher/identity.ts`:

- **`accountId`** comes from the partition's own cookies where a network keeps
  one there (X `twid`, Instagram/Threads `ds_user_id`, Facebook `c_user`).
  Proof of which account holds the session, available without loading anything
  — but a number, not a name.
- **`accountHandle`** is read off a live signed-in page for that workspace,
  found by `ShellWindow.liveContentsFor` (the embedded network view first, then
  a tab). No extra request, no private API, no bearer token. It arrives with
  `handleSource: "session"`, and the UI names an account only when that field
  is present.
- Anything unreadable is `handleUnknown` — a sentence for the operator, not a
  fallback.

**`workspace.accountHandle` is not consulted, and must not be.** It is a label
typed once and stored; presenting it as the signed-in account is how this shell
told its owner he was posting from `@northstarhq`, an account that had never
existed, while a different account was signed in. A wrong name beside a green
tick is worse than no name. The selectors that read handles are product
knowledge and unverified like every other selector here, so a miss has to read
as unknown.

---

## 9. Scheduling

The API server owns the clock (`src/lib/scheduler.ts`), so a scheduled post goes
out whether or not the UI is open. Per tick it finds due, still-approved drafts
and pushes them through the same door the Post button uses.

- Intent is written to the dispatch log *before* the network call, so a crash
  mid-attempt cannot look like "never tried".
- A claim keeps one attempt per instruction; failure leaves the draft `failed`
  with the reason attached and waits for a person.
- The scheduler never writes the browser state document; the UI reconciles from
  `/schedule/dispatches`.

Two open project tasks live here (see §11).

---

## 10. Conventions

- **TypeScript everywhere**, strict. `pnpm run typecheck` must be clean.
- **Comments explain *why*, in prose.** Existing comments state the trap being
  avoided ("sanitising alone would collide two workspaces into one cookie jar").
  Match that register; do not add restating-the-code noise.
- **UI:** React + Tailwind + shadcn/ui in `components/ui` (leave those alone),
  app-specific pieces in `components/app` and `sections`. Interactive elements
  carry `data-testid` (`button-*`, `filter-*`, `draft-<id>`, `queue-<id>`,
  `calendar-post-<id>`).
- **The AI Composer is a pool, not a result set.** Suggestions accumulate:
  "Keep going" appends a batch (duplicates dropped), "Start over" replaces.
  Acting on a card — saved as a draft, or discarded — removes it, after a
  ~420ms holo sweep (`.ua-dissolving` in `index.css`); the card is dropped from
  state when the animation ends, because dropping it on click unmounts the
  element and nothing plays. This is composer-only: the review queue and the
  calendar keep every draft, which is where a saved one is worked on.
  Candidates carry a **stable id and a fixed ordinal** (`lib/candidates.ts`).
  Review state is keyed by that id and never by array index — with removable
  cards an index key slides one card's "I read this and take responsibility for
  it" onto different text, which then reaches drafts under a sign-off nobody
  gave. There is a test named for that exact hazard.
- **A field added to a persisted type must be backfilled in `lib/hydrate.ts`
  in the same commit.** The ledger holds documents written by every build that
  came before, so a new required field is undefined on all of them and
  TypeScript cannot see the mismatch — the type says required, the JSON on disk
  says nothing. Attachments shipped without this and took the review queue
  down: drafts written before `media` existed came back undefined, the queue
  read `.length` inside its `map`, and the section died in its error boundary,
  hiding three healthy drafts because one old one sat beside them. Hydration
  fills gaps in the in-memory copy only; it never rewrites the ledger.
- **The publish budget is three coupled numbers**: `SETUP_BUDGET_MS` (12s),
  `COMPOSE_BUDGET_MS` (18s, struck *after* the page loads), and the API
  server's bridge `REQUEST_TIMEOUT_MS` (40s), which must outlast their sum.
  The compose deadline used to be struck before an unbounded `loadURL`, so a
  cold start left confirmation no window: measured at 20.7s for the first
  publish after launch against a 17s budget, versus ~6s warm. The post went out
  and was recorded `failed`. `PRE_CONFIRM_SHARE` now guarantees confirmation a
  reserve, and `onPhase` logs every phase duration — read that log before
  theorising about a slow publish.
- **A file dropped anywhere but a card is swallowed in `App.tsx`.** The default
  action for a file dropped on a page is to navigate to it, and this page is the
  privileged UI origin — the one view holding `window.uaShell`. A near miss
  while attaching a photo would replace the whole app with an image viewer,
  with no way back. The window-level listener prevents that and does nothing
  else; cards that accept a drop call `preventDefault` themselves.
- **Navigation** is section state in `App.tsx`, not a router.
  `onNavigate(section, { draftId })` focuses one post; the review queue widens
  its filter and scrolls to it. If a post can belong to another workspace,
  switch the active workspace *before* navigating, or the operator lands in a
  list that does not contain what they clicked.
- **Error surfaces** say what happened and what the operator can do. No toast
  that says "Something went wrong".
- **Tests** are `node --test` (no framework). Shell tests use scripted fakes and
  a fake clock rather than Electron.
- Commit messages are prose explaining the reasoning, not a bullet list of
  files.

---

## 11. Current state

**Working and verified here:** workspace isolation, UA/client-hint derivation,
the privileged origin gate, the approval gate (all refusal paths exercised
live), scheduled dispatch, the append-only ledger and its integrity check, the
idempotency ledger, the bridge contract, live sign-in end to end up to the point
where a real browser session is needed, and the calendar → review-queue flow.

**Verified on the owner's machine (2026-09-02):** the full approve → publish →
confirm round-trip on X — a real post from the macOS shell, through the hidden
composer window in the workspace's own session, confirmed by X and shown as
posted with a working "View it on X" link. That is one post on one account;
treat it as proof the path works, not as coverage of every X UI state.

**Not verified, and must not be described as working:** the six shared-composer
adapters against real accounts (§7). No display exists in the Replit container,
so nobody has watched them run.

**A fresh install is empty.** `artifacts/ua-social-browser/src/data.ts` boots
with no workspaces, drafts, accounts, or activity, and no approver name. The
review queue refuses to approve until Settings › Approver name is filled, and
the publish path sends the recorded approval verbatim or refuses — there is no
`'Operator'` fallback. Approvals already recorded keep the name they were
signed under; the ledger is not rewritten.

**Dead until configured:** AI drafting needs `AIASSIST_API_KEY` (the legacy
`AIAssIST_API_KEY` spelling still works with a deprecation warning). Without it
`/api/ai/*` fails loudly.

**Open project tasks** (proposed, not started):

- Tell the operator when a scheduled post did not go out.
- Stop the app and server drifting apart on scheduling data.

**Media:** drafts carry images and video on the seven driven networks. Uploads
are stored content-addressed by `artifacts/api-server/src/lib/media-store.ts`,
handed to the shell as paths, and attached with CDP `DOM.setFileInputFiles`
(the debugger is already attached for UA emulation, so it is reused). The four
Instagram and Pinterest are driven too, through an upload-first path with
optional `afterAttach` steps for Instagram's crop and filter screens. TikTok,
YouTube and Reddit still refuse. **Not verified:** no file-input selector or
step selector here has been run against a real signed-in account.

**Pinterest posts to whichever board is already selected.** A pin belongs to a
board and nothing in the draft model names one, so the flow does not choose:
when no board is selected the publish button never enables and the attempt
fails loudly. Check the selected board before trusting a scheduled pin.

**Not built:** signed installers per OS, per-tab UA switching (it is per
workspace), a sign-in indicator on the shell's own tab strip, any real
multi-tenant auth layer.

---

## 12. Traps that have already cost time

- **Native binaries.** The Replit workspace template excluded every
  non-linux-x64 optional binary (rollup, esbuild, lightningcss, Tailwind oxide)
  via `"-"` overrides in `pnpm-workspace.yaml`. That makes the repo unbuildable
  on macOS/Windows — where the shell is actually packaged — with
  `Cannot find module @rollup/rollup-darwin-x64`. They have been removed. If a
  template sync brings them back, remove them again.
- **Seed data reached a real audience.** `data.ts` once shipped a fictional
  operator ("Alex Morgan"), fictional accounts, and sample drafts so the UI
  looked alive. The owner approved one of those sample drafts while the sample
  name was still in Settings and published it from a real account, so the
  ledger recorded a real post under a person who does not exist — and because
  an approval is a snapshot of who signed at the time, renaming afterwards
  could not fix it. The seed is gone and the approver name is required before
  approval. Do not add "just a little" sample content back; invariant 10 is
  not about aesthetics.
- **`minimumReleaseAge: 1440`** in `pnpm-workspace.yaml` is a supply-chain
  guard. Leave it on; use the exclude list if something is genuinely urgent.
- **`nedb-engine` stays external** in the api-server esbuild bundle — bundling
  it breaks startup on a native binding.
- **The API server child outlives a badly-killed shell.** It holds an exclusive
  lock on the data directory, so the *next* launch dies with "locked by another
  process (pid N)" — an error about a pid the operator cannot connect to this
  app. Quit now waits for the child, the shell records its pid, and the next
  start reclaims it (only when the pid's command line still matches what was
  recorded — pids get reused). Do not "simplify" that check away.
- **Nothing that needs a renderer may block a first load.** A fresh
  `WebContentsView` has no renderer until something loads, so CDP
  `Emulation.*` commands sent to it can sit unanswered. Awaiting them before
  `loadURL` deadlocks the tab open, and the symptom is a black rectangle with
  no error anywhere. `applyEmulation` is bounded and re-applies on `dom-ready`;
  keep it that way. For the same reason, decide whether a tab needs loading
  from `webContents.getURL()` — the URL a tab was *created with* says nothing
  about whether the page ever arrived.
- **`pnpm install` after pulling** if the lockfile moved, and delete
  `node_modules` if it was populated under the old lockfile.
- **`scripts/post-merge.sh`** runs `pnpm --filter db push`, inherited from the
  template. This project does not use that database; if a merge trips on it,
  that is why.
- **The Replit container is ephemeral.** Nothing counts until it is pushed to
  GitHub. The `origin` remote sometimes loses its credential in a fresh
  container; push with the stored PAT rather than rewriting the remote URL:
  ```bash
  git -c http.extraheader="AUTHORIZATION: basic $(printf 'x-access-token:%s' "$GITHUB_PAT" | base64 -w0)" push origin main
  ```
  Never print or commit the token.
- **Agent memory** lives in `.agents/memory/` (index + topic files) and is
  committed with the code. Read it before starting; add a topic file when you
  learn something a future agent could not recover from the code. Keep secrets
  and changelogs out of it.

---

## 13. Working agreement with the owner

- Verify before claiming. "Typechecks" is not "works"; say which is which.
- Name the caveat rather than burying it — especially anything involving a post
  that may or may not have gone out.
- Do not spawn subagents in this project; the owner has asked for the work to be
  done directly in the main session.
- Push finished work to `main` with the reasoning in the commit message.
