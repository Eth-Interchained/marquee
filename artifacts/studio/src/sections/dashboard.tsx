import {
  CalendarClock,
  CircleCheck,
  FileText,
  Fingerprint,
  Sparkles,
  Users,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { PlatformGlyph } from '@/components/app/platform-glyph';
import { SectionShell, type SectionProps } from '@/sections/section-shell';
import {
  PLATFORM_LABEL,
  draftsForWorkspace,
  formatDateTime,
  relativeTime,
} from '@/lib/workspace';

function Stat({
  icon: Icon,
  label,
  value,
  hint,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-1 p-4">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Icon className="h-4 w-4" />
          <span className="text-xs font-medium uppercase tracking-wide">
            {label}
          </span>
        </div>
        <p className="text-2xl font-semibold tabular-nums">{value}</p>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </CardContent>
    </Card>
  );
}

export function Dashboard({
  state,
  workspace,
  profile,
  onNavigate,
}: SectionProps) {
  const drafts = draftsForWorkspace(state, workspace.id);
  const scheduled = drafts
    .filter((draft) => draft.status === 'scheduled' && draft.scheduledFor)
    .sort((a, b) => (a.scheduledFor ?? '').localeCompare(b.scheduledFor ?? ''));
  const connected = state.accounts.filter(
    (account) => account.workspaceId === workspace.id && account.connected,
  );

  return (
    <SectionShell
      title={workspace.name}
      description={`Isolated ${PLATFORM_LABEL[workspace.platform]} workspace running under ${profile?.name ?? 'no UA profile'}. Cookies, storage, and session data never cross into another workspace.`}
      actions={
        <>
          <Button variant="outline" onClick={() => onNavigate('drafts')} data-testid="button-open-drafts">
            <FileText className="mr-2 h-4 w-4" />
            Drafts
          </Button>
          <Button onClick={() => onNavigate('composer')} data-testid="button-open-composer">
            <Sparkles className="mr-2 h-4 w-4" />
            Compose with AI
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          icon={FileText}
          label="Drafts"
          value={String(drafts.filter((d) => d.status === 'draft').length)}
          hint="Awaiting your review"
        />
        <Stat
          icon={CalendarClock}
          label="Scheduled"
          value={String(scheduled.length)}
          hint="Approved and queued"
        />
        <Stat
          icon={Users}
          label="Accounts"
          value={String(connected.length)}
          hint="Connected in this workspace"
        />
        <Stat
          icon={Sparkles}
          label="AI requests"
          value={String(state.usage.requests)}
          hint={`${state.settings.model} via ${state.settings.provider}`}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.35fr_1fr]">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Upcoming</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {scheduled.length === 0 ? (
              <p className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
                Nothing scheduled. Approve a draft to queue it.
              </p>
            ) : (
              scheduled.slice(0, 4).map((draft) => (
                <button
                  key={draft.id}
                  type="button"
                  onClick={() => onNavigate('drafts', { draftId: draft.id })}
                  className="flex w-full gap-3 rounded-md border border-card-border bg-background/40 p-3 text-left hover-elevate"
                  data-testid={`upcoming-${draft.id}`}
                >
                  <PlatformGlyph
                    platform={draft.platform}
                    className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="line-clamp-2 text-sm">{draft.body}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {formatDateTime(draft.scheduledFor)}
                    </p>
                  </div>
                </button>
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <Fingerprint className="h-4 w-4" />
              Isolation
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {profile ? (
              <>
                <dl className="space-y-2">
                  {[
                    ['Profile', profile.name],
                    ['Platform', profile.platform],
                    ['Viewport', profile.viewport],
                    ['Locale', profile.locale],
                    ['Timezone', profile.timezone],
                    ['Client Hints', profile.clientHints ? 'Aligned' : 'Off'],
                  ].map(([label, value]) => (
                    <div key={label} className="flex justify-between gap-3">
                      <dt className="text-muted-foreground">{label}</dt>
                      <dd className="truncate text-right font-medium">
                        {value}
                      </dd>
                    </div>
                  ))}
                </dl>
                <Separator />
                <p className="break-all font-mono text-[10px] leading-relaxed text-muted-foreground">
                  {profile.userAgent}
                </p>
              </>
            ) : (
              <p className="text-muted-foreground">
                This workspace has no UA profile assigned.
              </p>
            )}
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={() => onNavigate('profiles')}
              data-testid="button-manage-profiles"
            >
              Manage UA profiles
            </Button>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Recent activity</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col">
          {state.activity.length === 0 ? (
            <p className="py-3 text-sm text-muted-foreground">
              Nothing has happened in this browser yet. Drafts, approvals, and
              posts show up here as they occur.
            </p>
          ) : null}
          {state.activity.slice(0, 6).map((entry, index) => (
            <div key={entry.id}>
              {index > 0 ? <Separator /> : null}
              <div className="flex items-start gap-3 py-3">
                <CircleCheck className="mt-0.5 h-4 w-4 shrink-0 text-chart-2" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{entry.title}</p>
                  <p className="text-xs text-muted-foreground">{entry.detail}</p>
                </div>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {relativeTime(entry.timestamp)}
                </span>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </SectionShell>
  );
}
