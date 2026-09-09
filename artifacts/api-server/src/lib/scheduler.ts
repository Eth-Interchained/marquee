import { PublishPostBody } from "@marquee/api-zod";
import { readBrowserState } from "./browser-store";
import type { DispatchClaim } from "./dispatch-claims";
import { releaseClaim, takeClaim } from "./dispatch-claims";
import { findInstructionAttempt, recordDispatch } from "./dispatch-log";
import { logger } from "./logger";
import { dispatchApprovedPost, idempotencyKeyFor } from "./publish-dispatch";
import { isBridgeConfigured } from "./session-bridge";
import {
  asStoredDraft,
  isApproved,
  readStoredDraft,
  type StoredDraft,
} from "./stored-draft";
import { SINGLE_TENANT_ID, tenancyMode } from "./tenant";

/**
 * Scheduled dispatch.
 *
 * A time attached to an approved draft is a promise that the post will go out
 * then. This loop keeps it: every tick it looks for drafts that are due and
 * pushes them through the same door the Post button uses.
 *
 * What it deliberately does not do:
 *
 * - It never posts without an approval attached. Editing a draft clears the
 *   approval, so an edited draft simply stops being eligible.
 * - It never retries on its own. One automatic attempt per instruction — this
 *   approval, for this send time — after which the draft is `failed` with the
 *   reason on it and a person decides. Moving it to a new time is a new
 *   instruction and earns one more attempt; the idempotency key is what stops
 *   any of that posting the same thing twice.
 * - It never writes into the browser state document. The browser owns that
 *   document; the scheduler reports through the dispatch log instead, so the
 *   two cannot clobber each other's writes.
 */

const DEFAULT_INTERVAL_MS = 30_000;

export function schedulerIntervalMs(): number {
  const raw = process.env.MARQUEE_SCHEDULER_INTERVAL_MS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_INTERVAL_MS;
  const parsed = Number(raw);
  if (Number.isNaN(parsed) || parsed < 0) return DEFAULT_INTERVAL_MS;
  return Math.floor(parsed);
}

export type SchedulerStatus = {
  active: boolean;
  bridgeConfigured: boolean;
  intervalMs: number;
  detail: string;
};

export function schedulerStatus(): SchedulerStatus {
  const intervalMs = schedulerIntervalMs();
  const bridgeConfigured = isBridgeConfigured();

  if (tenancyMode() === "multi") {
    return {
      active: false,
      bridgeConfigured,
      intervalMs,
      detail:
        "Automatic dispatch is off in multi-tenant mode: the scheduler has no authenticated tenant to act for. Scheduled posts wait for someone to press Post.",
    };
  }

  if (intervalMs === 0) {
    return {
      active: false,
      bridgeConfigured,
      intervalMs,
      detail:
        "Automatic dispatch is switched off. A scheduled post waits until someone presses Post.",
    };
  }

  if (!bridgeConfigured) {
    return {
      active: true,
      bridgeConfigured,
      intervalMs,
      detail:
        "The desktop shell is not attached, so there is no signed-in session to post through. A scheduled post that comes due is marked failed rather than quietly held back.",
    };
  }

  return {
    active: true,
    bridgeConfigured,
    intervalMs,
    detail:
      "Scheduled posts are sent automatically through this workspace's signed-in session, carrying the approval they were signed with.",
  };
}

type ClaimedDispatch = {
  claim: DispatchClaim;
  request: ReturnType<typeof PublishPostBody.parse>;
  scheduledFor: string;
  idempotencyKey: string;
};

/**
 * Decides whether one draft may be sent, and claims it if so.
 *
 * Deliberately synchronous from the read to the claim: nothing may run between
 * checking that the approval is still attached and locking the draft, or a
 * revocation written in that gap would be read as "still approved" and the post
 * would go out anyway. The tick's earlier snapshot is not trusted here — by the
 * time a slow bridge call has returned, it can be seconds old.
 */
