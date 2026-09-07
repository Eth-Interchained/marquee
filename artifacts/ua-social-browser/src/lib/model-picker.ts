/**
 * Making the model list a menu instead of a dump.
 *
 * The gateway answers `/v1/models` with everything the account can reach —
 * 58 entries across five providers on the account this was built against. The
 * picker showed that flat, unlabelled and unsorted, so:
 *
 *  - entries appeared as raw ids (`accounts/fireworks/models/deepseek-v3`)
 *    because the route dropped the `name` the gateway sent;
 *  - `tts:chatterbox-turbo` sat between two chat models, and choosing it for a
 *    text post fails in a way nothing in the menu warned about;
 *  - the model the composer was already defaulting to could be anywhere in the
 *    list, or absent from it.
 *
 * TWO RULES SHAPE WHAT IS HERE.
 *
 * **An audio model is not offered for writing text.** Not hidden from the
 * account — the catalogue is right to advertise it, it is genuinely reachable
 * — just not listed where the only thing on offer is a written post.
 *
 * **A missing field never hides a model.** `modality` and `provider` are
 * optional: an older gateway omits them. Filtering on a field that is not
 * there would empty the picker, so absence means "no reason to exclude".
 * Being shown a model that then fails is a smaller harm than being shown
 * nothing, and it is the failure direction the rest of this codebase takes.
 */

/** The shape the API client hands over. Optional fields may genuinely be absent. */
export type ModelOption = {
  id: string;
  name: string;
  provider?: string;
  modality?: string;
};

/** What the composer writes. Audio models are not candidates for it. */
export type Purpose = 'text';

/** Provider ids the gateway uses, in the order worth showing them. */
const PROVIDER_ORDER = ['pin', 'anthropic', 'openai', 'gemini', 'groq'];

const PROVIDER_LABEL: Record<string, string> = {
  pin: 'PIN network',
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  gemini: 'Gemini',
  groq: 'Groq',
  mistral: 'Mistral',
  perplexity: 'Perplexity',
  fireworks: 'Fireworks',
};

export function providerLabel(provider: string | undefined): string {
  if (!provider) return 'Other';
  return PROVIDER_LABEL[provider] ?? provider;
}

/**
 * Is this model usable for writing a post?
 *
 * `modality: 'audio'` is the gateway saying so outright. The `tts:` prefix is
 * the convention PIN operators register under and is checked as well, because
 * the modality field is new and this app must behave correctly against a
 * gateway that predates it.
 */
export function usableForText(model: ModelOption): boolean {
  if (model.modality === 'audio') return false;
  if (model.id.startsWith('tts:')) return false;
  return true;
}

export type ModelGroup = {
  provider: string | undefined;
  label: string;
  models: ModelOption[];
};

export type PickerModels = {
  groups: ModelGroup[];
  /** How many the gateway offered but this purpose cannot use. */
  excluded: number;
  /** Every id still on offer — used to tell if the selected one survived. */
  offered: Set<string>;
};

/** Sorted so a human can find something: known providers first, then by name. */
function compareProviders(a: string | undefined, b: string | undefined): number {
  const ai = a ? PROVIDER_ORDER.indexOf(a) : -1;
  const bi = b ? PROVIDER_ORDER.indexOf(b) : -1;
  if (ai !== bi) {
    // An unknown provider sorts after the known ones rather than vanishing.
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  }
  return (a ?? '').localeCompare(b ?? '');
}

/**
 * Groups and filters the catalogue for one purpose.
 *
 * Pure. Deduplicates on id — the same model can arrive twice when a gateway
 * lists it under more than one provider, and a select with two identical
 * values is a React key collision waiting to happen.
 */
export function modelsForPurpose(
  models: readonly ModelOption[],
  _purpose: Purpose = 'text',
): PickerModels {
  const seen = new Set<string>();
  const usable: ModelOption[] = [];
  let excluded = 0;

  for (const model of models) {
    if (!model.id || seen.has(model.id)) continue;
    seen.add(model.id);
    if (!usableForText(model)) {
      excluded += 1;
      continue;
    }
    usable.push(model);
  }

  const byProvider = new Map<string | undefined, ModelOption[]>();
  for (const model of usable) {
    const key = model.provider;
    const list = byProvider.get(key);
    if (list) list.push(model);
    else byProvider.set(key, [model]);
  }

  const groups: ModelGroup[] = [...byProvider.entries()]
    .sort(([a], [b]) => compareProviders(a, b))
    .map(([provider, list]) => ({
      provider,
      label: providerLabel(provider),
      models: [...list].sort((a, b) => a.name.localeCompare(b.name)),
    }));

  return {
    groups,
    excluded,
    offered: new Set(usable.map((model) => model.id)),
  };
}

/**
 * What to say when the configured model is not in the list.
 *
 * This is a real state and it was silent: the composer defaulted to
 * `GLM-4-32B` while the endpoint listed seven PIN ids that were all
 * unroutable, so the app was set to a model its own picker could not offer and
 * nothing said a word. Generating with it would fail at the gateway.
 *
 * Returns null when the model is present, or when the list has not loaded —
 * an empty catalogue is a loading state, not a verdict about the model.
 */
export function describeMissingModel(
  selected: string,
  picker: PickerModels,
): string | null {
  if (picker.offered.size === 0) return null;
  if (picker.offered.has(selected)) return null;
  return `${selected} is not in the list of models this account can reach. Generating with it will fail — pick one below.`;
}

/** A short note about what was left out, or null when nothing was. */
export function describeExcluded(picker: PickerModels): string | null {
  if (picker.excluded === 0) return null;
  return picker.excluded === 1
    ? 'One speech model is not listed, because this writes text.'
    : `${picker.excluded} speech models are not listed, because this writes text.`;
}
