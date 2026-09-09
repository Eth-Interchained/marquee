import { useMemo } from 'react';
import { Download, ShieldAlert, ShieldCheck } from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip as ChartTooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { SectionShell, type SectionProps } from '@/sections/section-shell';
import { PLATFORM_LABEL } from '@/lib/workspace';

export function Usage({
  state,
}: SectionProps & { integrity?: { verified: boolean; sequence: number } }) {
  const totalTokens = state.usage.inputTokens + state.usage.outputTokens;

  const perWorkspace = useMemo(
    () =>
      state.workspaces.map((workspace) => ({
        name: workspace.name,
        drafts: state.drafts.filter(
          (draft) => draft.workspaceId === workspace.id,
        ).length,
        scheduled: state.drafts.filter(
          (draft) =>
            draft.workspaceId === workspace.id && draft.status === 'scheduled',
        ).length,
      })),
    [state.workspaces, state.drafts],
  );

  const aiEvents = state.activity.filter((entry) => entry.type === 'ai').length;

  return (
    <SectionShell
      title="Usage"
      description="What the assistant actually cost you, and what it produced. Token counts come straight from the provider response, not from an estimate."
      actions={
        <Button variant="outline" asChild data-testid="button-export-state">
          <a href="/api/browser/export" download>
            <Download className="mr-2 h-4 w-4" />
            Export state
          </a>
        </Button>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[
          ['Requests', String(state.usage.requests), 'AiAssist calls'],
          ['Input tokens', state.usage.inputTokens.toLocaleString(), 'Prompt side'],
          [
            'Output tokens',
            state.usage.outputTokens.toLocaleString(),
            'Completion side',
          ],
          ['Total tokens', totalTokens.toLocaleString(), 'Across all workspaces'],
        ].map(([label, value, hint]) => (
          <Card key={label}>
            <CardContent className="flex flex-col gap-1 p-4">
              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {label}
              </span>
              <span className="text-2xl font-semibold tabular-nums">{value}</span>
              <span className="text-xs text-muted-foreground">{hint}</span>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Output by workspace</CardTitle>
        </CardHeader>
        <CardContent className="h-[260px]">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={perWorkspace}>
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="hsl(var(--border))"
                vertical={false}
              />
              <XAxis
                dataKey="name"
                stroke="hsl(var(--muted-foreground))"
                fontSize={11}
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                stroke="hsl(var(--muted-foreground))"
                fontSize={11}
                tickLine={false}
                axisLine={false}
                allowDecimals={false}
              />
              <ChartTooltip
                cursor={{ fill: 'hsl(var(--muted))' }}
                contentStyle={{
                  background: 'hsl(var(--popover))',
                  border: '1px solid hsl(var(--popover-border))',
                  borderRadius: 8,
                  fontSize: 12,
                }}
              />
              <Bar
                dataKey="drafts"
                name="Total posts"
                fill="hsl(var(--chart-1))"
                radius={[4, 4, 0, 0]}
              />
              <Bar
                dataKey="scheduled"
                name="Scheduled"
                fill="hsl(var(--chart-2))"
                radius={[4, 4, 0, 0]}
              />
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Provider</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {[
              ['Model', state.settings.model],
              ['Provider header', state.settings.provider],
              ['Key handling', 'Server-side only'],
              ['Prompt retention', state.settings.storeAiPrompts ? 'On' : 'Off'],
              ['AI events logged', String(aiEvents)],
            ].map(([label, value]) => (
              <div key={label} className="flex justify-between gap-3">
                <span className="text-muted-foreground">{label}</span>
                <span className="font-medium">{value}</span>
              </div>
            ))}
            <Separator />
            <p className="text-xs text-muted-foreground">
              Requests are proxied by the workspace API server. The API key is
              never exposed to renderer processes or page content.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Content mix</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {(
              Object.keys(PLATFORM_LABEL) as Array<keyof typeof PLATFORM_LABEL>
            ).map((platform) => {
              const count = state.drafts.filter(
                (draft) => draft.platform === platform,
              ).length;
              const ratio = state.drafts.length
                ? Math.round((count / state.drafts.length) * 100)
                : 0;
              return (
                <div key={platform} className="space-y-1">
                  <div className="flex justify-between text-xs">
                    <span className="text-muted-foreground">
                      {PLATFORM_LABEL[platform]}
                    </span>
                    <span className="tabular-nums">{count}</span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-primary"
                      style={{ width: `${ratio}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
      </div>
    </SectionShell>
  );
}

export function IntegrityBadge({
  verified,
  sequence,
}: {
  verified: boolean;
  sequence: number;
}) {
  const Icon = verified ? ShieldCheck : ShieldAlert;
  return (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <Icon className={verified ? 'h-3.5 w-3.5 text-chart-2' : 'h-3.5 w-3.5 text-destructive'} />
      Ledger #{sequence}
    </span>
  );
}
