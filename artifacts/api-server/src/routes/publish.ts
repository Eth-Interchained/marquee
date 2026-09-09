import { Router, type IRouter } from "express";
import {
  BeginSignInBody,
  BeginSignInResponse,
  GetSessionStatusResponse,
  PublishPostBody,
  SignOutOfSessionBody,
  SignOutOfSessionResponse,
} from "@marquee/api-zod";
import { readBrowserState } from "../lib/browser-store";
import { releaseClaim, takeClaim } from "../lib/dispatch-claims";
import {
  dispatchApprovedPost,
  idempotencyKeyFor,
} from "../lib/publish-dispatch";
import { mediaFingerprint, type MediaRef } from "../lib/media-store";
import { beginSignIn, readSessionStatus, signOutOfSession } from "../lib/session-bridge";
import { asStoredDraft, type StoredDraft } from "../lib/stored-draft";
import { tenantOrUnauthorized } from "../lib/tenant";

const router: IRouter = Router();

/** Statuses that mean a person has signed this draft off. */
const APPROVED_STATUSES = new Set([
  "approved",
  "scheduled",
  "publishing",
  "failed",
]);

type ApprovedDraft = StoredDraft & { approvedBy: string; approvedAt: string };

type ApprovalCheck =
  | { ok: true; draft: ApprovedDraft }
  | { ok: false; detail: string };

/**
 * Checks the approval against the stored draft rather than the request.
 *
 * The caller asserting `approval` in its own body proves nothing: whoever sends
 * the request writes those fields. The only trustworthy record of a human
 * sign-off is the one already in the ledger, put there by the workspace UI, so
 * that is what decides whether anything leaves. The submitted body must match
 * the approved text too — otherwise an approved draft id becomes a licence to
 * post anything.
 *
 * This is the same reading the scheduler does before an automatic send, so both
 * paths are held to one approval rather than to two different ones.
 */
function verifyApproval(
  tenantId: string,
  input: {
    workspaceId: string;
    draftId: string;
    platform: string;
    body: string;
    media?: MediaRef[];
    approval: { approvedBy: string; approvedAt: string };
  },
): ApprovalCheck {
  const state = readBrowserState(tenantId);
  if (!state) {
    return {
      ok: false,
      detail: "No workspace state is stored yet, so nothing has been approved.",
    };
  }

  const draft: StoredDraft | null =
    state.drafts
      .map(asStoredDraft)
      .find((entry): entry is StoredDraft => entry?.id === input.draftId) ??
    null;
  if (!draft) {
    return {
      ok: false,
      detail: `Draft ${input.draftId} is not in this workspace's ledger. Only a stored, approved draft can be published.`,
    };
  }

  const approvedBy = draft.approvedBy?.trim();
  const approvedAt = draft.approvedAt?.trim();
  if (!APPROVED_STATUSES.has(draft.status) || !approvedBy || !approvedAt) {
    return {
      ok: false,
      detail:
        "That draft has not been approved by a person. Approve it in the review queue first.",
    };
  }

  if (draft.workspaceId !== input.workspaceId) {
    return {
      ok: false,
      detail: "That draft was approved for a different workspace.",
    };
  }

  if (draft.platform !== input.platform) {
    return {
      ok: false,
      detail: "That draft was approved for a different network.",
    };
  }

  if (draft.body !== input.body) {
    return {
      ok: false,
      detail:
        "The submitted text does not match the approved draft. Approve the edited version first.",
    };
  }

  // An approval covers the pictures as much as the words. Without this an
  // approved draft id would be a licence to post any image, which is the same
  // hole the body check above exists to close — and alt text is published
  // content too, so a changed description is a changed post.
  if (mediaFingerprint(draft.media) !== mediaFingerprint(input.media)) {
    return {
      ok: false,
      detail:
        "The submitted attachments do not match the approved draft. Approve the edited version first.",
    };
  }

  if (
    input.approval.approvedBy.trim() !== approvedBy ||
    input.approval.approvedAt.trim() !== approvedAt
  ) {
    return {
      ok: false,
      detail:
        "The approval in this request disagrees with the recorded sign-off.",
    };
  }

  return { ok: true, draft: { ...draft, approvedBy, approvedAt } };
}

router.get("/session/status", async (req, res) => {
  const workspaceId = req.query.workspaceId;
  if (typeof workspaceId !== "string" || workspaceId.trim() === "") {
    return res.status(400).json({ error: "workspaceId is required" });
  }

  const platform =
    typeof req.query.platform === "string" && req.query.platform.trim() !== ""
      ? req.query.platform.trim()
      : undefined;

  const status = await readSessionStatus(workspaceId, platform);
  return res.json(GetSessionStatusResponse.parse(status));
});

