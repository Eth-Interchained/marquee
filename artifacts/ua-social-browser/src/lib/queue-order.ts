/**
 * The order the review queue puts posts in.
 *
 * This existed as one line — `b.updatedAt.localeCompare(a.updatedAt)` — and
 * that line had a bug the owner found by using it: toggling "post immediately"
 * bounced him to the top of the page.
 *
 * Nothing was scrolling. `patchDraft` stamps `updatedAt` on every change, so
 * the moment a card was touched it became the newest thing in the list and
 * moved to position 0, dragging the eye with it and pushing everything else
 * down. **Ordering a work queue by "last touched" means every edit reshuffles
 * it under the operator's hands.**
 *
 * So the rule here is: within any group the operator is actively working, the
 * sort key is a timestamp that *cannot change when they edit*. `updatedAt`
 * survives only for finished history, which is locked and cannot be edited at
 * all.
 *
 * The groups are ordered by what each card is waiting for, because that is the
 * question the queue exists to answer — not "what did I touch last" but "what
 * needs me, and what is about to happen without me".
 */

import type { Draft, DraftStatus } from '@/types';

/**
 * Where a status sits in the queue, and which clock it runs on.
 *
 * Lower ranks come first. The clocks differ per group on purpose:
 *
 *  - **failed / draft** wait on a decision, so they run on `createdAt`
 *    ascending: whatever has been waiting longest is first, and `createdAt`
 *    never changes, so editing a card cannot move it.
 *  - **publishing / scheduled** are going to happen on their own, so they run
 *    on `scheduledFor` ascending. The next thing to fire is the last thing
 *    still worth stopping.
 *  - **approved** with no time is ready but unsent, on `approvedAt` ascending.
 *  - **published / attested** are history, newest first. `updatedAt` is safe
 *    here precisely because these cards are locked.
 */
const RANK: Record<DraftStatus, number> = {
  failed: 0,
  draft: 1,
  publishing: 2,
  scheduled: 3,
  approved: 4,
  published: 5,
  attested: 5,
};

/** Which timestamp a status is ordered by, and in which direction. */
type Clock = { at: (draft: Draft) => string; newestFirst: boolean };

const CLOCK: Record<DraftStatus, Clock> = {
  failed: { at: (d) => d.createdAt, newestFirst: false },
  draft: { at: (d) => d.createdAt, newestFirst: false },
  publishing: { at: (d) => d.scheduledFor ?? d.createdAt, newestFirst: false },
  scheduled: { at: (d) => d.scheduledFor ?? d.createdAt, newestFirst: false },
  approved: { at: (d) => d.approvedAt ?? d.createdAt, newestFirst: false },
  published: { at: (d) => d.updatedAt, newestFirst: true },
  attested: { at: (d) => d.updatedAt, newestFirst: true },
};

/**
 * The sort key for one draft, as a comparable tuple.
 *
 * Exported so a test can assert the thing that matters: that the key does not
 * change when a draft is edited.
 */
export function queueKey(draft: Draft): { rank: number; at: string } {
  return { rank: RANK[draft.status], at: CLOCK[draft.status].at(draft) };
}

/**
 * Orders the queue. Pure, and a new array — the caller's list is untouched.
 *
 * Ties break on `id` so the order is total: two drafts created in the same
 * millisecond must not swap places between renders, or the list would shuffle
 * on its own.
 */
export function orderForQueue(drafts: Draft[]): Draft[] {
  return [...drafts].sort((a, b) => {
    const left = queueKey(a);
    const right = queueKey(b);

    if (left.rank !== right.rank) return left.rank - right.rank;

    const compared = left.at.localeCompare(right.at);
    if (compared !== 0) {
      return CLOCK[a.status].newestFirst ? -compared : compared;
    }

    return a.id.localeCompare(b.id);
  });
}

/**
 * Whether editing a draft could move it in the queue.
 *
 * True only when the edit changes the status group or the group's own clock —
 * changing a scheduled time genuinely is a change of when it fires, and the
 * operator asked for that. Everything else must leave the position alone, and
 * there is a test asserting it.
 */
export function editWouldReorder(before: Draft, after: Draft): boolean {
  const from = queueKey(before);
  const to = queueKey(after);
  return from.rank !== to.rank || from.at !== to.at;
}
