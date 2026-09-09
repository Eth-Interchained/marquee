import { useMemo, useState } from 'react';
import { AlertTriangle, ChevronLeft, ChevronRight, Timer } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PlatformGlyph } from '@/components/app/platform-glyph';
import { useSchedulerStatus } from '@/hooks/use-scheduler';
import { cn } from '@/lib/utils';
import { SectionShell, type SectionProps } from '@/sections/section-shell';
import { PLATFORM_LABEL, findWorkspace, formatDateTime } from '@/lib/workspace';
import type { Draft } from '@/types';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function startOfMonthGrid(month: Date): Date {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  // Convert Sunday-first (0) to Monday-first (0 = Monday).
  const weekday = (first.getDay() + 6) % 7;
  return new Date(first.getFullYear(), first.getMonth(), 1 - weekday);
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export function Calendar({
  state,
  updateState,
  workspace,
  onNavigate,
}: SectionProps) {
  const [month, setMonth] = useState(() => new Date());
  const [scope, setScope] = useState<'workspace' | 'all'>('workspace');
  const scheduler = useSchedulerStatus();

  const scheduled = useMemo(
    () =>
      state.drafts.filter(
        (draft) =>
          draft.status === 'scheduled' &&
          draft.scheduledFor &&
          (scope === 'all' || draft.workspaceId === workspace.id),
      ),
    [state.drafts, scope, workspace.id],
  );

  const days = useMemo(() => {
    const start = startOfMonthGrid(month);
    return Array.from({ length: 42 }, (_, index) => {
      const date = new Date(
        start.getFullYear(),
        start.getMonth(),
        start.getDate() + index,
      );
      const items = scheduled.filter((draft) =>
        isSameDay(new Date(draft.scheduledFor as string), date),
      );
      return { date, items };
    });
  }, [month, scheduled]);

  /**
   * The calendar is a way into a post, not just a picture of one.
   *
   * In "all workspaces" scope a queued post can belong to a workspace that is
   * not the open one, and the review queue only ever shows the open workspace —
   * so switch to the post's workspace before pointing at it, or the operator
   * lands on a list that does not contain what they clicked.
   */
  function openPost(draft: Draft) {
    if (draft.workspaceId !== workspace.id) {
      updateState((current) => ({
        ...current,
        activeWorkspaceId: draft.workspaceId,
      }));
    }
    onNavigate('drafts', { draftId: draft.id });
  }

  const upcoming = [...scheduled].sort((a, b) =>
    (a.scheduledFor ?? '').localeCompare(b.scheduledFor ?? ''),
  );

  const shiftMonth = (delta: number) =>
    setMonth(
      (current) => new Date(current.getFullYear(), current.getMonth() + delta, 1),
    );

  const accentFor = (draft: Draft) =>
    findWorkspace(state, draft.workspaceId)?.accent ?? 'hsl(var(--primary))';

  return (
    <SectionShell
      title="Plan"
      description="A shared view of what is queued and when. A time on an approved post is kept: it goes out then, through this workspace's own session, carrying the approval you signed it with."
      actions={
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 rounded-md border border-border p-1">
            {(['workspace', 'all'] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setScope(option)}
                className={cn(
                  'rounded px-2.5 py-1 text-xs transition-colors hover-elevate',
                  scope === option
                    ? 'bg-accent font-medium text-accent-foreground'
                    : 'text-muted-foreground',
                )}
                data-testid={`scope-${option}`}
              >
                {option === 'workspace' ? 'This workspace' : 'All workspaces'}
              </button>
            ))}
          </div>
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            onClick={() => shiftMonth(-1)}
            aria-label="Previous month"
            data-testid="button-prev-month"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="min-w-[128px] text-center text-sm font-medium">
            {month.toLocaleString(undefined, {
              month: 'long',
              year: 'numeric',
            })}
          </span>
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            onClick={() => shiftMonth(1)}
            aria-label="Next month"
            data-testid="button-next-month"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      }
    >
      {scheduler ? (
        <div
          className={cn(
            'flex items-start gap-2 rounded-md border p-3 text-xs',
            scheduler.active && scheduler.bridgeConfigured
              ? 'border-card-border text-muted-foreground'
              : 'border-destructive/40 bg-destructive/10 text-destructive',
          )}
          data-testid="banner-scheduler"
        >
          {scheduler.active && scheduler.bridgeConfigured ? (
            <Timer className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          ) : (
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          )}
          <span>{scheduler.detail}</span>
        </div>
      ) : null}

      <Card>
        <CardContent className="p-3">
          <div className="grid grid-cols-7 gap-1">
            {WEEKDAYS.map((day) => (
              <div
                key={day}
                className="pb-1 text-center text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
              >
                {day}
              </div>
            ))}

            {days.map(({ date, items }) => {
              const inMonth = date.getMonth() === month.getMonth();
              const today = isSameDay(date, new Date());
              return (
                <div
                  key={date.toISOString()}
                  className={cn(
                    'min-h-[86px] rounded-md border p-1.5',
                    inMonth
                      ? 'border-card-border bg-background/40'
                      : 'border-transparent bg-transparent opacity-45',
                    today && 'border-primary/60',
                  )}
                  data-testid={`day-${date.toISOString().slice(0, 10)}`}
                >
                  <span
                    className={cn(
                      'text-[11px] tabular-nums',
                      today ? 'font-semibold text-primary' : 'text-muted-foreground',
                    )}
                  >
                    {date.getDate()}
                  </span>
                  <div className="mt-1 flex flex-col gap-1">
                    {items.slice(0, 2).map((draft) => (
                      <button
                        key={draft.id}
                        type="button"
                        onClick={() => openPost(draft)}
                        className="flex w-full items-center gap-1 rounded border px-1 py-0.5 text-left text-[10px] hover-elevate"
                        style={{ borderColor: accentFor(draft) }}
                        title={draft.body}
                        data-testid={`calendar-post-${draft.id}`}
                      >
                        <PlatformGlyph
                          platform={draft.platform}
                          className="h-2.5 w-2.5 shrink-0"
                        />
                        <span className="truncate">
                          {new Date(
                            draft.scheduledFor as string,
                          ).toLocaleTimeString(undefined, {
                            hour: 'numeric',
                            minute: '2-digit',
                          })}
                        </span>
                      </button>
                    ))}
                    {items.length > 2 ? (
                      <span className="text-[10px] text-muted-foreground">
                        +{items.length - 2} more
                      </span>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Queue</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {upcoming.length === 0 ? (
            <p className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
              Nothing queued.{' '}
              <button
                type="button"
                className="underline underline-offset-2"
                onClick={() => onNavigate('drafts')}
              >
                Schedule a draft
              </button>
              .
            </p>
          ) : (
            upcoming.map((draft) => (
              <button
                key={draft.id}
                type="button"
                onClick={() => openPost(draft)}
                className="flex w-full items-start gap-3 rounded-md border border-card-border p-3 text-left hover-elevate"
                data-testid={`queue-${draft.id}`}
              >
                <span
                  className="mt-1 h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: accentFor(draft) }}
                />
                <div className="min-w-0 flex-1">
                  <p className="line-clamp-2 text-sm">{draft.body}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {PLATFORM_LABEL[draft.platform]} ·{' '}
                    {findWorkspace(state, draft.workspaceId)?.name ??
                      'Unknown workspace'}{' '}
                    · {formatDateTime(draft.scheduledFor)}
                  </p>
                </div>
                <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
              </button>
            ))
          )}
        </CardContent>
      </Card>
    </SectionShell>
  );
}
