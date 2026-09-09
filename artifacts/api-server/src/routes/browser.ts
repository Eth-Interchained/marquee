import { Router, type IRouter } from "express";
import {
  exportStoreHistory,
  getStoreHealth,
  readBrowserState,
  writeBrowserState,
  type BrowserStateDocument,
} from "../lib/browser-store";
import { claimedDraftIds } from "../lib/dispatch-claims";
import { logger } from "../lib/logger";
import { mediaFingerprint } from "../lib/media-store";
import { asStoredDraft } from "../lib/stored-draft";
import { tenancyMode, tenantLabel, tenantOrUnauthorized } from "../lib/tenant";

const router: IRouter = Router();

/** The fields that decide whether, and as what, a post goes out. */
const DISPATCH_FIELDS = [
  "body",
  "platform",
  "status",
  "scheduledFor",
  "approvedBy",
  "approvedAt",
] as const;

function draftId(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const id = (value as Record<string, unknown>).id;
  return typeof id === "string" ? id : null;
}

function differsInDispatch(incoming: unknown, stored: unknown): boolean {
  const a = incoming as Record<string, unknown>;
  const b = stored as Record<string, unknown>;
  const changed: string[] = DISPATCH_FIELDS.filter(
    (field) => a?.[field] !== b?.[field],
  );

  // Attachments are a dispatch field too — swapping the picture under a send
  // changes what reaches an audience just as surely as swapping the words. It
  // cannot join the list above because that compares by identity, and two
  // arrays holding the same references are never `===`; comparing them that
  // way would report every save as a change and hold drafts nobody edited.
  if (mediaFingerprint(asStoredDraft(a)?.media) !== mediaFingerprint(asStoredDraft(b)?.media)) {
    changed.push("media");
  }

  if (changed.length === 0) return false;

  // Marking a post as going out is the browser agreeing with what is already
  // happening, not overwriting it. Holding that would make every press of Post
  // look like a rejected edit.
  if (changed.length === 1 && changed[0] === "status" && a.status === "publishing") {
    return false;
  }

  return true;
}

/**
 * A draft that is being sent right now cannot be taken back, so the browser is
 * not allowed to overwrite it mid-flight. Its stored copy wins and the browser
 * is told which drafts were held, rather than being left to believe an edit or
 * a revocation landed when the post was already on its way out.
 */
function holdDraftsBeingSent(
  tenantId: string,
  incoming: BrowserStateDocument,
): { document: BrowserStateDocument; heldDrafts: string[] } {
  const claimed = claimedDraftIds(tenantId);
  if (claimed.size === 0) return { document: incoming, heldDrafts: [] };

  const stored = readBrowserState(tenantId);
  if (!stored) return { document: incoming, heldDrafts: [] };

  const storedById = new Map<string, unknown>();
  for (const draft of stored.drafts) {
    const id = draftId(draft);
    if (id && claimed.has(id)) storedById.set(id, draft);
  }
  if (storedById.size === 0) return { document: incoming, heldDrafts: [] };

  const heldDrafts: string[] = [];
  const seen = new Set<string>();

  const drafts = incoming.drafts.map((draft) => {
    const id = draftId(draft);
    if (!id) return draft;
    seen.add(id);

    const authoritative = storedById.get(id);
    if (!authoritative) return draft;
    if (!differsInDispatch(draft, authoritative)) return draft;

    heldDrafts.push(id);
    return authoritative;
  });

  // Discarding a post that is already going out does not stop it either.
  for (const [id, authoritative] of storedById) {
    if (seen.has(id)) continue;
    drafts.push(authoritative);
    heldDrafts.push(id);
  }

  if (heldDrafts.length === 0) return { document: incoming, heldDrafts: [] };

  logger.warn(
    { tenantId, heldDrafts },
    "Held a state write over drafts that are being sent",
  );
  return { document: { ...incoming, drafts }, heldDrafts };
}

function isBrowserState(value: unknown): value is BrowserStateDocument {
  if (!value || typeof value !== "object") return false;
  const state = value as Record<string, unknown>;
  return (
    typeof state.version === "number" &&
    typeof state.activeWorkspaceId === "string" &&
    Array.isArray(state.workspaces) &&
    Array.isArray(state.uaProfiles) &&
    Array.isArray(state.drafts) &&
    Array.isArray(state.accounts) &&
    Array.isArray(state.activity) &&
    typeof state.settings === "object" &&
    typeof state.usage === "object"
  );
}

router.get("/tenant", (req, res): void => {
  const tenantId = tenantOrUnauthorized(req, res);
  if (!tenantId) return;
  res.json({
    id: tenantId,
    mode: tenancyMode(),
    label: tenantLabel(tenantId),
  });
});

router.get("/browser/state", (req, res): void => {
  const tenantId = tenantOrUnauthorized(req, res);
  if (!tenantId) return;
  res.json({
    state: readBrowserState(tenantId),
    integrity: getStoreHealth(),
  });
});

router.put("/browser/state", (req, res): void => {
  const tenantId = tenantOrUnauthorized(req, res);
  if (!tenantId) return;

  if (!isBrowserState(req.body)) {
    res.status(400).json({ error: "Invalid browser state" });
    return;
  }

  const { document, heldDrafts } = holdDraftsBeingSent(tenantId, req.body);

  res.json({
    state: writeBrowserState(tenantId, document),
    integrity: getStoreHealth(),
    heldDrafts,
  });
});

router.get("/browser/integrity", (_req, res): void => {
  res.json(getStoreHealth());
});

router.get("/browser/export", (req, res): void => {
  const tenantId = tenantOrUnauthorized(req, res);
  if (!tenantId) return;

  res.setHeader(
    "Content-Disposition",
    'attachment; filename="marquee-export.json"',
  );
  res.json(exportStoreHistory(tenantId));
});

export default router;
