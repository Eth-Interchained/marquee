import { Router, type IRouter } from "express";
import {
  CLOSE,
  END,
  OPEN,
  extractBlock,
  extractTaggedBlocks,
  jsonFromResponse,
} from "sentinel-blocks";
import {
  CreateAiBriefBody,
  CreateAiBriefResponse,
  CreateAiSuggestionBody,
  CreateAiSuggestionResponse,
  ListAiModelsResponse,
} from "@marquee/api-zod";

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

/**
 * Reads the suggestions out of a completion.
 *
 * Was: strip fences, `JSON.parse`, hope. That is hand-rolled extraction and it
 * breaks the moment a model prefaces its answer with a sentence — which they
 * do. `sentinel-blocks` walks the whole ladder instead: the `<<<SUGGESTIONS>>>`
 * block, then a plain parse, then a light repair, then a balanced slice. It
 * never fabricates; if nothing parses it throws and the caller decides.
 */
function parseJsonContent(content: string) {
  const parsed = jsonFromResponse<unknown>(content, "SUGGESTIONS");

  if (Array.isArray(parsed)) return parsed;

  /*
   * A TIGHTER PROMPT IS NOT A GUARANTEE, so the parser gives ground too.
   *
   * The prompt now shows the array explicitly, and a model will still
   * sometimes wrap it — `{ "suggestions": [...] }` is the obvious thing to
   * send when the block is named SUGGESTIONS. Refusing that cost sixty seconds
   * of real work and showed the operator a 502.
   *
   * Unwrapping ONE array-valued property is not guesswork: there is exactly
   * one array in the payload and exactly one thing this endpoint wants. What
   * it deliberately does not do is search for a key by name, which would be
   * guessing at vocabulary rather than reading structure.
   */
  if (typeof parsed === "object" && parsed !== null) {
    const arrays = Object.values(parsed as Record<string, unknown>).filter(
      (value): value is unknown[] => Array.isArray(value),
    );
    if (arrays.length === 1) return arrays[0];

    // A single suggestion sent unwrapped. It has the shape of one item, so it
    // is one item — the operator asked for options and got fewer, which is a
    // thin answer rather than a failed one.
    if ("text" in (parsed as Record<string, unknown>)) return [parsed];
  }

  throw new Error(
    `AiAssist returned a ${
      Array.isArray(parsed) ? "array" : typeof parsed
    } where a suggestion array was expected`,
  );
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
/**
 * The one tool prompt mode gives the model.
 *
 * Declared as a typed, enumerated schema rather than described in prose,
 * because that difference is measurable: on `imagine`, identical weights and
 * identical questions went from 2/7 to 6/7 usable tool calls when the schema
 * became typed. A model guesses far less when the shape is spelled out, and
 * every guess here is a field the operator has to notice and undo.
 *
 * ONE tool, not several. The model's whole job in prompt mode is to fill in a
 * brief; a second tool would be a second thing to get wrong.
 *
 * THE CALL TRAVELS IN A SENTINEL BLOCK, not as a native tool call. Several
 * models on this gateway — the PIN network's among them — have no native tool
 * calling at all, and a feature that works on Anthropic while silently doing
 * nothing on the operator's own hardware is worse than one mechanism that
 * works everywhere. `sentinel-blocks` is that mechanism, and its extraction
 * survives the quotes and newlines a JSON payload arrives with.
 */
const SET_BRIEF_TOOL = {
  name: "set_brief",
  description:
    "Fill in one or more fields of the composer's brief. Call it only for what the operator actually told you.",
  parameters: {
    platform: `one of: ${PLATFORM_VALUES.join(" | ")}`,
    task: `one of: ${TASK_VALUES.join(" | ")}`,
    tone: "string, max 100 chars — how the post should sound",
    audience: "string, max 200 chars — who it is for",
    sourceText:
      "string — the raw facts the post gets written from. Their material, never invented.",
    numberOfSuggestions: "integer 1-8 — how many options to draft",
    includeHashtags: "boolean",
  },
} as const;

/**
 * The conversation's instructions.
 *
 * Written as a brief to a colleague rather than a list of output rules. The
 * previous version opened with "Return ONLY a valid JSON object" and the model
 * answered like a formatter. What the operator wants is someone to talk to who
 * happens to be filling in a form while they talk.
 */
function briefSystemPrompt(platform: string): string {
  const schema = Object.entries(SET_BRIEF_TOOL.parameters)
    .map(([field, spec]) => `  ${field}: ${spec}`)
    .join("\n");

  return [
    "You are helping a social media operator work out what to post. Talk to them like a colleague who knows the trade: plain, warm, brief. Ask one question at a time when something matters and you do not know it. Never lecture, and never recite their own words back at them.",
    "",
    `Their workspace posts to ${platform}. Assume that unless they say otherwise.`,
    "",
    "You have ONE tool:",
    "",
    `${SET_BRIEF_TOOL.name} — ${SET_BRIEF_TOOL.description}`,
    schema,
    "",
    "Every message you send has this shape. Put what you say to the operator in a CONVERSATION block:",
    "",
    `${OPEN}CONVERSATION${CLOSE}`,
    "Warm it is. Who is this one for — regulars, or people who have not been in yet?",
    END,
    "",
    "And when you want to fill something in, add a SET_BRIEF block. Name the fields you are setting in the tag, separated by ||, and put the values as JSON inside:",
    "",
    `${OPEN}SET_BRIEF TONE||AUDIENCE${CLOSE}`,
    '{ "tone": "Warm and conversational", "audience": "Men and women in Winter Park" }',
    END,
    "",
    "Rules that matter:",
    "- The CONVERSATION block is the only thing the operator reads. Keep it to a sentence or two, like speech.",
    `- The tag must name exactly the fields the JSON sets, using these names: ${Object.keys(SET_BRIEF_TOOL.parameters).join("||")}. If the tag and the JSON disagree, the operator is told.`,
    "- Include ONLY the fields they actually told you. Leaving one out keeps whatever the form already has, which is always safer than a guess.",
    "- If you have nothing to fill in yet — you are only asking a question — send the CONVERSATION block alone. That is a complete turn.",
    "- Never invent facts. If you do not know the date, the price, or a stylist's name, ask.",
  ].join("\n");
}

/**
 * Reads a completion as two DECLARED blocks, never as leftovers.
 *
 *     <<<CONVERSATION>>>
 *     What the operator reads.
 *     <<<END>>>
 *
 *     <<<SET_BRIEF TONE||AUDIENCE>>>
 *     { "tone": "...", "audience": "..." }
 *     <<<END>>>
 *
 * The owner's protocol, and it corrects a real mistake. The previous version
 * took the conversation to be whatever text was LEFT OVER once the tool block
 * had been stripped out — and stripping meant a regex I had written by hand.
 * That is exactly the heuristic extraction this module exists to avoid, having
 * crept back in through the side door. Now both halves are named, both are
 * extracted by the library, and nothing is inferred from what remains.
 *
 * THE TAG DECLARES WHAT THE CALL SETS. `<<<SET_BRIEF TONE||AUDIENCE>>>` says
 * which fields the payload is meant to carry, so the payload can be checked
 * against a stated intention instead of simply trusted. A model that names
 * TONE and then sends SOURCETEXT has done something worth noticing, and the
 * mismatch is reported rather than silently applied.
 *
 * Both blocks are optional, and each absence means something specific:
 *  - no SET_BRIEF: the model is only talking. A complete, valid turn.
 *  - no CONVERSATION: an older or blunter model that ignored the format. The
 *    whole completion becomes the reply, because refusing to show the operator
 *    words the model genuinely said would be the worse failure.
 */
function parseBriefContent(content: string): {
  reply: string;
  proposal: Record<string, unknown>;
  missing: string[];
  /** Set when the tag and the payload disagree about what is being filled in. */
  mismatch: string | null;
} {
  const raw = content.trim();
  if (raw === "") {
    throw new Error("AiAssist returned an empty reply");
  }

  // What the operator reads. Declared, not deduced.
  const spoken = extractBlock(raw, "CONVERSATION");

  const calls = extractTaggedBlocks(raw, "SET_BRIEF");
  // Last call wins: a model that corrects itself mid-message meant the second
  // one, and applying both in order would let a stale value overwrite a fresh
  // one depending on key order.
  const call = calls.length > 0 ? calls[calls.length - 1] : undefined;

  const fallbackReply = () => {
    if (spoken !== null && spoken !== "") return spoken;
    // No CONVERSATION block. Show what it said rather than nothing — but not
    // the machinery, so a bare tool call does not surface as JSON.
    const withoutBlocks = raw.includes(`${OPEN}SET_BRIEF`) ? "" : raw;
    return withoutBlocks || "Filled that in.";
  };

  if (!call) {
    return { reply: fallbackReply(), proposal: {}, missing: [], mismatch: null };
  }

  let args: unknown;
  try {
    // The ladder, not a bare JSON.parse: arguments arrive with quotes and
    // newlines that shatter a naive parse.
    args = jsonFromResponse<unknown>(call.content);
  } catch {
    // It TRIED to call the tool and produced rubbish — distinct from just
    // talking, and worth saying so. Silently proposing nothing would leave the
    // operator wondering why their instruction had no effect.
    return {
      reply:
        spoken ||
        "I meant to fill in the brief there but garbled it. Say that again?",
      proposal: {},
      missing: [],
      mismatch: "the tool call was not readable",
    };
  }

  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return {
      reply: fallbackReply(),
      proposal: {},
      missing: [],
      mismatch: "the tool call was not an object",
    };
  }

  const incoming = args as Record<string, unknown>;
  const fields = Object.keys(SET_BRIEF_TOOL.parameters);

  const proposal: Record<string, unknown> = {};
  for (const field of fields) {
    const value = incoming[field];
    // An empty string is not an answer. Letting one through would blank a
    // field the operator had already filled in, which reads as lost work.
    if (value === undefined || value === null) continue;
    if (typeof value === "string" && value.trim() === "") continue;
    proposal[field] = value;
  }

  // The tag's declaration, checked against what actually arrived.
  //
  // NORMALISED PAST PUNCTUATION, not merely lowercased. A model writes
  // `SOURCE_TEXT` in a tag and `sourceText` in JSON — both entirely
  // reasonable, and the same field. Comparing on case alone reported them as a
  // disagreement, so the one field that HAD changed came with a warning saying
  // it had not. A false alarm about the machinery is worse than no alarm: it
  // teaches the operator to ignore the real ones.
  const canonical = (name: string) =>
    name.trim().toLowerCase().replace(/[^a-z0-9]/g, "");

  const declared = call.arg
    .split("||")
    .map(canonical)
    .filter((name) => name !== "");
  const applied = Object.keys(proposal).map(canonical);
  /** Canonical name -> the field as the schema spells it, for the message. */
  const spelling = new Map(
    Object.keys(SET_BRIEF_TOOL.parameters).map((f) => [canonical(f), f]),
  );
  const readable = (name: string) => spelling.get(name) ?? name;

  const promisedButAbsent = declared.filter((name) => !applied.includes(name));
  const sentButUndeclared =
    declared.length > 0
      ? applied.filter((name) => !declared.includes(name))
      : [];

  const mismatch =
    promisedButAbsent.length > 0 || sentButUndeclared.length > 0
      ? [
          promisedButAbsent.length > 0
            ? `named but not sent: ${promisedButAbsent.map(readable).join(", ")}`
            : "",
          sentButUndeclared.length > 0
            ? `sent but not named: ${sentButUndeclared.map(readable).join(", ")}`
            : "",
        ]
          .filter((part) => part !== "")
          .join("; ")
      : null;

  return {
    reply: fallbackReply(),
    proposal,
    // Derived, not asked for. The model reporting its own omissions was one
    // more thing for it to get wrong, and the answer is already knowable.
    missing: fields.filter((field) => !(field in proposal)),
    mismatch,
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
  /*
   * Tightened, and the shape of the tightening is the point.
   *
   * The previous version was seven rules `.join(" ")` into one run-on
   * paragraph, with the required shape described in words: "the JSON array".
   * A 32B model read that and sent `{ "suggestions": [...] }` — a completely
   * reasonable reading, since the block is called SUGGESTIONS — and the route
   * threw "non-array suggestion payload" after sixty seconds of work.
   *
   * So: newlines instead of one paragraph, the constraint stated as ARRAY vs
   * OBJECT rather than implied, and a WORKED EXAMPLE. An example is worth more
   * than any amount of description — it is the difference the `imagine` runs
   * measured, and it costs a dozen tokens.
   */
  const systemPrompt = [
    "You are a senior social media editor writing posts for a real business.",
    "",
    `Write ${count} distinct options for ${input.platform}. Each under ${maxCharacters} characters.`,
    input.includeHashtags === false
      ? "No hashtags."
      : "Hashtags only where they genuinely aid discovery.",
    "Work only from the operator's material. Never invent a fact, a date, a price or a name.",
    "",
    "Answer with a sentinel block containing a JSON ARRAY — square brackets at the top level, NOT an object wrapping one:",
    "",
    `${OPEN}SUGGESTIONS${CLOSE}`,
    "[",
    '  { "text": "the post itself", "rationale": "why this angle", "characterCount": 21 },',
    '  { "text": "a different angle", "rationale": "why this one differs", "characterCount": 17 }',
    "]",
    END,
    "",
    "Anything outside the block is ignored, so think out loud beforehand if it helps.",
  ].join("\n");

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

  const systemPrompt = briefSystemPrompt(input.platform);

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