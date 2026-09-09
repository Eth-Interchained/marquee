---
name: Publishing boundary
description: The non-negotiable rule about how posts reach a social network in this project, and what the web surface may do.
---

A post reaches a network only through the human's own signed-in browser session
inside the native shell, carrying an explicit human approval. There is no
server-held platform token and no server-side posting path.

**Why:** the product's whole claim is that a model drafts and a person signs. A
server-side fallback would turn it into an autonomous poster, which is the thing
it is explicitly not. Equally, a "marked as published" UI state that never hit
the network is a lie about whether something reached an audience.

**How to apply:**
- When the session bridge is absent, publishing returns 503 with a plain reason
  and the draft becomes `failed` with that reason attached. Never a silent
  success, never a queued-for-later pretence.
- Editing an approved draft clears its approval. Approval is on the exact text.
- The idempotency key derives from draft id + approval timestamp, so a retry
  cannot double-post. Scheduled sends go through the same door as the Post
  button — see [Scheduled dispatch](scheduled-dispatch.md).

**Known gap, deliberately open:** approval is asserted by the browser document,
and the API is unauthenticated with open CORS. Anyone who can reach the server
can write a due, "approved" draft and the scheduler will send it. That was
survivable when a person had to press Post; automatic dispatch makes the
server-side approval boundary load-bearing. Closing it means server-authorized
approval transitions plus authenticated state/publish endpoints — treat any
work near this as security-critical rather than as plumbing.
- Live network views render only in the shell. Social networks block framing, so
  the web surface shows an explicit "runs in the desktop shell" state instead of
  a mocked feed.

## One flow, no forks

Every driven network goes through `compose-driver.ts`. There are no bespoke
submit paths, and adding one is a regression even when it looks locally
simpler.

X used to be the exception, and the exception is what proved the rule. Its
`xSubmit` predated the shared flow's guard for "the page bounced to a login
right after submit, so whether the post went out is unknown". The shared flow
returns `login` and reports the attempt as unconfirmed. `xSubmit` decided
success by "the editor is gone and we are no longer on `/compose/`" — which a
login page satisfies — and so reported a **phantom post**, on the single
adapter that had ever been verified against a real account.

The lesson is not "X had a bug". It is that a fork stops receiving fixes, and
the fixes in this file are the ones that keep the app from lying about whether
something reached an audience. Add a network with a `COMPOSERS` entry.

**Absence of the editor must never be the only success signal.** It is the
weakest test in the flow and it is what both known phantom cases had in common
— X's login bounce, and Facebook's dialog-scoped editor closing without a
`stillComposingPath`. Prefer a positive signal: a toast, or a link to the post
that was just created.

## Correcting a record the operator can see is wrong

A post that went out without confirmation is recorded `failed`. That was the
honest answer and remains the right default — but the operator can look at the
account, and until recently the app gave them no way to say what they found. A
ledger that cannot be corrected by the person who can see the truth is not more
honest than one that can; it is only wrong for longer.

`attested` is that correction. The rules are in
`artifacts/studio/src/lib/attestation.ts` and are load-bearing:

- **Never `published`.** `published` means the network confirmed it. `attested`
  means a named person says so. The badge reads "Posted · your word", and the
  card says who and denies that the network confirmed it.
- **Only a `failed` draft.** There is nothing to correct until an attempt
  exists and came back wrong. A `published` draft is refused outright — the
  network's confirmation is stronger evidence and a weaker claim may not
  replace it.
- **Signed, with no fallback name**, exactly like an approval.
- **`lastError` survives**, and the operator's link is stored on the
  attestation rather than in `postUrl`, so what the shell saw and what the
  person found stay separable.
- **Retractable**, returning the record to `failed`. The append-only ledger
  keeps the claim and its withdrawal both.
- **Never publishable again.** `attested` is neither `approved` nor
  `scheduled`, so no scheduler will look at it. The post already went out.
