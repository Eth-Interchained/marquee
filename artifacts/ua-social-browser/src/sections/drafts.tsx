import { useEffect, useId, useRef, useState } from 'react';
import {
  AlertTriangle,
  BadgeCheck,
  CalendarClock,
  ExternalLink,
  ImagePlus,
  Loader2,
  RotateCcw,
  Send,
  Trash2,
  X as XIcon,
} from 'lucide-react';
import { usePublishPost } from '@workspace/api-client-react';
import type { PublishRequestPlatform } from '@workspace/api-client-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';
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
import { PlatformGlyph } from '@/components/app/platform-glyph';
import { useToast } from '@/hooks/use-toast';
import { approverName, recordedApproval } from '@/lib/approver';
import { attest, describeAttestation, isRefusal, retract } from '@/lib/attestation';
import {
  MEDIA_ACCEPT_ATTRIBUTE,
  formatBytes,
  mediaFingerprint,
  mediaUrl,
  refuseAttachment,
  uploadMedia,
} from '@/lib/media';
import { draggingFiles, leftTheCard } from '@/lib/drop';
import { orderForQueue } from '@/lib/queue-order';
import { cn } from '@/lib/utils';
import { SectionShell, type SectionProps } from '@/sections/section-shell';
import { platformProfile } from '@/lib/platforms';
import {
  draftsForWorkspace,
  formatDateTime,
  fromLocalInputValue,
  logActivity,
  relativeTime,
  toLocalInputValue,
} from '@/lib/workspace';
import type { Draft, DraftMedia, DraftStatus } from '@/types';

type Filter = 'all' | 'pending' | 'approved' | 'published';

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'pending', label: 'Needs review' },
  { id: 'approved', label: 'Approved' },
  { id: 'published', label: 'Posted' },
];

const STATUS_STYLE: Record<DraftStatus, string> = {
  draft: 'border-border text-muted-foreground',
  approved: 'border-primary/50 text-primary',
  scheduled: 'border-chart-4/50 text-chart-4',
  publishing: 'border-chart-3/50 text-chart-3',
  published: 'border-chart-2/50 text-chart-2',
  failed: 'border-destructive/50 text-destructive',
  // Deliberately not the `published` green. The post is out, but on the
  // operator's word rather than the network's, and the badge should not look
  // like a confirmation.
  attested: 'border-chart-4/50 text-chart-4',
};

const STATUS_LABEL: Record<DraftStatus, string> = {
  draft: 'Needs review',
  approved: 'Approved',
  scheduled: 'Scheduled',
  publishing: 'Posting',
  published: 'Posted',
  failed: 'Failed',
  // Names the source of the claim. "Posted" on its own would be the exact
  // conflation this status exists to prevent.
  attested: 'Posted · your word',
};

function matchesFilter(draft: Draft, filter: Filter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'pending':
      return draft.status === 'draft' || draft.status === 'failed';
    case 'approved':
      return draft.status === 'approved' || draft.status === 'scheduled';
    case 'published':
      // An attested post is a post, as far as the operator is concerned — this
      // is where they will look for it. The badge on the card is what keeps the
      // network's confirmation and the operator's word distinguishable.
      return draft.status === 'published' || draft.status === 'attested';
  }
}

/** The publish endpoint returns its reason in the error body. */
function failureMessage(error: unknown): string {
  const data = (error as { data?: { message?: string; error?: string } })?.data;
  return (
    data?.message ??
    data?.error ??
    'The post could not be sent. Nothing was published.'
  );
}

/** How long a post arrived at from the calendar stays visibly marked. */
const FOCUS_HIGHLIGHT_MS = 4_000;

