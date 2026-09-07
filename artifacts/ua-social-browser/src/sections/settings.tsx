import { Download, RotateCcw, ShieldAlert, ShieldCheck } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { useListAiModels } from '@workspace/api-client-react';
import { initialState } from '@/data';
import { platformProfile } from '@/lib/platforms';
import {
  MEDIA_HOST_ENV,
  apiSurface,
  platformsWithApiMode,
} from '@/lib/publish-route';
import { SectionShell, type SectionProps } from '@/sections/section-shell';

type SettingsProps = SectionProps & {
  integrity: { verified: boolean; sequence: number; head: string };
};

export function Settings({ state, updateState, integrity }: SettingsProps) {
  const modelsQuery = useListAiModels();
  const models = modelsQuery.data?.models ?? [];
  const options = models.some((model) => model.id === state.settings.model)
    ? models
    : [{ id: state.settings.model, name: state.settings.model }, ...models];

  const IntegrityIcon = integrity.verified ? ShieldCheck : ShieldAlert;

  return (
    <SectionShell
      title="Settings"
      description="Assistant defaults, review gates, and the state of the embedded store that backs every workspace."
    >
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Assistant</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="settings-operator">Approver name</Label>
            <Input
              id="settings-operator"
              value={state.settings.operatorName}
              onChange={(event) =>
                updateState((current) => ({
                  ...current,
                  settings: {
                    ...current.settings,
                    operatorName: event.target.value,
                  },
                }))
              }
              placeholder="Your name"
              className="max-w-sm"
              data-testid="input-operator-name"
            />
            <p className="text-xs text-muted-foreground">
              Recorded on every approval and sent with the post so the ledger
              shows who signed off. Nothing can be approved while this is
              empty, and approvals already recorded keep the name they were
              signed under.
            </p>
          </div>

          <Separator />

          <div className="space-y-1.5">
            <Label htmlFor="settings-model">Default model</Label>
            <Select
              value={state.settings.model}
              onValueChange={(value) =>
                updateState((current) => ({
                  ...current,
                  settings: { ...current.settings, model: value },
                }))
              }
            >
              <SelectTrigger
                id="settings-model"
                className="max-w-sm"
                data-testid="select-default-model"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {options.map((model) => (
                  <SelectItem key={model.id} value={model.id}>
                    {model.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Sent with the <code className="font-mono">pin</code> provider
              header from the server. Renderer processes never see the key.
            </p>
          </div>

          <Separator />

          <div className="flex items-start justify-between gap-6">
            <div>
              <Label htmlFor="settings-confirm">Confirm before publish</Label>
              <p className="mt-0.5 text-sm text-muted-foreground">
                Asks once more before a post leaves through your session. The
                human approval itself is always required, with or without this.
              </p>
            </div>
            <Switch
              id="settings-confirm"
              checked={state.settings.confirmBeforePublish}
              onCheckedChange={(checked) =>
                updateState((current) => ({
                  ...current,
                  settings: {
                    ...current.settings,
                    confirmBeforePublish: checked,
                  },
                }))
              }
              data-testid="switch-confirm-publish"
            />
          </div>

          <div className="flex items-start justify-between gap-6">
            <div>
              <Label htmlFor="settings-prompts">Store AI prompts</Label>
              <p className="mt-0.5 text-sm text-muted-foreground">
                Keeps your briefs in the local store for reuse. Off by default —
                prompts are discarded after the response.
              </p>
            </div>
            <Switch
              id="settings-prompts"
              checked={state.settings.storeAiPrompts}
              onCheckedChange={(checked) =>
                updateState((current) => ({
                  ...current,
                  settings: { ...current.settings, storeAiPrompts: checked },
                }))
              }
              data-testid="switch-store-prompts"
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Publishing</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="settings-publish-mode">Default route</Label>
            <Select
              value={state.settings.publish.mode}
              onValueChange={(value) =>
                updateState((current) => ({
                  ...current,
                  settings: {
                    ...current.settings,
                    publish: {
                      ...current.settings.publish,
                      mode: value as 'session' | 'api',
                    },
                  },
                }))
              }
            >
              <SelectTrigger
                id="settings-publish-mode"
                className="max-w-sm"
                data-testid="select-publish-mode"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="session">
                  Your signed-in session
                </SelectItem>
                <SelectItem value="api">Directly via the network API</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Two routes, not two apps — the same composer and the same
              approval either way. The session route works everywhere and posts
              as you. The direct route exists on {platformsWithApiMode().length}{' '}
              networks, hands back a real post id instead of reading the page,
              and can publish on schedule without this app running. A post
              whose chosen route is unavailable says so rather than switching
              quietly.
            </p>
          </div>

          <Separator />

          <div className="space-y-3">
            <div>
              <Label>Direct publishing targets</Label>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Which account each network publishes to. These are
                identifiers, not credentials.
              </p>
            </div>

            {(
              [
                ['metaPageId', 'facebook', 'Facebook Page ID'],
                ['instagramUserId', 'instagram', 'Instagram account ID'],
                ['threadsUserId', 'threads', 'Threads user ID'],
              ] as const
            ).map(([field, platform, label]) => (
              <div key={field} className="space-y-1.5">
                <Label htmlFor={`settings-${field}`}>{label}</Label>
                <Input
                  id={`settings-${field}`}
                  value={state.settings.publish[field]}
                  onChange={(event) =>
                    updateState((current) => ({
                      ...current,
                      settings: {
                        ...current.settings,
                        publish: {
                          ...current.settings.publish,
                          [field]: event.target.value,
                        },
                      },
                    }))
                  }
                  placeholder="Not set"
                  className="max-w-sm font-mono text-xs"
                  data-testid={`input-${field}`}
                />
                <p className="text-xs text-muted-foreground">
                  {platform === 'facebook'
                    ? 'Facebook’s API publishes as a Page and cannot post to a personal profile. Leave this empty to keep Facebook on the session route.'
                    : platform === 'instagram'
                      ? `Must be a Business or Creator account. Instagram has no text-only post, so every post here needs an image or video — ${platformProfile('instagram').label} captions are drafted in the composer and the media is hosted before publishing.`
                      : 'Threads signs in separately from the rest of Meta, even on the same developer account.'}
                </p>
              </div>
            ))}
          </div>

          <Separator />

          <div className="space-y-2">
            <Label>Keys</Label>
            <p className="text-xs text-muted-foreground">
              Tokens and API keys are read from the server’s environment and
              never enter this browser’s state. That is deliberate: everything
              on this page is downloadable through{' '}
              <code className="font-mono">Export state</code>, so a token
              stored here would be a token in your Downloads folder. Set these
              in the server environment:
            </p>
            <ul className="space-y-1.5 text-xs">
              {[
                ...new Set(
                  platformsWithApiMode().map(
                    (platform) => apiSurface(platform)!.tokenEnvVar,
                  ),
                ),
                MEDIA_HOST_ENV,
              ].map((envVar) => (
                <li key={envVar} className="flex items-baseline gap-2">
                  <code className="rounded bg-muted px-1.5 py-0.5 font-mono">
                    {envVar}
                  </code>
                  <span className="text-muted-foreground">
                    {envVar === MEDIA_HOST_ENV
                      ? 'Media host. Instagram and Facebook fetch images from a public URL rather than accepting an upload, so images are hosted first.'
                      : envVar === 'THREADS_ACCESS_TOKEN'
                        ? 'Threads publishing.'
                        : 'Facebook Page and Instagram publishing — Instagram goes through the linked Page’s token, so it is one variable, not two.'}
                  </span>
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted-foreground">
              Each publishing permission needs Meta’s App Review before it
              works for anyone but you.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Local store</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex items-center gap-2">
            <IntegrityIcon
              className={
                integrity.verified
                  ? 'h-4 w-4 text-chart-2'
                  : 'h-4 w-4 text-destructive'
              }
            />
            <span className="font-medium">
              {integrity.verified
                ? 'Append-only ledger verified'
                : 'Ledger verification failed'}
            </span>
          </div>

          <dl className="space-y-2">
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">Sequence</dt>
              <dd className="font-mono tabular-nums">{integrity.sequence}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">Head</dt>
              <dd className="max-w-[60%] truncate font-mono text-xs">
                {integrity.head || '—'}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">Last write</dt>
              <dd>{new Date(state.updatedAt).toLocaleString()}</dd>
            </div>
          </dl>

          <Separator />

          <div className="flex flex-wrap gap-2">
            <Button variant="outline" asChild>
              <a href="/api/browser/export" download data-testid="link-export">
                <Download className="mr-2 h-4 w-4" />
                Export state
              </a>
            </Button>

            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline" data-testid="button-reset">
                  <RotateCcw className="mr-2 h-4 w-4" />
                  Reset to defaults
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Reset all browser state?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Workspaces, drafts, accounts, activity, usage, and your
                    approver name are cleared; UA profiles return to the
                    built-in device presets. The ledger keeps its history, so
                    the previous state remains in the export.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={() =>
                      updateState(() => ({
                        ...initialState,
                        updatedAt: new Date().toISOString(),
                      }))
                    }
                    data-testid="button-confirm-reset"
                  >
                    Reset
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Boundaries</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            This browser isolates your own workspaces. It does not evade bot
            detection, solve CAPTCHAs, rotate identities to dodge rate limits,
            or automate engagement.
          </p>
          <p>
            UA profiles are declared device configurations. They are visible to
            you in the toolbar at all times, so you always know which identity a
            tab is browsing under.
          </p>
        </CardContent>
      </Card>
    </SectionShell>
  );
}
