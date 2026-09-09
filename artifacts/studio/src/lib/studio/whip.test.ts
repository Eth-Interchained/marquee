import assert from 'node:assert/strict';
import { test } from 'node:test';

import { authorizationHeader, preferCodec, resolveSessionUrl, viewerUrls } from './whip.ts';

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
