import { useEffect, useRef, useState } from 'react';
import { Loader2, LogIn, Plus, RefreshCw, Trash2 } from 'lucide-react';
import {
  getSessionStatus,
  useBeginSignIn,
  useSignOutOfSession,
} from '@marquee/api-client-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { PlatformGlyph } from '@/components/app/platform-glyph';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { SectionShell, type SectionProps } from '@/sections/section-shell';
import {
  PLATFORMS,
  PLATFORM_LABEL,
  createId,
  initialsFor,
  logActivity,
} from '@/lib/workspace';
import type { Platform, SocialAccount } from '@/types';

/** How often, and for how long, a sign-in in progress is checked for. */
const POLL_MS = 3_000;
const WATCH_MS = 3 * 60_000;

export function Accounts({ state, updateState, workspace }: SectionProps) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [handle, setHandle] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [platform, setPlatform] = useState<Platform>(workspace.platform);

  const signIn = useBeginSignIn();
  /** The account whose sign-in tab is open, if any. */
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [checkingId, setCheckingId] = useState<string | null>(null);
  const signOut = useSignOutOfSession();
  /** The account the operator is being asked to confirm removal of. */
  const [removing, setRemoving] = useState<SocialAccount | null>(null);

  const accounts = state.accounts.filter(
    (account) => account.workspaceId === workspace.id,
  );

  const pending = accounts.find((account) => account.id === pendingId) ?? null;
  const pendingPlatform = pending?.platform ?? null;

  /**
   * The badge is a claim about a session, so it is only ever written from one.
   * Nothing here marks an account signed in because a tab was opened or a form
   * was filled in — that is the difference between this app and a dashboard
   * that guesses.
   */
  function recordSession(accountId: string, authenticated: boolean) {
    updateState((current) => {
      const account = current.accounts.find((item) => item.id === accountId);
      if (!account || account.connected === authenticated) return current;

      return {
        ...current,
        accounts: current.accounts.map((item) =>
          item.id === accountId ? { ...item, connected: authenticated } : item,
        ),
        activity: logActivity(current, {
          type: 'workspace',
          title: authenticated ? 'Account signed in' : 'Account signed out',
          detail: `${account.handle} · ${PLATFORM_LABEL[account.platform]} · read from the workspace session`,
        }),
      };
    });
  }

  const recordSessionRef = useRef(recordSession);
  recordSessionRef.current = recordSession;

  /**
   * Signing in happens in the network's own page, in this workspace's tab, so
   * this view cannot watch it. It asks the session itself until the account
   * shows up, then stops. Three minutes is long enough for a second factor;
   * after that it gives up quietly rather than polling forever.
   */
  useEffect(() => {
    if (!pendingId || !pendingPlatform) return;

    const startedAt = Date.now();
    let cancelled = false;

    const timer = window.setInterval(() => {
      if (Date.now() - startedAt > WATCH_MS) {
        setPendingId(null);
        return;
      }

      void getSessionStatus({
        workspaceId: workspace.id,
        platform: pendingPlatform,
      })
        .then((status) => {
          if (cancelled || !status.bridgeAvailable) return;
          if (!status.authenticated) return;
          recordSessionRef.current(pendingId, true);
          setPendingId(null);
          toast({
            title: 'Signed in',
            description: status.detail,
          });
        })
        .catch(() => {
          // A failed check says nothing about the account, so it changes
          // nothing. The next tick tries again.
        });
    }, POLL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [pendingId, pendingPlatform, workspace.id, toast]);

  /**
   * Opens the network's own login page in this workspace's tab. The account
   * row is bookkeeping; this is the part that matters, so every path that
   * registers an account offers it immediately.
   */
  async function startSignIn(accountId: string, target: Platform) {
    const label = PLATFORM_LABEL[target];

    try {
      const invitation = await signIn.mutateAsync({
        data: { workspaceId: workspace.id, platform: target },
      });

      if (invitation.alreadySignedIn) {
        // The shell read the session to answer this, so it is evidence.
        recordSession(accountId, true);
        setPendingId(null);
      } else {
        setPendingId(invitation.opened ? accountId : null);
      }

      toast({
        title: invitation.alreadySignedIn
          ? `Already signed in to ${label}`
          : invitation.opened
            ? `Sign in to ${label} in this workspace's tab`
            : 'No sign-in was opened',
        description: invitation.detail,
        variant: invitation.opened || invitation.alreadySignedIn ? undefined : 'destructive',
      });
    } catch {
      setPendingId(null);
      toast({
        title: 'Could not start a sign-in',
        description:
          'The workspace API did not answer, so no page was opened and nothing about this account changed.',
        variant: 'destructive',
      });
    }
  }

  /** Re-reads the session behind one account and rewrites its badge from that. */
  async function checkAccount(accountId: string, target: Platform) {
    setCheckingId(accountId);
    try {
      const status = await getSessionStatus({
        workspaceId: workspace.id,
        platform: target,
      });

      if (!status.bridgeAvailable) {
        // Unknown is not the same as signed out, so the badge is left alone.
        toast({
          title: 'Cannot read this session here',
          description: status.detail,
        });
        return;
      }

      recordSession(accountId, status.authenticated);
      toast({
        title: status.authenticated ? 'Signed in' : 'Not signed in',
        description: status.detail,
      });
    } catch {
      toast({
        title: 'Session check failed',
        description:
          'The workspace API did not answer. The badge still shows the last session that was actually read.',
        variant: 'destructive',
      });
    } finally {
      setCheckingId(null);
    }
  }

  /**
   * Removes an account, and the session behind it.
   *
   * This used to filter the row out of state and stop there. The cookie jar is
   * keyed by workspace, so the previous account stayed signed in: registering
   * a different handle here reused that session, the badge read "Signed in"
   * about the jar rather than about the name, and — because a draft carries a
   * workspace and a platform but no account — an approved post would have gone
   * out from whoever was actually in the jar.
   *
   * **The session goes first, and the label only follows if that worked.** A
   * failed sign-out that still forgot the label would leave the operator with
   * no row on screen and a live session underneath it, which is worse than
   * either problem alone.
   */
  async function removeAccount(account: SocialAccount) {
    if (pendingId === account.id) setPendingId(null);

    try {
      const outcome = await signOut.mutateAsync({
        data: { workspaceId: workspace.id, platform: account.platform },
      });

      if (!outcome.signedOut) {
        toast({
          title: 'Still signed in — nothing removed',
          description: outcome.detail,
          variant: 'destructive',
        });
        return;
      }

      updateState((current) => ({
        ...current,
        accounts: current.accounts.filter((item) => item.id !== account.id),
        activity: logActivity(current, {
          type: 'workspace',
          title: 'Account removed and signed out',
          detail: `${account.handle} · ${PLATFORM_LABEL[account.platform]} · ${workspace.name}`,
        }),
      }));

      toast({ title: 'Signed out and removed', description: outcome.detail });
    } catch {
      toast({
        title: 'Could not sign out',
        description:
          'The shell could not be reached, so nothing was changed. The account is still signed in.',
        variant: 'destructive',
      });
    } finally {
      setRemoving(null);
    }
  }

  async function addAccount() {
    const normalizedHandle = handle.trim();
    const normalizedName = displayName.trim();
    if (!normalizedHandle || !normalizedName) {
      toast({
        title: 'Handle and display name are required',
        variant: 'destructive',
      });
      return;
    }

    const id = createId('account');
    const target = platform;

    updateState((current) => ({
      ...current,
      accounts: [
        ...current.accounts,
        {
          id,
          workspaceId: workspace.id,
          platform: target,
          handle: normalizedHandle.startsWith('@')
            ? normalizedHandle
            : `@${normalizedHandle}`,
          displayName: normalizedName,
          connected: false,
          avatar: initialsFor(normalizedName),
        },
      ],
      activity: logActivity(current, {
        type: 'workspace',
        title: 'Account added',
        detail: `${normalizedHandle} · ${workspace.name}`,
      }),
    }));

    setHandle('');
    setDisplayName('');
    setOpen(false);

    // Adding an account is the operator saying "I want to use this account
    // here", so the login page comes straight up rather than waiting behind a
    // second button they have to find.
    await startSignIn(id, target);
  }

  return (
    <SectionShell
      title="Accounts"
      description={`Accounts registered to ${workspace.name}. Signing in opens the network's own login page in this workspace's tab, under its isolated session — this app never sees the credentials, and an account is only marked signed in when the session itself says so.`}
      actions={
        <Button onClick={() => setOpen(true)} data-testid="button-add-account">
          <Plus className="mr-2 h-4 w-4" />
          Add account
        </Button>
      }
    >
      {accounts.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="p-10 text-center text-sm text-muted-foreground">
            No accounts registered to this workspace yet.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {accounts.map((account) => {
            const awaiting = pendingId === account.id;
            const checking = checkingId === account.id;

            return (
              <Card key={account.id} data-testid={`account-${account.id}`}>
                <CardContent className="flex items-center gap-3 p-4">
                  <div
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold"
                    style={{
                      backgroundColor: `${workspace.accent}22`,
                      color: workspace.accent,
                    }}
                  >
                    {account.avatar}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {account.displayName}
                    </p>
                    <p className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
                      <PlatformGlyph
                        platform={account.platform}
                        className="h-3 w-3"
                      />
                      {account.handle}
                    </p>
                  </div>
                  <span
                    className={cn(
                      'rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide',
                      account.connected
                        ? 'border-chart-2/50 text-chart-2'
                        : 'border-border text-muted-foreground',
                    )}
                    data-testid={`status-${account.id}`}
                  >
                    {account.connected ? 'Signed in' : 'Not signed in'}
                  </span>
                  <div className="flex items-center gap-1">
                    {!account.connected ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          void startSignIn(account.id, account.platform)
                        }
                        disabled={signIn.isPending || awaiting}
                        data-testid={`button-signin-${account.id}`}
                      >
                        {awaiting ? (
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        ) : (
                          <LogIn className="mr-2 h-4 w-4" />
                        )}
                        {awaiting ? 'Waiting' : 'Sign in'}
                      </Button>
                    ) : null}
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      aria-label="Re-read this session"
                      onClick={() =>
                        void checkAccount(account.id, account.platform)
                      }
                      disabled={checking}
                      data-testid={`button-check-${account.id}`}
                    >
                      <RefreshCw
                        className={cn('h-4 w-4', checking && 'animate-spin')}
                      />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      aria-label="Sign out and remove account"
                      onClick={() => setRemoving(account)}
                      disabled={signOut.isPending}
                      data-testid={`button-remove-${account.id}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">What this browser will not do</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2 text-sm text-muted-foreground sm:grid-cols-2">
          <p>· No credential storage outside the OS keychain and profile jar.</p>
          <p>· No automated posting, liking, following, or messaging.</p>
          <p>· No CAPTCHA solving or anti-detection evasion.</p>
          <p>· No scraping of another user's private data.</p>
        </CardContent>
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add an account</DialogTitle>
            <DialogDescription>
              Registers the account with this workspace and opens the network's
              own sign-in page in this workspace's tab. You sign in yourself;
              the session stays inside this workspace's profile.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="account-platform">Platform</Label>
              <Select
                value={platform}
                onValueChange={(value) => setPlatform(value as Platform)}
              >
                <SelectTrigger id="account-platform" data-testid="select-account-platform">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PLATFORMS.map((option) => (
                    <SelectItem key={option} value={option}>
                      {PLATFORM_LABEL[option]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="account-name">Display name</Label>
              <Input
                id="account-name"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder="Display name"
                data-testid="input-account-name"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="account-handle">Handle</Label>
              <Input
                id="account-handle"
                value={handle}
                onChange={(event) => setHandle(event.target.value)}
                placeholder="@handle"
                data-testid="input-account-handle"
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => void addAccount()}
              disabled={signIn.isPending}
              data-testid="button-save-account"
            >
              {signIn.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <LogIn className="mr-2 h-4 w-4" />
              )}
              Add and sign in
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/*
        The trash icon signs the workspace out now, not just forgets a name.
        That is what makes the row's disappearance mean something — but it also
        makes it destructive, so it is stated before it happens rather than
        explained in a toast afterwards.
      */}
      <AlertDialog
        open={removing !== null}
        onOpenChange={(next) => {
          if (!next) setRemoving(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Sign out of {removing ? PLATFORM_LABEL[removing.platform] : ''} and
              remove this account?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {removing
                ? `This destroys the ${PLATFORM_LABEL[removing.platform]} session in ${workspace.name}, so ${removing.handle} will have to sign in again — with a second factor if the account uses one. Other networks in this workspace keep their sessions. Nothing is removed unless the sign-out actually works.`
                : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-remove">
              Keep it
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={signOut.isPending}
              onClick={(event) => {
                // Held open until the shell answers, so the operator sees the
                // refusal on the card rather than a dialog vanishing on a
                // sign-out that did not happen.
                event.preventDefault();
                if (removing) void removeAccount(removing);
              }}
              data-testid="button-confirm-remove"
            >
              {signOut.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : null}
              Sign out and remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

    </SectionShell>
  );
}
