import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  describeExcluded,
  describeMissingModel,
  modelsForPurpose,
  providerLabel,
  usableForText,
  type ModelOption,
} from './model-picker.ts';

/** The real production catalogue, trimmed: five providers, one audio model. */
const LIVE: ModelOption[] = [
  { id: 'GLM-4-32B', name: 'GLM-4-32B', provider: 'pin', modality: 'chat' },
  { id: 'llama-3.1-8b', name: 'llama-3.1-8b', provider: 'pin', modality: 'chat' },
  { id: 'qwen-3-8b', name: 'qwen-3-8b', provider: 'pin', modality: 'chat' },
  {
    id: 'tts:chatterbox-turbo',
    name: 'tts:chatterbox-turbo',
    provider: 'pin',
    modality: 'audio',
  },
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', provider: 'anthropic', modality: 'chat' },
  { id: 'gpt-5.5', name: 'GPT-5.5', provider: 'openai', modality: 'chat' },
  { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', provider: 'gemini', modality: 'chat' },
  { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B', provider: 'groq', modality: 'chat' },
];

describe('a speech model is not offered for writing text', () => {
  test('an audio modality is excluded', () => {
    const picker = modelsForPurpose(LIVE);
    assert.equal(picker.offered.has('tts:chatterbox-turbo'), false);
    assert.equal(picker.excluded, 1);
  });

  test('a tts: prefix is excluded even with no modality field', () => {
    // The modality field is new. This app has to behave correctly against a
    // gateway that predates it, and `tts:` is the convention PIN operators
    // register under.
    const picker = modelsForPurpose([
      { id: 'tts:chatterbox-turbo', name: 'tts:chatterbox-turbo' },
      { id: 'GLM-4-32B', name: 'GLM-4-32B' },
    ]);
    assert.deepEqual([...picker.offered], ['GLM-4-32B']);
  });

  test('usableForText is the single decision both paths share', () => {
    assert.equal(usableForText({ id: 'x', name: 'x', modality: 'audio' }), false);
    assert.equal(usableForText({ id: 'tts:x', name: 'tts:x' }), false);
    assert.equal(usableForText({ id: 'GLM-4-32B', name: 'GLM-4-32B' }), true);
  });

  test('the exclusion is stated, not silent', () => {
    assert.match(describeExcluded(modelsForPurpose(LIVE)) ?? '', /speech model/);
  });

  test('nothing excluded says nothing', () => {
    const picker = modelsForPurpose([{ id: 'a', name: 'A', modality: 'chat' }]);
    assert.equal(describeExcluded(picker), null);
  });
});

describe('a missing field never hides a model', () => {
  test('no modality means no reason to exclude', () => {
    // Filtering on a field an older gateway does not send would empty the
    // picker. Being shown a model that then fails is the smaller harm.
    const picker = modelsForPurpose([
      { id: 'mystery-model', name: 'Mystery' },
    ]);
    assert.equal(picker.offered.has('mystery-model'), true);
    assert.equal(picker.excluded, 0);
  });

  test('no provider still gets a group', () => {
    const picker = modelsForPurpose([{ id: 'loner', name: 'Loner' }]);
    assert.equal(picker.groups.length, 1);
    assert.equal(picker.groups[0].label, 'Other');
    assert.equal(picker.groups[0].models[0].id, 'loner');
  });

  test('an unknown provider sorts last rather than vanishing', () => {
    const picker = modelsForPurpose([
      { id: 'z', name: 'Z', provider: 'someone-new' },
      { id: 'g', name: 'G', provider: 'pin' },
    ]);
    assert.deepEqual(
      picker.groups.map((group) => group.provider),
      ['pin', 'someone-new'],
    );
  });
});

describe('the list is navigable', () => {
  test('grouped by provider, PIN first', () => {
    const picker = modelsForPurpose(LIVE);
    assert.deepEqual(
      picker.groups.map((group) => group.provider),
      ['pin', 'anthropic', 'openai', 'gemini', 'groq'],
    );
  });

  test('models inside a group are sorted by name', () => {
    const picker = modelsForPurpose(LIVE);
    const pin = picker.groups.find((group) => group.provider === 'pin');
    assert.deepEqual(
      pin?.models.map((model) => model.id),
      ['GLM-4-32B', 'llama-3.1-8b', 'qwen-3-8b'],
    );
  });

  test('a duplicate id appears once', () => {
    // The same model can arrive under two providers; two identical select
    // values is a key collision waiting to happen.
    const picker = modelsForPurpose([
      { id: 'same', name: 'Same', provider: 'pin' },
      { id: 'same', name: 'Same', provider: 'groq' },
    ]);
    assert.equal(picker.offered.size, 1);
    assert.equal(
      picker.groups.reduce((n, group) => n + group.models.length, 0),
      1,
    );
  });

  test('providers get human labels', () => {
    assert.equal(providerLabel('pin'), 'PIN network');
    assert.equal(providerLabel('anthropic'), 'Anthropic');
    assert.equal(providerLabel(undefined), 'Other');
    assert.equal(providerLabel('brand-new'), 'brand-new', 'unknown falls back to the id');
  });

  test('the input is not mutated', () => {
    const snapshot = LIVE.map((model) => model.id);
    modelsForPurpose(LIVE);
    assert.deepEqual(LIVE.map((model) => model.id), snapshot);
  });
});

describe('a configured model the account cannot reach', () => {
  test('is named, because it used to fail silently', () => {
    // The real state: the composer defaulted to GLM-4-32B while the endpoint
    // listed seven unroutable PIN ids, so the app was set to a model its own
    // picker could not offer and nothing said so.
    const picker = modelsForPurpose(LIVE);
    const note = describeMissingModel('pin:mistral:7b', picker);

    assert.match(note ?? '', /not in the list/);
    assert.match(note ?? '', /pin:mistral:7b/);
  });

  test('a reachable model says nothing', () => {
    const picker = modelsForPurpose(LIVE);
    assert.equal(describeMissingModel('GLM-4-32B', picker), null);
  });

  test('an empty catalogue is a loading state, not a verdict', () => {
    // Warning before the list arrives would flash a false alarm on every mount.
    const picker = modelsForPurpose([]);
    assert.equal(describeMissingModel('GLM-4-32B', picker), null);
  });

  test('a selected speech model is reported as unreachable here', () => {
    // It exists and is reachable on the account, but not for writing text —
    // and the operator has it selected, so silence would be the wrong answer.
    const picker = modelsForPurpose(LIVE);
    assert.notEqual(describeMissingModel('tts:chatterbox-turbo', picker), null);
  });
});
