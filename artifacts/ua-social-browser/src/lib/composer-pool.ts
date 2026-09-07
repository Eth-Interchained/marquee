/**
 * Keeping the composer's options across a reload.
 *
 * The candidate pool lived only in React state, so anything that unmounted the
 * Composer took the options with it — including the crash that came in with
 * the missing-import bug. Generating them cost a model call and the operator's
 * attention; losing them to a stack trace is the app throwing away work it
 * already paid for.
 *
 * So the pool is mirrored into `localStorage` and restored on mount.
 *
 * **The review flags are deliberately NOT stored.** They are the one piece of
 * state in this app that records a human taking responsibility: `saveAsDraft`
 * refuses until the operator has ticked "I have read this". Restoring that tick
 * would mean a card could reach the review queue with a sign-off given in a
 * session that ended in a crash — nobody read it *here*, and the record would
 * say somebody did. The text is worth recovering. The sign-off is not; it costs
 * one click to give again, and it should cost that.
 *
 * Everything else follows from treating storage as untrusted:
 *
 *  - a stored pool belongs to one workspace and one platform, and is ignored
 *    anywhere else, because options written for X are not options for Instagram;
 *  - anything unparseable, wrong-shaped, or stale is dropped rather than
 *    repaired, and dropping it clears the key so the same bad value is not
 *    re-examined on every mount;
 *  - every call is wrapped: `localStorage` throws when quota is full or storage
 *    is disabled, and a composer that cannot save its options must still be a
 *    composer.
 */

import type { Candidate, SuggestionLike } from '@/lib/candidates';

/** Bumped when the stored shape changes. An older version is dropped, not migrated. */
const VERSION = 1;

/**
 * How long a pool is worth restoring.
 *
 * Options are written against a brief the operator had in mind at the time.
 * Handing back yesterday's completions as though they were current is worse
 * than handing back nothing, so the window is short enough that a restored
 * pool is recognisably the one you just lost.
 */
export const POOL_TTL_MS = 6 * 60 * 60 * 1_000;

/**
 * The most candidates kept.
 *
 * The pool grows on every "keep going" and nothing bounds it. A cap keeps one
 * long session from filling the quota that the rest of the app also writes to.
 */
export const MAX_STORED = 40;

/** The minimum a stored candidate must have to be worth restoring. */
type StoredCandidate = {
  id: string;
  ordinal: number;
  generationId: string;
  text: string;
  rationale: string;
  characterCount: number;
};

export type StoredPool = {
  version: number;
  workspaceId: string;
  platform: string;
  savedAt: number;
  nextOrdinal: number;
  candidates: StoredCandidate[];
};

/** Just the bits of `Storage` used here, so tests need no browser. */
export type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

export function poolKey(workspaceId: string, platform: string): string {
  return `ua:composer-pool:${workspaceId}:${platform}`;
}

function isStoredCandidate(value: unknown): value is StoredCandidate {
  if (typeof value !== 'object' || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.id === 'string' &&
    c.id !== '' &&
    typeof c.ordinal === 'number' &&
    Number.isFinite(c.ordinal) &&
    typeof c.generationId === 'string' &&
    typeof c.text === 'string' &&
    c.text.trim() !== '' &&
    typeof c.rationale === 'string' &&
    typeof c.characterCount === 'number'
  );
}

/**
 * Why a stored pool was not restored. Returned rather than thrown so the caller
 * can tell "nothing saved" from "something saved and rejected".
 */
export type RestoreOutcome<T extends SuggestionLike> =
  | { restored: true; candidates: Candidate<T>[]; nextOrdinal: number; savedAt: number }
  | {
      restored: false;
      reason: 'empty' | 'unreadable' | 'wrong-shape' | 'other-context' | 'stale';
    };

