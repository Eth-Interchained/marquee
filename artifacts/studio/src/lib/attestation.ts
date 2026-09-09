/**
 * When the operator knows better than the record.
 *
 * A post went out. The network never confirmed it before the deadline, so the
 * attempt was recorded `failed` — which was the honest answer at the time and
 * the right one: claiming success without confirmation is the single thing this
 * app must never do. Then the operator looked at the account and saw the post
 * sitting there.
 *
 * Until now there was nothing to do about that. The record said Failed, the
 * operator knew it was wrong, and the app offered no way to say so. A ledger
 * that cannot be corrected by the person who can see the truth is not more
 * honest than one that can — it is just wrong for longer.
 *
 * So the operator can attest. The rules exist because an attestation is
 * evidence of a *different kind* than a network confirmation, and the two must
 * stay distinguishable forever:
 *
 *  1. **An attestation is never `published`.** `published` means the network
 *     said so (invariant 2). This produces `attested`, its own status, and the
 *     UI names the source: posted according to *you*, not according to X.
 *  2. **Only a failed attempt can be attested.** Attesting a draft nobody ever
 *     tried to post is not a correction, it is a fiction. There is nothing to
 *     correct until an attempt exists and has come back wrong.
 *  3. **Someone has to sign it.** The same rule as approval, for the same
 *     reason: an unsigned claim about what reached an audience is worthless,
 *     and there is no fallback name.
 *  4. **It is retractable.** An operator who attests the wrong draft must be
 *     able to take it back, which returns the record to `failed` — the state
 *     the machine actually observed. The append-only ledger keeps both the
 *     claim and its retraction; nothing is erased.
 *  5. **It never makes a draft publishable again.** `attested` is not
 *     `approved` and not `scheduled`, so no scheduler will look at it. The
 *     post already went out — sending it again is the double-post this whole
 *     design is built to prevent.
 */

import type { Draft } from '@/types';

/** What the operator states, and who stated it. */
export type Attestation = {
  /** The operator's name. Required — an unsigned attestation is worthless. */
  by: string;
  at: string;
  /**
   * A link to the post, when the operator has one.
   *
   * Optional because the claim stands on the operator's word either way, and
   * demanding a URL would push someone into pasting something approximate. But
   * it is the difference between a claim and a checkable claim, so the UI asks.
   */
  postUrl: string | null;
};

/** Why an attestation was refused, phrased for the operator. */
export type AttestationRefusal = { refused: string };

export type AttestationResult = Partial<Draft> | AttestationRefusal;

export function isRefusal(result: AttestationResult): result is AttestationRefusal {
  return 'refused' in result;
}

/**
 * Whether this draft is in a state where "it actually posted" means anything.
 *
 * Only a failed attempt. A draft that was never attempted has nothing to
 * correct, and one already recorded `published` was confirmed by the network —
 * a stronger statement than an operator's word, which must not be overwritten
 * by a weaker one.
 */
export function canAttest(draft: Pick<Draft, 'status'>): boolean {
  return draft.status === 'failed';
}

/** Whether this draft currently carries an operator's claim. */
export function isAttested(draft: Pick<Draft, 'status'>): boolean {
  return draft.status === 'attested';
}

/**
 * Records that the operator saw this post on the account.
 *
 * `lastError` is deliberately kept. It is what the machine observed, and the
 * operator's claim sits beside it rather than on top of it: the record should
 * read "the confirmation never arrived, and the operator later found the post",
 * because that is what happened.
 */
export function attest(input: {
  draft: Draft;
  by: string | null;
  at: string;
  postUrl?: string | null;
}): AttestationResult {
  if (!canAttest(input.draft)) {
    return {
      refused:
        input.draft.status === 'published'
          ? 'This post was confirmed by the network itself, which is a stronger record than a note. There is nothing to correct.'
          : 'Only a post that was attempted and came back failed can be corrected this way.',
    };
  }

  const by = input.by?.trim();
  if (!by) {
    return {
      refused:
        'Say who is confirming this. The correction is recorded under your name, so it needs one.',
    };
  }

  const url = input.postUrl?.trim();

  return {
    status: 'attested',
    attestation: { by, at: input.at, postUrl: url ? url : null },
    // The operator's link is the only postUrl this path can produce, and it is
    // theirs rather than the network's — so it is stored on the attestation and
    // `postUrl` is left as the machine found it.
  };
}

/**
 * Takes the claim back.
 *
 * Returns the record to `failed`, which is what the machine actually observed.
 * The attestation is dropped from the current state; the ledger keeps every
 * version, so the claim and its retraction both survive.
 */
export function retract(draft: Draft): AttestationResult {
  if (!isAttested(draft)) {
    return { refused: 'There is no correction on this post to take back.' };
  }

  return { status: 'failed', attestation: null };
}

/**
 * One line naming the source of the claim, for the operator to read.
 *
 * Always says *who*, never just "posted". The whole point of a separate status
 * is that the reader can tell an operator's word from the network's.
 */
export function describeAttestation(draft: Draft): string | null {
  const attestation = draft.attestation;
  if (!attestation) return null;

  return `${attestation.by} confirmed this posted after checking the account. The network never sent confirmation, so this is their account of it rather than the network's.`;
}
