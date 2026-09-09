import { useEffect, useRef, useState } from 'react';

import { PLATFORM_LABEL, logActivity } from '@/lib/workspace';
import type { BrowserState, Draft } from '@/types';

/**
 * Reconciling with the scheduler.
 *
 * The API server dispatches scheduled posts on its own clock, including while
 * this page is closed. It never writes into the browser state document — that
 * belongs to this app — so it reports what it did through a dispatch log, and
 * this hook folds those outcomes back into the drafts held here.
 *
 * It asks about the posts this app is still waiting on, by name, rather than
 * reading a recent feed. A workspace that has been closed for a month is then
 * no different from one closed for a minute: it asks about the same few drafts
 * it left behind, and nothing can have scrolled off the end of a list in the
 * meantime.
 *
 * Applying an outcome is idempotent: once a draft already reflects it, the
 * poll stops finding work and stops writing.
 */

const POLL_INTERVAL_MS = 15_000;

export type SchedulerStatus = {
  active: boolean;
  bridgeConfigured: boolean;
  intervalMs: number;
  detail: string;
};

export type DispatchRecord = {
  seq: number;
  idempotencyKey: string;
  draftId: string;
  workspaceId: string;
  platform: string;
  approvedBy: string;
  approvedAt: string;
  scheduledFor?: string;
  /** `uncertain` means the send was interrupted and nobody knows if it went out. */
  status: 'published' | 'failed' | 'uncertain';
  message: string;
  postUrl?: string;
  postId?: string;
  source: 'operator' | 'scheduler';
  dispatchedAt: string;
};

function applies(draft: Draft | undefined, record: DispatchRecord): boolean {
  if (!draft) return false;

  // The record travelled under one specific approval. If the draft has been
  // edited and re-approved since, it is a different post and this is stale.
  if (draft.approvedAt !== record.approvedAt) return false;

  if (record.status === 'published') return draft.status !== 'published';

  // A failure from the Post button is already on screen with a toast; only the
  // scheduler's failures are news to this page.
  if (record.source !== 'scheduler') return false;

  // And only about the send time it is queued for now. Moving a failed post to
  // a new time queues a fresh attempt; the old failure must not stamp itself
  // back over it.
  if (record.scheduledFor !== draft.scheduledFor) return false;

  return draft.status === 'scheduled' || draft.status === 'publishing';
}

function patchDraft(draft: Draft, record: DispatchRecord): Draft {
  if (record.status === 'published') {
    return {
      ...draft,
      status: 'published',
      postUrl: record.postUrl ?? null,
      lastError: null,
      updatedAt: record.dispatchedAt,
    };
  }
  return {
    ...draft,
    status: 'failed',
    lastError: record.message,
    updatedAt: record.dispatchedAt,
  };
}

function applyDispatches(
  current: BrowserState,
  records: DispatchRecord[],
): BrowserState {
  let next = current;

  for (const record of records) {
    const draft = next.drafts.find((item) => item.id === record.draftId);
    if (!applies(draft, record)) continue;

    const label = PLATFORM_LABEL[draft!.platform];
    next = {
      ...next,
      drafts: next.drafts.map((item) =>
        item.id === record.draftId ? patchDraft(item, record) : item,
      ),
      activity: logActivity(
        next,
        record.status === 'published'
          ? {
              type: 'publish',
              title: 'Posted at its scheduled time',
              detail: `${label} · under ${record.approvedBy}'s approval`,
            }
          : {
              type: 'publish',
              title: 'Scheduled post did not go out',
              detail: `${label} · ${record.message}`,
            },
      ),
    };
  }

  return next;
}

export function useScheduledDispatches(
  state: BrowserState,
  updateState: (updater: (current: BrowserState) => BrowserState) => void,
): void {
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      // Only the posts whose fate this app does not yet know.
      const pending = stateRef.current.drafts.filter(
        (draft) =>
          (draft.status === 'scheduled' || draft.status === 'publishing') &&
          draft.approvedAt,
      );
      if (pending.length === 0) return;

      try {
        const response = await fetch('/api/schedule/outcomes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            keys: pending.map((draft) => `${draft.id}:${draft.approvedAt}`),
          }),
        });
        if (!response.ok) return;

        const payload = (await response.json()) as {
          outcomes?: DispatchRecord[];
        };
        if (cancelled || !payload.outcomes?.length) return;

        const chronological = [...payload.outcomes].sort(
          (a, b) => a.seq - b.seq,
        );
        const drafts = stateRef.current.drafts;

        // Only touch state when an outcome is genuinely new: every update
        // writes the whole document back, and a no-op write every 15 seconds
        // would be a lie about the document having changed.
        const hasWork = chronological.some((record) =>
          applies(
            drafts.find((draft) => draft.id === record.draftId),
            record,
          ),
        );
        if (!hasWork) return;

        updateState((current) => applyDispatches(current, chronological));
      } catch {
        // The workspace keeps working with the API unreachable; try next tick.
      }
    }

    void poll();
    const timer = window.setInterval(() => void poll(), POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [updateState]);
}

export function useSchedulerStatus(): SchedulerStatus | null {
  const [status, setStatus] = useState<SchedulerStatus | null>(null);

  useEffect(() => {
    let cancelled = false;

    fetch('/api/schedule/status')
      .then(async (response) => (response.ok ? response.json() : null))
      .then((payload: SchedulerStatus | null) => {
        if (!cancelled && payload) setStatus(payload);
      })
      .catch(() => {
        // No status means no claim about scheduling is rendered at all.
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return status;
}
