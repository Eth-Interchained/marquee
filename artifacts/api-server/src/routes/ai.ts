import { Router, type IRouter } from "express";
import {
  CreateAiBriefBody,
  CreateAiBriefResponse,
  CreateAiSuggestionBody,
  CreateAiSuggestionResponse,
  ListAiModelsResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();
const AIASSIST_BASE_URL = "https://api.AiAssist.net";
/**
 * The provider used when the caller does not name one.
 *
 * PIN is the operator's own network and the app's default, but it must NOT be
 * forced onto every request: this header was hardcoded, so choosing Claude or
 * GPT in the picker still routed the call at PIN, which serves neither. The
 * model was selectable and unusable at the same time.
 */
const DEFAULT_PROVIDER = "pin";

/**
 * Which provider to route a request at.
 *
 * The client sends the provider that `/ai/models` reported for the chosen
 * model, so the header follows the model rather than contradicting it. An
 * absent or empty value falls back to the default rather than being sent
 * blank, because an empty header is a routing decision nobody made.
 */
function providerFor(requested: string | undefined): string {
  const value = (requested ?? "").trim();
  return value === "" ? DEFAULT_PROVIDER : value;
}
const DEFAULT_MODEL = "GLM-4-32B";

type ChatCompletionResponse = {
  choices?: Array<{ message?: { content?: string } }>;
  model?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

/**
 * The credential is `AIASSIST_API_KEY`. `AIAssIST_API_KEY` was the original,
 * awkwardly-cased spelling and is still accepted so an existing install keeps
 * working, but it warns once: two names for one credential is exactly how an
 * environment ends up with a stale copy that nobody notices is unused.
 */
const LEGACY_API_KEY_VAR = "AIAssIST_API_KEY";
let warnedAboutLegacyKeyVar = false;

function getApiKey() {
  const key = process.env.AIASSIST_API_KEY?.trim();
  if (key) return key;

  const legacy = process.env[LEGACY_API_KEY_VAR]?.trim();
  if (legacy) {
    if (!warnedAboutLegacyKeyVar) {
      warnedAboutLegacyKeyVar = true;
      console.warn(
        `[ai] Using ${LEGACY_API_KEY_VAR}, which is deprecated. Save the same value as AIASSIST_API_KEY and delete the old one.`,
      );
    }
    return legacy;
  }

  throw new Error("AIASSIST_API_KEY is not configured");
}

function parseJsonContent(content: string) {
  const normalized = content
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");
  const parsed: unknown = JSON.parse(normalized);
  if (!Array.isArray(parsed)) {
    throw new Error("AiAssist returned a non-array suggestion payload");
  }
  return parsed;
}

/**
 * The enums the model is allowed to answer with.
 *
 * Spelled out for the prompt rather than described, because "a platform" gets
 * answered with "Twitter" and the schema only accepts "x". Kept beside the
 * route so the two cannot drift apart silently — the zod validator refuses a
 * bad value either way, but a refusal the operator sees as a 502 is a worse
 * outcome than a prompt that never produced one.
 */
const PLATFORM_VALUES = [
  "x", "instagram", "facebook", "threads", "linkedin", "bluesky",
  "mastodon", "reddit", "tiktok", "youtube", "pinterest", "tumblr",
] as const;

const TASK_VALUES = [
  "suggest", "rewrite", "shorten", "expand", "variants", "hashtags",
] as const;

/**
 * Reads the brief object out of a model reply.
 *
 * Same fence-stripping as `parseJsonContent`, but this one wants an OBJECT and
 * that difference matters: a model that answers with a bare array here would
 * otherwise pass a truthiness check and produce a brief with no fields at all,
 * which looks like "the model had nothing to say" rather than a parse failure.
 *
 * Unknown keys are dropped rather than passed through. The proposal is applied
 * straight onto form state, so anything not in the schema has no business
 * arriving there.
 */
function parseBriefContent(content: string): {
  reply: string;
  proposal: Record<string, unknown>;
  missing: string[];
} {
  const normalized = content
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");
  const parsed: unknown = JSON.parse(normalized);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("AiAssist returned a non-object brief payload");
  }

  const raw = parsed as Record<string, unknown>;
  const incoming = (raw.proposal ?? {}) as Record<string, unknown>;
  const allowed = [
    "platform", "task", "tone", "audience", "sourceText",
    "numberOfSuggestions", "includeHashtags",
  ];

  const proposal: Record<string, unknown> = {};
  for (const field of allowed) {
    const value = incoming[field];
    // An empty string is not an answer. Letting one through would blank a
    // field the operator had already filled in, which reads as the app losing
    // their work rather than the model declining to guess.
    if (value === undefined || value === null) continue;
    if (typeof value === "string" && value.trim() === "") continue;
    proposal[field] = value;
  }

  return {
    reply: typeof raw.reply === "string" && raw.reply.trim() !== ""
      ? raw.reply
      : "Filled in what I could from that.",
    proposal,
    missing: Array.isArray(raw.missing)
      ? raw.missing.filter((m): m is string => typeof m === "string")
      : [],
  };
}

router.get("/ai/models", async (req, res) => {
  try {
    const response = await fetch(`${AIASSIST_BASE_URL}/v1/models`, {
      headers: {
        Authorization: `Bearer ${getApiKey()}`,
      },
    });
    if (!response.ok) {
      req.log.error({ status: response.status }, "AiAssist models request failed");
      return res.status(502).json({ error: "Unable to load AI models" });
    }

    type UpstreamModel = {
      id?: string;
      name?: string;
      provider?: string;
      modality?: string;
    };
    const payload = (await response.json()) as {
      data?: UpstreamModel[];
      models?: UpstreamModel[];
    };
    // `provider` and `modality` are passed through rather than dropped: the
    // picker groups by the first and refuses audio models by the second, and
    // this route flattening them to {id, name} is why the client had neither.
    // Both stay optional — an older gateway omits them, and the client is
    // built to filter nothing rather than hide models over a missing field.
    const models = (payload.data ?? payload.models ?? [])
      .filter((model) => model.id)
      .map((model) => ({
        id: model.id!,
        name: model.name ?? model.id!,
        ...(model.provider ? { provider: model.provider } : {}),
        ...(model.modality === "chat" || model.modality === "audio"
          ? { modality: model.modality }
          : {}),
      }));

    return res.json(ListAiModelsResponse.parse({ models }));
  } catch (error) {
    req.log.error({ err: error }, "AiAssist models request failed");
    return res.status(502).json({ error: "Unable to load AI models" });
  }
});

router.post("/ai/suggest", async (req, res) => {
  const parsed = CreateAiSuggestionBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid AI suggestion request" });
  }

  const input = parsed.data;
  const model = input.model || DEFAULT_MODEL;
  const provider = providerFor(input.provider);
  const count = input.numberOfSuggestions ?? 3;
  const maxCharacters = input.maxCharacters ?? 1300;
  const systemPrompt = [
    "You are a senior social media editor.",
    "Return ONLY a valid JSON array, with no markdown fences.",
    'Each item must have exactly: "text", "rationale", and "characterCount".',
    `Create ${count} distinct suggestions for ${input.platform}.`,
    `Keep each text under ${maxCharacters} characters.`,
    input.includeHashtags === false
      ? "Do not add hashtags."
      : "Use hashtags only when they add real discovery value.",
  ].join(" ");

  try {
    const response = await fetch(`${AIASSIST_BASE_URL}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${getApiKey()}`,
        "Content-Type": "application/json",
        "X-AiAssist-Provider": provider,
      },
      body: JSON.stringify({
        model,
        temperature: 0.75,
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: JSON.stringify({
              task: input.task,
              tone: input.tone,
              audience: input.audience,
              sourceText: input.sourceText,
            }),
          },
        ],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      req.log.error(
        { status: response.status, response: errorText.slice(0, 300) },
        "AiAssist suggestion request failed",
      );
      return res.status(502).json({ error: "AiAssist could not generate suggestions" });
    }

    const payload = (await response.json()) as ChatCompletionResponse;
    const content = payload.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("AiAssist returned no message content");
    }

    const suggestions = parseJsonContent(content);
    const result = CreateAiSuggestionResponse.parse({
      suggestions: suggestions.slice(0, count).map((suggestion) => ({
        text: String(suggestion.text ?? ""),
        rationale: String(suggestion.rationale ?? ""),
        characterCount: String(suggestion.text ?? "").length,
      })),
      model: payload.model ?? model,
      provider,
      usage: {
        inputTokens: payload.usage?.prompt_tokens ?? 0,
        outputTokens: payload.usage?.completion_tokens ?? 0,
      },
    });

    return res.json(result);
  } catch (error) {
    req.log.error({ err: error }, "AI suggestion parsing or request failed");
    return res.status(502).json({ error: "AI suggestions are temporarily unavailable" });
  }
});

