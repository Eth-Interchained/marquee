import {
  Cloud,
  CloudOff,
  Fingerprint,
  Loader2,
  Lock,
  Plus,
  ShieldCheck,
  X,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { PlatformGlyph } from '@/components/app/platform-glyph';
import { ShellMark } from '@/components/app/shell-mark';
import { cn } from '@/lib/utils';
import { PLATFORM_ORIGIN, PLATFORM_LABEL } from '@/lib/workspace';
import type { SaveStatus } from '@/hooks/use-browser-state';
import type { UAProfile, Workspace } from '@/types';

type BrowserChromeProps = {
  workspaces: Workspace[];
  activeWorkspaceId: string;
  activeProfile: UAProfile | undefined;
  saveStatus: SaveStatus;
  integrityVerified: boolean;
  onSelectWorkspace: (workspaceId: string) => void;
  onCloseWorkspace: (workspaceId: string) => void;
  onNewWorkspace: () => void;
};

const SAVE_COPY: Record<SaveStatus, string> = {
  loading: 'Restoring session',
  saving: 'Saving session',
  saved: 'Session saved',
  offline: 'Local only',
  error: 'Save failed',
};

function SaveIndicator({
  status,
  verified,
}: {
  status: SaveStatus;
  verified: boolean;
}) {
  const Icon =
    status === 'saving' || status === 'loading'
      ? Loader2
      : status === 'saved'
        ? Cloud
        : CloudOff;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className="flex items-center gap-1.5 rounded-full border border-border/60 bg-card/70 px-2.5 py-1 text-[11px] text-muted-foreground"
          data-testid="status-persistence"
        >
          <Icon
            className={cn(
              'h-3.5 w-3.5',
              (status === 'saving' || status === 'loading') && 'animate-spin',
              status === 'error' && 'text-destructive',
            )}
          />
          <span>{SAVE_COPY[status]}</span>
          {verified ? (
            <ShieldCheck className="h-3.5 w-3.5 text-chart-2" />
          ) : null}
        </div>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        Browser state is written to the embedded NEDB store.
        {verified ? ' Ledger integrity verified.' : ' Integrity unverified.'}
      </TooltipContent>
    </Tooltip>
  );
}

export function BrowserChrome({
  workspaces,
  activeWorkspaceId,
  activeProfile,
  saveStatus,
  integrityVerified,
  onSelectWorkspace,
  onCloseWorkspace,
  onNewWorkspace,
}: BrowserChromeProps) {
  const active = workspaces.find(
    (workspace) => workspace.id === activeWorkspaceId,
  );

  return (
    <header className="shrink-0 border-b border-border bg-sidebar">
      {/* Tab strip — one tab per isolated workspace */}
      <div className="flex items-end gap-1 px-2 pt-2">
        <div className="flex items-center pb-1.5 pr-2.5 pl-1.5">
          <ShellMark accent={active?.accent} className="h-[21px] w-[21px]" />
        </div>

        <div className="flex min-w-0 flex-1 items-end gap-1 overflow-x-auto">
          {workspaces.map((workspace) => {
            const isActive = workspace.id === activeWorkspaceId;
            return (
              <div
                key={workspace.id}
                className={cn(
                  'group relative flex h-9 min-w-[168px] max-w-[240px] shrink-0 items-center gap-2 rounded-t-lg border border-b-0 px-3 text-sm transition-colors',
                  isActive
                    ? 'border-border bg-background text-foreground'
                    : 'border-transparent bg-transparent text-muted-foreground hover-elevate',
                )}
                style={
                  isActive
                    ? { boxShadow: `inset 0 2px 0 0 ${workspace.accent}` }
                    : undefined
                }
              >
                <button
                  type="button"
                  onClick={() => onSelectWorkspace(workspace.id)}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  data-testid={`tab-workspace-${workspace.id}`}
                >
                  <PlatformGlyph
                    platform={workspace.platform}
                    className="h-3.5 w-3.5 shrink-0"
                  />
                  <span className="truncate">{workspace.name}</span>
                </button>
                {workspaces.length > 1 ? (
                  <button
                    type="button"
                    aria-label={`Close ${workspace.name}`}
                    onClick={() => onCloseWorkspace(workspace.id)}
                    className="rounded p-0.5 opacity-0 transition-opacity hover-elevate group-hover:opacity-100"
                    data-testid={`button-close-${workspace.id}`}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                ) : null}
              </div>
            );
          })}

          <Button
            size="icon"
            variant="ghost"
            className="mb-1 h-7 w-7 shrink-0"
            onClick={onNewWorkspace}
            aria-label="New workspace"
            data-testid="button-new-workspace"
          >
            <Plus className="h-4 w-4" />
          </Button>
        </div>

        <div className="pb-1.5 pl-2">
          <SaveIndicator status={saveStatus} verified={integrityVerified} />
        </div>
      </div>

      {/* Toolbar — omnibox plus the identity of the active isolated context */}
      <div className="flex items-center gap-2 border-t border-border/60 bg-background px-3 py-2">
        {/*
          No back / forward / reload here.

          They used to sit in this spot as three permanently `disabled` buttons.
          Navigation belongs to the shell's own toolbar, which drives the real
          `WebContentsView`; this header sits above the privileged UI and has
          nothing to navigate. Controls that can never do anything are worse
          than absent — they invite a click and answer it with silence.
        */}
        <div
          className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-full border border-border bg-card px-3"
          data-testid="omnibox"
        >
          <Lock className="h-3.5 w-3.5 shrink-0 text-chart-2" />
          <span className="truncate font-mono text-xs text-muted-foreground">
            {active ? PLATFORM_ORIGIN[active.platform] : 'about:workspaces'}
          </span>
          {active ? (
            <span className="ml-auto shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
              {PLATFORM_LABEL[active.platform]} · isolated
            </span>
          ) : null}
        </div>

        <Tooltip>
          <TooltipTrigger asChild>
            <div
              className="flex h-9 shrink-0 items-center gap-2 rounded-full border px-3 text-xs"
              style={{
                borderColor: active?.accent ?? 'hsl(var(--border))',
                color: active?.accent ?? undefined,
              }}
              data-testid="chip-ua-profile"
            >
              <Fingerprint className="h-3.5 w-3.5" />
              <span className="max-w-[180px] truncate font-medium">
                {activeProfile?.name ?? 'No UA profile'}
              </span>
            </div>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-xs">
            <p className="font-medium">{activeProfile?.name}</p>
            <p className="mt-1 break-all font-mono text-[10px] leading-relaxed opacity-80">
              {activeProfile?.userAgent}
            </p>
            <p className="mt-1 opacity-80">
              {activeProfile?.viewport} · {activeProfile?.locale} ·{' '}
              {activeProfile?.timezone}
            </p>
          </TooltipContent>
        </Tooltip>
      </div>
    </header>
  );
}
