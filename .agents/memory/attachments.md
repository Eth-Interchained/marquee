---
name: Attachments
description: Where uploaded files live, why they are not in the state document, and the two checks that keep a post's pictures honest.
---

Drafts carry images and video. The bytes do not travel with them.

**Where the bytes live.** `artifacts/api-server/src/lib/media-store.ts` writes
uploads to `<NEDB_DATA_DIR>/media/<tenant>/<sha256>/<filename>`. The directory
is the hash of the contents; the file keeps a sanitised version of its original
name, because that name is what the network shows on the post. A draft, and
later a publish request, carry only a reference.

**Why not in the state document.** The browser state is PUT whole on a debounce
behind a textarea. An image inside it would be rewritten on every keystroke,
and the append-only ledger would keep every copy for good.

**How a file reaches a network.** The API server resolves each reference to an
absolute path and sends that over the bridge. Both processes see one
filesystem: the shell chose `NEDB_DATA_DIR` and spawned the server with it. The
shell then does two things before anything is uploaded
(`desktop/shell/src/publisher/approved-media.ts`):

1. Refuses any path outside its own data directory. The bridge is loopback and
   token-gated, but the component that turns a path into "upload this file"
   should not be the component that trusts its input.
2. Re-hashes the file. An approval is for exact content, and content includes
   the picture — a file that no longer matches the recorded hash is not the one
   that was approved, so the post does not go out.

The upload itself is CDP `DOM.setFileInputFiles`
(`desktop/shell/src/publisher/upload.ts`). Page JavaScript cannot set
`input.files`, and clicking the input opens a native dialog nothing here can
drive. The debugger is already attached for UA emulation, so this reuses that
session — attaching twice throws.

**The rules that matter, all covered by tests:**

- The publish path compares submitted attachments against the stored draft and
  refuses a mismatch. Without that, an approved draft id is a licence to post
  any image. A dropped attachment and an edited alt text are both mismatches:
  alt text is published content.
- Attachments are a dispatch field in `routes/browser.ts`, so they cannot be
  swapped under a send in flight. They could not join `DISPATCH_FIELDS`
  directly — that list compares with `!==`, and two arrays are never `===`, so
  every save would have reported a change. They are compared by fingerprint
  instead.
- The composer flow attaches *before* it submits and waits for the network to
  acknowledge the upload. Submitting early posts the words without the picture,
  which is a different post from the approved one.
- A file that cannot be attached fails the post. It never degrades to
  text-only.
- A missing file fails the whole dispatch rather than posting the attachments
  that did resolve.

**Instagram is verified** against a real signed-in account (2026-09-03), and
what that exercise found is the reason to distrust the rest. Three of its
selectors were wrong, and none of the three was findable by reading:

- `opener` matched `svg[aria-label="New post"]`, not the `<a role="link">`
  around it. `SVGElement` has no `.click()`, so opening the composer threw a
  TypeError on every attempt. **Instagram publishing had never worked and could
  not have.** The driver now walks up from any match to the nearest clickable
  ancestor, and retries a capped number of times instead of assuming one click
  worked.
- the crop and filter steps clicked "the first enabled `div[role="button"]` in
  the dialog", which on both screens is **Back** — and each step's `waitFor`
  was `div[role="dialog"]`, already on screen, so the step reported success
  while walking backwards. Steps now name their control's text, and a step with
  nothing real to wait for is refused rather than assumed.
- `mediaAttached` looked for an `<img>` or `<canvas>`. Instagram renders the
  attachment as `background-image: url(blob:…)` on a bare div; the dialog
  contains no image element at all.

