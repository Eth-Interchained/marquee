import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  Copy,
  Infinity as InfinityIcon,
  Loader2,
  Sparkles,
  Trash2,
  Wand2,
} from 'lucide-react';
import {
  useCreateAiSuggestion,
  useListAiModels,
  type AiSuggestion,
  type AiSuggestionInputPlatform,
  type AiSuggestionInputTask,
} from '@workspace/api-client-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import {
  appendCandidates,
  pruneReviewed,
  replaceCandidates,
  withoutCandidate,
  type Candidate,
} from '@/lib/candidates';
import { cn } from '@/lib/utils';
import { SectionShell, type SectionProps } from '@/sections/section-shell';
import {
  PLATFORMS,
  PLATFORM_LABEL,
  PLATFORM_LIMIT,
  createId,
  logActivity,
} from '@/lib/workspace';
import type { Platform } from '@/types';

/**
 * Reveal timing. These must match `.ua-revealing` in `index.css`.
 *
 * The stagger is what makes a batch read as being written rather than
 * appearing: eight cards landing at once is a jolt. The sweep is the longer of
 * the two CSS animations, so it decides when the run is over.
 */
/**
 * A card's silhouette while the model writes it.
 *
 * Sized to a real option — label row, three lines of body, a rationale line,
 * a button row — because the point is that nothing moves when the text
 * arrives. A spinner in the middle of an empty panel would tell the operator
 * less and cost them a layout jump.
 */
function GhostSuggestion() {
  return (
    <Card className="ua-ghost" aria-hidden="true">
      <CardContent className="space-y-3 p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="ua-ghost-bar h-3 w-20" />
          <div className="ua-ghost-bar h-3 w-12" />
        </div>
        <div className="space-y-2">
          <div className="ua-ghost-bar h-3.5 w-full" />
          <div className="ua-ghost-bar h-3.5 w-[92%]" />
          <div className="ua-ghost-bar h-3.5 w-[64%]" />
        </div>
        <div className="ua-ghost-bar h-3 w-2/5" />
        <div className="flex gap-2 pt-1">
          <div className="ua-ghost-bar h-8 w-28" />
          <div className="ua-ghost-bar h-8 w-20" />
        </div>
      </CardContent>
    </Card>
  );
}

const REVEAL_STAGGER_MS = 70;
const REVEAL_SWEEP_MS = 620;

const TASKS: Array<{ id: AiSuggestionInputTask; label: string; hint: string }> = [
  { id: 'suggest', label: 'Suggest', hint: 'Draft new options from your notes' },
  { id: 'rewrite', label: 'Rewrite', hint: 'Keep the point, change the delivery' },
  { id: 'shorten', label: 'Shorten', hint: 'Tighten without losing meaning' },
  { id: 'expand', label: 'Expand', hint: 'Add depth and supporting detail' },
  { id: 'variants', label: 'Variants', hint: 'Same idea, different angles' },
  { id: 'hashtags', label: 'Hashtags', hint: 'Discovery tags worth using' },
];

const TONES = [
  'Direct and plainspoken',
  'Warm and conversational',
  'Analytical',
  'Optimistic',
  'Contrarian',
  'Technical',
];

