import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  Copy,
  Infinity as InfinityIcon,
  Loader2,
  MessageSquare,
  Send,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Wand2,
} from "lucide-react";
import {
  useCreateAiBrief,
  useCreateAiSuggestion,
  useListAiModels,
  type AiSuggestion,
  type AiSuggestionInputPlatform,
  type AiSuggestionInputTask,
} from "@workspace/api-client-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import {
  appendCandidates,
  pruneReviewed,
  replaceCandidates,
  withoutCandidate,
  type Candidate,
} from "@/lib/candidates";
import {
  applyBrief,
  describeChanges,
  type AppliedBrief,
  type FormState,
} from "@/lib/brief";
import { describeRestored, readPool, writePool } from "@/lib/composer-pool";
import {
  describeExcluded,
  describeMissingModel,
  modelsForPurpose,
} from "@/lib/model-picker";
import { cn } from "@/lib/utils";
import { SectionShell, type SectionProps } from "@/sections/section-shell";
import {
  PLATFORMS,
  PLATFORM_LABEL,
  PLATFORM_LIMIT,
  createId,
  fromLocalInputValue,
  logActivity,
  toLocalInputValue,
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

const TASKS: Array<{ id: AiSuggestionInputTask; label: string; hint: string }> =
  [
    {
      id: "suggest",
      label: "Suggest",
      hint: "Draft new options from your notes",
    },
    {
      id: "rewrite",
      label: "Rewrite",
      hint: "Keep the point, change the delivery",
    },
    { id: "shorten", label: "Shorten", hint: "Tighten without losing meaning" },
    { id: "expand", label: "Expand", hint: "Add depth and supporting detail" },
    { id: "variants", label: "Variants", hint: "Same idea, different angles" },
    { id: "hashtags", label: "Hashtags", hint: "Discovery tags worth using" },
  ];

const TONES = [
  "Direct and plainspoken",
  "Warm and conversational",
  "Analytical",
  "Optimistic",
  "Contrarian",
  "Technical",
];

export function Composer({ state, updateState, workspace }: SectionProps) {
  const { toast } = useToast();

  const [platform, setPlatform] = useState<Platform>(workspace.platform);
  const [task, setTask] = useState<AiSuggestionInputTask>("suggest");
  const [tone, setTone] = useState(TONES[0]);
  const [audience, setAudience] = useState(
    "Founders and product leaders evaluating AI tooling",
  );
  const [sourceText, setSourceText] = useState("");
  const [model, setModel] = useState(state.settings.model);
  const [count, setCount] = useState(3);
  const [includeHashtags, setIncludeHashtags] = useState(false);
  // A working pool, not the result of one request: generating more adds to it
  // and judging a card removes that card. Keyed by id throughout — see
  // `lib/candidates.ts` for why an index key is unsafe here.
  const [suggestions, setSuggestions] = useState<
    Array<Candidate<AiSuggestion>>
  >([]);
  /**
   * Which end of the pool the pending batch will land on.
   *
   * The ghosts stand where the real cards will appear — below the existing
   * options for "keep going", in their place for a fresh generation — so the
   * list does not reshuffle when the text arrives.
   */
  const [pendingMode, setPendingMode] = useState<"replace" | "more" | null>(
    null,
  );
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

  /**
   * Two ways into the same brief.
   *
   * "form" is the original: six fields, answered directly. "prompt" lets the
   * operator describe the post in a sentence and has the model fill those same
   * fields in. It is a faster way to fill the form, NOT a second route to
   * publishing — the proposal lands in fields they can see and edit, and
   * generating still takes their click.
   */
  const [composerMode, setComposerMode] = useState<"form" | "prompt">("form");
  const [chat, setChat] = useState<
    Array<{ id: string; role: "operator" | "model"; content: string }>
  >([]);
  const [prompt, setPrompt] = useState("");
  /** A proposal waiting to be read. Never applied without the operator. */
  const [pendingBrief, setPendingBrief] = useState<AppliedBrief | null>(null);
  const [briefError, setBriefError] = useState<string | null>(null);

  const modelsQuery = useListAiModels();
  const suggest = useCreateAiSuggestion();
  const brief = useCreateAiBrief();

  /**
   * Options survive a reload; the review ticks do not.
   *
   * A crash used to take the whole pool with it — see `lib/composer-pool.ts`.
   * This restores the text and deliberately leaves `reviewed` empty, so every
   * recovered card has to be read and ticked again before it can become a
   * draft. The toast says so, because silently handing back cards that look
   * reviewed would be the actual hazard.
   */
  const restoredFor = useRef<string | null>(null);
  useEffect(() => {
    const context = `${workspace.id}:${platform}`;
    if (restoredFor.current === context) return;
    restoredFor.current = context;

    const outcome = readPool<AiSuggestion>({
      storage: window.localStorage,
      workspaceId: workspace.id,
      platform,
      now: Date.now(),
    });

    if (!outcome.restored) {
      // Switching context must not leave the previous pool on screen.
      setSuggestions([]);
      setReviewed({});
      nextOrdinal.current = 1;
      return;
    }

    setSuggestions(outcome.candidates);
    setReviewed({});
    nextOrdinal.current = outcome.nextOrdinal;
    toast({
      title: 'Recovered your options',
      description: describeRestored(outcome.candidates.length),
    });
  }, [workspace.id, platform, toast]);

  /**
   * Mirrors the pool after every change.
   *
   * This is also what "delete on interaction" means here: judging a card
   * removes it from the pool, so the next write no longer contains it, and an
   * emptied pool clears the key outright.
   */
  useEffect(() => {
    writePool({
      storage: window.localStorage,
      workspaceId: workspace.id,
      platform,
      candidates: suggestions,
      nextOrdinal: nextOrdinal.current,
      now: Date.now(),
    });
  }, [suggestions, workspace.id, platform]);

  useEffect(
    () => () => {
      for (const timer of dissolveTimers.current) window.clearTimeout(timer);
      dissolveTimers.current = [];
      for (const timer of revealTimers.current) window.clearTimeout(timer);
      revealTimers.current = [];
    },
    [],
  );

  /**
   * The catalogue as a menu: grouped by provider, speech models left out.
   *
   * This replaces a list that prepended the configured model whenever the
   * gateway did not offer it — which made an unreachable model look available
   * and was how `GLM-4-32B` sat selected while the endpoint listed seven PIN
   * ids that could not resolve. An unreachable selection is now SAID, not
   * papered over. See `lib/model-picker.ts`.
   */
  const picker = useMemo(
    () => modelsForPurpose(modelsQuery.data?.models ?? []),
    [modelsQuery.data],
  );
  const missingModel = describeMissingModel(model, picker);
  const excludedNote = describeExcluded(picker);

  const limit = PLATFORM_LIMIT[platform];
  const canSubmit = sourceText.trim().length >= 3 && !suggest.isPending;


  /** The form as prompt mode sees it, and as `applyBrief` compares against. */
  function currentForm(): FormState {
    return { platform, task, tone, audience, sourceText, count, includeHashtags };
  }

  /**
   * Sends the conversation and holds the answer for the operator to read.
   *
   * The proposal is NOT applied here. `applyBrief` computes what would change
   * and that account is shown first, because a form that rewrites itself while
   * you are looking away is the same complaint as the queue jumping under the
   * cursor.
   */
  function sendPrompt() {
    const said = prompt.trim();
    if (said === "" || brief.isPending) return;

    const turn = { id: createId("turn"), role: "operator" as const, content: said };
    const conversation = [...chat, turn];
    setChat(conversation);
    setPrompt("");
    setBriefError(null);
    setPendingBrief(null);

    brief.mutate(
      {
        data: {
          platform: platform as AiSuggestionInputPlatform,
          model,
          conversation: conversation.map((entry) => ({
            role: entry.role,
            content: entry.content,
          })),
        },
      },
      {
        onSuccess: (result) => {
          setChat((current) => [
            ...current,
            { id: createId("turn"), role: "model", content: result.reply },
          ]);
          const applied = applyBrief(currentForm(), result.proposal ?? {});
          setPendingBrief(applied);
        },
        onError: () => {
          setBriefError(
            "AiAssist could not read that. Nothing in the form was changed.",
          );
        },
      },
    );
  }

  /** Applies a read proposal, and optionally goes straight on to generating. */
  function acceptBrief(applied: AppliedBrief, thenGenerate: boolean) {
    setPlatform(applied.next.platform);
    setTask(applied.next.task as AiSuggestionInputTask);
    setTone(applied.next.tone);
    setAudience(applied.next.audience);
    setSourceText(applied.next.sourceText);
    setCount(applied.next.count);
    setIncludeHashtags(applied.next.includeHashtags);
    setPendingBrief(null);

    toast({ title: "Brief applied", description: describeChanges(applied) });

    if (thenGenerate) {
      // Back to the form, because that is where the options appear and where
      // the operator judges them. Prompt mode's job ends at a filled brief.
      setComposerMode("form");
      // The state above lands on the next render; generate from the values
      // just computed rather than from stale closure state.
      handleGenerate("replace", applied.next);
    }
  }

  /**
   * `mode` is the difference between starting over and keeping the loop going.
   * "More" appends, so options accumulate while you work through them; the
   * plain generate replaces, for when the brief itself has changed.
   */
  function handleGenerate(
    mode: "replace" | "more" = "replace",
    /**
     * The brief to generate from, when it is not the one in state yet.
     *
     * `acceptBrief` applies a proposal and can go straight on to generating.
     * React has not re-rendered at that point, so reading the fields from
     * state here would send the PREVIOUS brief — the operator would watch the
     * form fill in correctly and get options for what it used to say.
     */
    override?: FormState,
  ) {
    const form = override ?? currentForm();
    if (form.sourceText.trim().length < 3 || suggest.isPending) return;
    setErrorMessage(null);
    setPendingMode(mode);
    // One id per request, stamped onto every candidate it returns. It is what
    // lets the queue recognise several kept drafts as variants of one idea
    // rather than several separate posts — see `lib/sibling-groups.ts`.
    const generationId = createId('gen');

    suggest.mutate(
      {
        data: {
          platform: form.platform as AiSuggestionInputPlatform,
          task: form.task as AiSuggestionInputTask,
          tone: form.tone,
          audience: form.audience,
          sourceText: form.sourceText.trim(),
          model,
          numberOfSuggestions: form.count,
          maxCharacters: PLATFORM_LIMIT[form.platform],
          includeHashtags: form.includeHashtags,
        },
      },
      {
        onSuccess: (result) => {
          let duplicates = 0;
          let arrived: string[] = [];
          setSuggestions((current) => {
            const outcome =
              mode === "more"
                ? appendCandidates({
                    existing: current,
                    incoming: result.suggestions,
                    startOrdinal: nextOrdinal.current,
                    makeId: () => createId('sug'),
                    generationId,
                  })
                : replaceCandidates({
                    incoming: result.suggestions,
                    makeId: () => createId('sug'),
                    generationId,
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

          if (mode === "replace") setReviewed({});
          if (duplicates > 0) {
            toast({
              title:
                duplicates === 1
                  ? "One option repeated what you already had"
                  : `${duplicates} options repeated what you already had`,
              description:
                "They were dropped rather than listed. Change the tone or the notes to push it somewhere new.",
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
              type: "ai",
              title: `AI ${task} generated`,
              detail: `${result.suggestions.length} ${PLATFORM_LABEL[platform]} options for ${workspace.name} · ${result.model}`,
            }),
          }));
        },
        onError: () => {
          setPendingMode(null);
          setErrorMessage(
            "AiAssist could not generate suggestions. The request failed upstream — nothing was saved.",
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
        title: "Review required",
        description:
          "Confirm you have read the suggestion before it becomes a draft.",
        variant: "destructive",
      });
      return;
    }

    updateState((current) => ({
      ...current,
      drafts: [
        {
          id: createId("draft"),
          workspaceId: workspace.id,
          platform,
          body: candidate.text,
          media: [],
          status: "draft",
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
          origin: {
            generationId: candidate.generationId,
            ordinal: candidate.ordinal,
          },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        ...current.drafts,
      ],
      activity: logActivity(current, {
        type: "draft",
        title: "Draft saved after human review",
        detail: `${PLATFORM_LABEL[platform]} · ${workspace.name}`,
      }),
    }));

    // It lives in the review queue now, so it leaves the pool. Nothing is lost:
    // the queue and the calendar are where a draft is worked on from here.
    dissolve(candidate.id);

    toast({
      title: "Saved to drafts",
      description:
        "You can edit, schedule, or discard it from the review queue.",
    });
  }

  /** Discarding a candidate writes nothing — it was never a draft. */
  function discard(candidate: Candidate<AiSuggestion>) {
    dissolve(candidate.id);
  }

  async function copyText(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast({ title: "Copied to clipboard" });
    } catch {
      toast({
        title: "Clipboard unavailable",
        description: "Select the text manually to copy it.",
        variant: "destructive",
      });
    }
  }

  return (
    <SectionShell
      title="AI Composer"
      description="The model proposes. You decide. Every suggestion needs an explicit review before it can become a draft — nothing is queued or published automatically."
      actions={
        <div className="flex items-center gap-1 rounded-md border border-border p-1">
          {(
            [
              { id: "form", label: "Form", icon: SlidersHorizontal,
                hint: "Answer the fields yourself" },
              { id: "prompt", label: "Prompt", icon: MessageSquare,
                hint: "Describe it and let the model fill the fields in" },
            ] as const
          ).map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => setComposerMode(option.id)}
              title={option.hint}
              className={cn(
                "flex items-center gap-1.5 rounded px-2.5 py-1 text-xs transition-colors hover-elevate",
                composerMode === option.id
                  ? "bg-accent font-medium text-accent-foreground"
                  : "text-muted-foreground",
              )}
              data-testid={`mode-${option.id}`}
            >
              <option.icon className="h-3.5 w-3.5" />
              {option.label}
            </button>
          ))}
        </div>
      }
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
                <SelectTrigger
                  id="composer-platform"
                  data-testid="select-platform"
                >
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
                      "rounded-md border px-2 py-1.5 text-xs transition-colors hover-elevate",
                      task === option.id
                        ? "border-primary bg-primary/10 font-medium text-foreground"
                        : "border-border text-muted-foreground",
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
                  {/*
                    The selected model is offered even when the gateway does
                    not list it, or the Select would render an empty trigger
                    and the operator could not see what they were set to. The
                    warning below is what tells them it will not work.
                  */}
                  {missingModel ? (
                    <SelectItem value={model}>{model}</SelectItem>
                  ) : null}
                  {picker.groups.map((group) => (
                    <SelectGroup key={group.label}>
                      <SelectLabel>{group.label}</SelectLabel>
                      {group.models.map((option) => (
                        <SelectItem key={option.id} value={option.id}>
                          {option.name}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  ))}
                </SelectContent>
              </Select>
              {missingModel ? (
                <p
                  className="flex items-start gap-1.5 text-xs text-destructive"
                  data-testid="warning-model-unreachable"
                >
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>{missingModel}</span>
                </p>
              ) : null}
              <p className="text-xs text-muted-foreground">
                {modelsQuery.isError
                  ? "Model list unavailable — using the configured default."
                  : `Routed server-side through provider "${state.settings.provider}".`}
                {excludedNote ? ` ${excludedNote}` : ""}
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
          {composerMode === "prompt" ? (
            <Card data-testid="prompt-panel">
              <CardHeader className="pb-3">
                <CardTitle className="text-base">
                  Describe the post you want
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-xs text-muted-foreground">
                  Say it however you like — what it is about, who it is for, how
                  it should sound. The model fills in the brief on the left; it
                  does not write the post until you press Generate, and it never
                  changes a field without showing you first.
                </p>

                {chat.length > 0 ? (
                  <div
                    className="max-h-[280px] space-y-2 overflow-y-auto rounded-md border border-border p-3"
                    data-testid="prompt-transcript"
                  >
                    {chat.map((entry) => (
                      <div
                        key={entry.id}
                        className={cn(
                          "rounded-md px-3 py-2 text-sm",
                          entry.role === "operator"
                            ? "bg-accent/60 text-accent-foreground"
                            : "border border-border",
                        )}
                        data-testid={`turn-${entry.role}`}
                      >
                        {entry.content}
                      </div>
                    ))}
                    {brief.isPending ? (
                      <div className="ua-ghost-bar h-8 w-3/5" />
                    ) : null}
                  </div>
                ) : null}

                {/*
                  The proposal is shown, not applied. A form that rewrites
                  itself while the operator is reading is the same complaint as
                  a queue that jumps under the cursor.
                */}
                {pendingBrief ? (
                  <div
                    className="space-y-3 rounded-md border border-primary/40 bg-primary/5 p-3"
                    data-testid="brief-proposal"
                  >
                    {pendingBrief.changes.length > 0 ? (
                      <>
                        <p className="text-xs font-medium">
                          It would change these:
                        </p>
                        <ul className="space-y-1 text-xs">
                          {pendingBrief.changes.map((change) => (
                            <li
                              key={change.field}
                              className="flex flex-wrap items-baseline gap-1.5"
                              data-testid={`change-${change.field}`}
                            >
                              <span className="font-medium">
                                {change.label}
                              </span>
                              <span className="text-muted-foreground line-through">
                                {change.from}
                              </span>
                              <span aria-hidden="true">→</span>
                              <span>{change.to}</span>
                            </li>
                          ))}
                        </ul>
                      </>
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        Nothing in the brief needed changing.
                      </p>
                    )}

                    {pendingBrief.refused.length > 0 ? (
                      <div
                        className="space-y-1 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive"
                        data-testid="brief-refused"
                      >
                        {pendingBrief.refused.map((item) => (
                          <p key={item.field}>
                            Ignored {item.field} “{item.value}” — {item.reason}.
                          </p>
                        ))}
                      </div>
                    ) : null}

                    {pendingBrief.changes.length > 0 ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          size="sm"
                          onClick={() => acceptBrief(pendingBrief, false)}
                          data-testid="button-apply-brief"
                        >
                          Apply to the brief
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={
                            pendingBrief.next.sourceText.trim().length < 3
                          }
                          title={
                            pendingBrief.next.sourceText.trim().length < 3
                              ? "There are no notes to write from yet — tell it what the post is about"
                              : undefined
                          }
                          onClick={() => acceptBrief(pendingBrief, true)}
                          data-testid="button-apply-and-generate"
                        >
                          <Wand2 className="mr-2 h-3.5 w-3.5" />
                          Apply and generate
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setPendingBrief(null)}
                          data-testid="button-discard-brief"
                        >
                          Leave the brief alone
                        </Button>
                      </div>
                    ) : null}
                  </div>
                ) : null}

                <div className="flex items-end gap-2">
                  <Textarea
                    value={prompt}
                    onChange={(event) => setPrompt(event.target.value)}
                    onKeyDown={(event) => {
                      // Enter sends, shift+enter is a newline — the shape
                      // every chat box has, so muscle memory works.
                      if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault();
                        sendPrompt();
                      }
                    }}
                    placeholder={
                      chat.length === 0
                        ? "e.g. promote the grand reopening on Oct 3, warm but not hype, for locals — three options"
                        : "Add a correction or another detail"
                    }
                    className="min-h-[72px] resize-y"
                    maxLength={4000}
                    data-testid="input-prompt"
                  />
                  <Button
                    onClick={sendPrompt}
                    disabled={prompt.trim() === "" || brief.isPending}
                    className={cn(brief.isPending && "ua-charging")}
                    data-testid="button-send-prompt"
                  >
                    {brief.isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Send className="h-4 w-4" />
                    )}
                  </Button>
                </div>

                {briefError ? (
                  <div
                    className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
                    data-testid="error-prompt"
                  >
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>{briefError}</span>
                  </div>
                ) : null}
              </CardContent>
            </Card>
          ) : null}

          <Card className={cn(composerMode === "prompt" && "hidden")}>
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
                  {sourceText.length} / 12000 · target ≤ {limit} chars for{" "}
                  {PLATFORM_LABEL[platform]}
                </span>
                <div className="flex items-center gap-2">
                  {suggestions.length > 0 ? (
                    <Button
                      variant="outline"
                      onClick={() => handleGenerate("more")}
                      disabled={!canSubmit}
                      // Disabled is the guard against a second request; the
                      // glow is so a working control does not read as a dead
                      // one. Only the button that was pressed lights up.
                      className={cn(pendingMode === "more" && "ua-charging")}
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
                    onClick={() => handleGenerate("replace")}
                    disabled={!canSubmit}
                    className={cn(pendingMode === "replace" && "ua-charging")}
                    data-testid="button-generate"
                  >
                    {suggest.isPending ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Wand2 className="mr-2 h-4 w-4" />
                    )}
                    {suggest.isPending
                      ? "Generating"
                      : suggestions.length > 0
                        ? "Start over"
                        : "Generate suggestions"}
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
          {pendingMode === "replace" ? (
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
                    dissolving[suggestion.id] && "ua-dissolving",
                    // A card being dismissed is never also arriving; the
                    // dissolve wins so a fast accept cannot fight the reveal.
                    !dissolving[suggestion.id] &&
                      revealing[suggestion.id] !== undefined &&
                      "ua-revealing",
                  )}
                  style={
                    revealing[suggestion.id] !== undefined
                      ? ({
                          ["--ua-reveal-delay" as string]: `${
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
                          "text-xs tabular-nums",
                          overLimit
                            ? "font-medium text-destructive"
                            : "text-muted-foreground",
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
                          variant={isReviewed ? "default" : "outline"}
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
          {pendingMode === "more" ? (
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
