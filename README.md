# marquee

**The whole broadcast studio in a browser tab.**

Screen or game capture, a camera in the corner, social widgets, and go-live — composited in the browser and sent out from one place. Underneath it, every on-air event (follow, raid, chat line, scene switch, and later tips) is a hash-chained document in [NEDB](https://github.com/Eth-Interchained/nedb): `TRACE` gives you a receipt for anything that appeared on screen, `AS OF` lets you scrub a VOD and see the overlay exactly as it was, and `verify` proves the record was never edited.

Nothing rented. No install. Open a URL.

## Status — build step 1 of 7: the compositor

| step | what | status |
|---|---|---|
| 1 | Compositor: screen + camera corner, drag/resize, mixer, local preview | **this release** |
| 2 | Go live: WHIP → mediamtx → HLS player page | next |
| 3 | Event log + SSE widgets (feed, alerts, who's-live) with `caused_by` | |
| 4 | RTMP fan-out to Twitch / YouTube / Kick | |
| 5 | VOD `AS OF` scrub (seq ↔ timestamp) | |
| 6 | Tips: ITC/wITC + Stripe as events | deferred |
| 7 | Audience-side interaction | undesigned |

## Run it

```bash
npm install
npm run dev          # http://localhost:3400
```

Production:

```bash
npm run build
npm start            # Express on :3401 serving dist/, /api/health reports nedbd reachability
```

## Try it (numbered, so a pass/fail means something)

1. Open the studio. Expect: dark canvas, "Screen: no source" full-bleed, a rounded "Camera: no source" box bottom-right, header shows `1920×1080` and a live fps counter.
2. Click **Share screen / game**, pick a window or tab. Expect: your screen letterboxed on the canvas; the Sources list shows `screen`.
3. Click **Add camera**, allow. Expect: your face in the corner, mirrored, rounded. Sources shows the camera label.
4. Drag the camera box anywhere. Expect: it moves, never leaves the canvas, and comes to the front.
5. Grab a corner of the camera box and drag. Expect: it resizes and stays 16:9.
6. Change Shape to **Circle** in the right rail. Expect: round camera. Resize keeps it round.
7. Click **Add microphone**, allow, speak. Expect: a channel appears under Audio with a moving meter; the slider changes the level number.
8. Share a **Chrome tab** that is playing audio (macOS: tab only — window/screen give no audio, and the studio tells you so). Expect: a second audio channel.
9. Deny the camera permission on purpose. Expect: a red notice with the browser's own error name, not a silent black box.
10. Click the browser's "Stop sharing" bar. Expect: the screen layer returns to "no source" and a notice says the source ended.

## Honest limits (browser reality, not marquee's choice)
- Browser encode ceiling is ~1080p30 in practice. We do not promise 4K60.
- macOS system/game audio capture is Chrome **tab** audio only. Whole-screen audio capture is Windows/ChromeOS.
- WebRTC media (step 2) cannot ride Cloudflare's orange cloud; mediamtx needs a direct port or grey-cloud host.

## License
BUSL-1.1 (Licensor: Interchained LLC; Change Date 2030-09-08; Change License GPL-3.0-only). See `LICENSE` and `COPYING-GPL-3.0.txt`.

© Interchained LLC × Vex
