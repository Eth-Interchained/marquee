import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseServerFrame, resizeFrame } from './runtime-client.ts';

test('resize frames carry the NUL prefix the runtime keys on', () => {
  const frame = resizeFrame(133, 40);
  assert.equal(frame.charCodeAt(0), 0);
  assert.deepEqual(JSON.parse(frame.slice(1)), { type: 'resize', cols: 133, rows: 40 });
});

test('server frames parse to exit / error, and anything else is named unknown rather than dropped', () => {
  assert.deepEqual(parseServerFrame('{"type":"exit","code":0}'), { type: 'exit', code: 0 });
  assert.deepEqual(parseServerFrame('{"type":"error","detail":"bad"}'), { type: 'error', detail: 'bad' });
  assert.deepEqual(parseServerFrame('not json'), { type: 'unknown', raw: 'not json' });
  assert.deepEqual(parseServerFrame('{"type":"exit"}'), { type: 'unknown', raw: '{"type":"exit"}' });
});
