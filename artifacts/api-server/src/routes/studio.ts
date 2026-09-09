import { Router, type IRouter } from "express";
import { RecordStudioEventBody, SaveStudioSceneBody } from "@workspace/api-zod";
import {
  EVENT_KINDS,
  listEvents,
  readScene,
  recordEvent,
  receipt,
  saveScene,
  traceEvent,
  UnknownCauseError,
  type StudioEventKind,
} from "../lib/studio-store";
import { logger } from "../lib/logger";
import { tenantOrUnauthorized } from "../lib/tenant";

const router: IRouter = Router();

/**
 * Workspaces are scoped under the tenant even single-tenant, so a later
 * multi-tenant resolver partitions the receipts without a migration.
 */
function scoped(tenantId: string, workspaceId: string): string {
  return `${tenantId}:${workspaceId}`;
}

router.get("/studio/events", (req, res) => {
  const tenantId = tenantOrUnauthorized(req, res);
  if (!tenantId) return;
  const workspaceId = typeof req.query.workspaceId === "string" ? req.query.workspaceId : "";
  if (!workspaceId) {
    res.status(400).json({ error: "workspaceId is required" });
    return;
  }
  const limitRaw = Number(req.query.limit ?? 50);
  const limit = Number.isFinite(limitRaw) ? Math.min(500, Math.max(1, Math.floor(limitRaw))) : 50;
  res.json({ events: listEvents(scoped(tenantId, workspaceId), limit), receipt: receipt() });
});

router.post("/studio/events", (req, res) => {
  const tenantId = tenantOrUnauthorized(req, res);
  if (!tenantId) return;
  const parsed = RecordStudioEventBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid event", detail: parsed.error.flatten() });
    return;
  }
  const { workspaceId, kind, at, payload, causedBy } = parsed.data;
  if (!(EVENT_KINDS as readonly string[]).includes(kind)) {
    res.status(400).json({ error: `Unknown event kind ${kind}; allowed: ${EVENT_KINDS.join(", ")}` });
    return;
  }
  try {
    const result = recordEvent({
      workspaceId: scoped(tenantId, workspaceId),
      kind: kind as StudioEventKind,
      at: at ? new Date(at).toISOString() : undefined,
      payload: (payload ?? {}) as Record<string, unknown>,
      causedBy,
    });
    logger.info({ tenantId, workspaceId, kind, id: result.event.id, seq: result.event.seq, head: result.receipt.head }, "Studio event recorded");
    res.status(201).json(result);
  } catch (error) {
    if (error instanceof UnknownCauseError) {
      res.status(404).json({ error: error.message, missing: error.missing });
      return;
    }
    throw error;
  }
});

router.get("/studio/events/:id/trace", (req, res) => {
  const tenantId = tenantOrUnauthorized(req, res);
  if (!tenantId) return;
  const trace = traceEvent(req.params.id);
  if (!trace) {
    res.status(404).json({ error: `No event ${req.params.id}` });
    return;
  }
  res.json(trace);
});

router.get("/studio/scenes/:workspaceId", (req, res) => {
  const tenantId = tenantOrUnauthorized(req, res);
  if (!tenantId) return;
  const doc = readScene(scoped(tenantId, req.params.workspaceId));
  if (!doc) {
    res.status(404).json({ error: "No scene saved for this workspace yet" });
    return;
  }
  res.json({ ...doc, workspaceId: req.params.workspaceId });
});

router.put("/studio/scenes/:workspaceId", (req, res) => {
  const tenantId = tenantOrUnauthorized(req, res);
  if (!tenantId) return;
  const parsed = SaveStudioSceneBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid scene", detail: parsed.error.flatten() });
    return;
  }
  const result = saveScene(scoped(tenantId, req.params.workspaceId), parsed.data.scene as Record<string, unknown>);
  res.json({ ...result, document: { ...result.document, workspaceId: req.params.workspaceId } });
});

export default router;
