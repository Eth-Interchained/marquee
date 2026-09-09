import assert from 'node:assert/strict';
import { test } from 'node:test';

import { approverName, recordedApproval } from './approver.ts';

test('an empty or blank approver name is nobody, not a default', () => {
  assert.equal(approverName(''), null);
  assert.equal(approverName('   '), null);
  assert.equal(approverName('\t\n'), null);
});

test('a real name is kept verbatim apart from surrounding whitespace', () => {
  assert.equal(approverName('  Mark Evans '), 'Mark Evans');
});

test('a publish carries exactly the recorded approval', () => {
  assert.deepEqual(
    recordedApproval({
      approvedBy: 'Mark Evans',
      approvedAt: '2026-09-02T21:50:00.000Z',
    }),
    { approvedBy: 'Mark Evans', approvedAt: '2026-09-02T21:50:00.000Z' },
  );
});

test('half an approval is no approval — nothing is filled in at send time', () => {
  assert.equal(
    recordedApproval({ approvedBy: null, approvedAt: '2026-09-02T21:50:00.000Z' }),
    null,
  );
  assert.equal(recordedApproval({ approvedBy: 'Mark Evans', approvedAt: null }), null);
  assert.equal(recordedApproval({ approvedBy: '   ', approvedAt: '2026-09-02T21:50:00.000Z' }), null);
  assert.equal(recordedApproval({ approvedBy: null, approvedAt: null }), null);
});
