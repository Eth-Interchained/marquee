import { randomUUID } from "node:crypto";
import { db, getStoreHealth } from "./store";

/**
 * The Studio's receipts: an append-only log of what happened on air, chained
 * by cause, in the same local NEDB store as everything else.
 *
 * Two collections:
 *   - `studio_events`  — one document per event, never updated
 *   - `studio_scenes`  — one document per workspace, replaced on save; every
 *                        earlier version is still reachable AS OF its seq
 *
 * Causality is stored twice on purpose:
 *   - inline, as `causedBy: string[]` on the event, for any reader; and
 *   - as `caused_by` edges in the store's link graph, so `neighbors` /
 *     `inbound` (and NQL TRACE) can walk it without parsing documents.
 *
 * The previous event on the same workspace is always linked as a cause, so
 * the chain stays continuous even when a caller passes no `causedBy`. A
 * caller-named cause that does not exist is refused: a receipt pointing at
 * nothing is worse than a receipt with no pointer.
 */

export const EVENTS = "studio_events";
export const SCENES = "studio_scenes";
export const CAUSED_BY = "caused_by";

// Recording kinds sit alongside the live ones on purpose: recording is the
// primary act, so a take leaves the same tamper-evident trail a broadcast
// does. `recording_finalised` is separate from `recording_stopped` because the
// MP4 is a second artifact produced from the first, and losing that
// distinction would make a failed finalise look like a failed recording.
export const EVENT_KINDS = [
  "go_live",
  "stream_ended",
  "scene_saved",
  "source_added",
  "source_removed",
  "stream_error",
  "recording_started",
  "recording_stopped",
  "recording_finalised",
  "recording_error",
] as const;
export type StudioEventKind = (typeof EVENT_KINDS)[number];

export type StudioEvent = {
  id: string;
  workspaceId: string;
  kind: StudioEventKind;
  at: string;
  payload: Record<string, unknown>;
  causedBy: string[];
  seq: number;
};

export type StoreReceipt = { head: string; seq: number; verified: boolean };

export type StudioSceneDocument = {
  workspaceId: string;
  scene: Record<string, unknown>;
  version: number;
  savedAt: string;
  lastEventId: string;
};

/** Graph node name for an event — collection-qualified so it cannot collide. */
export function nodeOf(eventId: string): string {
  return `${EVENTS}/${eventId}`;
}
export function eventIdOfNode(node: string): string {
  return node.startsWith(`${EVENTS}/`) ? node.slice(EVENTS.length + 1) : node;
}

function chainId(workspaceId: string): string {
  return `chain:${workspaceId}`;
}

export function receipt(): StoreReceipt {
  const h = getStoreHealth();
  return { head: h.head, seq: h.sequence, verified: h.verified };
}

export function readEvent(id: string): StudioEvent | null {
  const raw = db.get(EVENTS, id);
  if (!raw) return null;
  const parsed = JSON.parse(raw) as StudioEvent & Record<string, unknown>;
  return stripEngineFields(parsed);
}

/** The engine injects `_seq`, `_hash`, `_id`, `_coll`; keep `seq`, drop the rest for the wire. */
function stripEngineFields(doc: StudioEvent & Record<string, unknown>): StudioEvent {
  const { _seq, _hash, _id, _coll, ...rest } = doc;
  void _hash;
  void _id;
  void _coll;
  const seq = typeof rest.seq === "number" ? rest.seq : Number(_seq ?? 0);
  return { ...(rest as StudioEvent), seq };
}

/** The most recent event id on a workspace's chain, if any. */
function chainTip(workspaceId: string): string | null {
  const raw = db.get(EVENTS, chainId(workspaceId));
  if (!raw) return null;
  const parsed = JSON.parse(raw) as { tip?: string };
  return typeof parsed.tip === "string" ? parsed.tip : null;
}

export class UnknownCauseError extends Error {
  readonly status = 404;
  constructor(readonly missing: string[]) {
    super(`causedBy names events that do not exist: ${missing.join(", ")}`);
  }
}

