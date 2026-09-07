import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { editWouldReorder, orderForQueue, queueKey } from './queue-order.ts';
import type { Draft, DraftStatus } from '../types.ts';

let seq = 0;

function draft(status: DraftStatus, over: Partial<Draft> = {}): Draft {
  seq += 1;
  const stamp = `2026-09-0${Math.min(9, seq)}T10:00:00.000Z`;
  return {
    id: `draft-${seq}`,
    workspaceId: 'ws-x',
    platform: 'x',
    body: `post ${seq}`,
    media: [],
    status,
    scheduledFor: null,
    approvedBy: null,
    approvedAt: null,
    postUrl: null,
    lastError: null,
    createdAt: stamp,
    updatedAt: stamp,
    ...over,
  } as Draft;
}

const ids = (drafts: Draft[]) => drafts.map((d) => d.id);

describe('what the queue puts first', () => {
  test('a decision waiting on you outranks anything that runs itself', () => {
    const posted = draft('published');
    const scheduled = draft('scheduled', { scheduledFor: '2026-09-20T10:00:00.000Z' });
    const needsReview = draft('draft');
    const broke = draft('failed');

    assert.deepEqual(
      ids(orderForQueue([posted, scheduled, needsReview, broke])),
      [broke.id, needsReview.id, scheduled.id, posted.id],
    );
  });

  test('scheduled posts run soonest-first, because that is real urgency', () => {
    // The next thing to fire is the last thing still worth stopping.
    const later = draft('scheduled', { scheduledFor: '2026-12-01T10:00:00.000Z' });
    const sooner = draft('scheduled', { scheduledFor: '2026-09-08T10:00:00.000Z' });
    const soonest = draft('scheduled', { scheduledFor: '2026-09-07T18:00:00.000Z' });

    assert.deepEqual(
      ids(orderForQueue([later, sooner, soonest])),
      [soonest.id, sooner.id, later.id],
    );
  });

  test('things needing review are oldest-first, so nothing rots at the bottom', () => {
    const newer = draft('draft', { createdAt: '2026-09-06T10:00:00.000Z' });
    const older = draft('draft', { createdAt: '2026-09-01T10:00:00.000Z' });

    assert.deepEqual(ids(orderForQueue([newer, older])), [older.id, newer.id]);
  });

  test('history is newest-first, which is the only place updatedAt is used', () => {
    const old = draft('published', { updatedAt: '2026-09-01T10:00:00.000Z' });
    const recent = draft('published', { updatedAt: '2026-09-06T10:00:00.000Z' });

    assert.deepEqual(ids(orderForQueue([old, recent])), [recent.id, old.id]);
  });

  test('an attested post sits with the posted ones', () => {
    // It went out. Whoever says so, it is history rather than work.
    const attested = draft('attested', { updatedAt: '2026-09-06T10:00:00.000Z' });
    const needsReview = draft('draft');

    assert.deepEqual(ids(orderForQueue([attested, needsReview])), [
      needsReview.id,
      attested.id,
    ]);
  });
});

