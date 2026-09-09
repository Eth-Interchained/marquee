---
name: Go Live over WHIP
description: One upstream from the creator to mediamtx; what mediamtx's auth actually accepts; where WebRTC media cannot go.
---

The Studio publishes its canvas (`captureStream()`) plus the mixer's output as
ONE WebRTC stream over WHIP (`src/lib/studio/whip.ts`) to a mediamtx the
operator runs (`deploy/mediamtx/mediamtx.yml`). mediamtx serves HLS/WHEP to
viewers and fans out to RTMP. The creator's machine never sends N streams.

## mediamtx internal auth takes Basic, not a bare Bearer password

Verified against v1.21.0 with the real binary: `Authorization: Bearer <pass>`
→ 401; `Basic base64(user:pass)` → passes auth (400 on a bogus SDP, i.e. the
next check). `Bearer user:pass` also passes. `?user=&pass=` is refused for WHIP.

**Why:** the first client draft sent a bare bearer and would have failed on a
correctly configured server with an error that looks like a wrong password.

**How to apply:** `WhipAuth` is `basic | bearer | none`; the Studio sends
`basic`. `bearer` exists for `authMethod: jwt` deployments. The 401 error text
says this so nobody re-discovers it.

## WebRTC media does not ride Cloudflare's proxy

The WHIP HTTP handshake is fine behind the orange cloud; the UDP media (ICE on
8189) is not.

**How to apply:** the ingest hostname goes on a grey-cloud DNS record or the
Studio is pointed at the IP. `webrtcAdditionalHosts` in the yml must name the
public IP or ICE candidates are unreachable. Hostile creator NATs need TURN
(`webrtcICEServers2`, coturn).

## `webrtcAdditionalHosts` is not optional

With it empty, the first sandbox publish got 201 + answer and then
`deadline exceeded while waiting connection` — ICE never completed. With the
reachable address listed on the server (and the client offering a matching
host candidate), ICE connected in 63 ms and the session went to `publish`.

**Why:** mediamtx only advertises the candidates it is told about; a client
with no route to any of them hangs until the deadline, which reads like "the
server is broken" rather than "the server never told me where it is".

**How to apply:** on the VPS set `webrtcAdditionalHosts: ['<public IP>']`.
An ICE timeout after a good 201 is a candidates problem, not an auth problem.

## RTMP auth is the opposite of WHIP's

mediamtx takes RTMP credentials from the URL query
(`rtmp://host:1935/path?user=…&pass=…`); `user:pass@host` fails with
"authentication failed". WHIP takes Basic (or `Bearer user:pass`) and refuses a
bare Bearer. Verified against v1.21.0.

## Fan-out: one ffmpeg tee, keys in an owner-only env file, idle paths park

`deploy/mediamtx/fanout.py` runs on `runOnAvailable` (1.21 name; `runOnReady`
is the deprecated alias), reads the stream back over loopback RTSP, and tees
`-c:v copy` / AAC to every `FANOUT_<NAME>` in `~/.config/marquee/fanout.env`.

**Why park:** `runOnAvailableRestart: yes` re-runs the command on ANY exit, so
a script that exits 0 for "nothing to do" is restarted every 5 s per idle path
(seen live in the log). Parking (`exec sleep infinity`) holds the slot until
mediamtx ends it. `--print` still exits, so tests and operators can inspect
the exact ffmpeg argv with keys redacted.

**Proven end to end in the sandbox:** RTMP publish → path ready →
runOnAvailable → tee → second path ready with bytes climbing → HLS master
playlist 200 with real segments and readers attached.

## What the sandbox proved, and what it did not

Proven against the real v1.21.0 binary with a real WebRTC stack (werift):
WHIP POST → 201 + `Location` + SDP answer (H264/opus); auth refusals; ICE
connected; session `state: publish` with bytes received; DELETE → 200 and the
session gone. Not proven here: decodable frames and HLS segments — the test
pushed synthetic RTP. First `index.m3u8` with real segments is a VPS run from
the Studio. Do not claim "viewers can watch" before that.
