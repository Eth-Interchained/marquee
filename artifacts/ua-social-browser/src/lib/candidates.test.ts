import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  appendCandidates,
  pruneReviewed,
  replaceCandidates,
  withoutCandidate,
  type Candidate,
  type SuggestionLike,
} from './candidates.ts';

const suggestion = (text: string): SuggestionLike => ({
  text,
  rationale: `because of ${text}`,
  characterCount: text.length,
});

/**
 * One factory per test, shared across every generation in it.
 *
 * Deliberately not one per call: a fresh counter reissues `sug-1` for the
 * second batch, two candidates end up sharing an id, and removing one removes
 * both. That is not a hypothetical — it broke this file's own ordinal test
 * before it was written this way, which is a fair demonstration of why the
 * real `createId` mixes a timestamp with randomness.
 */
function ids() {
  let n = 0;
  return () => `sug-${++n}`;
}

test('a fresh generation numbers from one', () => {
  const { candidates, nextOrdinal } = replaceCandidates({
    incoming: [suggestion('a'), suggestion('b')],
    makeId: ids(),
    generationId: 'gen-1',
  });

  assert.deepEqual(
    candidates.map((c) => c.ordinal),
    [1, 2],
  );
  assert.equal(nextOrdinal, 3);
});

test('generating more adds to the pool instead of replacing it', () => {
  const makeId = ids();
  const first = replaceCandidates({ incoming: [suggestion('a')], makeId, generationId: 'gen-1' });
  const second = appendCandidates({
    existing: first.candidates,
    incoming: [suggestion('b'), suggestion('c')],
    startOrdinal: first.nextOrdinal,
    makeId,
    generationId: 'gen-2',
  });

  assert.deepEqual(
    second.candidates.map((c) => c.text),
    ['a', 'b', 'c'],
  );
});

test('ordinals keep climbing across generations and never renumber', () => {
  // The point: a card you are reading keeps its number while its neighbours go.
  const makeId = ids();
  const first = replaceCandidates({
    incoming: [suggestion('a'), suggestion('b')],
    makeId,
    generationId: 'gen-1',
  });
  const second = appendCandidates({
    existing: first.candidates,
    incoming: [suggestion('c')],
    startOrdinal: first.nextOrdinal,
    makeId,
    generationId: 'gen-2',
  });

  assert.deepEqual(
    second.candidates.map((c) => c.ordinal),
    [1, 2, 3],
  );

  const afterRemoval = withoutCandidate(second.candidates, second.candidates[0]!.id);
  assert.deepEqual(
    afterRemoval.map((c) => c.ordinal),
    [2, 3],
    'the survivors keep the numbers they were given',
  );
});

test('a model repeating itself does not fill the pool with repeats', () => {
  const makeId = ids();
  const first = replaceCandidates({ incoming: [suggestion('same')], makeId, generationId: 'gen-1' });
  const second = appendCandidates({
    existing: first.candidates,
    incoming: [suggestion('  SAME  '), suggestion('different')],
    startOrdinal: first.nextOrdinal,
    makeId,
    generationId: 'gen-2',
  });

  assert.equal(second.duplicates, 1);
  assert.deepEqual(
    second.candidates.map((c) => c.text),
    ['same', 'different'],
  );
});

test('an empty suggestion is never a candidate', () => {
  const { candidates, duplicates } = replaceCandidates({
    incoming: [suggestion('   '), suggestion('real')],
    makeId: ids(),
    generationId: 'gen-1',
  });

  assert.deepEqual(
    candidates.map((c) => c.text),
    ['real'],
  );
  assert.equal(duplicates, 1);
});

test('every candidate gets its own id', () => {
  const { candidates } = replaceCandidates({
    incoming: [suggestion('a'), suggestion('b'), suggestion('c')],
    makeId: ids(),
    generationId: 'gen-1',
  });

  assert.equal(new Set(candidates.map((c) => c.id)).size, 3);
});

test('removing a candidate takes only that one', () => {
  const { candidates } = replaceCandidates({
    incoming: [suggestion('a'), suggestion('b'), suggestion('c')],
    makeId: ids(),
    generationId: 'gen-1',
  });

  const left = withoutCandidate(candidates, candidates[1]!.id);
  assert.deepEqual(
    left.map((c) => c.text),
    ['a', 'c'],
  );
});

test("a sign-off never slides onto a card it was not given for", () => {
  // The bug this whole module exists to prevent. Review state used to be keyed
  // by array index, so removing a card shifted every later flag down one.
  const { candidates } = replaceCandidates({
    incoming: [suggestion('a'), suggestion('b'), suggestion('c')],
    makeId: ids(),
    generationId: 'gen-1',
  });
  const [a, b, c] = candidates as [Candidate, Candidate, Candidate];

  // The operator reads and signs off on 'c' only.
  const reviewed = { [c.id]: true };

  const left = withoutCandidate(candidates, a.id);
  const pruned = pruneReviewed(reviewed, left);

  assert.equal(pruned[c.id], true, "c keeps the sign-off it was given");
  assert.equal(pruned[b.id], undefined, "b must not inherit anything");
});

test('review flags for departed candidates are dropped', () => {
  const { candidates } = replaceCandidates({
    incoming: [suggestion('a'), suggestion('b')],
    makeId: ids(),
    generationId: 'gen-1',
  });
  const [a, b] = candidates as [Candidate, Candidate];

  const pruned = pruneReviewed(
    { [a.id]: true, [b.id]: true },
    withoutCandidate(candidates, a.id),
  );

  assert.deepEqual(Object.keys(pruned), [b.id]);
});

test('two candidates never share an id, so a removal is never a double removal', () => {
  const makeId = ids();
  const first = replaceCandidates({ incoming: [suggestion('a')], makeId, generationId: 'gen-1' });
  const second = appendCandidates({
    existing: first.candidates,
    incoming: [suggestion('b')],
    startOrdinal: first.nextOrdinal,
    makeId,
    generationId: 'gen-2',
  });

  const allIds = second.candidates.map((c) => c.id);
  assert.equal(new Set(allIds).size, allIds.length, 'ids must be unique across generations');

  const left = withoutCandidate(second.candidates, second.candidates[0]!.id);
  assert.equal(left.length, 1, 'removing one card removes exactly one card');
});

test('candidates carry the generation they arrived in', () => {
  const makeId = ids();
  const first = replaceCandidates({
    incoming: [suggestion('a'), suggestion('b')],
    makeId,
    generationId: 'gen-1',
  });
  const second = appendCandidates({
    existing: first.candidates,
    incoming: [suggestion('c')],
    startOrdinal: first.nextOrdinal,
    makeId,
    generationId: 'gen-2',
  });

  assert.deepEqual(
    second.candidates.map((candidate) => candidate.generationId),
    ['gen-1', 'gen-1', 'gen-2'],
    'a second batch must not restamp the batch already on screen',
  );
});
