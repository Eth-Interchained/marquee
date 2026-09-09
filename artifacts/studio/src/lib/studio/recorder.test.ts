/**
 * The recorder's logic, without a browser.
 *
 * The fakes here mimic the two behaviours that actually bite: MediaRecorder
 * delivering a final chunk on `stop()` (lose it and every take is short), and
 * writes that resolve out of order (interleave them and the container is
 * corrupt).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  RECORDING_FORMATS,
  RecordingSession,
  finaliseToMp4,
  formatBytes,
  formatElapsed,
  pickRecordingFormat,
  type RecorderState,
} from './recorder';
import type { ShellRecording } from '../shell-bridge';

// ---------------------------------------------------------------- pure parts

test('pickRecordingFormat prefers H.264 and only falls back when it must', () => {
  // The machine Chromium usually is: H.264 available under its real name.
  const everything = pickRecordingFormat(() => true);
  assert.equal(everything?.mimeType, 'video/x-matroska;codecs=avc1,opus');
  assert.equal(everything?.canStreamCopyToMp4, true);

  // A machine with no H.264 encoder: VP9, and the note must warn about MP4.
  const noH264 = pickRecordingFormat((type) => type.includes('vp9') || type.includes('vp8'));
  assert.equal(noH264?.videoCodec, 'vp9');
  assert.equal(noH264?.canStreamCopyToMp4, false);
  assert.match(noH264!.note, /re-encoding/i);

  // Only the matroska alias missing — the webm/h264 spelling is the same bytes.
  const aliasOnly = pickRecordingFormat((type) => type === 'video/webm;codecs=h264,opus');
  assert.equal(aliasOnly?.videoCodec, 'h264');
  assert.equal(aliasOnly?.canStreamCopyToMp4, true);

  // Nothing supported is a real answer, not a throw.
  assert.equal(pickRecordingFormat(() => false), null);
});

test('no format claims MP4 stream-copy unless it is H.264', () => {
  // The guard on the measured Chromium behaviour: a VP9 file in an MP4 is
  // exactly what this design exists to avoid.
  for (const format of RECORDING_FORMATS) {
    assert.equal(
      format.canStreamCopyToMp4,
      format.videoCodec === 'h264',
      `${format.mimeType} makes the wrong MP4 claim`,
    );
    assert.ok(format.note.length > 20, `${format.mimeType} needs a note the UI can show`);
  }
  // We never ask for video/mp4 with codecs: the constructor throws on it.
  assert.ok(!RECORDING_FORMATS.some((f) => f.mimeType.startsWith('video/mp4')));
});

test('formatBytes and formatElapsed read correctly at the boundaries', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1023), '1023 B');
  assert.equal(formatBytes(1024), '1.0 KB');
  assert.equal(formatBytes(1024 * 1024), '1.0 MB');
  assert.equal(formatBytes(15 * 1024 * 1024), '15 MB');
  assert.equal(formatBytes(3.7 * 1024 * 1024 * 1024), '3.7 GB');

  assert.equal(formatElapsed(0), '00:00');
  assert.equal(formatElapsed(9_000), '00:09');
  assert.equal(formatElapsed(61_000), '01:01');
  assert.equal(formatElapsed(3_600_000), '1:00:00');
  assert.equal(formatElapsed(7_265_000), '2:01:05');
  // A negative clock skew must not print nonsense.
  assert.equal(formatElapsed(-5_000), '00:00');
});

// --------------------------------------------------------------------- fakes

type Written = { id: string; size: number };

function fakeRecordingBridge(overrides: Partial<ShellRecording> = {}) {
  const writes: Written[] = [];
  let bytes = 0;
  let chunks = 0;
  const calls: string[] = [];
  const bridge: ShellRecording = {
    async begin(mimeType) {
      calls.push(`begin:${mimeType}`);
      return { id: 'rec_1', path: `/videos/marquee/take.mkv`, startedAt: new Date().toISOString() };
    },
    async writeChunk(id, blob) {
      writes.push({ id, size: blob.size });
      bytes += blob.size;
      chunks += 1;
      return { bytes, chunks };
    },
    async finish(id) {
      calls.push('finish');
      return { id, path: '/videos/marquee/take.mkv', bytes, durationMs: 4_000, chunks, clean: true };
    },
    async abort(id) {
      calls.push('abort');
      return { id, path: '/videos/marquee/take.mkv', bytes, durationMs: 4_000, chunks, clean: false };
    },
    async revealInFolder(p) {
      return { revealed: true, path: p };
    },
    ...overrides,
  };
  return { bridge, writes, calls, total: () => bytes };
}

/** Just enough MediaRecorder to be wrong in the ways the real one is. */
class FakeRecorder {
  state: 'inactive' | 'recording' | 'paused' = 'inactive';
  ondataavailable: ((event: { data: { size: number } }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  timeslice: number | null = null;
  constructor(public stream: unknown, public options: { mimeType?: string }) {}
  start(timeslice?: number) {
    this.state = 'recording';
    this.timeslice = timeslice ?? null;
  }
  pause() {
    this.state = 'paused';
  }
  resume() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    // The real one emits a final chunk BEFORE onstop. That ordering is the
    // reason stop() waits for onstop and then drains the queue.
    this.emit(7);
    this.onstop?.();
  }
  emit(size: number) {
    this.ondataavailable?.({ data: { size } });
  }
}

const streamWithVideo = () =>
  ({ getVideoTracks: () => [{ kind: 'video' }], getAudioTracks: () => [] }) as unknown as MediaStream;
const streamWithNothing = () =>
  ({ getVideoTracks: () => [], getAudioTracks: () => [] }) as unknown as MediaStream;

const h264 = RECORDING_FORMATS[0];

function session(bridge: ShellRecording, stream = streamWithVideo(), states: RecorderState[] = []) {
  let recorder: FakeRecorder | null = null;
  const s = new RecordingSession({
    stream,
    recording: bridge,
    format: h264,
    label: 'take one',
    timesliceMs: 1000,
    onState: (state) => states.push(state),
    recorderFactory: (st, opts) => {
      recorder = new FakeRecorder(st, opts);
      return recorder as unknown as MediaRecorder;
    },
  });
  return { s, states, recorder: () => recorder!, };
}

// ------------------------------------------------------------------ sessions

test('a take opens the file first, then the recorder, and reports the real path', async () => {
  const { bridge, calls } = fakeRecordingBridge();
  const { s, states, recorder } = session(bridge);

  const started = await s.start();
  assert.equal(started.path, '/videos/marquee/take.mkv');
  assert.deepEqual(calls, ['begin:video/x-matroska;codecs=avc1,opus']);
  assert.equal(recorder().state, 'recording');
  // The timeslice is what bounds a crash's cost; it must actually be passed.
  assert.equal(recorder().timeslice, 1000);
  assert.equal(states[0]?.kind, 'recording');
  assert.equal(s.current.kind, 'recording');
});

test('an empty scene is refused before any file is opened', async () => {
  const { bridge, calls } = fakeRecordingBridge();
  const { s } = session(bridge, streamWithNothing());
  await assert.rejects(s.start(), /nothing to record/i);
  // No orphan file: the refusal happens before begin().
  assert.deepEqual(calls, []);
});

test('every chunk reaches disk in order, including the final one from stop()', async () => {
  const { bridge, writes } = fakeRecordingBridge();
  const { s, recorder } = session(bridge);
  await s.start();

  recorder().emit(100);
  recorder().emit(200);
  const closed = await s.stop();

  // 100, 200, then the 7-byte tail the real MediaRecorder flushes on stop.
  assert.deepEqual(writes.map((w) => w.size), [100, 200, 7]);
  assert.equal(closed.bytes, 307);
  assert.equal(closed.clean, true);
  assert.equal(s.current.kind, 'stopped');
  if (s.current.kind === 'stopped') {
    assert.equal(s.current.path, '/videos/marquee/take.mkv');
    assert.match(s.current.note, /finalise to MP4/i);
  }
});

test('zero-byte chunks are dropped rather than counted', async () => {
  const { bridge, writes } = fakeRecordingBridge();
  const { s, recorder } = session(bridge);
  await s.start();
  recorder().emit(0);
  recorder().emit(0);
  recorder().emit(50);
  await s.stop();
  assert.deepEqual(writes.map((w) => w.size), [50, 7]);
});

test('slow writes are serialized, so chunks cannot interleave', async () => {
  // Resolve the writes out of order on purpose: without the promise chain the
  // second chunk would land before the first and the container is ruined.
  const order: number[] = [];
  const gates: Array<() => void> = [];
  const { bridge } = fakeRecordingBridge({
    async writeChunk(_id, blob) {
      const size = blob.size;
      await new Promise<void>((resolve) => gates.push(resolve));
      order.push(size);
      return { bytes: 0, chunks: order.length };
    },
  });
  const { s, recorder } = session(bridge);
  await s.start();

  recorder().emit(1);
  recorder().emit(2);
  recorder().emit(3);
  await Promise.resolve();
  // Only the first write may be in flight; the rest are queued behind it.
  assert.equal(gates.length, 1, 'writes must not run concurrently');

  // Release them in reverse; the chain still forces 1, 2, 3.
  while (gates.length > 0 || order.length < 3) {
    gates.pop()?.();
    await new Promise((r) => setTimeout(r, 0));
  }
  assert.deepEqual(order.slice(0, 3), [1, 2, 3]);
});

test('a write that fails stops the take, keeps the file, and names the failure', async () => {
  let n = 0;
  const { bridge, calls } = fakeRecordingBridge({
    async writeChunk(_id, blob) {
      n += 1;
      if (n === 2) throw new Error('ENOSPC: no space left on device');
      return { bytes: blob.size, chunks: n };
    },
  });
  const states: RecorderState[] = [];
  const { s, recorder } = session(bridge, streamWithVideo(), states);
  await s.start();

  recorder().emit(10);
  recorder().emit(20);
  await new Promise((r) => setTimeout(r, 0));

  const error = states.find((state) => state.kind === 'error');
  assert.ok(error, 'the failure must reach the UI');
  if (error?.kind === 'error') {
    assert.match(error.message, /ENOSPC/);
    // The path is kept so the operator can go find what survived.
    assert.equal(error.path, '/videos/marquee/take.mkv');
  }

  // stop() must report the ORIGINAL failure, not a tidy success.
  await assert.rejects(s.stop(), (thrown: unknown) => {
    assert.ok(thrown instanceof Error);
    assert.match(thrown.message, /ENOSPC/);
    assert.match(thrown.message, /partial recording was kept/i);
    return true;
  });
  // Closed via abort, never finish — the file is not advertised as complete.
  assert.ok(calls.includes('abort'));
  assert.ok(!calls.includes('finish'));
});

test('a recorder that refuses to construct closes the file it already opened', async () => {
  const { bridge, calls } = fakeRecordingBridge();
  const states: RecorderState[] = [];
  const s = new RecordingSession({
    stream: streamWithVideo(),
    recording: bridge,
    format: h264,
    onState: (state) => states.push(state),
    recorderFactory: () => {
      // Exactly what Chromium does for video/mp4 with explicit codecs.
      throw new Error('NotSupportedError: mimeType is not supported');
    },
  });

  await assert.rejects(s.start(), /refused to record/i);
  // The descriptor is released, and the (empty) file is still kept.
  assert.deepEqual(calls, ['begin:video/x-matroska;codecs=avc1,opus', 'abort']);
  const error = states.find((state) => state.kind === 'error');
  assert.ok(error && error.kind === 'error' && error.path === '/videos/marquee/take.mkv');
});

test('a MediaRecorder error event is surfaced, not swallowed', async () => {
  const { bridge } = fakeRecordingBridge();
  const states: RecorderState[] = [];
  const { s, recorder } = session(bridge, streamWithVideo(), states);
  await s.start();

  recorder().onerror?.({ error: { name: 'SecurityError', message: 'the capture source went away' } });
  const error = states.find((state) => state.kind === 'error');
  assert.ok(error && error.kind === 'error');
  if (error.kind === 'error') {
    assert.match(error.message, /SecurityError/);
    assert.match(error.message, /capture source went away/);
  }
});

test('pause and resume move the state without closing the file', async () => {
  const { bridge, calls } = fakeRecordingBridge();
  const { s, recorder } = session(bridge);
  await s.start();

  s.pause();
  assert.equal(s.current.kind, 'paused');
  assert.equal(recorder().state, 'paused');
  s.resume();
  assert.equal(s.current.kind, 'recording');
  assert.ok(!calls.includes('finish') && !calls.includes('abort'));
});

test('stopping when nothing is recording says so instead of half-working', async () => {
  const { bridge } = fakeRecordingBridge();
  const { s } = session(bridge);
  await assert.rejects(s.stop(), /Nothing is recording/);
  await s.start();
  await s.stop();
  // A second stop is an error, not a silent no-op that looks like success.
  await assert.rejects(s.stop(), /Nothing is recording/);
});

test('starting twice is refused rather than orphaning the first file', async () => {
  const { bridge } = fakeRecordingBridge();
  const { s } = session(bridge);
  await s.start();
  await assert.rejects(s.start(), /already recording/i);
});

// ------------------------------------------------------------------ finalise

test('finaliseToMp4 returns the runtime report on success', async () => {
  const report = {
    source: '/videos/marquee/take.mkv',
    output: '/videos/marquee/take.mp4',
    outputBytes: 1_077_874,
    durationSeconds: 4.008,
    videoCodec: 'h264',
    audioCodec: 'aac',
    videoWasCopied: true,
    tookSeconds: 0.169,
    notes: ['Audio re-encoded opus -> aac (opus in MP4 is poorly supported).'],
  };
  let seen: { url: string; body: unknown } | null = null;
  const result = await finaliseToMp4('/videos/marquee/take.mkv', (async (url: string, init: RequestInit) => {
    seen = { url, body: JSON.parse(String(init.body)) };
    return { ok: true, status: 200, text: async () => JSON.stringify(report) };
  }) as unknown as typeof fetch);

  assert.deepEqual(seen, { url: '/runtime/remux', body: { source: '/videos/marquee/take.mkv' } });
  assert.equal(result.videoWasCopied, true);
  assert.equal(result.output, '/videos/marquee/take.mp4');
});

test('finaliseToMp4 surfaces the runtime\'s own words on every failure shape', async () => {
  const reply = (status: number, body: string) =>
    (async () => ({ ok: false, status, text: async () => body })) as unknown as typeof fetch;

  // 501: PyAV missing. The message must say the BUILD cannot do it, because
  // that is a different fix from a bad recording.
  await assert.rejects(
    finaliseToMp4('/x.mkv', reply(501, JSON.stringify({ detail: 'PyAV is not installed in this runtime' }))),
    /cannot finalise recordings to MP4.*PyAV is not installed/s,
  );
  // 422: the runtime explains what is wrong with the file; pass it through.
  await assert.rejects(
    finaliseToMp4('/x.mkv', reply(422, JSON.stringify({ detail: 'holds vp9 video, which does not belong in an MP4' }))),
    /HTTP 422.*vp9/s,
  );
  await assert.rejects(finaliseToMp4('/x.mkv', reply(404, JSON.stringify({ detail: 'no recording at /x.mkv' }))), /no recording at/);
  // A non-JSON body (a proxy error page) still reaches the operator raw.
  await assert.rejects(finaliseToMp4('/x.mkv', reply(502, '<html>bad gateway</html>')), /bad gateway/);
});