export function Drafts({
  state,
  updateState,
  workspace,
  onNavigate,
  focusedDraftId,
  onFocusHandled,
}: SectionProps & {
  /** A post the operator clicked elsewhere — scroll to it and mark it. */
  focusedDraftId?: string | null;
  onFocusHandled?: () => void;
}) {
  const { toast } = useToast();
  const [filter, setFilter] = useState<Filter>('all');
  const [pendingPublish, setPendingPublish] = useState<Draft | null>(null);
  const [sendingId, setSendingId] = useState<string | null>(null);
  const [uploadingId, setUploadingId] = useState<string | null>(null);
  /**
   * Which card a file is currently hovering over.
   *
   * One id rather than a boolean per card: only one thing can be dragged at a
   * time, so this cannot get out of step with itself.
   */
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  /** The failed post the operator is correcting, and the link they are giving. */
  const [attesting, setAttesting] = useState<Draft | null>(null);
  const [attestedUrl, setAttestedUrl] = useState('');
  const fileInputPrefix = useId();
  const publishPost = usePublishPost();

  // Whoever is named here is who the ledger says signed. There is no fallback
  // name: an approval recorded under a placeholder is a false statement about
  // who agreed to publish, and the record cannot be corrected afterwards.
  const operator = approverName(state.settings.operatorName);
  /**
   * The queue's own order, not the store's.
   *
   * `draftsForWorkspace` sorts by `updatedAt` for every other caller, which is
   * fine for a log and wrong for a work queue: `patchDraft` stamps `updatedAt`
   * on every change, so touching a card made it the newest thing and threw it
   * to position 0 — the "bounced to the top" the owner reported. See
   * `lib/queue-order.ts` for what replaces it and why.
   */
  const drafts = orderForQueue(
    draftsForWorkspace(state, workspace.id).filter((draft) =>
      matchesFilter(draft, filter),
    ),
  );
  const awaitingReview = drafts.some(
    (draft) => draft.status === 'draft' || draft.status === 'failed',
  );

  const cardRefs = useRef(new Map<string, HTMLDivElement>());
  const focusHandled = useRef(onFocusHandled);
  focusHandled.current = onFocusHandled;

  // A post arrived at from the calendar may be filtered out of this view, so
  // widen the filter first and scroll to it once it is actually on screen.
  useEffect(() => {
    if (focusedDraftId) setFilter('all');
  }, [focusedDraftId]);

  useEffect(() => {
    if (!focusedDraftId) return;

    cardRefs.current
      .get(focusedDraftId)
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' });

    const timer = window.setTimeout(
      () => focusHandled.current?.(),
      FOCUS_HIGHLIGHT_MS,
    );
    return () => window.clearTimeout(timer);
  }, [focusedDraftId, filter]);

  function patchDraft(id: string, patch: Partial<Draft>) {
    updateState((current) => ({
      ...current,
      drafts: current.drafts.map((draft) =>
        draft.id === id
          ? { ...draft, ...patch, updatedAt: new Date().toISOString() }
          : draft,
      ),
    }));
  }

  function approve(draft: Draft) {
    if (operator === null) {
      toast({
        title: 'Say who is approving',
        description:
          'Approvals are recorded under your name. Add it under Settings › Approver name, then approve.',
        variant: 'destructive',
      });
      return;
    }
    patchDraft(draft.id, {
      status: draft.scheduledFor ? 'scheduled' : 'approved',
      approvedBy: operator,
      approvedAt: new Date().toISOString(),
      lastError: null,
    });
    updateState((current) => ({
      ...current,
      activity: logActivity(current, {
        type: 'draft',
        title: 'Approved by a human',
        detail: `${platformProfile(draft.platform).label} · ${operator}`,
      }),
    }));
  }

  function revokeApproval(draft: Draft) {
    patchDraft(draft.id, {
      status: 'draft',
      approvedBy: null,
      approvedAt: null,
      scheduledFor: null,
    });
  }

  /**
   * Records the operator's own account of a post the network never confirmed.
   *
   * The rules live in `lib/attestation.ts`; this only carries the answer into
   * state and says plainly when the module refuses.
   */
  function confirmAttestation(draft: Draft) {
    const result = attest({
      draft,
      by: operator,
      at: new Date().toISOString(),
      postUrl: attestedUrl,
    });

    if (isRefusal(result)) {
      toast({
        title: 'Not recorded',
        description: result.refused,
        variant: 'destructive',
      });
      return;
    }

    patchDraft(draft.id, result);
    updateState((current) => ({
      ...current,
      activity: logActivity(current, {
        type: 'draft',
        title: 'Corrected by a human',
        detail: `${platformProfile(draft.platform).label} · ${operator} confirmed it posted`,
      }),
    }));
    setAttesting(null);
    setAttestedUrl('');
  }

  /** Puts the record back to what the machine observed. */
  function retractAttestation(draft: Draft) {
    const result = retract(draft);
    if (isRefusal(result)) {
      toast({ title: 'Nothing to take back', description: result.refused });
      return;
    }
    patchDraft(draft.id, result);
    updateState((current) => ({
      ...current,
      activity: logActivity(current, {
        type: 'draft',
        title: 'Correction withdrawn',
        detail: `${platformProfile(draft.platform).label} · back to what the shell saw`,
      }),
    }));
  }

  /**
   * Attaching or removing a picture is editing the post.
   *
   * The sign-off is on the exact content, and content includes what is being
   * shown — the API server checks the attachments against the approval before
   * it sends, so a change here that kept its approval would simply be refused
   * later, with the operator wondering why.
   */
  function setMedia(draft: Draft, media: DraftMedia[]) {
    const changed = mediaFingerprint(draft.media) !== mediaFingerprint(media);
    const approved = Boolean(draft.approvedAt);
    patchDraft(draft.id, {
      media,
      ...(changed && approved && draft.status !== 'published'
        ? { status: 'draft' as const, approvedBy: null, approvedAt: null }
        : {}),
    });
  }

  async function attachFiles(draft: Draft, files: FileList | null) {
    if (!files || files.length === 0) return;

    setUploadingId(draft.id);
    // Read from the draft as it was, then apply once: each upload awaits, and
    // reading `draft.media` again between them would drop everything attached
    // since this handler started.
    const attached: DraftMedia[] = [...draft.media];

    try {
      for (const file of Array.from(files)) {
        const refusal = refuseAttachment({
          platform: draft.platform,
          existing: attached,
          file,
        });
        if (refusal) {
          toast({
            title: 'Not attached',
            description: refusal.reason,
            variant: 'destructive',
          });
          continue;
        }

        try {
          attached.push(await uploadMedia(file));
        } catch (error) {
          toast({
            title: 'Not attached',
            description:
              error instanceof Error ? error.message : `${file.name} could not be stored.`,
            variant: 'destructive',
          });
        }
      }

      if (mediaFingerprint(attached) !== mediaFingerprint(draft.media)) {
        setMedia(draft, attached);
      }
    } finally {
      setUploadingId(null);
    }
  }

  function onDragOver(draft: Draft, event: React.DragEvent) {
    if (!draggingFiles(event.dataTransfer.types)) return;
    // Without this the drop never fires: the default action for a dragged file
    // is to navigate to it, and preventing it here is what marks the element
    // as a valid target.
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    if (dropTargetId !== draft.id) setDropTargetId(draft.id);
  }

  function onDragLeave(draft: Draft, event: React.DragEvent) {
    if (!leftTheCard(event.currentTarget, event.relatedTarget as Node | null)) return;
    if (dropTargetId === draft.id) setDropTargetId(null);
  }

  function onDrop(draft: Draft, event: React.DragEvent) {
    event.preventDefault();
    setDropTargetId(null);
    void attachFiles(draft, event.dataTransfer.files);
  }

  function removeDraft(draft: Draft) {
    updateState((current) => ({
      ...current,
      drafts: current.drafts.filter((item) => item.id !== draft.id),
      activity: logActivity(current, {
        type: 'draft',
        title: 'Draft discarded',
        detail: `${platformProfile(draft.platform).label} · ${workspace.name}`,
      }),
    }));
    toast({ title: 'Draft discarded' });
  }

  function schedule(draft: Draft, value: string) {
    const scheduledFor = fromLocalInputValue(value);
    if (!scheduledFor) return;
    patchDraft(draft.id, {
      scheduledFor,
      status: draft.approvedAt ? 'scheduled' : draft.status,
    });
  }

  /**
   * Most posts go out the moment the operator presses Post, so that is the
   * default and a time is the exception. Turning the clock off clears the time
   * rather than remembering it: a stored time nobody can see is the kind of
   * thing that sends a post at 3am a week later.
   */
  function setImmediate(draft: Draft, immediate: boolean) {
    if (immediate) {
      patchDraft(draft.id, {
        scheduledFor: null,
        status: draft.status === 'scheduled' ? 'approved' : draft.status,
      });
      return;
    }

    // The same value the picker shows when it is empty, so the operator sees
    // exactly the time they are agreeing to.
    const suggested = fromLocalInputValue(toLocalInputValue(null));
    patchDraft(draft.id, {
      scheduledFor: suggested,
      status: draft.approvedAt && suggested ? 'scheduled' : draft.status,
    });
  }

  function requestPublish(draft: Draft) {
    // The composer refuses this too, but finding out after a window has opened
    // and a network has been driven is a slow way to learn something the app
    // already knew.
    if (platformProfile(draft.platform).requiresMedia && draft.media.length === 0) {
      toast({
        title: 'Needs a picture',
        description: `${platformProfile(draft.platform).label} does not take a post without an image or video. Attach one and approve it again.`,
        variant: 'destructive',
      });
      return;
    }
    if (recordedApproval(draft) === null) {
      toast({
        title: 'Approval required',
        description: 'A person has to sign off before anything reaches the network.',
        variant: 'destructive',
      });
      return;
    }
    if (state.settings.confirmBeforePublish) {
      setPendingPublish(draft);
      return;
    }
    void send(draft);
  }

  async function send(draft: Draft) {
    setPendingPublish(null);
    // The approval sent is the one a person recorded, verbatim. If half of it
    // is missing the draft was never properly approved, and inventing the
    // other half here would be the app signing on someone's behalf.
    const approval = recordedApproval(draft);
    if (approval === null) {
      toast({
        title: 'Approval required',
        description: 'A person has to sign off before anything reaches the network.',
        variant: 'destructive',
      });
      return;
    }
    setSendingId(draft.id);
    patchDraft(draft.id, { status: 'publishing', lastError: null });

    try {
      const result = await publishPost.mutateAsync({
        data: {
          workspaceId: workspace.id,
          draftId: draft.id,
          platform: draft.platform as PublishRequestPlatform,
          body: draft.body,
          // Sent as recorded. The server compares this against the approved
          // draft and refuses a mismatch, the same way it does for the text.
          media: draft.media,
          approval,
          // No idempotency key: the server derives it from the stored draft and
          // its approval, and refuses a different one. Sending our own could
          // only ever disagree with the record and be refused.
        },
      });

      patchDraft(draft.id, {
        status: 'published',
        postUrl: result.postUrl ?? null,
        lastError: null,
      });
      updateState((current) => ({
        ...current,
        activity: logActivity(current, {
          type: 'publish',
          title: 'Posted through your session',
          detail: `${platformProfile(draft.platform).label} · ${workspace.name}`,
        }),
      }));
      toast({
        title: `Posted to ${platformProfile(draft.platform).label}`,
        description: result.message ?? 'Sent from your own signed-in session.',
      });
    } catch (error) {
      const message = failureMessage(error);
      patchDraft(draft.id, { status: 'failed', lastError: message });
      updateState((current) => ({
        ...current,
        activity: logActivity(current, {
          type: 'publish',
          title: 'Publish attempt failed',
          detail: message,
        }),
      }));
      toast({
        title: 'Not posted',
        description: message,
        variant: 'destructive',
      });
    } finally {
      setSendingId(null);
    }
  }

  return (
    <SectionShell
      title="Review queue"
      description="The model drafts, you approve, and the post leaves from your own signed-in session on the network — when you press Post, or at the time you set. Nothing here reaches an audience without an approval attached to it."
      actions={
        <div className="flex items-center gap-1 rounded-md border border-border p-1">
          {FILTERS.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => setFilter(option.id)}
              className={cn(
                'rounded px-2.5 py-1 text-xs transition-colors hover-elevate',
                filter === option.id
                  ? 'bg-accent font-medium text-accent-foreground'
                  : 'text-muted-foreground',
              )}
              data-testid={`filter-${option.id}`}
            >
              {option.label}
            </button>
          ))}
        </div>
      }
    >
      {operator === null && awaitingReview ? (
        <Card
          className="border-chart-4/50 bg-chart-4/10"
          data-testid="notice-approver-missing"
        >
          <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4 text-sm">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-chart-4" />
              <span>
                Nothing can be approved until the app knows who is approving.
                Every sign-off is recorded under that name and sent with the
                post.
              </span>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => onNavigate('settings')}
              data-testid="button-set-approver"
            >
              Set your approver name
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {drafts.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="p-10 text-center text-sm text-muted-foreground">
            {filter === 'all'
              ? 'No posts in this workspace yet. Draft one in the AI Composer, or write your own on the Network page, and it lands here for review.'
              : 'Nothing in this view yet.'}
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          {drafts.map((draft) => {
            const network = platformProfile(draft.platform);
            const overLimit = draft.body.length > network.charLimit;
            const locked =
              draft.status === 'published' || draft.status === 'publishing';
            const isSending = sendingId === draft.id;
            const approved = Boolean(draft.approvedAt);
            const needsMedia = network.requiresMedia && draft.media.length === 0;
            const isDropTarget = dropTargetId === draft.id;
            // No time set is not an unfinished schedule — it is the normal
            // case: it goes out when a person presses Post.
            const immediate = draft.scheduledFor === null;

            return (
              <Card
                key={draft.id}
                ref={(node) => {
                  if (node) cardRefs.current.set(draft.id, node);
                  else cardRefs.current.delete(draft.id);
                }}
                className={cn(
                  'relative transition-colors',
                  focusedDraftId === draft.id &&
                    'ring-2 ring-primary ring-offset-2 ring-offset-background',
                  isDropTarget && 'ring-2 ring-primary border-primary',
                )}
                // The whole card is the target, not a small strip inside it —
                // a drop zone you have to aim for is worse than a button.
                {...(locked
                  ? {}
                  : {
                      onDragOver: (event: React.DragEvent) => onDragOver(draft, event),
                      onDragLeave: (event: React.DragEvent) => onDragLeave(draft, event),
                      onDrop: (event: React.DragEvent) => onDrop(draft, event),
                    })}
                data-testid={`draft-${draft.id}`}
              >
                {isDropTarget ? (
                  <div
                    className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-md bg-background/85"
                    data-testid={`dropzone-${draft.id}`}
                  >
                    <span className="flex items-center gap-2 text-sm font-medium text-primary">
                      <ImagePlus className="h-4 w-4" />
                      Drop to attach to this post
                    </span>
                  </div>
                ) : null}
                <CardContent className="space-y-3 p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <PlatformGlyph platform={draft.platform} tinted />
                    <span className="text-sm font-medium">{network.label}</span>
                    <span
                      className={cn(
                        'rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide',
                        STATUS_STYLE[draft.status],
                      )}
                    >
                      {STATUS_LABEL[draft.status]}
                    </span>
                    {approved ? (
                      <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                        <BadgeCheck className="h-3.5 w-3.5 text-chart-2" />
                        {draft.approvedBy} · {relativeTime(draft.approvedAt!)}
                      </span>
                    ) : null}
                    <span className="ml-auto text-xs text-muted-foreground">
                      Updated {relativeTime(draft.updatedAt)}
                    </span>
                  </div>

                  <Textarea
                    value={draft.body}
                    readOnly={locked}
                    onChange={(event) =>
                      patchDraft(draft.id, {
                        body: event.target.value,
                        // Editing after approval invalidates the sign-off.
                        ...(approved && draft.status !== 'published'
                          ? {
                              status: 'draft' as const,
                              approvedBy: null,
                              approvedAt: null,
                            }
                          : {}),
                      })
                    }
                    className="min-h-[110px] resize-y"
                    data-testid={`input-body-${draft.id}`}
                  />

                  <div className="space-y-2">
                    {draft.media.length > 0 ? (
                      <div className="flex flex-wrap gap-3">
                        {draft.media.map((item) => (
                          <div
                            key={item.id}
                            className="w-44 space-y-1.5 rounded-md border border-border p-2"
                            data-testid={`media-${draft.id}-${item.sha256.slice(0, 8)}`}
                          >
                            <div className="relative">
                              {item.mimeType.startsWith('video/') ? (
                                <video
                                  src={mediaUrl(item)}
                                  className="h-24 w-full rounded object-cover"
                                  muted
                                />
                              ) : (
                                <img
                                  src={mediaUrl(item)}
                                  alt={item.altText || item.filename}
                                  className="h-24 w-full rounded object-cover"
                                />
                              )}
                              {!locked ? (
                                <button
                                  type="button"
                                  onClick={() =>
                                    setMedia(
                                      draft,
                                      draft.media.filter((other) => other.id !== item.id),
                                    )
                                  }
                                  className="absolute right-1 top-1 rounded-full bg-background/90 p-1 hover-elevate"
                                  aria-label={`Remove ${item.filename}`}
                                  data-testid={`button-remove-media-${draft.id}-${item.sha256.slice(0, 8)}`}
                                >
                                  <XIcon className="h-3 w-3" />
                                </button>
                              ) : null}
                            </div>
                            <p className="truncate text-[11px] text-muted-foreground" title={item.filename}>
                              {item.filename} · {formatBytes(item.bytes)}
                            </p>
                            {network.supportsAltText ? (
                              <Input
                                value={item.altText ?? ''}
                                readOnly={locked}
                                placeholder="Describe it"
                                onChange={(event) =>
                                  setMedia(
                                    draft,
                                    draft.media.map((other) =>
                                      other.id === item.id
                                        ? { ...other, altText: event.target.value }
                                        : other,
                                    ),
                                  )
                                }
                                className="h-7 text-xs"
                                aria-label={`Alt text for ${item.filename}`}
                                data-testid={`input-alt-${draft.id}-${item.sha256.slice(0, 8)}`}
                              />
                            ) : null}
                          </div>
                        ))}
                      </div>
                    ) : null}

                    {!locked ? (
                      <div className="flex items-center gap-2">
                        <input
                          id={`${fileInputPrefix}-${draft.id}`}
                          type="file"
                          multiple
                          accept={MEDIA_ACCEPT_ATTRIBUTE}
                          className="hidden"
                          onChange={(event) => {
                            void attachFiles(draft, event.target.files);
                            // Cleared so re-picking the same file still fires.
                            event.target.value = '';
                          }}
                          data-testid={`input-media-${draft.id}`}
                        />
                        <Button
                          variant="outline"
                          size="sm"
                          asChild
                          disabled={uploadingId === draft.id}
                        >
                          <label
                            htmlFor={`${fileInputPrefix}-${draft.id}`}
                            className="cursor-pointer"
                            data-testid={`button-attach-${draft.id}`}
                          >
                            {uploadingId === draft.id ? (
                              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <ImagePlus className="mr-2 h-3.5 w-3.5" />
                            )}
                            {uploadingId === draft.id ? 'Storing' : 'Attach'}
                          </label>
                        </Button>
                        <span className="text-xs text-muted-foreground">
                          {draft.media.length}/{network.mediaLimit}
                          {network.requiresMedia && draft.media.length === 0
                            ? ` · ${network.label} needs one`
                            : ''}
                          {approved && draft.media.length > 0
                            ? ' · changing these clears the approval'
                            : ''}
                        </span>
                      </div>
                    ) : null}
                  </div>

                  {draft.status === 'failed' && draft.lastError ? (
                    <div
                      className="space-y-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
                      data-testid={`error-${draft.id}`}
                    >
                      <div className="flex items-start gap-2">
                        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                        <span>{draft.lastError}</span>
                      </div>
                      {/*
                        The operator can see the account; this app cannot. When
                        they have looked and the post is there, the record needs
                        a way to say so — see `lib/attestation.ts` for why that
                        is `attested` and never `published`.
                      */}
                      <button
                        type="button"
                        onClick={() => setAttesting(draft)}
                        className="text-xs underline underline-offset-2"
                        data-testid={`button-attest-${draft.id}`}
                      >
                        Checked the account — it actually posted
                      </button>
                    </div>
                  ) : null}

                  {draft.status === 'attested' && draft.attestation ? (
                    <div
                      className="space-y-2 rounded-md border border-chart-4/40 bg-chart-4/10 p-3 text-sm text-chart-4"
                      data-testid={`attested-${draft.id}`}
                    >
                      <div className="flex items-start gap-2">
                        <BadgeCheck className="mt-0.5 h-4 w-4 shrink-0" />
                        <span>{describeAttestation(draft)}</span>
                      </div>
                      {draft.lastError ? (
                        <p className="text-xs opacity-80">
                          What the shell saw at the time: {draft.lastError}
                        </p>
                      ) : null}
                      <div className="flex flex-wrap items-center gap-3">
                        {draft.attestation.postUrl ? (
                          <a
                            href={draft.attestation.postUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-1.5 text-xs underline underline-offset-2"
                            data-testid={`link-attested-${draft.id}`}
                          >
                            <ExternalLink className="h-3.5 w-3.5" />
                            The link you gave
                          </a>
                        ) : null}
                        <button
                          type="button"
                          onClick={() => retractAttestation(draft)}
                          className="text-xs underline underline-offset-2"
                          data-testid={`button-retract-${draft.id}`}
                        >
                          Take that back
                        </button>
                      </div>
                    </div>
                  ) : null}

                  {draft.status === 'published' && draft.postUrl ? (
                    <a
                      href={draft.postUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-2 text-sm text-chart-2 underline underline-offset-2"
                      data-testid={`link-post-${draft.id}`}
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                      View it on {network.label}
                    </a>
                  ) : null}

                  <div className="flex flex-wrap items-end justify-between gap-3">
                    <div className="flex flex-wrap items-end gap-3">
                      <div className="space-y-2">
                        <div className="flex items-center gap-2">
                          <Checkbox
                            id={`immediate-${draft.id}`}
                            checked={immediate}
                            disabled={locked}
                            onCheckedChange={(checked) =>
                              setImmediate(draft, checked === true)
                            }
                            data-testid={`checkbox-immediate-${draft.id}`}
                          />
                          <Label
                            htmlFor={`immediate-${draft.id}`}
                            className="text-xs font-normal"
                          >
                            Post immediately
                          </Label>
                        </div>

                        {!immediate ? (
                          <div className="space-y-1">
                            <Label
                              htmlFor={`schedule-${draft.id}`}
                              className="text-xs text-muted-foreground"
                            >
                              Send at
                            </Label>
                            <Input
                              id={`schedule-${draft.id}`}
                              type="datetime-local"
                              disabled={locked}
                              value={toLocalInputValue(draft.scheduledFor)}
                              onChange={(event) =>
                                schedule(draft, event.target.value)
                              }
                              className="h-9 w-[210px]"
                              data-testid={`input-schedule-${draft.id}`}
                            />
                          </div>
                        ) : null}
                      </div>
                      <span
                        className={cn(
                          'pb-2 text-xs tabular-nums',
                          overLimit
                            ? 'font-medium text-destructive'
                            : 'text-muted-foreground',
                        )}
                      >
                        {draft.body.length} / {network.charLimit}
                      </span>
                    </div>

                    <div className="flex items-center gap-2">
                      {!locked ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => removeDraft(draft)}
                          data-testid={`button-delete-${draft.id}`}
                        >
                          <Trash2 className="mr-2 h-3.5 w-3.5" />
                          Discard
                        </Button>
                      ) : null}

                      {!approved && draft.status !== 'published' ? (
                        <Button
                          size="sm"
                          disabled={overLimit || locked || operator === null}
                          title={
                            operator === null
                              ? 'Set your approver name in Settings first'
                              : undefined
                          }
                          onClick={() => approve(draft)}
                          data-testid={`button-approve-${draft.id}`}
                        >
                          <BadgeCheck className="mr-2 h-3.5 w-3.5" />
                          Approve
                        </Button>
                      ) : null}

                      {approved && draft.status !== 'published' ? (
                        <>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => revokeApproval(draft)}
                            disabled={isSending}
                            data-testid={`button-revoke-${draft.id}`}
                          >
                            <RotateCcw className="mr-2 h-3.5 w-3.5" />
                            Revoke
                          </Button>
                          <Button
                            size="sm"
                            disabled={overLimit || isSending || needsMedia}
                            title={
                              needsMedia
                                ? `${network.label} needs an image or video`
                                : undefined
                            }
                            onClick={() => requestPublish(draft)}
                            data-testid={`button-publish-${draft.id}`}
                          >
                            {isSending ? (
                              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Send className="mr-2 h-3.5 w-3.5" />
                            )}
                            {isSending ? 'Posting' : `Post to ${network.label}`}
                          </Button>
                        </>
                      ) : null}
                    </div>
                  </div>

                  {immediate && approved && draft.status !== 'published' ? (
                    <>
                      <Separator />
                      <p className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Send className="h-3.5 w-3.5" />
                        No time set: this goes out when you press Post to{' '}
                        {network.label}, and not before. Tick the box off to
                        give it a time instead.
                      </p>
                    </>
                  ) : null}

                  {draft.status === 'scheduled' && draft.scheduledFor ? (
                    <>
                      <Separator />
                      <p className="flex items-center gap-2 text-xs text-muted-foreground">
                        <CalendarClock className="h-3.5 w-3.5" />
                        Goes out on its own at{' '}
                        {formatDateTime(draft.scheduledFor)}, through this
                        workspace's session and under this approval. Edit the
                        text and the approval drops, so it stays put. One
                        attempt per time you set: if it fails, the reason lands
                        here rather than a silent retry — set a new time to try
                        again.
                      </p>
                    </>
                  ) : null}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/*
        Correcting the record. The dialog exists rather than a bare button
        because this is a claim recorded under someone's name, and it should
        take a deliberate act — and because the link is worth asking for while
        the operator is already looking at the post.
      */}
      <AlertDialog
        open={attesting !== null}
        onOpenChange={(open) => {
          if (!open) {
            setAttesting(null);
            setAttestedUrl('');
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>This one actually posted?</AlertDialogTitle>
            <AlertDialogDescription>
              {operator === null
                ? 'Corrections are recorded under your name. Add it under Settings › Approver name first.'
                : `The network never confirmed this, so the shell recorded it as failed. Recording it as posted on your word keeps both facts: what the shell saw, and what ${operator} found on the account. It will never read as confirmed by the network.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2">
            <Label htmlFor="attested-url">Link to the post (optional)</Label>
            <Input
              id="attested-url"
              value={attestedUrl}
              onChange={(event) => setAttestedUrl(event.target.value)}
              placeholder="https://…"
              data-testid="input-attested-url"
            />
            <p className="text-xs text-muted-foreground">
              Not required — your word stands either way. It is the difference
              between a claim and one anyone can check.
            </p>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-attest">
              Never mind
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={operator === null}
              onClick={() => attesting && confirmAttestation(attesting)}
              data-testid="button-confirm-attest"
            >
              Record that it posted
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={pendingPublish !== null}
        onOpenChange={(open) => {
          if (!open) setPendingPublish(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Post to{' '}
              {pendingPublish
                ? platformProfile(pendingPublish.platform).label
                : ''}
              ?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This sends the post through your signed-in session in this
              workspace, under {pendingPublish?.approvedBy}'s approval. It
              becomes public immediately.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-publish">
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => pendingPublish && void send(pendingPublish)}
              data-testid="button-confirm-publish"
            >
              Post it
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SectionShell>
  );
}
