import { useEffect, useRef, useState } from 'react';
import {
  Bell,
  ExternalLink,
  Loader2,
  LogIn,
  MonitorSmartphone,
  PenLine,
  RefreshCw,
  ShieldCheck,
  ShieldX,
} from 'lucide-react';
import { useBeginSignIn, useGetSessionStatus } from '@marquee/api-client-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { PlatformGlyph } from '@/components/app/platform-glyph';
import { SectionShell, type SectionProps } from '@/sections/section-shell';
import { platformProfile } from '@/lib/platforms';
import { createId, logActivity } from '@/lib/workspace';
import { getShell } from '@/lib/shell-bridge';

/** How often, and for how long, a pending sign-in is checked for. */
const SIGN_IN_POLL_MS = 3_000;
const SIGN_IN_WATCH_MS = 3 * 60_000;

export function Network({ state, updateState, workspace, profile }: SectionProps) {
  const { toast } = useToast();
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [surfaceState, setSurfaceState] = useState<
    'idle' | 'mounting' | 'mounted' | 'unavailable'
  >('idle');
  const [surfaceError, setSurfaceError] = useState<string | null>(null);
  const [partition, setPartition] = useState<string | null>(null);
  const [quickNote, setQuickNote] = useState('');

  const network = platformProfile(workspace.platform);
  const sessionQuery = useGetSessionStatus({ workspaceId: workspace.id });
  const session = sessionQuery.data;
  const { refetch: refetchSession } = sessionQuery;
  const signIn = useBeginSignIn();
  const [awaitingSignIn, setAwaitingSignIn] = useState(false);

  useEffect(() => {
    const shell = getShell();
    const container = surfaceRef.current;
    if (!shell || !container || !profile) {
      setSurfaceState('unavailable');
      return;
    }

    let handle: { close(): Promise<void> } | null = null;
    setPartition(null);
    let cancelled = false;
    setSurfaceState('mounting');
    setSurfaceError(null);

    shell
      .attachSurface(container, {
        workspaceId: workspace.id,
        url: network.feedUrl,
        userAgent: profile.userAgent,
        acceptLanguage: profile.locale,
        timezone: profile.timezone,
        clientHints: profile.clientHints,
      })
      .then((mounted) => {
        if (cancelled) {
          void mounted.close();
          return;
        }
        handle = mounted;
        // The shell owns the partition; report what it actually used rather
        // than guessing at a key this page cannot derive.
        setPartition(mounted.partition);
        setSurfaceState('mounted');
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setSurfaceState('unavailable');
        setSurfaceError(
          error instanceof Error ? error.message : 'Surface failed to mount.',
        );
      });

    return () => {
      cancelled = true;
      void handle?.close();
    };
  }, [workspace.id, network.feedUrl, profile]);

  function openInTab(url: string) {
    const shell = getShell();
    if (shell) {
      void shell.openInWorkspaceTab(workspace.id, url);
      return;
    }
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  function captureNote() {
    const body = quickNote.trim();
    if (!body) return;

    updateState((current) => ({
      ...current,
      drafts: [
        {
          id: createId('draft'),
          workspaceId: workspace.id,
          platform: workspace.platform,
          body,
          media: [],
          status: 'draft',
          scheduledFor: null,
          approvedBy: null,
          approvedAt: null,
          postUrl: null,
          lastError: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        ...current.drafts,
      ],
      activity: logActivity(current, {
        type: 'draft',
        title: 'Captured from the network view',
        detail: `${network.label} · ${workspace.name}`,
      }),
    }));

    setQuickNote('');
    toast({
      title: 'Captured as a draft',
      description: 'Refine it in the composer, then approve it to post.',
    });
  }

  const sessionReady = Boolean(session?.authenticated);

  /**
   * Signing in happens in the workspace's tab, in the network's own page, so
   * this view cannot observe it directly — and must not guess. It asks the
   * session itself until the account shows up, then stops. An opened tab is
   * never treated as a signed-in account.
   */
  useEffect(() => {
    if (!awaitingSignIn) return;
    if (sessionReady) {
      setAwaitingSignIn(false);
      return;
    }

    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      if (Date.now() - startedAt > SIGN_IN_WATCH_MS) {
        setAwaitingSignIn(false);
        return;
      }
      void refetchSession();
    }, SIGN_IN_POLL_MS);

    return () => window.clearInterval(timer);
  }, [awaitingSignIn, sessionReady, refetchSession]);

  async function startSignIn() {
    try {
      const invitation = await signIn.mutateAsync({
        data: { workspaceId: workspace.id },
      });

      setAwaitingSignIn(invitation.opened);
      toast({
        title: invitation.alreadySignedIn
          ? 'Already signed in'
          : invitation.opened
            ? `Sign in to ${network.label} in the tab`
            : 'No sign-in available here',
        description: invitation.detail,
      });
      void refetchSession();
    } catch {
      toast({
        title: 'Could not start a sign-in',
        description:
          'The workspace API did not answer, so nothing was opened. Nothing about this workspace changed.',
        variant: 'destructive',
      });
    }
  }

  return (
    <SectionShell
      title={`${network.label} · ${workspace.name}`}
      description={network.note}
      actions={
        <>
          <Button
            variant="outline"
            size="sm"
            onClick={() => sessionQuery.refetch()}
            data-testid="button-refresh-session"
          >
            <RefreshCw
              className={cn(
                'mr-2 h-4 w-4',
                sessionQuery.isFetching && 'animate-spin',
              )}
            />
            Session
          </Button>
          {!sessionReady ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void startSignIn()}
              disabled={signIn.isPending || awaitingSignIn}
              data-testid="button-sign-in"
            >
              {signIn.isPending || awaitingSignIn ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <LogIn className="mr-2 h-4 w-4" />
              )}
              Sign in
            </Button>
          ) : null}
          {network.notificationsUrl ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => openInTab(network.notificationsUrl as string)}
              data-testid="button-open-notifications"
            >
              <Bell className="mr-2 h-4 w-4" />
              Notifications
            </Button>
          ) : null}
          <Button
            size="sm"
            onClick={() => openInTab(network.composeUrl)}
            data-testid="button-open-native-composer"
          >
            <ExternalLink className="mr-2 h-4 w-4" />
            Open {network.label}
          </Button>
        </>
      }
    >
      <div
        className="flex items-center gap-3 rounded-md border p-3 text-sm"
        style={{ borderColor: `${network.accent}55` }}
        data-testid="session-banner"
      >
        {sessionQuery.isLoading ? (
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
        ) : sessionReady ? (
          <ShieldCheck className="h-4 w-4 shrink-0 text-chart-2" />
        ) : (
          <ShieldX className="h-4 w-4 shrink-0 text-chart-3" />
        )}
        <div className="min-w-0 flex-1">
          <p className="font-medium" data-testid="session-headline">
            {sessionQuery.isLoading
              ? 'Checking the workspace session'
              : sessionReady
                ? // The handle is named only when the shell read it off the
                  // network's own signed-in page. Anything else — including a
                  // handle stored on this workspace — is not evidence about
                  // whose account this is, and naming it would answer the one
                  // question the operator must never be misled about.
                  session?.accountHandle && session.handleSource === 'session'
                  ? `Signed in as ${session.accountHandle}`
                  : 'Signed in'
                : awaitingSignIn
                  ? 'Waiting for the sign-in to finish in the tab'
                  : 'Not ready to post'}
          </p>
          <p className="text-xs text-muted-foreground">
            {sessionQuery.isError
              ? 'The workspace API did not answer. Posting is disabled until it does.'
              : (session?.detail ??
                'Session state is resolved by the desktop shell.')}
          </p>
          {sessionReady && !session?.accountHandle ? (
            <p
              className="mt-0.5 text-xs text-chart-4"
              data-testid="session-account-unknown"
            >
              {session?.handleUnknown ??
                'Which account this is could not be read from the session.'}
              {session?.accountId
                ? ` This session belongs to account ${session.accountId}.`
                : ''}
            </p>
          ) : null}
        </div>
        <span className="shrink-0 text-xs text-muted-foreground">
          {profile?.name ?? 'No UA profile'}
        </span>
      </div>

      <Card className="overflow-hidden">
        <CardHeader className="flex-row items-center justify-between gap-3 space-y-0 border-b border-card-border py-3">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <PlatformGlyph platform={workspace.platform} tinted />
            {network.feedUrl}
          </CardTitle>
          <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
            {partition
              ? `partition: ${partition}`
              : 'isolated session per workspace'}
          </span>
        </CardHeader>

        <CardContent className="p-0">
          <div
            ref={surfaceRef}
            className="min-h-[420px] w-full"
            data-testid="network-surface"
          >
            {surfaceState !== 'mounted' ? (
              <div className="flex min-h-[420px] flex-col items-center justify-center gap-3 p-10 text-center">
                {surfaceState === 'mounting' ? (
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                ) : (
                  <MonitorSmartphone className="h-7 w-7 text-muted-foreground" />
                )}
                <p className="text-sm font-medium">
                  {surfaceState === 'mounting'
                    ? 'Mounting the isolated surface'
                    : 'The live network runs in the desktop shell'}
                </p>
                <p className="max-w-md text-sm text-muted-foreground">
                  {surfaceError ??
                    `${network.label} refuses to render inside a plain iframe, and faking it would be worse than not showing it. In the native shell this panel is a real Chromium view bound to this workspace's own cookie jar and UA profile.`}
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => openInTab(network.feedUrl)}
                  data-testid="button-open-feed"
                >
                  <ExternalLink className="mr-2 h-4 w-4" />
                  Open the feed
                </Button>
              </div>
            ) : null}
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <PenLine className="h-4 w-4" />
              Quick capture
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Textarea
              value={quickNote}
              onChange={(event) => setQuickNote(event.target.value)}
              placeholder={`Something you saw on ${network.label} worth replying to, or a thought to turn into a post later.`}
              className="min-h-[104px] resize-y"
              data-testid="input-quick-capture"
            />
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs tabular-nums text-muted-foreground">
                {quickNote.length} / {network.charLimit}
              </span>
              <Button
                size="sm"
                onClick={captureNote}
                disabled={!quickNote.trim()}
                data-testid="button-capture"
              >
                Save as draft
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Network rules</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {[
              ['Character limit', network.charLimit.toLocaleString()],
              ['Media per post', String(network.mediaLimit)],
              ['Threads', network.supportsThread ? 'Supported' : 'No'],
              ['Alt text', network.supportsAltText ? 'Supported' : 'No'],
              ['Media required', network.requiresMedia ? 'Yes' : 'No'],
            ].map(([label, value]) => (
              <div key={label} className="flex justify-between gap-3">
                <span className="text-muted-foreground">{label}</span>
                <span className="font-medium">{value}</span>
              </div>
            ))}
            <Separator />
            <p className="text-xs text-muted-foreground">
              Drafts for this workspace:{' '}
              {
                state.drafts.filter(
                  (draft) => draft.workspaceId === workspace.id,
                ).length
              }
            </p>
          </CardContent>
        </Card>
      </div>
    </SectionShell>
  );
}
