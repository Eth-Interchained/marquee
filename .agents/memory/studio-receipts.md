---
name: Studio receipts
description: Why every on-air event is an append-only, cause-chained document in the local store, and how the chain is kept unbroken.
---

The Studio writes a receipt for everything that happens on air — a source
added or removed, a scene saved, a go-live, a stream end or error — as a
document in `studio_events`, chained to what caused it. `GET
/studio/events/{id}/trace` walks the store's own `caused_by` edges to answer
"what produced this" and "what did this produce". The store's Merkle head and
`verify()` come back with every write as the receipt.

## The chain is never left to the caller

`recordEvent` always links the previous event on the same workspace as a
cause, in addition to whatever the caller names.

**Why:** a caller that forgets `causedBy` would leave an island; an island
cannot be traced. The Studio UI also loses events on a dropped connection, and
an automatic link means the next successful write still joins the chain.

**How to apply:** never write to `studio_events` except through
`recordEvent`. The per-workspace tip lives in the same collection under
`chain:<workspace>`; `listEvents` walks it newest-first without scanning.

## Causality is stored twice, on purpose

Inline as `causedBy: string[]`, and as `link(studio_events/<id>, "caused_by",
studio_events/<cause>)` edges in the store graph.

**Why:** the inline list is for any reader of the document; the edges are what
`neighbors`/`inbound` — and NQL `TRACE` — walk without parsing documents. The
test asserts that `effects` come from `inbound`, i.e. from the graph, not from
the field.

**How to apply:** graph node names are collection-qualified
(`studio_events/<id>`). A cause named in `causedBy` that does not exist is
refused with 404 — a receipt pointing at nothing is worse than one with no
pointer.

## The scene is a document, and every version is still there

`studio_scenes/<workspace>` is replaced on save, and every save writes a
`scene_saved` event chained to the previous save's event.

**Why:** `AS OF` on the store recovers any earlier version; the events give
the human-readable trail of when and how many layers.

## Zod 3, not 4

`type: integer` in the OpenAPI spec makes orval emit `zod.int()`, which does
not exist in the workspace's zod 3.25 and breaks `typecheck:libs`. Use
`type: number` for integers until zod is upgraded.