/**
 * Live sign-in.
 *
 * The account is authenticated inside the shell's own browser, in the network's
 * own login page, under this workspace's isolated session. Nothing about the
 * credentials passes through here — this endpoint only asks the shell to put
 * that page in front of the operator, and says whether it managed to.
 */
router.post("/session/signin", async (req, res) => {
  const parsed = BeginSignInBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "workspaceId is required" });
  }

  const invitation = await beginSignIn(
    parsed.data.workspaceId,
    parsed.data.platform,
  );

  req.log.info(
    {
      workspaceId: invitation.workspaceId,
      opened: invitation.opened,
      alreadySignedIn: invitation.alreadySignedIn,
    },
    "Live sign-in requested",
  );

  return res.json(BeginSignInResponse.parse(invitation));
});

/**
 * Sign-out.
 *
 * Destroys one network's session inside a workspace and reports what the
 * session says afterwards. Nothing here decides success: the shell removes the
 * cookies, re-reads, and this passes that answer along.
 */
router.post("/session/signout", async (req, res) => {
  const parsed = SignOutOfSessionBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "workspaceId is required" });
  }

  const outcome = await signOutOfSession(
    parsed.data.workspaceId,
    parsed.data.platform,
  );

  req.log.info(
    {
      workspaceId: parsed.data.workspaceId,
      platform: parsed.data.platform ?? "(workspace default)",
      signedOut: outcome.signedOut,
    },
    "Sign-out requested",
  );

  return res.json(SignOutOfSessionResponse.parse(outcome));
});

router.post("/publish", async (req, res) => {
  const parsed = PublishPostBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid publish request" });
  }

  const input = parsed.data;
  const tenantId = tenantOrUnauthorized(req, res);
  if (!tenantId) return;

  // The approval is the whole point of the product: a model may draft, but a
  // person signs. No approval, no network call. The sign-off is read from the
  // stored ledger, never from the request that wants to publish.
  const approval = verifyApproval(tenantId, input);
  if (!approval.ok) {
    req.log.warn(
      { workspaceId: input.workspaceId, draftId: input.draftId },
      "Refused a publish request with no recorded human approval",
    );
    return res.status(409).json({ error: approval.detail });
  }

  const stored = approval.draft;

  // A post is identified by itself and the approval it carries, and by nothing
  // a caller gets to choose. A client may send that key along, but a different
  // one is refused rather than honoured: two invented keys for one post would
  // each look new, and each would post.
  const expectedKey = idempotencyKeyFor(stored.id, stored.approvedAt);
  if (input.idempotencyKey && input.idempotencyKey !== expectedKey) {
    return res.status(400).json({
      error:
        "The idempotency key of a post is its draft and the approval it carries; a different key cannot be supplied.",
    });
  }

  // The same claim the scheduler takes, for the same reason: while this is on
  // its way out, the stored copy is the truth and nothing may quietly rewrite
  // the post underneath it.
  const claim = takeClaim(tenantId, stored.id, stored.approvedAt);
  if (!claim) {
    return res
      .status(409)
      .json({ error: "This post is already on its way out." });
  }

  // Same door the scheduler uses: whichever of the two gets there first does
  // the posting, and the other is handed that result rather than posting again.
  const outcome = await dispatchApprovedPost({
    tenantId,
    workspaceId: stored.workspaceId,
    draftId: stored.id,
    platform: stored.platform,
    body: stored.body,
    // The stored copy, like the text: what was approved is what is sent.
    media: stored.media,
    approval: { approvedBy: stored.approvedBy, approvedAt: stored.approvedAt },
    source: "operator",
    // Pressing Post on a post that is also due is that instruction being
    // carried out, so it is recorded against the send time and the scheduler
    // does not come along afterwards and send it a second time.
    ...(stored.scheduledFor ? { scheduledFor: stored.scheduledFor } : {}),
  }).finally(() => releaseClaim(claim));

  const base = {
    draftId: input.draftId,
    platform: input.platform,
    attemptedAt: outcome.attemptedAt,
  };

  if (outcome.status === "published") {
    req.log.info(
      {
        workspaceId: input.workspaceId,
        draftId: input.draftId,
        replayed: outcome.replayed,
      },
      outcome.replayed
        ? "Publish replayed an earlier dispatch of the same approval"
        : "Published through workspace session",
    );
    return res.json({
      ...base,
      status: "published" as const,
      postUrl: outcome.postUrl,
      postId: outcome.postId,
      message: outcome.message,
    });
  }

  const failure = {
    ...base,
    status: "failed" as const,
    message: outcome.message,
  };

  switch (outcome.reason) {
    case "approval-missing":
      return res.status(409).json({ error: outcome.message });
    case "unauthenticated":
      return res.status(409).json(failure);
    case "rejected":
      return res.status(502).json(failure);
    default:
      return res.status(503).json(failure);
  }
});

export default router;
