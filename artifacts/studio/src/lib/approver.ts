import type { Draft } from '@/types';

/**
 * The name the ledger will record as the person who signed off. `null` means
 * nobody has told the app who they are yet — and the answer to "who approved
 * this?" is never allowed to be a made-up placeholder, so the caller must
 * refuse rather than substitute one.
 */
export function approverName(operatorName: string): string | null {
  const trimmed = operatorName.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * The approval a publish request may carry: exactly what was recorded on the
 * draft when a person approved it, or nothing. Filling a missing half in at
 * send time would let a post go out under a signature nobody gave.
 */
export function recordedApproval(
  draft: Pick<Draft, 'approvedBy' | 'approvedAt'>,
): { approvedBy: string; approvedAt: string } | null {
  const approvedBy = draft.approvedBy?.trim() ?? '';
  const approvedAt = draft.approvedAt?.trim() ?? '';
  if (approvedBy === '' || approvedAt === '') return null;
  return { approvedBy, approvedAt };
}
