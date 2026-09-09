import { useCallback, useEffect, useRef, useState } from 'react';
import { initialState } from '@/data';
import { hydrateDraft, hydrateState } from '@/lib/hydrate';
import { toast } from '@/hooks/use-toast';
import type { BrowserState, Draft } from '@/types';

export type SaveStatus = 'loading' | 'saved' | 'saving' | 'offline' | 'error';

type SavePayload = {
  state?: BrowserState & { drafts: Draft[] };
  integrity: { verified: boolean; sequence: number; head: string };
  /** Drafts the server would not let this write touch: they were being sent. */
  heldDrafts?: string[];
};

export function useBrowserState() {
  const [state, setState] = useState<BrowserState>(initialState);
  const [status, setStatus] = useState<SaveStatus>('loading');
  const [integrity, setIntegrity] = useState({
    verified: true,
    sequence: 0,
    head: '',
  });
  const hydrated = useRef(false);
  const saveTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/browser/state')
      .then(async (response) => {
        if (!response.ok) throw new Error('State service unavailable');
        return response.json();
      })
      .then((payload) => {
        if (cancelled) return;
        // The ledger holds documents written by older builds. Anything this
        // version added is filled in here, once, rather than defended against
        // at every place that reads it — see `lib/hydrate.ts`.
        if (payload.state) setState(hydrateState(payload.state));
        setIntegrity(payload.integrity);
        setStatus('saved');
        hydrated.current = true;
      })
      .catch(() => {
        if (cancelled) return;
        setStatus('offline');
        hydrated.current = true;
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * The server refuses to let a post that is already being sent be edited,
   * revoked, or discarded underneath the send. When that happens it says so,
   * and its copy of those drafts is the true one — take it, and say plainly
   * that the change did not land.
   */
  const adoptHeldDrafts = useCallback((payload: SavePayload) => {
    const held = payload.heldDrafts ?? [];
    if (held.length === 0 || !payload.state) return;

    const heldIds = new Set(held);
    const authoritative = new Map(
      payload.state.drafts
        .filter((draft) => heldIds.has(draft.id))
        // Held drafts come from the same store as the initial load, so they
        // need the same gap-filling before anything renders them.
        .map((draft) => [draft.id, hydrateDraft(draft)] as const),
    );

    setState((current) => {
      const drafts = current.drafts.map(
        (draft) => authoritative.get(draft.id) ?? draft,
      );
      const known = new Set(drafts.map((draft) => draft.id));
      for (const [id, draft] of authoritative) {
        if (!known.has(id)) drafts.push(draft);
      }
      return { ...current, drafts };
    });

    toast({
      title:
        held.length === 1
          ? 'That post was already going out'
          : 'Those posts were already going out',
      description:
        'The send had started, so the change was not applied. The result will appear here as soon as it lands.',
      variant: 'destructive',
    });
  }, []);

  const updateState = useCallback(
    (updater: (current: BrowserState) => BrowserState) => {
      setState((current) => {
        const next = {
          ...updater(current),
          updatedAt: new Date().toISOString(),
        };
        if (!hydrated.current) return next;
        setStatus('saving');
        window.clearTimeout(saveTimer.current);
        saveTimer.current = window.setTimeout(() => {
          fetch('/api/browser/state', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(next),
          })
            .then(async (response) => {
              if (!response.ok) throw new Error('Save failed');
              return response.json();
            })
            .then((payload) => {
              setIntegrity(payload.integrity);
              setStatus('saved');
              adoptHeldDrafts(payload);
            })
            .catch(() => setStatus('error'));
        }, 350);
        return next;
      });
    },
    [],
  );

  return { state, updateState, status, integrity };
}