export function readPool<T extends SuggestionLike>(input: {
  storage: StorageLike;
  workspaceId: string;
  platform: string;
  now: number;
}): RestoreOutcome<T> {
  const key = poolKey(input.workspaceId, input.platform);

  let raw: string | null;
  try {
    raw = input.storage.getItem(key);
  } catch {
    return { restored: false, reason: 'unreadable' };
  }
  if (raw === null || raw === '') return { restored: false, reason: 'empty' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Not repairable, and re-parsing it on every mount is pure waste.
    clearPool(input.storage, input.workspaceId, input.platform);
    return { restored: false, reason: 'unreadable' };
  }

  const pool = parsed as Partial<StoredPool>;
  if (
    typeof pool !== 'object' ||
    pool === null ||
    pool.version !== VERSION ||
    typeof pool.savedAt !== 'number' ||
    typeof pool.nextOrdinal !== 'number' ||
    !Array.isArray(pool.candidates)
  ) {
    clearPool(input.storage, input.workspaceId, input.platform);
    return { restored: false, reason: 'wrong-shape' };
  }

  // The key already carries both, but a value that disagrees with its own key
  // is a value written by something else. Trust neither half of it.
  if (
    pool.workspaceId !== input.workspaceId ||
    pool.platform !== input.platform
  ) {
    clearPool(input.storage, input.workspaceId, input.platform);
    return { restored: false, reason: 'other-context' };
  }

  if (input.now - pool.savedAt >= POOL_TTL_MS) {
    clearPool(input.storage, input.workspaceId, input.platform);
    return { restored: false, reason: 'stale' };
  }

  const candidates = pool.candidates.filter(isStoredCandidate);
  if (candidates.length === 0) {
    clearPool(input.storage, input.workspaceId, input.platform);
    return { restored: false, reason: 'wrong-shape' };
  }

  return {
    restored: true,
    candidates: candidates as unknown as Candidate<T>[],
    nextOrdinal: pool.nextOrdinal,
    savedAt: pool.savedAt,
  };
}

/**
 * Mirrors the live pool into storage.
 *
 * Called on every change to the pool, which is what makes "delete on
 * interaction" fall out for free: judging a card removes it from the pool, and
 * the next write no longer contains it. An empty pool clears the key rather
 * than storing an empty list — there is nothing to come back to.
 */
export function writePool<T extends SuggestionLike>(input: {
  storage: StorageLike;
  workspaceId: string;
  platform: string;
  candidates: readonly Candidate<T>[];
  nextOrdinal: number;
  now: number;
}): boolean {
  if (input.candidates.length === 0) {
    return clearPool(input.storage, input.workspaceId, input.platform);
  }

  // Oldest go first: the newest options are the ones being worked on.
  const kept = input.candidates.slice(-MAX_STORED);

  const payload: StoredPool = {
    version: VERSION,
    workspaceId: input.workspaceId,
    platform: input.platform,
    savedAt: input.now,
    nextOrdinal: input.nextOrdinal,
    candidates: kept.map((candidate) => ({
      id: candidate.id,
      ordinal: candidate.ordinal,
      generationId: candidate.generationId,
      text: candidate.text,
      rationale: candidate.rationale,
      characterCount: candidate.characterCount,
    })),
  };

  try {
    input.storage.setItem(
      poolKey(input.workspaceId, input.platform),
      JSON.stringify(payload),
    );
    return true;
  } catch {
    // Quota, private mode, storage disabled. Losing the mirror is a smaller
    // failure than losing the composer, so this is swallowed on purpose.
    return false;
  }
}

export function clearPool(
  storage: StorageLike,
  workspaceId: string,
  platform: string,
): boolean {
  try {
    storage.removeItem(poolKey(workspaceId, platform));
    return true;
  } catch {
    return false;
  }
}

/** What to tell the operator when options come back. */
export function describeRestored(count: number): string {
  return count === 1
    ? 'One option was recovered from before the app closed. Read it again before keeping it — the review tick is not restored.'
    : `${count} options were recovered from before the app closed. Read them again before keeping any — review ticks are not restored.`;
}