export function Composer({ state, updateState, workspace }: SectionProps) {
  const { toast } = useToast();

  const [platform, setPlatform] = useState<Platform>(workspace.platform);
  const [task, setTask] = useState<AiSuggestionInputTask>('suggest');
  const [tone, setTone] = useState(TONES[0]);
  const [audience, setAudience] = useState(
    'Founders and product leaders evaluating AI tooling',
  );
  const [sourceText, setSourceText] = useState('');
  const [model, setModel] = useState(state.settings.model);
  const [count, setCount] = useState(3);
  const [includeHashtags, setIncludeHashtags] = useState(false);
  // A working pool, not the result of one request: generating more adds to it
  // and judging a card removes that card. Keyed by id throughout — see
  // `lib/candidates.ts` for why an index key is unsafe here.
  const [suggestions, setSuggestions] = useState<Array<Candidate<AiSuggestion>>>([]);
  /**
   * Which end of the pool the pending batch will land on.
   *
   * The ghosts stand where the real cards will appear — below the existing
   * options for "keep going", in their place for a fresh generation — so the
   * list does not reshuffle when the text arrives.
   */
  const [pendingMode, setPendingMode] = useState<'replace' | 'more' | null>(null);
  /**
   * id -> position in the arriving batch, driving the reveal stagger.
   *
   * Keyed by id rather than index for the same reason the review flags are:
   * a card removed mid-reveal must not hand its animation to a neighbour.
   */
  const [revealing, setRevealing] = useState<Record<string, number>>({});
  const [reviewed, setReviewed] = useState<Record<string, boolean>>({});
  const [dissolving, setDissolving] = useState<Record<string, true>>({});
  const nextOrdinal = useRef(1);
  /** Pending dissolve timers, so leaving the page mid-animation is harmless. */
  const dissolveTimers = useRef<number[]>([]);
  const revealTimers = useRef<number[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const modelsQuery = useListAiModels();
  const suggest = useCreateAiSuggestion();

  useEffect(
    () => () => {
      for (const timer of dissolveTimers.current) window.clearTimeout(timer);
      dissolveTimers.current = [];
      for (const timer of revealTimers.current) window.clearTimeout(timer);
      revealTimers.current = [];
    },
    [],
  );

  const modelOptions = useMemo(() => {
    const fetched = modelsQuery.data?.models ?? [];
    const hasConfigured = fetched.some(
      (option) => option.id === state.settings.model,
    );
    return hasConfigured
      ? fetched
      : [{ id: state.settings.model, name: state.settings.model }, ...fetched];
  }, [modelsQuery.data, state.settings.model]);

  const limit = PLATFORM_LIMIT[platform];
  const canSubmit = sourceText.trim().length >= 3 && !suggest.isPending;

  /**
   * `mode` is the difference between starting over and keeping the loop going.
   * "More" appends, so options accumulate while you work through them; the
   * plain generate replaces, for when the brief itself has changed.
   */
  function handleGenerate(mode: 'replace' | 'more' = 'replace') {
    if (!canSubmit) return;
    setErrorMessage(null);
    setPendingMode(mode);

    suggest.mutate(
      {
        data: {
          platform: platform as AiSuggestionInputPlatform,
          task,
          tone,
          audience,
          sourceText: sourceText.trim(),
          model,
          numberOfSuggestions: count,
          maxCharacters: limit,
          includeHashtags,
        },
      },
      {
        onSuccess: (result) => {
          let duplicates = 0;
          let arrived: string[] = [];
          setSuggestions((current) => {
            const outcome =
              mode === 'more'
                ? appendCandidates({
                    existing: current,
                    incoming: result.suggestions,
                    startOrdinal: nextOrdinal.current,
                    makeId: () => createId('sug'),
                  })
                : replaceCandidates({
                    incoming: result.suggestions,
                    makeId: () => createId('sug'),
                  });
            nextOrdinal.current = outcome.nextOrdinal;
            duplicates = outcome.duplicates;
            // Only what is actually new gets the reveal. On "keep going" the
            // options already on screen must not re-animate — the operator may
            // be reading one of them.
            const before = new Set(current.map((candidate) => candidate.id));
            arrived = outcome.candidates
              .filter((candidate) => !before.has(candidate.id))
              .map((candidate) => candidate.id);
            return outcome.candidates;
          });

          setPendingMode(null);
          if (arrived.length > 0) {
            setRevealing(
              Object.fromEntries(arrived.map((id, index) => [id, index])),
            );
            // Cleared once the last card has landed, so the class does not sit
            // on the cards holding them at opacity 0 if anything re-renders.
            const runFor =
              REVEAL_STAGGER_MS * (arrived.length - 1) + REVEAL_SWEEP_MS + 80;
            const timer = window.setTimeout(() => {
              setRevealing({});
              revealTimers.current = revealTimers.current.filter(
                (candidate) => candidate !== timer,
              );
            }, runFor);
            revealTimers.current.push(timer);
          }

          if (mode === 'replace') setReviewed({});
          if (duplicates > 0) {
            toast({
              title:
                duplicates === 1
                  ? 'One option repeated what you already had'
                  : `${duplicates} options repeated what you already had`,
              description:
                'They were dropped rather than listed. Change the tone or the notes to push it somewhere new.',
            });
          }
          updateState((current) => ({
            ...current,
            usage: {
              inputTokens: current.usage.inputTokens + result.usage.inputTokens,
              outputTokens:
                current.usage.outputTokens + result.usage.outputTokens,
              requests: current.usage.requests + 1,
            },
            activity: logActivity(current, {
              type: 'ai',
              title: `AI ${task} generated`,
              detail: `${result.suggestions.length} ${PLATFORM_LABEL[platform]} options for ${workspace.name} · ${result.model}`,
            }),
          }));
        },
        onError: () => {
          setPendingMode(null);
          setErrorMessage(
            'AiAssist could not generate suggestions. The request failed upstream — nothing was saved.',
          );
        },
      },
    );
  }

  /** How long the holo sweep runs. Matches `.ua-dissolving` in index.css. */
  const DISSOLVE_MS = 420;

  /**
   * Takes a card out of the pool, visibly.
   *
   * The card is marked first and removed when the animation is done. Dropping
   * it from state on click would unmount the element immediately and nothing
   * would play — the removal is the behaviour, the sweep is how the operator
   * sees that their judgement landed.
   */
  function dissolve(id: string) {
    setDissolving((current) => ({ ...current, [id]: true }));
    const timer = window.setTimeout(() => {
      setSuggestions((current) => {
        const next = withoutCandidate(current, id);
        // Prune in the same tick the card leaves, so a sign-off never outlives
        // the text it was given for.
        setReviewed((flags) => pruneReviewed(flags, next));
        return next;
      });
      setDissolving((current) => {
        const { [id]: _gone, ...rest } = current;
        return rest;
      });
      dissolveTimers.current = dissolveTimers.current.filter(
        (pending) => pending !== timer,
      );
    }, DISSOLVE_MS);
    dissolveTimers.current.push(timer);
  }

  function saveAsDraft(candidate: Candidate<AiSuggestion>) {
    if (!reviewed[candidate.id]) {
      toast({
        title: 'Review required',
        description:
          'Confirm you have read the suggestion before it becomes a draft.',
        variant: 'destructive',
      });
      return;
    }

    updateState((current) => ({
      ...current,
      drafts: [
        {
          id: createId('draft'),
          workspaceId: workspace.id,
          platform,
          body: candidate.text,
          media: [],
          status: 'draft',
          /**
           * Scheduled by default, not immediate.
           *
           * A post that goes out the instant it is approved leaves no gap to
           * change your mind in, and the operator asked for the safer default.
           * `toLocalInputValue(null)` is the same hour-from-now the picker
           * suggests when empty, so the time on the card is exactly the time
           * shown — nothing is stored that cannot be seen.
           */
          scheduledFor: fromLocalInputValue(toLocalInputValue(null)),
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
        title: 'Draft saved after human review',
        detail: `${PLATFORM_LABEL[platform]} · ${workspace.name}`,
      }),
    }));

    // It lives in the review queue now, so it leaves the pool. Nothing is lost:
    // the queue and the calendar are where a draft is worked on from here.
    dissolve(candidate.id);

    toast({
      title: 'Saved to drafts',
      description: 'You can edit, schedule, or discard it from the review queue.',
    });
  }

  /** Discarding a candidate writes nothing — it was never a draft. */
  function discard(candidate: Candidate<AiSuggestion>) {
    dissolve(candidate.id);
  }

  async function copyText(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast({ title: 'Copied to clipboard' });
    } catch {
      toast({
        title: 'Clipboard unavailable',
        description: 'Select the text manually to copy it.',
        variant: 'destructive',
      });
    }
  }

  return (
    <SectionShell
      title="AI Composer"
      description="The model proposes. You decide. Every suggestion needs an explicit review before it can become a draft — nothing is queued or published automatically."
    >
      <div className="grid gap-4 lg:grid-cols-[380px_1fr]">
        <Card className="h-fit">
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Brief</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="composer-platform">Platform</Label>
              <Select
                value={platform}
                onValueChange={(value) => setPlatform(value as Platform)}
              >
                <SelectTrigger id="composer-platform" data-testid="select-platform">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PLATFORMS.map((option) => (
                    <SelectItem key={option} value={option}>
                      {PLATFORM_LABEL[option]} · {PLATFORM_LIMIT[option]} chars
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label>Task</Label>
              <div className="grid grid-cols-3 gap-1.5">
                {TASKS.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    title={option.hint}
                    onClick={() => setTask(option.id)}
                    className={cn(
                      'rounded-md border px-2 py-1.5 text-xs transition-colors hover-elevate',
                      task === option.id
                        ? 'border-primary bg-primary/10 font-medium text-foreground'
                        : 'border-border text-muted-foreground',
                    )}
                    data-testid={`task-${option.id}`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                {TASKS.find((option) => option.id === task)?.hint}
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="composer-tone">Tone</Label>
              <Select value={tone} onValueChange={setTone}>
                <SelectTrigger id="composer-tone" data-testid="select-tone">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TONES.map((option) => (
                    <SelectItem key={option} value={option}>
                      {option}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="composer-audience">Audience</Label>
              <Input
                id="composer-audience"
                value={audience}
                maxLength={200}
                onChange={(event) => setAudience(event.target.value)}
                data-testid="input-audience"
              />
            </div>

            <Separator />

            <div className="space-y-1.5">
              <Label htmlFor="composer-model">Model</Label>
              <Select value={model} onValueChange={setModel}>
                <SelectTrigger id="composer-model" data-testid="select-model">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {modelOptions.map((option) => (
                    <SelectItem key={option.id} value={option.id}>
                      {option.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {modelsQuery.isError
                  ? 'Model list unavailable — using the configured default.'
                  : `Routed server-side through provider "${state.settings.provider}".`}
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="composer-count">Suggestions: {count}</Label>
              <Input
                id="composer-count"
                type="range"
                min={1}
                max={8}
                value={count}
                onChange={(event) => setCount(Number(event.target.value))}
                data-testid="input-count"
              />
            </div>

            <div className="flex items-center justify-between gap-3">
              <div>
                <Label htmlFor="composer-hashtags">Allow hashtags</Label>
                <p className="text-xs text-muted-foreground">
                  Only when they add discovery value.
                </p>
              </div>
              <Switch
                id="composer-hashtags"
                checked={includeHashtags}
                onCheckedChange={setIncludeHashtags}
                data-testid="switch-hashtags"
              />
            </div>
          </CardContent>
        </Card>

        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Your notes</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Textarea
                value={sourceText}
                onChange={(event) => setSourceText(event.target.value)}
                placeholder="Paste a rough thought, an existing post, or the point you want to make. The model works from your material, not from scratch."
                className="min-h-[168px] resize-y"
                maxLength={12000}
                data-testid="input-source"
              />
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span className="text-xs text-muted-foreground tabular-nums">
                  {sourceText.length} / 12000 · target ≤ {limit} chars for{' '}
                  {PLATFORM_LABEL[platform]}
                </span>
                <div className="flex items-center gap-2">
                  {suggestions.length > 0 ? (
                    <Button
                      variant="outline"
                      onClick={() => handleGenerate('more')}
                      disabled={!canSubmit}
                      // Disabled is the guard against a second request; the
                      // glow is so a working control does not read as a dead
                      // one. Only the button that was pressed lights up.
                      className={cn(pendingMode === 'more' && 'ua-charging')}
                      title="Add another batch without clearing the ones already here"
                      data-testid="button-generate-more"
                    >
                      {suggest.isPending ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : (
                        <InfinityIcon className="mr-2 h-4 w-4" />
                      )}
                      Keep going
                    </Button>
                  ) : null}
                  <Button
                    onClick={() => handleGenerate('replace')}
                    disabled={!canSubmit}
                    className={cn(pendingMode === 'replace' && 'ua-charging')}
                    data-testid="button-generate"
                  >
                    {suggest.isPending ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Wand2 className="mr-2 h-4 w-4" />
                    )}
                    {suggest.isPending
                      ? 'Generating'
                      : suggestions.length > 0
                        ? 'Start over'
                        : 'Generate suggestions'}
                  </Button>
                </div>
              </div>

              {errorMessage ? (
                <div
                  className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
                  data-testid="error-generate"
                >
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{errorMessage}</span>
                </div>
              ) : null}
            </CardContent>
          </Card>

          {/*
            A fresh generation replaces the list, so its ghosts stand where the
            options will be. "Keep going" appends, so they come after the cards
            already on screen — further down, where the new options land.
          */}
          {pendingMode === 'replace' ? (
            <div className="space-y-4" data-testid="generating-ghosts">
              {Array.from({ length: count }, (_, index) => (
                <GhostSuggestion key={`ghost-${index}`} />
              ))}
            </div>
          ) : suggestions.length === 0 ? (
            <Card className="border-dashed">
              <CardContent className="flex flex-col items-center gap-2 p-10 text-center">
                <Sparkles className="h-6 w-6 text-muted-foreground" />
                <p className="text-sm font-medium">No suggestions yet</p>
                <p className="max-w-sm text-sm text-muted-foreground">
                  Write your notes and generate options. Each one arrives with a
                  rationale so you can judge it rather than trust it. Options
                  you keep or drop leave this list — the review queue and the
                  calendar are where a saved draft lives from then on.
                </p>
              </CardContent>
            </Card>
          ) : (
            suggestions.map((suggestion) => {
              const overLimit = suggestion.characterCount > limit;
              const isReviewed = Boolean(reviewed[suggestion.id]);
              return (
                <Card
                  key={suggestion.id}
                  className={cn(
                    dissolving[suggestion.id] && 'ua-dissolving',
                    // A card being dismissed is never also arriving; the
                    // dissolve wins so a fast accept cannot fight the reveal.
                    !dissolving[suggestion.id] &&
                      revealing[suggestion.id] !== undefined &&
                      'ua-revealing',
                  )}
                  style={
                    revealing[suggestion.id] !== undefined
                      ? ({
                          ['--ua-reveal-delay' as string]: `${
                            revealing[suggestion.id]! * REVEAL_STAGGER_MS
                          }ms`,
                        } as React.CSSProperties)
                      : undefined
                  }
                  data-testid={`suggestion-${suggestion.id}`}
                >
                  <CardContent className="space-y-3 p-4">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        Option {suggestion.ordinal}
                      </span>
                      <span
                        className={cn(
                          'text-xs tabular-nums',
                          overLimit
                            ? 'font-medium text-destructive'
                            : 'text-muted-foreground',
                        )}
                      >
                        {suggestion.characterCount} / {limit}
                      </span>
                    </div>

                    <p className="whitespace-pre-wrap text-sm leading-relaxed">
                      {suggestion.text}
                    </p>

                    <div className="rounded-md border border-border bg-muted/40 p-3">
                      <p className="text-xs font-medium text-muted-foreground">
                        Why the model wrote it this way
                      </p>
                      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                        {suggestion.rationale}
                      </p>
                    </div>

                    <Separator />

                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <label className="flex items-center gap-2 text-xs text-muted-foreground">
                        <Switch
                          checked={isReviewed}
                          onCheckedChange={(checked) =>
                            setReviewed((current) => ({
                              ...current,
                              [suggestion.id]: checked,
                            }))
                          }
                          data-testid={`switch-reviewed-${suggestion.id}`}
                        />
                        I read this and take responsibility for it
                      </label>

                      <div className="flex items-center gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => copyText(suggestion.text)}
                          data-testid={`button-copy-${suggestion.id}`}
                        >
                          <Copy className="mr-2 h-3.5 w-3.5" />
                          Copy
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => discard(suggestion)}
                          title="Drop this option. Nothing is saved."
                          data-testid={`button-discard-${suggestion.id}`}
                        >
                          <Trash2 className="mr-2 h-3.5 w-3.5" />
                          Not this one
                        </Button>
                        <Button
                          size="sm"
                          variant={isReviewed ? 'default' : 'outline'}
                          onClick={() => saveAsDraft(suggestion)}
                          data-testid={`button-save-draft-${suggestion.id}`}
                        >
                          {isReviewed ? (
                            <CheckCircle2 className="mr-2 h-3.5 w-3.5" />
                          ) : (
                            <CalendarClock className="mr-2 h-3.5 w-3.5" />
                          )}
                          Save as draft
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })
          )}

          {/* "Keep going" adds to the pool, so the wait shows up below it. */}
          {pendingMode === 'more' ? (
            <div className="space-y-4" data-testid="generating-ghosts-more">
              {Array.from({ length: count }, (_, index) => (
                <GhostSuggestion key={`ghost-more-${index}`} />
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </SectionShell>
  );
}
