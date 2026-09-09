# Recording to MP4 — why it is two steps

Recording is marquee's primary function. Going live is the option.

## The measured constraint

In Electron 44 / Chromium 152, `MediaRecorder` gives you the right codec **or**
the right container, never both. Measured by recording real bytes out of the
real shell and probing them — `isTypeSupported` answers `true` for things that
do not do what the name says:

| Requested | What actually lands on disk |
|---|---|
| `video/mp4` | a real MP4 (`ftypisom`) containing **VP9/opus** — QuickTime and most editors refuse it |
| `video/mp4;codecs="avc1.42E01E,mp4a.40.2"` | the **constructor throws** |
| `video/webm;codecs="h264,opus"` | silently becomes **`video/x-matroska;codecs=avc1,opus`** |
| `video/webm;codecs="vp9,opus"` | webm vp9/opus |
| (default) | webm vp8/opus |

So: record **H.264/opus into Matroska** (the best codec available), then remux
to MP4 by **copying** the video stream. No second generation of loss, ~24x
realtime. Only the audio is re-encoded, because opus in MP4 is legal but badly
supported.

`pickRecordingFormat` in `artifacts/studio/src/lib/studio/recorder.ts` holds the
preference order, and each entry carries the note the UI shows. A machine with
no H.264 encoder falls back to VP9 and the panel says out loud that MP4 would
need a re-encode — `canStreamCopyToMp4` is false and the finalise is not offered.

## The path

1. **Renderer** (`lib/studio/recorder.ts`) — `RecordingSession` drives
   MediaRecorder with a 1s timeslice. Chunks go through a single promise chain:
   `dataavailable` is synchronous, the write is not, and without the chain a
   slow disk interleaves chunks and corrupts the container.
2. **Shell** (`desktop/shell/src/recorder.ts`) — `RecordingSink` appends each
   chunk to a file. Nothing is buffered in the page, so an hour of 1080p costs
   the renderer nothing and a crash costs the tail, not the take.
3. **Python** (`desktop/py-runtime/remux.py`, `POST /remux`) — PyAV with
   bundled ffmpeg. Video stream-copied, audio opus -> AAC. Reads the result
   back with `av.open()` rather than trusting what it wrote.

`/health` reports `remux: {pyav, libavcodec, ...}` so the Studio knows whether
finalising is possible **before** offering it. Absent -> the route answers 501,
not 500.

## Rules this path does not bend

- **A recording is never deleted.** Not on abort, not on a failed finalise, not
  to reclaim space. `abort()` keeps the partial file and reports its path — a
  partial Matroska is usually still playable. The remux writes a **new** file
  beside the source; removing the intermediate is the operator's call in the
  UI, never a side effect.
- **A finalise failure is not a recording failure.** They are separate receipts
  (`recording_stopped` vs `recording_finalised` / `recording_error`) and
  separate messages, because conflating them sends the operator looking for a
  file that is sitting right there.
- **The fd is opened synchronously.** `createWriteStream(path)` defers the open
  to the event loop, so `begin()` would return before the file exists and a
  permissions error would arrive as an `error` event *after* the take. Opening
  with `openSync(path, "wx")` and handing the stream an fd means an unwritable
  path throws while the operator is still looking at the button. `wx` also
  means a name collision can never truncate an earlier take — the name gets a
  `-2` suffix and retries.
- **Recordings land in `~/Videos/marquee`**, not an app-support directory.
  `app.getPath("videos")` *throws* where the path is unset (headless Linux),
  so the fallback to `<dataDir>/recordings` is a real code path.
- **Quitting mid-take flushes and keeps the file.** `shutdown()` calls
  `closeAll()` before anything else goes down.

## Verified on the real running system (2026-09-09)

Headless Electron (Xvfb) driven end to end: a 1920x1080 take recorded from the
live compositor, `recording started` -> `recording finished` (621,441 bytes,
5 chunks), finalised through the HTTP route, and confirmed with **ffprobe, not
PyAV**: `format_long_name=QuickTime / MOV`, `codec_name=h264`, 1920x1080,
`duration=4.957`, 149 frames, `avg_frame_rate=30.06`, and a full decode pass
with **zero errors**. Receipts `recording_started` -> `recording_stopped` ->
`recording_finalised` chained into the store's Merkle head.

### Known trait: the MP4 is variable frame rate

The source Matroska declares `avg_frame_rate=0/0` — MediaRecorder output is
genuinely VFR. The MP4 therefore reports a nonsense `r_frame_rate`
(`1000000/1`) while `avg_frame_rate`, `nb_frames` and `duration` are all
correct and consistent. This is inherited from the source, not introduced by
the remux. Forcing CFR would require re-encoding the video, which is exactly
the loss the stream copy exists to avoid, so it is deliberately not done.
