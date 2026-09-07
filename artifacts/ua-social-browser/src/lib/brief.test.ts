import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  applyBrief,
  describeChanges,
  readyToGenerate,
  type FormState,
} from './brief.ts';

const FORM: FormState = {
  platform: 'x',
  task: 'suggest',
  tone: 'Direct and plainspoken',
  audience: 'Founders evaluating AI tooling',
  sourceText: '',
  count: 3,
  includeHashtags: false,
};

describe('a proposal fills the form', () => {
  test('the fields the model answered are applied', () => {
    const { next } = applyBrief(FORM, {
      tone: 'Warm and conversational',
      audience: 'Winter Park locals',
      sourceText: 'Grand reopening Sat Oct 3, 6-8pm.',
      numberOfSuggestions: 5,
    });

    assert.equal(next.tone, 'Warm and conversational');
    assert.equal(next.audience, 'Winter Park locals');
    assert.equal(next.sourceText, 'Grand reopening Sat Oct 3, 6-8pm.');
    assert.equal(next.count, 5);
  });

  test('a field the model omitted keeps what the form had', () => {
    // An omission means "I was not told", not "clear it". Guessing an audience
    // the operator never mentioned is worse than leaving theirs alone.
    const { next } = applyBrief(FORM, { sourceText: 'Just the notes.' });

    assert.equal(next.audience, FORM.audience);
    assert.equal(next.tone, FORM.tone);
    assert.equal(next.platform, FORM.platform);
  });

  test('an empty string does not blank a field the operator filled in', () => {
    const { next, changes } = applyBrief(FORM, { audience: '   ' });

    assert.equal(next.audience, FORM.audience);
    assert.equal(changes.length, 0, 'and it is not reported as a change');
  });

  test('the form is never mutated', () => {
    const before = { ...FORM };
    applyBrief(FORM, { tone: 'Analytical', sourceText: 'notes' });
    assert.deepEqual(FORM, before);
  });

  test('a value identical to the current one is not reported as a change', () => {
    const { changes } = applyBrief(FORM, {
      platform: 'x',
      task: 'suggest',
      tone: FORM.tone,
    });
    assert.deepEqual(changes, []);
  });
});

describe('what a proposal is refused for', () => {
  test('a network this app cannot post to is refused, not coerced', () => {
    // The one mistake in this module that would reach an audience: a coerced
    // platform sends the post somewhere the operator did not choose.
    const { next, refused } = applyBrief(FORM, { platform: 'Twitter' });

    assert.equal(next.platform, 'x', 'the form keeps its own value');
    assert.equal(refused.length, 1);
    assert.equal(refused[0].field, 'platform');
    assert.match(refused[0].reason, /network/);
  });

  test('a task outside the composer’s list is refused', () => {
    const { next, refused } = applyBrief(FORM, { task: 'summarise' });

    assert.equal(next.task, 'suggest');
    assert.equal(refused[0].field, 'task');
  });

  test('a count outside 1-8 is refused rather than clamped', () => {
    // Clamping 40 to 8 would silently answer a question the operator did not
    // ask; refusing says the model produced something the form cannot take.
    const { next, refused } = applyBrief(FORM, { numberOfSuggestions: 40 });

    assert.equal(next.count, 3);
    assert.equal(refused[0].field, 'numberOfSuggestions');
    assert.match(refused[0].reason, /1–8/);
  });

  test('a valid platform in the wrong case is accepted', () => {
    const { next, refused } = applyBrief(FORM, { platform: 'Instagram' });

    assert.equal(next.platform, 'instagram');
    assert.deepEqual(refused, []);
  });

  test('a refusal does not stop the rest of the brief landing', () => {
    const { next, refused } = applyBrief(FORM, {
      platform: 'MySpace',
      tone: 'Analytical',
      sourceText: 'real notes',
    });

    assert.equal(refused.length, 1);
    assert.equal(next.tone, 'Analytical', 'the good fields still apply');
    assert.equal(next.sourceText, 'real notes');
  });
});

describe('the operator can read what moved', () => {
  test('every applied field is accounted for', () => {
    const { changes } = applyBrief(FORM, {
      tone: 'Analytical',
      sourceText: 'notes',
      numberOfSuggestions: 6,
      includeHashtags: true,
    });

    assert.deepEqual(
      changes.map((c) => c.field).sort(),
      ['count', 'includeHashtags', 'sourceText', 'tone'],
    );
  });

  test('long text is summarised in the account, not dumped', () => {
    const long = 'x'.repeat(400);
    const { changes, next } = applyBrief(FORM, { sourceText: long });

    const entry = changes.find((c) => c.field === 'sourceText');
    assert.ok(entry);
    assert.ok(entry.to.length < 80, 'the summary is short');
    assert.equal(next.sourceText, long, 'the field itself gets all of it');
  });

  test('a previously empty field reads as empty rather than blank', () => {
    const { changes } = applyBrief(FORM, { sourceText: 'notes' });
    assert.equal(changes[0].from, '(empty)');
  });

  test('the summary names the fields in plain words', () => {
    const applied = applyBrief(FORM, { tone: 'Analytical', sourceText: 'n' });
    assert.match(describeChanges(applied), /tone/);
    assert.match(describeChanges(applied), /your notes/);
  });

  test('a brief that changed nothing says so', () => {
    const applied = applyBrief(FORM, { platform: 'x' });
    assert.match(describeChanges(applied), /Nothing in the form needed changing/);
  });

  test('a single change is not described with a list', () => {
    const applied = applyBrief(FORM, { tone: 'Analytical' });
    assert.equal(describeChanges(applied), 'Filled in tone.');
  });
});

describe('readiness matches the Generate button', () => {
  test('notes under three characters are not ready', () => {
    assert.equal(readyToGenerate({ ...FORM, sourceText: 'ab' }), false);
  });

  test('whitespace is not notes', () => {
    assert.equal(readyToGenerate({ ...FORM, sourceText: '     ' }), false);
  });

  test('real notes are ready', () => {
    assert.equal(readyToGenerate({ ...FORM, sourceText: 'abc' }), true);
  });
});