export function recordEvent(input: {
  workspaceId: string;
  kind: StudioEventKind;
  at?: string;
  payload?: Record<string, unknown>;
  causedBy?: string[];
}): { event: StudioEvent; receipt: StoreReceipt } {
  const causes = new Set<string>(input.causedBy ?? []);
  const missing = [...causes].filter((id) => !db.get(EVENTS, id));
  if (missing.length > 0) throw new UnknownCauseError(missing);

  // The chain: whatever happened last on this workspace is a cause of this.
  const previous = chainTip(input.workspaceId);
  if (previous && previous !== undefined) causes.add(previous);

  const id = `ev_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
  const causedBy = [...causes];
  const stored = JSON.parse(
    db.put(
      EVENTS,
      id,
      JSON.stringify({
        id,
        workspaceId: input.workspaceId,
        kind: input.kind,
        at: input.at ?? new Date().toISOString(),
        payload: input.payload ?? {},
        causedBy,
      }),
    ),
  ) as StudioEvent & Record<string, unknown>;
  const seq = Number(stored._seq ?? db.seq());

  // Persist seq on the document so readers do not depend on engine fields, and
  // so the wire shape is identical for the write response and later reads.
  const withSeq = JSON.parse(db.put(EVENTS, id, JSON.stringify({ ...stripEngineFields(stored), seq }))) as StudioEvent & Record<string, unknown>;

  for (const cause of causedBy) db.link(nodeOf(id), CAUSED_BY, nodeOf(cause));
  db.put(EVENTS, chainId(input.workspaceId), JSON.stringify({ tip: id, workspaceId: input.workspaceId }));
  db.flush();

  return { event: stripEngineFields(withSeq), receipt: receipt() };
}

export function listEvents(workspaceId: string, limit = 50): StudioEvent[] {
  // Walk the chain from the tip: newest first, bounded, no full scan.
  const out: StudioEvent[] = [];
  let cursor = chainTip(workspaceId);
  const seen = new Set<string>();
  while (cursor && out.length < limit && !seen.has(cursor)) {
    seen.add(cursor);
    const ev = readEvent(cursor);
    if (!ev) break;
    out.push(ev);
    // The chain predecessor is the cause that lives on the same workspace and
    // was written immediately before; by construction it is the one we added.
    cursor = ev.causedBy.map(readEvent).filter((c): c is StudioEvent => !!c && c.workspaceId === workspaceId).sort((a, b) => b.seq - a.seq)[0]?.id ?? null;
  }
  return out;
}

export function traceEvent(id: string, maxDepth = 64): { event: StudioEvent; causes: StudioEvent[]; effects: StudioEvent[] } | null {
  const event = readEvent(id);
  if (!event) return null;
  const causes: StudioEvent[] = [];
  const seen = new Set<string>([id]);
  let frontier = [id];
  let depth = 0;
  while (frontier.length > 0 && depth < maxDepth) {
    const next: string[] = [];
    for (const node of frontier) {
      for (const cause of db.neighbors(nodeOf(node), CAUSED_BY)) {
        const cid = eventIdOfNode(cause);
        if (seen.has(cid)) continue;
        seen.add(cid);
        const ev = readEvent(cid);
        if (ev) {
          causes.push(ev);
          next.push(cid);
        }
      }
    }
    frontier = next;
    depth += 1;
  }
  const effects = db
    .inbound(nodeOf(id), CAUSED_BY)
    .map((n) => readEvent(eventIdOfNode(n)))
    .filter((e): e is StudioEvent => e !== null);
  return { event, causes, effects };
}

export function readScene(workspaceId: string): StudioSceneDocument | null {
  const raw = db.get(SCENES, workspaceId);
  if (!raw) return null;
  const { _seq, _hash, _id, _coll, ...doc } = JSON.parse(raw) as StudioSceneDocument & Record<string, unknown>;
  void _seq;
  void _hash;
  void _id;
  void _coll;
  return doc as StudioSceneDocument;
}

export function saveScene(workspaceId: string, scene: Record<string, unknown>): { document: StudioSceneDocument; event: StudioEvent; receipt: StoreReceipt } {
  const previous = readScene(workspaceId);
  const version = (previous?.version ?? 0) + 1;
  const layers = Array.isArray((scene as { layers?: unknown }).layers) ? ((scene as { layers: unknown[] }).layers.length) : 0;
  const { event } = recordEvent({
    workspaceId,
    kind: "scene_saved",
    payload: { version, layers },
    causedBy: previous?.lastEventId ? [previous.lastEventId] : [],
  });
  const document: StudioSceneDocument = {
    workspaceId,
    scene,
    version,
    savedAt: event.at,
    lastEventId: event.id,
  };
  db.put(SCENES, workspaceId, JSON.stringify(document));
  db.flush();
  return { document, event, receipt: receipt() };
}
