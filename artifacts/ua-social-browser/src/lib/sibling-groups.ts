/**
 * Variants of one idea, kept together in the queue.
 *
 * The composer is a pool: ask for options, keep the ones worth keeping. Each
 * one kept becomes its own draft, and by the time they reach the queue nothing
 * records that they were ever alternatives to each other. Three cards with
 * three different wordings of one announcement look exactly like three separate
 * announcements.
 *
 * That is not only untidy, it is a way to post the same thing twice. Approving
 * a card is a small, safe-feeling action; approving three cards that happen to
 * be three drafts of one idea sends one idea three times, and nothing in the
 * queue says so at the moment of the click.
 *
 * So grouping here does two jobs, and the second is the one that matters:
 *
 *  1. Siblings render as one stack instead of three unrelated cards.
 *  2. When more than one sibling is already cleared to send, the group says so.
 *
 * **Grouping never overrides the queue's order.** `orderForQueue` decides where
 * things sit — what is waiting on you, what is about to fire without you. This
 * runs after it, only ever pulls a sibling *up to* the first of its group, and
 * only within one status rank: a posted variant and a pending variant are not
 * the same kind of thing, and folding history into a live decision would hide
 * exactly the fact the operator needs.
 */

import type { Draft } from "@/types";
import { queueKey } from "@/lib/queue-order";

/** Statuses where a draft is cleared to send, or already gone. */
const COMMITTED = new Set<Draft["status"]>([
  "approved",
  "scheduled",
  "publishing",
  "published",
  "attested",
]);

/** One row of the rendered queue: a lone draft, or a stack of variants. */
export type QueueRow =
  | { kind: "single"; key: string; draft: Draft }
  | {
      kind: "group";
      key: string;
      generationId: string;
      drafts: Draft[];
      /** How many of these are already cleared to send, or sent. */
      committed: number;
      /**
       * Set when more than one variant is committed. This is the whole reason
       * the grouping exists, so it is computed here rather than in the view.
       */
      warning: string | null;
    };

/** Two drafts are siblings when they came out of the same generation. */
function siblingKeyOf(draft: Draft): string | null {
  const generationId = draft.origin?.generationId;
  if (typeof generationId !== "string" || generationId.trim() === "")
    return null;
  return generationId;
}

/**
 * What to tell the operator about a group where several variants are live.
 *
 * Deliberately does not say "error". Posting variants of one idea to different
 * networks is a normal thing to do on purpose; posting them to the *same*
 * network usually is not. So the wording names what will happen and leaves the
 * judgement where it belongs.
 */
export function describeCommittedSiblings(
  drafts: readonly Draft[],
): string | null {
  const committed = drafts.filter((draft) => COMMITTED.has(draft.status));
  if (committed.length < 2) return null;

  const platforms = new Set(committed.map((draft) => draft.platform));
  const count = committed.length;

  if (platforms.size === 1) {
    return `${count} variants of this one idea are cleared to go out on the same network. Unless that is deliberate, revoke all but one.`;
  }

  return `${count} variants of this one idea are cleared to go out, across ${platforms.size} networks.`;
}

/**
 * Folds an already-ordered queue into rows, grouping siblings.
 *
 * The input must already be through `orderForQueue`. A group takes the place of
 * its first member; later siblings of the same rank join it there and are not
 * emitted again. A single remaining sibling is not a group — a stack of one is
 * just a card with extra chrome.
 */
export function groupSiblings(ordered: readonly Draft[]): QueueRow[] {
  const rows: QueueRow[] = [];
  const claimed = new Set<string>();

  for (const draft of ordered) {
    if (claimed.has(draft.id)) continue;

    const sibling = siblingKeyOf(draft);
    if (sibling === null) {
      rows.push({ kind: "single", key: draft.id, draft });
      continue;
    }

    const rank = queueKey(draft).rank;
    const family = ordered.filter(
      (other) =>
        !claimed.has(other.id) &&
        siblingKeyOf(other) === sibling &&
        queueKey(other).rank === rank,
    );

    for (const member of family) claimed.add(member.id);

    if (family.length < 2) {
      rows.push({ kind: "single", key: draft.id, draft });
      continue;
    }

    rows.push({
      kind: "group",
      // Keyed by the anchor as well as the generation: one generation can hold
      // members at two different ranks, which is two rows, not one.
      key: `${sibling}:${draft.id}`,
      generationId: sibling,
      drafts: family,
      committed: family.filter((member) => COMMITTED.has(member.status)).length,
      warning: describeCommittedSiblings(family),
    });
  }

  return rows;
}

/** Every draft in the rows, in render order. Used by tests and by focus order. */
export function draftsInRows(rows: readonly QueueRow[]): Draft[] {
  return rows.flatMap((row) =>
    row.kind === "single" ? [row.draft] : row.drafts,
  );
}
