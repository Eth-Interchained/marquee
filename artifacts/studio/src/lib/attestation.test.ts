import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  attest,
  canAttest,
  describeAttestation,
  isAttested,
  isRefusal,
  retract,
} from './attestation.ts';
import type { Draft, DraftStatus } from '../types.ts';

function draft(status: DraftStatus, over: Partial<Draft> = {}): Draft {
  return {
    id: 'draft-1',
    workspaceId: 'ws-x',
    platform: 'x',
    body: 'a post',
    media: [],
    status,
    scheduledFor: null,
    approvedBy: 'Mark Evans',
    approvedAt: '2026-09-03T18:40:00.000Z',
    postUrl: null,
    lastError:
      'The post was submitted to X but no confirmation arrived before the deadline.',
    createdAt: '2026-09-03T18:30:00.000Z',
    updatedAt: '2026-09-03T18:41:47.000Z',
    ...over,
  } as Draft;
}

const AT = '2026-09-03T19:10:00.000Z';

test('a failed post can be corrected', () => {
  assert.equal(canAttest(draft('failed')), true);
});

test('an attestation never produces `published`', () => {
  // The load-bearing rule. `published` means the network said so; this is the
  // operator's word. Collapsing the two would put a claim the app cannot back
  // behind the same badge as one it can.
  const result = attest({ draft: draft('failed'), by: 'Mark Evans', at: AT });

  assert.ok(!isRefusal(result));
  assert.equal(result.status, 'attested');
  assert.notEqual(result.status, 'published');
});

test('the claim carries who made it and when', () => {
  const result = attest({ draft: draft('failed'), by: 'Mark Evans', at: AT });

  assert.ok(!isRefusal(result));
  assert.deepEqual(result.attestation, {
    by: 'Mark Evans',
    at: AT,
    postUrl: null,
  });
});

test('an unsigned correction is refused', () => {
  // Same rule as approval, for the same reason: an anonymous claim about what
  // reached an audience is worthless, and there is no fallback name.
  for (const by of [null, '', '   ']) {
    const result = attest({ draft: draft('failed'), by, at: AT });
    assert.ok(isRefusal(result), `must refuse a name of ${JSON.stringify(by)}`);
  }
});

test('a name is trimmed rather than stored with its whitespace', () => {
  const result = attest({
    draft: draft('failed'),
    by: '  Mark Evans  ',
    at: AT,
  });

  assert.ok(!isRefusal(result));
  assert.equal(result.attestation?.by, 'Mark Evans');
});

test('a post the network confirmed cannot be overwritten by a note', () => {
  // The network's confirmation is stronger evidence than anyone's word. A
  // weaker claim must not replace it.
  const result = attest({
    draft: draft('published'),
    by: 'Mark Evans',
    at: AT,
  });

  assert.ok(isRefusal(result));
  assert.match(result.refused, /confirmed by the network/i);
});

test('a post nobody ever attempted cannot be attested', () => {
  // There is nothing to correct until an attempt exists and came back wrong.
  // Attesting an untried draft is not a correction, it is a fiction.
  for (const status of ['draft', 'approved', 'scheduled', 'publishing'] as const) {
    const result = attest({ draft: draft(status), by: 'Mark Evans', at: AT });
    assert.ok(isRefusal(result), `must refuse to attest a ${status} draft`);
  }
});

test('the link is optional and kept when given', () => {
  const withLink = attest({
    draft: draft('failed'),
    by: 'Mark Evans',
    at: AT,
    postUrl: 'https://x.com/interchained/status/1',
  });

  assert.ok(!isRefusal(withLink));
  assert.equal(
    withLink.attestation?.postUrl,
    'https://x.com/interchained/status/1',
  );
});

test('a blank link is stored as absent rather than as an empty string', () => {
  const result = attest({
    draft: draft('failed'),
    by: 'Mark Evans',
    at: AT,
    postUrl: '   ',
  });

  assert.ok(!isRefusal(result));
  assert.equal(result.attestation?.postUrl, null);
});

test("the operator's link never becomes the draft's postUrl", () => {
  // `postUrl` is what the network reported. The operator's link is their own
  // and lives on the attestation, so a reader can always tell which is which.
  const result = attest({
    draft: draft('failed'),
    by: 'Mark Evans',
    at: AT,
    postUrl: 'https://x.com/interchained/status/1',
  });

  assert.ok(!isRefusal(result));
  assert.equal(
    'postUrl' in result,
    false,
    'attesting must not write the draft-level postUrl',
  );
});

test('what the shell observed is not erased by the correction', () => {
  // The record should read "confirmation never arrived, and the operator later
  // found the post" — both halves, because both are true.
  const result = attest({ draft: draft('failed'), by: 'Mark Evans', at: AT });

  assert.ok(!isRefusal(result));
  assert.equal(
    'lastError' in result,
    false,
    'the failure reason must survive the correction',
  );
});

test('a correction can be taken back, returning to what the machine saw', () => {
  const attested = draft('attested', {
    attestation: { by: 'Mark Evans', at: AT, postUrl: null },
  });

  const result = retract(attested);

  assert.ok(!isRefusal(result));
  assert.equal(result.status, 'failed');
  assert.equal(result.attestation, null);
});

test('there is nothing to retract on a post that was never attested', () => {
  const result = retract(draft('failed'));
  assert.ok(isRefusal(result));
});

test('an attested draft is never eligible for another attempt', () => {
  // The post already went out. Re-sending it is the double-post the whole
  // design exists to prevent, so `attested` must be neither of the two states
  // the scheduler acts on.
  const attested = draft('attested', {
    attestation: { by: 'Mark Evans', at: AT, postUrl: null },
  });

  assert.equal(isAttested(attested), true);
  assert.notEqual(attested.status, 'scheduled');
  assert.notEqual(attested.status, 'publishing');
  assert.notEqual(attested.status, 'approved');
});

test('the description names the person and denies the network confirmed it', () => {
  const attested = draft('attested', {
    attestation: { by: 'Mark Evans', at: AT, postUrl: null },
  });

  const text = describeAttestation(attested);
  assert.ok(text);
  assert.match(text, /Mark Evans/);
  assert.match(text, /never sent confirmation/i);
});

test('there is no description without a claim', () => {
  assert.equal(describeAttestation(draft('failed')), null);
});
