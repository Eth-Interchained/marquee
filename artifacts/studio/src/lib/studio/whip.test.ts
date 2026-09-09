import assert from 'node:assert/strict';
import { test } from 'node:test';

import { authorizationHeader, preferCodec, resolveSessionUrl, viewerUrls, wireScaleFactor } from './whip.ts';

test('authorizationHeader: basic → Basic base64(user:pass); bearer → Bearer; none/empty → null', () => {
  assert.equal(authorizationHeader({ kind: 'basic', user: 'marquee', pass: 'testpass123' }), 'Basic ' + Buffer.from('marquee:testpass123').toString('base64'));
  assert.equal(authorizationHeader({ kind: 'bearer', token: 'jwt.here' }), 'Bearer jwt.here');
  assert.equal(authorizationHeader({ kind: 'bearer', token: '' }), null);
  assert.equal(authorizationHeader({ kind: 'none' }), null);
  assert.equal(authorizationHeader(undefined), null);
});

const SDP = [
  'v=0',
  'o=- 1 1 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'm=video 9 UDP/TLS/RTP/SAVPF 96 97 102 103',
  'a=rtpmap:96 VP8/90000',
  'a=rtpmap:97 rtx/90000',
  'a=rtpmap:102 H264/90000',
  'a=rtpmap:103 rtx/90000',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111 63',
  'a=rtpmap:111 opus/48000/2',
  'a=rtpmap:63 red/48000/2',
].join('\r\n');

test('resolveSessionUrl handles absolute, relative, and missing Location', () => {
  const ep = 'https://live.example.com/mystream/whip';
  assert.equal(resolveSessionUrl(ep, 'https://live.example.com/mystream/whip/abc'), 'https://live.example.com/mystream/whip/abc');
  assert.equal(resolveSessionUrl(ep, '/mystream/whip/abc'), 'https://live.example.com/mystream/whip/abc');
  assert.equal(resolveSessionUrl(ep, 'abc'), 'https://live.example.com/mystream/abc');
  assert.equal(resolveSessionUrl(ep, null), null);
});

test('preferCodec moves the wanted payload types to the front of the m= line only', () => {
  const out = preferCodec(SDP, 'video', 'H264');
  const m = out.split('\r\n').find((l) => l.startsWith('m=video'));
  assert.equal(m, 'm=video 9 UDP/TLS/RTP/SAVPF 102 96 97 103');
  // audio line untouched, attributes untouched
  assert.ok(out.includes('m=audio 9 UDP/TLS/RTP/SAVPF 111 63'));
  assert.ok(out.includes('a=rtpmap:96 VP8/90000'));
});

test('preferCodec is a no-op when the codec or the m= section is absent', () => {
  assert.equal(preferCodec(SDP, 'video', 'AV1'), SDP.replace(/\n/g, '\n'));
  assert.equal(preferCodec('v=0\r\nm=audio 9 X 111\r\na=rtpmap:111 opus/48000/2', 'video', 'H264'), 'v=0\r\nm=audio 9 X 111\r\na=rtpmap:111 opus/48000/2');
});

test('viewerUrls builds mediamtx HLS and WebRTC read URLs from a public base', () => {
  assert.deepEqual(viewerUrls('https://live.ne-db.com/', '/marquee/demo/'), {
    hls: 'https://live.ne-db.com:8888/marquee/demo/index.m3u8',
    webrtc: 'https://live.ne-db.com:8889/marquee/demo',
  });
});

test('wireScaleFactor scales the canvas down for the wire without touching the file', () => {
  // The whole point: the canvas can be 4K while the stream stays 1080p, from
  // ONE composite. 1 means "send it as it is".
  assert.equal(wireScaleFactor(1920, 1080), 1);
  assert.equal(wireScaleFactor(1280, 720), 1);
  // Never scale UP a small canvas to fill the wire.
  assert.equal(wireScaleFactor(640, 360), 1);

  // 4K halves; 5K-ish scales by its longest ratio.
  assert.equal(wireScaleFactor(3840, 2160), 2);
  assert.ok(Math.abs(wireScaleFactor(2560, 1440) - 4 / 3) < 1e-9);

  // The LARGEST ratio wins, because scaleResolutionDownBy divides both axes —
  // taking the smaller one would leave an axis still over the limit.
  assert.equal(wireScaleFactor(1920, 2160), 2);
  assert.equal(wireScaleFactor(3840, 1080), 2);

  // An ultrawide is limited by width, and the result must not exceed either cap.
  const ultra = wireScaleFactor(5120, 1440);
  assert.ok(5120 / ultra <= 1920.0001 && 1440 / ultra <= 1080.0001);

  // A custom cap is honoured (720p wire).
  assert.equal(wireScaleFactor(2560, 1440, 1280, 720), 2);

  // Garbage in must not produce a factor that blanks the stream.
  assert.equal(wireScaleFactor(0, 0), 1);
  assert.equal(wireScaleFactor(Number.NaN, 1080), 1);
  assert.equal(wireScaleFactor(-1920, -1080), 1);
});