describe('editing a card must not move it', () => {
  test('toggling post-immediately on an unapproved draft changes nothing about its place', () => {
    // The bug the owner hit: `patchDraft` stamps `updatedAt`, the old sort read
    // `updatedAt`, and the card he had just touched teleported to position 0.
    const before = draft('draft', {
      createdAt: '2026-09-01T10:00:00.000Z',
      updatedAt: '2026-09-01T10:00:00.000Z',
    });
    const after: Draft = {
      ...before,
      scheduledFor: '2026-09-09T12:00:00.000Z',
      updatedAt: '2026-09-07T16:00:00.000Z',
    };

    assert.equal(editWouldReorder(before, after), false);
    assert.deepEqual(queueKey(after), queueKey(before));
  });

  test('a touched draft keeps its position among its neighbours', () => {
    const first = draft('draft', { createdAt: '2026-09-01T10:00:00.000Z' });
    const middle = draft('draft', { createdAt: '2026-09-02T10:00:00.000Z' });
    const last = draft('draft', { createdAt: '2026-09-03T10:00:00.000Z' });

    const before = orderForQueue([first, middle, last]);

    // The operator toggles the middle one. Under the old sort this jumped to
    // the top of the list.
    const touched: Draft = { ...middle, updatedAt: '2026-09-07T16:00:00.000Z' };
    const after = orderForQueue([first, touched, last]);

    assert.deepEqual(ids(after), ids(before));
    assert.equal(ids(after)[1], middle.id, 'it stays in the middle');
  });

  test('editing the body does not move a draft either', () => {
    const before = draft('draft', { createdAt: '2026-09-01T10:00:00.000Z' });
    const after: Draft = {
      ...before,
      body: 'rewritten',
      updatedAt: '2026-09-07T16:00:00.000Z',
    };

    assert.equal(editWouldReorder(before, after), false);
  });

  test('attaching a picture does not move a draft', () => {
    const before = draft('draft', { createdAt: '2026-09-01T10:00:00.000Z' });
    const after: Draft = {
      ...before,
      media: [
        {
          sha256: 'a'.repeat(64),
          filename: 'p.png',
          mimeType: 'image/png',
          bytes: 10,
        },
      ] as Draft['media'],
      updatedAt: '2026-09-07T16:00:00.000Z',
    };

    assert.equal(editWouldReorder(before, after), false);
  });

  test('changing WHEN a scheduled post fires does move it, and should', () => {
    // Not a phantom jump: the operator changed when it happens, and the group
    // is ordered by exactly that.
    const before = draft('scheduled', { scheduledFor: '2026-12-01T10:00:00.000Z' });
    const after: Draft = { ...before, scheduledFor: '2026-09-08T10:00:00.000Z' };

    assert.equal(editWouldReorder(before, after), true);
  });

  test('approving a draft moves it, because it is no longer waiting on anyone', () => {
    const before = draft('draft');
    const after: Draft = {
      ...before,
      status: 'approved',
      approvedAt: '2026-09-07T16:00:00.000Z',
      approvedBy: 'Mark Evans',
    };

    assert.equal(editWouldReorder(before, after), true);
  });
});

describe('the order is total, so the list never shuffles on its own', () => {
  test('two drafts sharing a timestamp keep a stable order', () => {
    // Without a tiebreak, `sort` may swap equal elements between renders and
    // the queue would drift while nobody touched it.
    const same = '2026-09-01T10:00:00.000Z';
    const a = draft('draft', { createdAt: same });
    const b = draft('draft', { createdAt: same });

    const once = ids(orderForQueue([a, b]));
    const twice = ids(orderForQueue([b, a]));

    assert.deepEqual(once, twice);
  });

  test('ordering the same list twice gives the same answer', () => {
    const list = [
      draft('published'),
      draft('draft'),
      draft('scheduled', { scheduledFor: '2026-09-09T10:00:00.000Z' }),
      draft('failed'),
      draft('approved', { approvedAt: '2026-09-05T10:00:00.000Z' }),
    ];

    assert.deepEqual(ids(orderForQueue(list)), ids(orderForQueue(list)));
  });

  test('the input list is not mutated', () => {
    const list = [draft('published'), draft('failed')];
    const snapshot = ids(list);

    orderForQueue(list);

    assert.deepEqual(ids(list), snapshot);
  });

  test('a scheduled post with no time still has a place', () => {
    // Shouldn't happen, but a missing time must not produce `undefined` in the
    // comparator and scramble the list.
    const noTime = draft('scheduled', { scheduledFor: null });
    const withTime = draft('scheduled', { scheduledFor: '2026-09-09T10:00:00.000Z' });

    const ordered = orderForQueue([noTime, withTime]);
    assert.equal(ordered.length, 2);
    assert.ok(queueKey(noTime).at, 'it falls back to a real timestamp');
  });
});

describe('a new draft arrives scheduled, not immediate', () => {
  test('a draft with a time is not "post immediately"', () => {
    // The composer now writes an hour-from-now rather than null. The card's
    // checkbox reads `scheduledFor === null`, so a time is what makes the
    // safer default the visible one.
    const withTime = draft('draft', { scheduledFor: '2026-09-07T17:00:00.000Z' });
    assert.notEqual(withTime.scheduledFor, null);
  });

  test('arriving scheduled does not change where it sits in the queue', () => {
    // Unapproved drafts are ranked and clocked by `createdAt`, so carrying a
    // time does not push a fresh draft away from the other things needing
    // review — it still lines up by age with everything else waiting.
    const immediate = draft('draft', {
      createdAt: '2026-09-01T10:00:00.000Z',
      scheduledFor: null,
    });
    const scheduled = draft('draft', {
      createdAt: '2026-09-02T10:00:00.000Z',
      scheduledFor: '2026-12-01T10:00:00.000Z',
    });

    assert.deepEqual(ids(orderForQueue([scheduled, immediate])), [
      immediate.id,
      scheduled.id,
    ]);
  });
});
