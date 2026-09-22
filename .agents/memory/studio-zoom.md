# The zoom pass — why it works, and what it cost to get right

A screen recording of a 4K display watched at 1080p is unreadable: text is a
quarter of its real size. The fix is not "record smaller", it is to **crop the
region that matters and scale that to the delivery size**. A 1920x1080 window
out of a 3840x2160 capture is a 2x zoom at full native sharpness, with no
upscaling anywhere.

This is the entire reason takes are recorded at the display's native
resolution. A zoom into an already-downscaled composite is mush.

## Where it looks: the cursor track

`<take>.cursor.jsonl`, written by the shell (see `studio-recording.md`).
People dwell where they are working and travel when they are moving on:

- a **dwell** — the cursor inside `dwell_radius` for `dwell_ms` — becomes a
  zoom in, centred on the **mean** of the dwell's samples, not the last one
  (the final sample of a dwell is usually the start of the movement out of it,
  so anchoring on it aims the camera where the cursor *left*);
- **travel**, or the cursor leaving the display, becomes a zoom out;
- every change is a **pair** of keyframes `ease_ms` apart, so the render
  interpolates a move instead of cutting;
- a zoom is held for at least `min_hold_ms`. Without that floor, a cursor that
  settles twice in a second produces two zooms half a second apart, which is
  nauseating to watch.

**No clicks.** Global mouse-button events need a native hook that is not
available, so there is no click signal and no pretending otherwise. Dwell is
the honest substitute — you click where you have settled.

## Four bugs this cost, all found by running it

Every one of these was written, looked correct, and was wrong. Listed because
each would have been silent in production.

1. **`packet.decode()` yields ZERO video frames on PyAV 15.** The loop skipped
   packets with `dts is None` before decoding — and those leading packets carry
   the codec's SPS/PPS. Starved of its headers the decoder emitted nothing, and
   the result was **an output file with no video stream and no error anywhere**.
   Use `container.decode(*streams)` instead: it handles the headers and
   interleaves both streams in one read. This is why `render_zoom` reads its own
   output back before reporting success.

2. **Clearing `frame.pts` so "the encoder assigns its own" corrupts the mux.**
   Measured both ways on the same clip: preserving the pts the filter graph
   carried through encoded all 60 test frames cleanly; clearing it muxed ~20
   and then died with `[Errno 22] Invalid argument` at the flush. Keep the pts.

3. **`frame.time_base = None` raises.** PyAV wants a Fraction. Clearing the pts
   alone was already the whole intent.

4. **There is no numpy in this runtime.** The first crop used
   `frame.to_ndarray()` as a fallback, which would have failed at runtime on
   the operator's machine for a path unit tests never touched. Cropping goes
   through **libavfilter** (`crop` then `scale`) instead: no array round trip,
   no new dependency. `reformat(crop=...)` is not available on PyAV 15 either —
   checked, not assumed.

## Performance, measured

A filter graph's parameters are fixed at configure time and PyAV exposes no
`send_command`, so a changing crop needs a new graph:

| | |
|---|---|
| fresh graph per frame | 6.41 ms |
| reused graph | 1.95 ms |

So the last graph is **cached** and reused while the rect is unchanged. During
a hold the rect does not change at all, and holds are most of any take — on the
verification clip, **180 frames needed only 28 graphs**.

Overall the pass runs at roughly **2.5x realtime** (15s for a 6s 2560x1440
clip). Unlike `remux.py` this genuinely re-encodes every frame; there is no
stream copy to be had from a zoom. Output at the delivery size rather than the
source size keeps the bill proportionate.

`/zoom/plan` exists so the UI can say how many zooms were found **instantly**,
before anyone commits minutes to an encode.

## Verified independently (2026-09-09)

Rendered a 6s 2560x1440 clip with a synthetic dwell track, then compared frames
with **ffmpeg's PSNR filter** rather than trusting the library that wrote them:

| Comparison | PSNR | Reading |
|---|---|---|
| rendered zoom vs an ffmpeg-cropped source frame | **52.8 dB** | identical — the crop is exact |
| rendered zoom vs the **uncropped** source frame | **3.2 dB** | totally different — a zoom really happened |
| rendered wide section vs source | **33.5 dB** | matches (downscale + h264 on noise) |

Output: h264 1920x1080 + **aac**, `QuickTime / MOV`, 6.021s, full decode with
zero errors. The zoomed frame is 34KB against 416KB for the wide frame —
magnified content carries less detail per pixel, which corroborates the crop
from a third direction.

Every route error path names itself: **404** missing take or track, **422** a
binary file handed over as a track (says so in words, rather than leaking a
`UnicodeDecodeError` about byte offsets), **501** no PyAV, **401** untokened.

## Rules

- **The source is never modified or deleted.** A new file lands beside it.
- **A zoom failure is not a recording failure.** Separate receipt
  (`recording_zoomed` vs `recording_error` with `phase: "zoom"`), and the
  message says the take and its MP4 are untouched — conflating them sends
  someone hunting for a recording that is sitting right there.
- **Runs in `asyncio.to_thread`.** A long render on the event loop would block
  `/health` long enough for the supervisor to restart the runtime mid-encode.

## Multi-aspect export, and why vertical needs the cursor track

One take renders to as many delivery shapes as asked for — **16x9** (1920x1080),
**1x1** (1080x1080), **9x16** (1080x1920) — and the **source is decoded once**
for all of them. Rendering three aspects as three passes would decode a 4K take
three times, and decoding is the expensive half. Each shape gets its own
encoder and its own filter-graph cache; only the crop RECT differs, since the
crop CENTRE comes from one shared plan.

Measured: three shapes from a 6s 2560x1440 clip in **25.7s**, against ~45s for
three separate renders.

**A 9:16 crop of a 16:9 screen discards about 68% of the width.** A blind
centre-crop is therefore useless for a screen recording — you would be cropping
away most of what was on screen with no idea what mattered. Vertical export is
only worth offering *because* the cursor track says where the work was. Proven
with ffmpeg PSNR against the rendered vertical frame:

| Compared against | PSNR | Reading |
|---|---|---|
| the cursor-followed crop | **60.4 dB** | identical |
| a blind centre crop | **3.1 dB** | nothing alike |

Same for square: 56.5 dB against its aimed crop, 2.8 dB against the centre.

Details that matter:

- **The FIRST shape requested is primary** and gets the plain `.zoomed.mp4`;
  the rest carry their label (`.zoomed-9x16.mp4`). Ask for vertical first and
  the plain-named file is vertical — deliberate, so "the one I wanted" is the
  one without a suffix.
- **Duplicates are dropped, order preserved.** Two identical labels would
  collide on one output path.
- **Bitrate scales with pixel count**, so a 1080x1080 square is not handed the
  same budget as a 1920x1080 frame.
- **Every container is closed in a `finally`.** A half-written MP4 with no moov
  atom looks exactly like corruption.
- The UI never lets the last shape be deselected — there would be nothing to
  render.

### A 500 that should have been a 422

The target-validation `HTTPException` was originally raised INSIDE the route's
`try`, where the broad `except Exception` caught it and re-wrapped it: a
request for an unknown shape came back as **500** with `HTTPException: 422`
buried in the message, telling the caller a bad request was a server fault.
Fixed by validating before the `try`, and both `/zoom` and `/remux` now carry
an explicit `except HTTPException: raise` so the whole class cannot recur.