/**
 * Prompt mode: a conversation in, a proposed brief out.
 *
 * The composer's form asks six questions the operator has to answer before the
 * model will write anything. That is the right shape when they know what they
 * want and a poor one when they are still deciding, so this lets them describe
 * it in a sentence and have the fields filled in.
 *
 * IT PROPOSES, IT DOES NOT ACT. The answer is applied to the form the operator
 * can see and edit, and generating still takes their click. Nothing on this
 * path reaches a network, and the review tick on every candidate is still
 * required before a draft exists — prompt mode is a faster way to fill in a
 * brief, not a second route to publishing.
 *
 * EVERY PROPOSED FIELD IS OPTIONAL, on purpose. A first message rarely settles
 * all six, and inventing an audience the operator never mentioned is worse
 * than leaving the field alone: the form keeps its current value, `missing`
 * names the gap, and nobody is misled about what they said.
 */
router.post("/ai/brief", async (req, res) => {
  const parsed = CreateAiBriefBody.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid AI brief request" });
  }

  const input = parsed.data;
  const model = input.model || DEFAULT_MODEL;
  const provider = providerFor(input.provider);

  const systemPrompt = [
    "You help a social media operator fill in a post composer.",
    "Return ONLY a valid JSON object, with no markdown fences.",
    'Shape: { "reply": string, "proposal": object, "missing": string[] }.',
    '"reply" is one or two sentences to the operator: what you understood, and the single most useful question if something important is still unclear.',
    '"proposal" may contain any of: platform, task, tone, audience, sourceText, numberOfSuggestions, includeHashtags.',
    "OMIT any field the operator has not actually told you. Do not guess an audience, a tone, or a platform from nothing — an omitted field keeps whatever the form already has, which is the safer outcome.",
    '"missing" lists the names of fields you deliberately left out because they still need the operator.',
    `platform must be one of: ${PLATFORM_VALUES.join(", ")}.`,
    `task must be one of: ${TASK_VALUES.join(", ")}.`,
    "sourceText is the operator's raw material — the notes the post gets written from. Put the facts they gave you there, and never invent facts they did not state.",
    "numberOfSuggestions is between 1 and 8.",
    `The workspace's network is ${input.platform}; assume that unless the operator says otherwise.`,
  ].join(" ");

  try {
    const response = await fetch(`${AIASSIST_BASE_URL}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${getApiKey()}`,
        "Content-Type": "application/json",
        "X-AiAssist-Provider": provider,
      },
      body: JSON.stringify({
        model,
        // Lower than /ai/suggest: this is an extraction task, and a creative
        // temperature here shows up as invented audiences.
        temperature: 0.2,
        messages: [
          { role: "system", content: systemPrompt },
          ...input.conversation.map((turn) => ({
            role: turn.role === "operator" ? "user" : "assistant",
            content: turn.content,
          })),
        ],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      req.log.error(
        { status: response.status, response: errorText.slice(0, 300) },
        "AiAssist brief request failed",
      );
      return res.status(502).json({ error: "AiAssist could not read that" });
    }

    const payload = (await response.json()) as ChatCompletionResponse;
    const content = payload.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("AiAssist returned no message content");
    }

    const result = CreateAiBriefResponse.parse({
      ...parseBriefContent(content),
      usage: {
        inputTokens: payload.usage?.prompt_tokens ?? 0,
        outputTokens: payload.usage?.completion_tokens ?? 0,
      },
    });

    return res.json(result);
  } catch (error) {
    req.log.error({ err: error }, "AI brief parsing or request failed");
    return res.status(502).json({ error: "Prompt mode is temporarily unavailable" });
  }
});

export default router;