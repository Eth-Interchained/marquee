import assert from 'node:assert/strict';
import { test } from 'node:test';

import { mediaFingerprint, mediaUrl, refuseAttachment } from './media.ts';
import type { DraftMedia } from '../types.ts';

const photo = (over: Partial<DraftMedia> = {}): DraftMedia => ({
  id: 'a'.repeat(64) + '/photo.jpg',
  sha256: 'a'.repeat(64),
  filename: 'photo.jpg',
  mimeType: 'image/jpeg',
  bytes: 1024,
  ...over,
});

const file = (over: Partial<{ type: string; size: number; name: string }> = {}) => ({
  type: 'image/jpeg',
  size: 1024,
  name: 'photo.jpg',
  ...over,
});

test('a type no network here can upload is refused before it is stored', () => {
  const refusal = refuseAttachment({
    platform: 'x',
    existing: [],
    file: file({ type: 'application/pdf', name: 'contract.pdf' }),
  });
  assert.ok(refusal);
  assert.match(refusal.reason, /contract\.pdf/);
});

test('a file over the size ceiling is refused with the real numbers', () => {
  const refusal = refuseAttachment({
    platform: 'x',
    existing: [],
    file: file({ size: 40 * 1024 * 1024 }),
  });
  assert.ok(refusal);
  assert.match(refusal.reason, /40\.0 MB/);
  assert.match(refusal.reason, /25\.0 MB/);
});

test("the network's own attachment limit is enforced, not a generic one", () => {
  // X takes four; the fifth is refused and the refusal says whose rule it is.
  const existing = [1, 2, 3, 4].map((n) =>
    photo({ sha256: String(n).repeat(64).slice(0, 64) }),
  );
  const refusal = refuseAttachment({ platform: 'x', existing, file: file() });
  assert.ok(refusal);
  assert.match(refusal.reason, /X takes at most 4/);
});

test('an accepted file within the limit is not refused', () => {
  assert.equal(refuseAttachment({ platform: 'x', existing: [], file: file() }), null);
});

test('an empty file is refused rather than stored', () => {
  const refusal = refuseAttachment({
    platform: 'x',
    existing: [],
    file: file({ size: 0 }),
  });
  assert.ok(refusal);
});

test('the fingerprint changes when the pictures change', () => {
  const before = [photo()];
  const after = [photo(), photo({ sha256: 'b'.repeat(64), id: 'b'.repeat(64) + '/two.jpg' })];
  assert.notEqual(mediaFingerprint(before), mediaFingerprint(after));
});

test('the fingerprint changes when only the alt text changes', () => {
  // Alt text is published content, so editing it edits the post.
  assert.notEqual(
    mediaFingerprint([photo()]),
    mediaFingerprint([photo({ altText: 'a cat' })]),
  );
});

test('the fingerprint changes when the order changes', () => {
  const one = photo();
  const two = photo({ sha256: 'b'.repeat(64), id: 'b'.repeat(64) + '/two.jpg' });
  assert.notEqual(mediaFingerprint([one, two]), mediaFingerprint([two, one]));
});

test('the fingerprint is stable for an unchanged set', () => {
  assert.equal(mediaFingerprint([photo()]), mediaFingerprint([photo()]));
  assert.equal(mediaFingerprint([]), mediaFingerprint(undefined));
});

test('a preview url escapes each segment without escaping the separator', () => {
  const url = mediaUrl(photo({ id: 'a'.repeat(64) + '/holiday photo.jpg' }));
  assert.equal(url, `/api/media/${'a'.repeat(64)}/holiday%20photo.jpg`);
});