The verified flow: feed → `a[role="link"]:has(svg[aria-label="New post"])` →
"Create new post" (a `<button>` "Select from computer" over a hidden
`input[type="file"]`) → **Crop** → Next → **Edit** (filters) → Next → caption
(`div[contenteditable="true"][role="textbox"]`, aria-label "Write a
caption...") → **Share**.

Instagram's controls carry obfuscated classes, no test ids and no aria-labels,
so their visible text is genuinely the only thing separating Next and Share
from Back. **Those text matchers are locale-dependent**: a non-English account
matches nothing and refuses with nothing submitted. Safe, but a real limit.

**Still not verified:** every other network's `fileInput` and composer selectors
are written from product knowledge and have never run against a real account.
Instagram is the evidence that "it reads correctly" is worth very little here.
`test/instagram-config.test.ts` locks in the shape of the mistakes rather than
the selectors — no step may click whichever control comes first, and no step
may claim success without something real to wait for.

**Upload-first networks.** Instagram and Pinterest have no caption field until
an image is in, so `mediaFirst` flips the order: wait for the *upload control*
rather than an editor, attach, walk any `afterAttach` screens, then look for
somewhere to type. `mediaRequired` refuses a post with no attachment before a
window is even opened. Instagram's crop and filter screens are two `afterAttach`
steps, each naming itself so a stalled flow says which screen it stalled on
rather than timing out anonymously; clicking is not treated as progress until
the screen it should have produced actually appears.

**Pinterest does not choose a board.** A pin belongs to a board and nothing in
the draft model names one, so it publishes to whatever board Pinterest already
has selected. With none selected the publish button never enables and the
attempt fails loudly. That is honest but it is a real limit — check the selected
board before trusting a scheduled pin. Giving the draft model a board is the
same shape of problem as Reddit's subreddit.

**Still refusing:** TikTok and YouTube (a post needs a video, and this drives
image composers rather than an encode-and-wizard flow) and Reddit (needs a
community and a title).

## Instagram serves two composers, and the UA profile decides which

The first fix to the Instagram adapter was verified against a desktop UA and
still failed on the owner's machine, with:

> Could not find anything on Instagram to open its composer with

His workspace runs the **Safari · iPhone 16** profile (393 × 852). The shell
sends `Emulation.setUserAgentOverride` with `userAgentMetadata.mobile: true`,
so Instagram serves the **mobile layout**: no left sidebar, no "New post" nav
item, nothing for a desktop nav selector to match at any retry count. The
window is 1280×900, but layout follows the UA, not the window.

So the profile now picks the graph. `publisher/device.ts` derives a
`DeviceClass` from the UA string, `SubmitContext` carries it, and `driven()`
resolves the graph **per publish** rather than capturing one at module load.

**Both classes drive the route flow**, which needs no navigation at all —
navigation being precisely what differs between the layouts:

| URL | what is there |
| --- | --- |
| `/create/select/` | the file input, present on load, no click |
| `/create/style/` | filters; real `<button>`s; "Next" |
| `/create/details/` | a `<textarea>` caption, and "Share" |

No `div[role="dialog"]` anywhere, and every dialog-scoped selector from the
first fix matches **zero** here. The caption is a `<textarea>`, not a
contenteditable, and its aria-label carries a real ellipsis ("Write a
caption…"), which is why the selector matches a substring. Steps are proven by
`waitForPath` — the URL cannot drift with a class rename or a translation,
which makes it a better signal than either markup or wording.

The dialog graph is kept in `COMPOSERS.instagram` as the verified desktop
fallback if the routes ever stop being addressable, and its guards still run
against it explicitly.

**NOT VERIFIED: both flows were driven under a desktop UA.** Nothing here has
run with a phone's user agent. The route flow is assigned to `mobile` because
it depends on no navigation, not because it has been watched working there. A
failure now names the profile in the refusal, so the next person checks that
before hunting selectors.

**Known and unfixed:** every UA profile declares a viewport (the iPhone one
says 393 × 852) and **nothing applies it**. `viewport` is not in
`WorkspaceIdentity` and is not parsed by `workspace-directory.ts`, so the
publish window stays hardcoded at 1280×900 — a phone's user agent sent from a
desktop-sized window. `publisher/device.ts` has `parseViewport` and
`publishViewportFor` ready for it; wiring them through is its own change.
