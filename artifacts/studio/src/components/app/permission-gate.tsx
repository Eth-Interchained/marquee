import { useCallback, useEffect, useState } from 'react';
import { ExternalLink, RotateCcw, ShieldAlert, ShieldCheck } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { getShell, type ShellPermissionKind, type ShellPermissionState } from '@/lib/shell-bridge';
import { cn } from '@/lib/utils';

/**
 * The permissions gate.
 *
 * macOS gates the camera, the microphone and screen recording separately, and
 * only the first two can be *asked* for. Screen recording has no API at all —
 * so for that one the honest UI is a button that opens the right Settings pane
 * and a plain warning that marquee has to be restarted afterwards. Anything
 * that looks like "click to allow" would leave the operator waiting for a
 * prompt macOS will never show.
 *
 * Every string shown here comes from the shell (`detail`), whose own tests
 * assert the copy — so this component cannot drift into promising a prompt.
 */

const LABEL: Record<ShellPermissionKind, string> = {
  screen: 'Screen Recording',
  camera: 'Camera',
  microphone: 'Microphone',
};

export function usePermissions() {
  const [states, setStates] = useState<ShellPermissionState[] | null>(null);
  const shell = getShell();
  const supported = Boolean(shell?.permissions);

  const refresh = useCallback(async () => {
    if (!shell?.permissions) {
      setStates(null);
      return;
    }
    try {
      setStates(await shell.permissions.status());
    } catch (error) {
      // Never leave the caller guessing why the gate is empty.
      console.error('[permissions] status read failed', error);
      setStates(null);
    }
  }, [shell]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const blocking = (states ?? []).filter((s) => s.status !== 'granted' && s.status !== 'not-applicable');
  return { states, blocking, supported, refresh };
}

export function PermissionRow({ state, onChanged }: { state: ShellPermissionState; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const shell = getShell();
  const granted = state.status === 'granted';

  const ask = async () => {
    if (!shell?.permissions) return;
    setBusy(true);
    setNote(null);
    try {
      const next = await shell.permissions.request(state.kind);
      // The status AFTER asking is the answer — never the fact that we asked.
      setNote(next.status === 'granted' ? `${LABEL[state.kind]} allowed.` : next.detail);
      onChanged();
    } catch (error) {
      setNote(`Could not ask the system: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const openSettings = async () => {
    if (!shell?.permissions) return;
    setBusy(true);
    setNote(null);
    try {
      const result = await shell.permissions.openSettings(state.kind);
      setNote(result.detail);
    } catch (error) {
      setNote(`Could not open Settings: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className={cn('flex flex-col gap-2 rounded-md border p-3', granted ? 'border-card-border' : 'border-chart-3/50')}
      data-testid={`permission-${state.kind}`}
    >
      <div className="flex items-center gap-2">
        {granted ? <ShieldCheck className="h-4 w-4 text-chart-2" /> : <ShieldAlert className="h-4 w-4 text-chart-3" />}
        <span className="text-sm font-medium">{LABEL[state.kind]}</span>
        <Badge variant="outline" className="ml-auto font-mono text-[10px]">
          {state.status}
        </Badge>
      </div>

      <p className="text-xs leading-relaxed text-muted-foreground">{state.detail}</p>

      {state.needsRestart && !granted ? (
        <p className="rounded border-l-2 border-chart-3 bg-background/40 px-2 py-1 text-[11px] text-muted-foreground">
          macOS applies a Screen Recording grant on the next launch — quit marquee and open it again after switching it on.
        </p>
      ) : null}

      {!granted ? (
        <div className="flex flex-wrap gap-2">
          {/* Only offered when the OS genuinely has a prompt for it. */}
          {state.canRequest ? (
            <Button size="sm" onClick={() => void ask()} disabled={busy} data-testid={`permission-ask-${state.kind}`}>
              Allow {LABEL[state.kind].toLowerCase()}
            </Button>
          ) : null}
          {state.settingsUrl ? (
            <Button size="sm" variant="outline" onClick={() => void openSettings()} disabled={busy} data-testid={`permission-settings-${state.kind}`}>
              <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
              Open Settings
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" onClick={onChanged} disabled={busy} data-testid={`permission-recheck-${state.kind}`}>
            <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
            Re-check
          </Button>
        </div>
      ) : null}

      {note ? <p className="font-mono text-[11px] text-muted-foreground">{note}</p> : null}
    </div>
  );
}

/**
 * Shown when the operator tries to capture and the OS is in the way. Not a
 * blocking wall on load: the Studio works fine without a camera, and a modal
 * that greets you before you have asked for anything is noise.
 */
export function PermissionDialog({
  open,
  onOpenChange,
  states,
  onChanged,
  reason,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  states: ShellPermissionState[];
  onChanged: () => void;
  reason?: string | null;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-chart-3" /> The system is in the way
          </DialogTitle>
          <DialogDescription>
            {reason ?? 'marquee needs the operating system’s permission before it can capture. It cannot grant these to itself.'}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          {states.map((state) => (
            <PermissionRow key={state.kind} state={state} onChanged={onChanged} />
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
