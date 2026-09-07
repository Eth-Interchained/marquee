/**
 * The composer's candidate pool.
 *
 * The composer is a loop: generate options, judge them, and each one you judge
 * leaves. So the list is a working pool rather than the result of one request —
 * a second generation adds to it instead of replacing it, and acting on a card
 * removes that card.
 *
 * Two things follow from that, and both are the reason this is a module with
 * tests rather than a few lines inline:
 *
 *  - **A candidate needs a stable id.** Review state used to be keyed by array
 *    index. That is harmless while the array only ever grows from zero, and
 *    actively dangerous the moment cards can be removed: drop option 2 and
 *    option 3's "I read this and take responsibility for it" slides onto
 *    option 4, so text nobody read reaches drafts under someone's sign-off.
 *  - **The label must not renumber.** An ordinal is assigned when a candidate
 *    arrives and never changes, so a card you are reading keeps its number
 *    while the ones around it disappear — and the numbers climbing past the
 *    batch size is an honest picture of how many options you have been through.
 */

/** The part of a model suggestion this module cares about. */
export type SuggestionLike = {
  text: string;
  rationale: string;
  characterCount: number;
};

export type Candidate<T extends SuggestionLike = SuggestionLike> = T & {
  /** Stable for the lifetime of the candidate. Review state is keyed by it. */
  id: string;
  /** Assigned on arrival, never reassigned. Drives the "Option N" label. */
  ordinal: number;
  /**
   * The generation this candidate arrived in.
   *
   * Carried so that drafts kept out of one run can be recognised as variants
   * of each other later — see `lib/sibling-groups.ts`. Required rather than
   * defaulted: a candidate whose origin quietly went missing produces a queue
   * that silently stops grouping, which looks like working software.
   */
  generationId: string;
};

/** Most suggestions differ; the ones that do not differ only in whitespace. */
function normalise(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

export type AppendResult<T extends SuggestionLike> = {
  candidates: Candidate<T>[];
  /** The next unused ordinal, to carry into the following generation. */
  nextOrdinal: number;
  /** How many arrivals were dropped as duplicates of what was already there. */
  duplicates: number;
};

/**
 * Adds a fresh batch to the pool.
 *
 * Duplicates are dropped rather than shown. Asking a model for more of the
 * same thing reliably produces some of the same thing, and a pool that fills
 * with repeats is worse than a short pool — it looks like progress.
 */
export function appendCandidates<T extends SuggestionLike>(input: {
  existing: readonly Candidate<T>[];
  incoming: readonly T[];
  startOrdinal: number;
  makeId: () => string;
  /** Shared by every candidate in this batch. */
  generationId: string;
}): AppendResult<T> {
  const seen = new Set(
    input.existing.map((candidate) => normalise(candidate.text)),
  );
  const candidates = [...input.existing];
  let ordinal = input.startOrdinal;
  let duplicates = 0;

  for (const suggestion of input.incoming) {
    const key = normalise(suggestion.text);
    if (key === "" || seen.has(key)) {
      duplicates += 1;
      continue;
    }
    seen.add(key);
    candidates.push({
      ...suggestion,
      id: input.makeId(),
      ordinal,
      generationId: input.generationId,
    });
    ordinal += 1;
  }

  return { candidates, nextOrdinal: ordinal, duplicates };
}

/** Replaces the pool outright, numbering from one. */
export function replaceCandidates<T extends SuggestionLike>(input: {
  incoming: readonly T[];
  makeId: () => string;
  generationId: string;
}): AppendResult<T> {
  return appendCandidates({
    existing: [],
    incoming: input.incoming,
    startOrdinal: 1,
    makeId: input.makeId,
    generationId: input.generationId,
  });
}

export function withoutCandidate<T extends SuggestionLike>(
  candidates: readonly Candidate<T>[],
  id: string,
): Candidate<T>[] {
  return candidates.filter((candidate) => candidate.id !== id);
}

/**
 * Drops review flags whose candidate has gone.
 *
 * Without this the map grows for the whole session, and — worse — a recycled
 * id would inherit a sign-off given to different text. Ids are not reused
 * today, but a stale `true` sitting in state waiting for one is not a thing to
 * leave lying around in the one map that records human responsibility.
 */
export function pruneReviewed<T extends SuggestionLike>(
  reviewed: Readonly<Record<string, boolean>>,
  candidates: readonly Candidate<T>[],
): Record<string, boolean> {
  const live = new Set(candidates.map((candidate) => candidate.id));
  const next: Record<string, boolean> = {};
  for (const [id, value] of Object.entries(reviewed)) {
    if (live.has(id)) next[id] = value;
  }
  return next;
}
