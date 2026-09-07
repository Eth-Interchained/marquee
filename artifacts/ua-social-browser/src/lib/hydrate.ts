import { initialState } from '@/data';
import type { BrowserState, Draft, DraftMedia } from '@/types';

/**
 * Bringing a stored document up to the shape this build expects.
 *
 * The ledger holds documents written by every version that came before. A
 * field added to `BrowserState` today does not appear in a draft saved last
 * week, and TypeScript cannot help: the type says `media: DraftMedia[]`, the
 * JSON on disk says nothing at all, and the first `draft.media.length` throws.
 *
 * That is not hypothetical — it is exactly how attachments broke the review
 * queue. Drafts written before media existed came back with `media` undefined,
 * `drafts.tsx` read `.length` on it, and the whole section died inside its
 * error boundary. The fix belongs here, at the one place a stored document
 * enters the app, rather than as a defensive read at each of the thirteen
 * places that touch the field.
 *
 * **This never rewrites anything on disk.** It fills gaps in the copy held in
 * memory. The ledger keeps every byte it already had; the next ordinary save
 * happens to include the filled-in defaults, which are additive.
 *
 * The rule for anyone adding a field to a persisted type: add it here in the
 * same commit, with a test for a document that predates it.
 */

function asMedia(value: unknown): DraftMedia[] {
  if (!Array.isArray(value)) return [];

  const media: DraftMedia[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const item = entry as Record<string, unknown>;
    // A half-written reference cannot identify a file, and one that reached the
    // publish path would be refused by the server anyway. Drop it here so the
    // operator sees an attachment missing rather than a card that cannot render.
    if (
      typeof item.id !== 'string' ||
      typeof item.sha256 !== 'string' ||
      typeof item.filename !== 'string' ||
      typeof item.mimeType !== 'string' ||
      typeof item.bytes !== 'number'
    ) {
      continue;
    }
    media.push({
      id: item.id,
      sha256: item.sha256,
      filename: item.filename,
      mimeType: item.mimeType,
      bytes: item.bytes,
      ...(typeof item.altText === 'string' ? { altText: item.altText } : {}),
    });
  }
  return media;
}

export function hydrateDraft(raw: unknown): Draft {
  const draft = (raw ?? {}) as Partial<Draft> & Record<string, unknown>;
  return {
    ...(draft as Draft),
    // Every field the UI iterates or measures has to survive a document that
    // was written before it existed.
    media: asMedia(draft.media),
  };
}

/**
 * Fills in whatever a stored `BrowserState` is missing.
 *
 * Top-level collections are guarded as well as `media`, because they fail the
 * same way for the same reason: a document from a build that had no `accounts`
 * array would take out the dashboard on `state.accounts.filter`.
 */
export function hydrateState(raw: unknown): BrowserState {
  const state = (raw ?? {}) as Partial<BrowserState> & Record<string, unknown>;

  return {
    ...(state as BrowserState),
    workspaces: Array.isArray(state.workspaces) ? state.workspaces : [],
    uaProfiles: Array.isArray(state.uaProfiles)
      ? state.uaProfiles
      : initialState.uaProfiles,
    accounts: Array.isArray(state.accounts) ? state.accounts : [],
    activity: Array.isArray(state.activity) ? state.activity : [],
    drafts: Array.isArray(state.drafts) ? state.drafts.map(hydrateDraft) : [],
    settings: {
      ...initialState.settings,
      ...(state.settings ?? {}),
      // `settings` is merged one level deep, so a nested object arrives whole
      // or not at all. A document written when `publish` held only `mode`
      // would otherwise replace the defaults entirely and leave the newer
      // fields undefined — the same failure as `media`, one level lower and
      // harder to see. Every nested settings group needs its own line here.
      publish: {
        ...initialState.settings.publish,
        ...((state.settings ?? {}).publish ?? {}),
      },
    },
    usage: { ...initialState.usage, ...(state.usage ?? {}) },
  };
}