function claimDueDraft(
  tenantId: string,
  draftId: string,
  now: number,
): ClaimedDispatch | null {
  const draft = readStoredDraft(tenantId, draftId);
  if (!draft || draft.status !== "scheduled") return null;

  const dueAt = draft.scheduledFor ? Date.parse(draft.scheduledFor) : NaN;
  if (Number.isNaN(dueAt) || dueAt > now) return null;

  // An edited draft has lost its approval. It is skipped, never sent.
  if (!isApproved(draft)) {
    logger.warn(
      { draftId: draft.id },
      "Scheduled draft came due without a human approval attached; skipping",
    );
    return null;
  }

  const scheduledFor = draft.scheduledFor as string;
  const idempotencyKey = idempotencyKeyFor(draft.id, draft.approvedAt);

  // One attempt per instruction. A previous result — sent, failed, or made by
  // hand — means this loop is done until a person changes something.
  if (findInstructionAttempt(tenantId, idempotencyKey, scheduledFor)) {
    return null;
  }

  // Held to the same contract as the manual route rather than a looser one.
  const parsed = PublishPostBody.safeParse({
    workspaceId: draft.workspaceId,
    draftId: draft.id,
    platform: draft.platform,
    body: draft.body,
    media: draft.media,
    approval: { approvedBy: draft.approvedBy, approvedAt: draft.approvedAt },
    idempotencyKey,
  });
  if (!parsed.success) {
    const detail = parsed.error.issues[0]?.message ?? "it failed validation";
    recordDispatch(tenantId, {
      idempotencyKey,
      draftId: draft.id,
      workspaceId: draft.workspaceId,
      platform: draft.platform,
      approvedBy: draft.approvedBy,
      approvedAt: draft.approvedAt,
      scheduledFor,
      status: "failed",
      message: `This post could not be sent as written: ${detail}. Nothing was posted.`,
      source: "scheduler",
      dispatchedAt: new Date().toISOString(),
    });
    return null;
  }

  const claim = takeClaim(tenantId, draft.id, draft.approvedAt);
  if (!claim) return null;

  return { claim, request: parsed.data, scheduledFor, idempotencyKey };
}

/** Runs one pass. Exported so it can be driven directly in a test or a probe. */
export async function runSchedulerTick(
  tenantId: string = SINGLE_TENANT_ID,
): Promise<number> {
  const state = readBrowserState(tenantId);
  if (!state) return 0;

  const now = Date.now();
  let dispatched = 0;

  // Only a shortlist is taken from this read. Each draft is checked again, from
  // storage, at the moment it is about to be sent.
  const candidates = state.drafts
    .map(asStoredDraft)
    .filter((draft): draft is StoredDraft => draft?.status === "scheduled")
    .map((draft) => draft.id);

  for (const draftId of candidates) {
    const claimed = claimDueDraft(tenantId, draftId, now);
    if (!claimed) continue;

    try {
      const outcome = await dispatchApprovedPost({
        ...claimed.request,
        tenantId,
        scheduledFor: claimed.scheduledFor,
        source: "scheduler",
      });
      dispatched += 1;

      // The dispatch may have replayed one that had already gone out, in which
      // case no record was written for this instruction. It still has to be
      // written down, or the next pass would see no attempt for it and send it
      // again.
      if (
        !findInstructionAttempt(
          tenantId,
          claimed.idempotencyKey,
          claimed.scheduledFor,
        )
      ) {
        recordDispatch(tenantId, {
          idempotencyKey: claimed.idempotencyKey,
          draftId,
          workspaceId: claimed.request.workspaceId,
          platform: claimed.request.platform,
          approvedBy: claimed.request.approval.approvedBy,
          approvedAt: claimed.request.approval.approvedAt,
          scheduledFor: claimed.scheduledFor,
          status: outcome.status,
          message: outcome.message,
          postUrl: outcome.postUrl,
          postId: outcome.postId,
          source: "scheduler",
          dispatchedAt: outcome.attemptedAt,
        });
      }

      logger.info(
        {
          draftId,
          workspaceId: claimed.request.workspaceId,
          status: outcome.status,
          replayed: outcome.replayed,
        },
        "Scheduled post dispatched",
      );
    } finally {
      releaseClaim(claimed.claim);
    }
  }

  return dispatched;
}

let timer: NodeJS.Timeout | null = null;
let ticking = false;

export function startScheduler(): void {
  if (timer) return;

  const status = schedulerStatus();
  if (!status.active) {
    logger.info({ detail: status.detail }, "Scheduler not started");
    return;
  }

  const tick = () => {
    // Ticks never overlap: a slow bridge call must not be joined by the next
    // pass looking at the same still-undispatched draft.
    if (ticking) return;
    ticking = true;
    void runSchedulerTick()
      .catch((error) => {
        logger.error({ err: error }, "Scheduler tick failed");
      })
      .finally(() => {
        ticking = false;
      });
  };

  timer = setInterval(tick, status.intervalMs);
  timer.unref();
  logger.info(
    { intervalMs: status.intervalMs, bridgeConfigured: status.bridgeConfigured },
    "Scheduler started",
  );
  tick();
}

export function stopScheduler(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
