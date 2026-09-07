import assert from 'node:assert/strict';
import { test } from 'node:test';

import { hydrateDraft, hydrateState } from './hydrate.ts';

/**
 * The bug these guard against, in full, because it is worth not repeating:
 *
 * Attachments added `media: DraftMedia[]` to `Draft` and the review queue
 * rendered `draft.media.length` directly. Every draft the composer wrote from
 * then on carried `media: []`, so it looked fine — but a draft already in the
 * ledger, written before the field existed, came back with `media` undefined.
 * The queue mapped over the list, hit that one draft, and threw
 * `Cannot read properties of undefined (reading 'length')` inside `Array.map`.
 * The whole section died in its error boundary, taking the healthy drafts with
 * it. Three brand-new drafts were invisible because of one old one beside them.
 *
 * TypeScript could not catch it: the type says the field is required and the
 * JSON on disk says nothing at all.
 */

const stored = (over: Record<string, unknown> = {}) => ({
  id: 'draft-1',
  workspaceId: 'ws-x',
  platform: 'x',
  body: 'a post',
  status: 'draft',
  scheduledFor: null,
  approvedBy: null,
  approvedAt: null,
  postUrl: null,
  lastError: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  ...over,
});

test('a draft written before media existed gets an empty list', () => {
  const draft = hydrateDraft(stored());
  assert.deepEqual(draft.media, []);
  // The expression that used to throw.
  assert.equal(draft.media.length, 0);
});

test('one old draft no longer poisons the whole list', () => {
  // Exactly the shape of the failure: an old draft beside three fresh ones.
  const state = hydrateState({
    drafts: [
      stored({ id: 'draft-2' }),                 // no media — the old seed
      stored({ id: 'fresh-1', media: [] }),
      stored({ id: 'fresh-2', media: [] }),
      stored({ id: 'fresh-3', media: [] }),
    ],
  });

  assert.doesNotThrow(() => state.drafts.map((d) => d.media.length));
  assert.deepEqual(
    state.drafts.map((d) => d.media.length),
    [0, 0, 0, 0],
  );
});

test('attachments that are already there survive untouched', () => {
  const item = {
    id: 'a'.repeat(64) + '/photo.jpg',
    sha256: 'a'.repeat(64),
    filename: 'photo.jpg',
    mimeType: 'image/jpeg',
    bytes: 2048,
    altText: 'a cat',
  };
  const draft = hydrateDraft(stored({ media: [item] }));
  assert.deepEqual(draft.media, [item]);
});

test('a half-written attachment is dropped rather than rendered', () => {
  // A reference missing its hash cannot identify a file, and the publish path
  // would refuse it anyway. Better a visibly missing picture than a card that
  // cannot render.
  const draft = hydrateDraft(
    stored({
      media: [
        { id: 'x', filename: 'photo.jpg', mimeType: 'image/jpeg', bytes: 1 }, // no sha256
        {
          id: 'b'.repeat(64) + '/ok.png',
          sha256: 'b'.repeat(64),
          filename: 'ok.png',
          mimeType: 'image/png',
          bytes: 2,
        },
      ],
    }),
  );
  assert.equal(draft.media.length, 1);
  assert.equal(draft.media[0]!.filename, 'ok.png');
});

test('media that is not even an array does not throw', () => {
  for (const value of [null, undefined, 'nope', 42, {}]) {
    assert.deepEqual(hydrateDraft(stored({ media: value })).media, []);
  }
});

test('every other field on the draft is left exactly as stored', () => {
  const raw = stored({ body: 'do not touch', approvedBy: 'Mark Evans' });
  const draft = hydrateDraft(raw);
  assert.equal(draft.body, 'do not touch');
  assert.equal(draft.approvedBy, 'Mark Evans');
  assert.equal(draft.createdAt, '2026-09-01T00:00:00.000Z');
});

test('top-level collections are guarded the same way', () => {
  // A document from a build that had no `accounts` array would take out the
  // dashboard on `state.accounts.filter` for identical reasons.
  const state = hydrateState({ version: 1, activeWorkspaceId: '' });
  assert.deepEqual(state.workspaces, []);
  assert.deepEqual(state.accounts, []);
  assert.deepEqual(state.activity, []);
  assert.deepEqual(state.drafts, []);
  assert.ok(Array.isArray(state.uaProfiles));
});

test('stored settings win over defaults, and missing ones are filled', () => {
  const state = hydrateState({ settings: { operatorName: 'Mark Evans' } });
  assert.equal(state.settings.operatorName, 'Mark Evans');
  // Not stored, so it comes from the default rather than being undefined.
  assert.equal(typeof state.settings.confirmBeforePublish, 'boolean');
});

test('an entirely absent document does not throw', () => {
  assert.doesNotThrow(() => hydrateState(undefined));
  assert.doesNotThrow(() => hydrateState(null));
  assert.deepEqual(hydrateState(null).drafts, []);
});

test('a document written before publish settings existed gets all of them', () => {
  // The rule at the top of hydrate.ts, applied to the field that motivated it:
  // every stored document predates `settings.publish`.
  const state = hydrateState({ settings: { operatorName: 'Mark Evans' } });

  assert.equal(state.settings.publish.mode, 'session', 'the route that shipped');
  assert.equal(state.settings.publish.metaPageId, '');
  assert.equal(state.settings.publish.instagramUserId, '');
  assert.equal(state.settings.publish.threadsUserId, '');
});

test('a partially stored publish group keeps its value AND gains the new fields', () => {
  // The failure this exists for: `settings` is merged one level deep, so a
  // nested object arrives whole or not at all. A document holding only `mode`
  // would replace the defaults outright and leave the rest undefined.
  const state = hydrateState({
    settings: { publish: { mode: 'api' } },
  });

  assert.equal(state.settings.publish.mode, 'api', 'the stored choice survives');
  assert.equal(
    state.settings.publish.metaPageId,
    '',
    'and a field added later is not undefined',
  );
});
