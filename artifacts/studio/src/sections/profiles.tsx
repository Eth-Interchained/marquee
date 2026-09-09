import { useState } from 'react';
import { Check, Fingerprint, Plus, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { SectionShell, type SectionProps } from '@/sections/section-shell';
import { createId, logActivity } from '@/lib/workspace';
import type { UAProfile } from '@/types';

const EMPTY_PROFILE: Omit<UAProfile, 'id'> = {
  name: '',
  platform: '',
  userAgent: '',
  viewport: '1440 × 900',
  locale: 'en-US',
  timezone: 'America/New_York',
  clientHints: true,
  color: '#7c5cff',
};

export function ProfilesSection({
  state,
  updateState,
  workspace,
}: SectionProps) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<Omit<UAProfile, 'id'>>(EMPTY_PROFILE);

  const usageCount = (profileId: string) =>
    state.workspaces.filter((item) => item.profileId === profileId).length;

  function openCreate() {
    setEditingId(null);
    setForm(EMPTY_PROFILE);
    setOpen(true);
  }

  function openEdit(profile: UAProfile) {
    setEditingId(profile.id);
    const { id: _id, ...rest } = profile;
    setForm(rest);
    setOpen(true);
  }

  function save() {
    if (!form.name.trim() || !form.userAgent.trim()) {
      toast({
        title: 'Name and User-Agent are required',
        variant: 'destructive',
      });
      return;
    }

    updateState((current) => {
      if (editingId) {
        return {
          ...current,
          uaProfiles: current.uaProfiles.map((profile) =>
            profile.id === editingId ? { ...profile, ...form } : profile,
          ),
          activity: logActivity(current, {
            type: 'workspace',
            title: 'UA profile updated',
            detail: form.name,
          }),
        };
      }
      return {
        ...current,
        uaProfiles: [...current.uaProfiles, { ...form, id: createId('ua') }],
        activity: logActivity(current, {
          type: 'workspace',
          title: 'UA profile created',
          detail: form.name,
        }),
      };
    });

    setOpen(false);
  }

  function removeProfile(profile: UAProfile) {
    if (usageCount(profile.id) > 0) {
      toast({
        title: 'Profile in use',
        description:
          'Reassign the workspaces using this profile before deleting it.',
        variant: 'destructive',
      });
      return;
    }
    updateState((current) => ({
      ...current,
      uaProfiles: current.uaProfiles.filter((item) => item.id !== profile.id),
    }));
  }

  function assignToWorkspace(profileId: string) {
    updateState((current) => ({
      ...current,
      workspaces: current.workspaces.map((item) =>
        item.id === workspace.id ? { ...item, profileId } : item,
      ),
      activity: logActivity(current, {
        type: 'workspace',
        title: 'UA profile assigned',
        detail: `${workspace.name} → ${
          current.uaProfiles.find((item) => item.id === profileId)?.name ?? ''
        }`,
      }),
    }));
    toast({
      title: 'Profile assigned',
      description:
        'A restart of the workspace context applies it to new navigations.',
    });
  }

  return (
    <SectionShell
      title="UA Profiles"
      description="A profile is the complete identity of a workspace: User-Agent string, Client Hints, viewport, locale, and timezone. They are declared honestly — this is device configuration, not disguise."
      actions={
        <Button onClick={openCreate} data-testid="button-add-profile">
          <Plus className="mr-2 h-4 w-4" />
          New profile
        </Button>
      }
    >
      <div className="grid gap-4 md:grid-cols-2">
        {state.uaProfiles.map((profile) => {
          const isActive = profile.id === workspace.profileId;
          return (
            <Card
              key={profile.id}
              className={cn(isActive && 'border-primary/60')}
              data-testid={`profile-${profile.id}`}
            >
              <CardHeader className="flex-row items-start justify-between gap-3 space-y-0 pb-3">
                <div className="flex min-w-0 items-center gap-2">
                  <span
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md"
                    style={{
                      backgroundColor: `${profile.color}22`,
                      color: profile.color,
                    }}
                  >
                    <Fingerprint className="h-4 w-4" />
                  </span>
                  <div className="min-w-0">
                    <CardTitle className="truncate text-base">
                      {profile.name}
                    </CardTitle>
                    <p className="truncate text-xs text-muted-foreground">
                      {profile.platform} · used by {usageCount(profile.id)}{' '}
                      workspace{usageCount(profile.id) === 1 ? '' : 's'}
                    </p>
                  </div>
                </div>
                {isActive ? (
                  <span className="flex shrink-0 items-center gap-1 rounded-full border border-primary/50 px-2 py-0.5 text-[10px] uppercase tracking-wide text-primary">
                    <Check className="h-3 w-3" />
                    Active
                  </span>
                ) : null}
              </CardHeader>

              <CardContent className="space-y-3">
                <p className="break-all rounded-md bg-muted/50 p-2 font-mono text-[10px] leading-relaxed text-muted-foreground">
                  {profile.userAgent}
                </p>

                <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                  {[
                    ['Viewport', profile.viewport],
                    ['Locale', profile.locale],
                    ['Timezone', profile.timezone],
                    ['Client Hints', profile.clientHints ? 'Aligned' : 'Off'],
                  ].map(([label, value]) => (
                    <div key={label} className="flex justify-between gap-2">
                      <dt className="text-muted-foreground">{label}</dt>
                      <dd className="truncate font-medium">{value}</dd>
                    </div>
                  ))}
                </dl>

                <Separator />

                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => openEdit(profile)}
                    data-testid={`button-edit-${profile.id}`}
                  >
                    Edit
                  </Button>
                  {!isActive ? (
                    <Button
                      size="sm"
                      onClick={() => assignToWorkspace(profile.id)}
                      data-testid={`button-assign-${profile.id}`}
                    >
                      Use in {workspace.name}
                    </Button>
                  ) : null}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="ml-auto h-8 w-8"
                    aria-label="Delete profile"
                    onClick={() => removeProfile(profile)}
                    data-testid={`button-delete-${profile.id}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {editingId ? 'Edit UA profile' : 'New UA profile'}
            </DialogTitle>
            <DialogDescription>
              The native shell applies these values to the workspace's request
              context, so declared identity and real behaviour stay consistent.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="profile-name">Name</Label>
              <Input
                id="profile-name"
                value={form.name}
                onChange={(event) =>
                  setForm({ ...form, name: event.target.value })
                }
                placeholder="Chrome · macOS"
                data-testid="input-profile-name"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="profile-platform">Platform label</Label>
              <Input
                id="profile-platform"
                value={form.platform}
                onChange={(event) =>
                  setForm({ ...form, platform: event.target.value })
                }
                placeholder="macOS 15"
                data-testid="input-profile-platform"
              />
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <Label htmlFor="profile-ua">User-Agent</Label>
              <Textarea
                id="profile-ua"
                value={form.userAgent}
                onChange={(event) =>
                  setForm({ ...form, userAgent: event.target.value })
                }
                className="min-h-[76px] font-mono text-xs"
                data-testid="input-profile-ua"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="profile-viewport">Viewport</Label>
              <Input
                id="profile-viewport"
                value={form.viewport}
                onChange={(event) =>
                  setForm({ ...form, viewport: event.target.value })
                }
                data-testid="input-profile-viewport"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="profile-locale">Locale</Label>
              <Input
                id="profile-locale"
                value={form.locale}
                onChange={(event) =>
                  setForm({ ...form, locale: event.target.value })
                }
                data-testid="input-profile-locale"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="profile-timezone">Timezone</Label>
              <Input
                id="profile-timezone"
                value={form.timezone}
                onChange={(event) =>
                  setForm({ ...form, timezone: event.target.value })
                }
                data-testid="input-profile-timezone"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="profile-color">Accent</Label>
              <Input
                id="profile-color"
                type="color"
                value={form.color}
                onChange={(event) =>
                  setForm({ ...form, color: event.target.value })
                }
                className="h-9 p-1"
                data-testid="input-profile-color"
              />
            </div>
            <div className="flex items-center justify-between gap-3 sm:col-span-2">
              <div>
                <Label htmlFor="profile-hints">Align Client Hints</Label>
                <p className="text-xs text-muted-foreground">
                  Keeps Sec-CH-UA headers consistent with the User-Agent string.
                </p>
              </div>
              <Switch
                id="profile-hints"
                checked={form.clientHints}
                onCheckedChange={(checked) =>
                  setForm({ ...form, clientHints: checked })
                }
                data-testid="switch-client-hints"
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={save} data-testid="button-save-profile">
              {editingId ? 'Save changes' : 'Create profile'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SectionShell>
  );
}
