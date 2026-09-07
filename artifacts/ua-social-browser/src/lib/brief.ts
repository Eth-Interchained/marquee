/**
 * Applying a proposed brief to the composer's form.
 *
 * Prompt mode lets the operator describe a post in a sentence instead of
 * answering six form questions. The model answers with a partial brief, and
 * this decides what that is allowed to do to the form.
 *
 * The rule everything here follows: **a proposal may fill a field, and it must
 * never silently contradict the operator.** So —
 *
 *  - a field the model omitted keeps the value the form already had, because
 *    an omission means "I was not told", not "clear it";
 *  - a value outside the schema's own enums is refused rather than coerced,
 *    since a coerced platform sends the post to the wrong network;
 *  - every change is described before it is applied, so the operator reads
 *    what moved rather than hunting for it.
 *
 * None of this touches publishing. A brief fills in a form; the candidates it
 * produces still need the review tick, and the draft still needs an approval.
 */

import type { Platform } from '@/types';

/** Mirrors the enums in the OpenAPI spec. A value outside them is refused. */
const PLATFORMS = new Set<string>([
  'x', 'instagram', 'facebook', 'threads', 'linkedin', 'bluesky',
  'mastodon', 'reddit', 'tiktok', 'youtube', 'pinterest', 'tumblr',
]);

const TASKS = new Set<string>([
  'suggest', 'rewrite', 'shorten', 'expand', 'variants', 'hashtags',
]);

/** The composer's settings, as prompt mode may propose them. */
export type Brief = {
  platform?: string;
  task?: string;
  tone?: string;
  audience?: string;
  sourceText?: string;
  numberOfSuggestions?: number;
  includeHashtags?: boolean;
};

/** The form's current values — what a proposal is compared against. */
export type FormState = {
  platform: Platform;
  task: string;
  tone: string;
  audience: string;
  sourceText: string;
  count: number;
  includeHashtags: boolean;
};

/** One field the proposal would change, in words the operator can check. */
export type Change = {
  field: keyof FormState;
  label: string;
  from: string;
  to: string;
};

export type AppliedBrief = {
  next: FormState;
  changes: Change[];
  /** Values refused for being outside the schema, with why. */
  refused: Array<{ field: string; value: string; reason: string }>;
};

const LABEL: Record<keyof FormState, string> = {
  platform: 'Network',
  task: 'Task',
  tone: 'Tone',
  audience: 'Audience',
  sourceText: 'Your notes',
  count: 'How many options',
  includeHashtags: 'Hashtags',
};

/** Long text is summarised in the change list; the field itself gets it all. */
function short(value: string): string {
  const flat = value.trim().replace(/\s+/g, ' ');
  return flat.length > 72 ? `${flat.slice(0, 69)}…` : flat;
}

/**
 * Merges a proposal into the form.
 *
 * Pure: returns the next state and an account of what moved, and mutates
 * nothing. The caller applies it only after the operator has seen the account.
 */
export function applyBrief(current: FormState, brief: Brief): AppliedBrief {
  const next: FormState = { ...current };
  const changes: Change[] = [];
  const refused: AppliedBrief['refused'] = [];

  const record = (field: keyof FormState, from: string, to: string) => {
    changes.push({ field, label: LABEL[field], from, to });
  };

  if (typeof brief.platform === 'string') {
    const value = brief.platform.trim().toLowerCase();
    if (!PLATFORMS.has(value)) {
      // Coercing here would post to the wrong network — the one mistake in
      // this module that reaches an audience.
      refused.push({
        field: 'platform',
        value: brief.platform,
        reason: 'not a network this app can post to',
      });
    } else if (value !== current.platform) {
      next.platform = value as Platform;
      record('platform', current.platform, value);
    }
  }

  if (typeof brief.task === 'string') {
    const value = brief.task.trim().toLowerCase();
    if (!TASKS.has(value)) {
      refused.push({
        field: 'task',
        value: brief.task,
        reason: 'not one of the composer’s tasks',
      });
    } else if (value !== current.task) {
      next.task = value;
      record('task', current.task, value);
    }
  }

  for (const field of ['tone', 'audience', 'sourceText'] as const) {
    const value = brief[field];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    // An empty string is not an answer; blanking a field the operator filled
    // in reads as the app losing their work.
    if (trimmed === '' || trimmed === current[field]) continue;
    next[field] = trimmed;
    record(field, short(current[field]) || '(empty)', short(trimmed));
  }

  if (typeof brief.numberOfSuggestions === 'number') {
    const value = Math.round(brief.numberOfSuggestions);
    if (!Number.isFinite(value) || value < 1 || value > 8) {
      refused.push({
        field: 'numberOfSuggestions',
        value: String(brief.numberOfSuggestions),
        reason: 'outside the 1–8 the composer allows',
      });
    } else if (value !== current.count) {
      next.count = value;
      record('count', String(current.count), String(value));
    }
  }

  if (typeof brief.includeHashtags === 'boolean'
      && brief.includeHashtags !== current.includeHashtags) {
    next.includeHashtags = brief.includeHashtags;
    record(
      'includeHashtags',
      current.includeHashtags ? 'on' : 'off',
      brief.includeHashtags ? 'on' : 'off',
    );
  }

  return { next, changes, refused };
}

/**
 * Whether the form is ready to generate from.
 *
 * The same bar the Generate button already applies: notes of at least three
 * characters. Prompt mode should say so rather than leaving the operator
 * clicking a disabled button and wondering which field is at fault.
 */
export function readyToGenerate(form: FormState): boolean {
  return form.sourceText.trim().length >= 3;
}

/** What to show once a brief has been applied. */
export function describeChanges(applied: AppliedBrief): string {
  if (applied.changes.length === 0) {
    return 'Nothing in the form needed changing.';
  }
  const fields = applied.changes.map((change) => change.label.toLowerCase());
  if (fields.length === 1) return `Filled in ${fields[0]}.`;
  return `Filled in ${fields.slice(0, -1).join(', ')} and ${fields.at(-1)}.`;
}
