"""
Turn a recording plus its cursor track into a zoomed edit.

THE IDEA, and why it is worth doing at all: a screen recording of a 4K display
watched at 1080p is unreadable — text is a quarter of its real size. The fix is
not "record smaller", it is to CROP the region that matters and scale that to
the delivery size. Crop a 1920x1080 window out of a 3840x2160 source and you
get a 2x zoom at full native sharpness, with no upscaling anywhere.

That is the whole reason takes are recorded at the display's native resolution.
A zoom into an already-downscaled composite is mush; a zoom into a native
capture is just... the pixels that were always there.

WHAT DECIDES WHERE TO LOOK: the cursor track written beside the take
(`<take>.cursor.jsonl`). People dwell where they are working and travel when
they are moving on, so:

  - a DWELL -- the cursor staying inside a small radius for long enough --
    becomes a zoom in, centred on where they settled;
  - TRAVEL, or the cursor leaving the display entirely, becomes a zoom out, so
    the viewer never loses the context of where the pointer went;
  - everything between two keyframes is eased, not cut, because a hard jump
    between framings reads as a mistake rather than a decision.

WHAT THIS DELIBERATELY DOES NOT DO: guess from clicks. Global mouse-button
events need a native hook that is not available, so there is no click signal in
the track and no pretending otherwise. Dwell is the honest substitute and it
carries most of the same information -- you click where you have settled.

COST: this re-encodes. A zoom is a different pixel for every pixel, so there is
no stream copy to be had; unlike `remux.py`, this pass genuinely pays for every
frame. Output at the delivery size rather than the source size keeps that bill
proportionate: 1080p out of 4K in is a cheap encode of a small frame, not an
expensive encode of a large one.

THE SOURCE IS NEVER MODIFIED OR DELETED. This writes a new file beside it, like
every other pass in this app.
"""

from __future__ import annotations

import json
import logging
import math
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Optional, Sequence

log = logging.getLogger("ua-py-runtime")


class ZoomUnavailable(RuntimeError):
    """PyAV is missing. Named so the route can answer 501 rather than 500."""


# --------------------------------------------------------------------- reading


@dataclass
class CursorSample:
    """One row of the track: milliseconds since the take started, plus position."""

    t_ms: int
    x: float
    y: float
    inside: bool


@dataclass
class CursorTrackFile:
    display: dict[str, int]
    samples: list[CursorSample]
    header: dict[str, Any]


def load_cursor_track(path: str) -> CursorTrackFile:
    """Read a `.cursor.jsonl` track.

    Tolerant on purpose: a take that ended badly leaves a truncated final line,
    and losing the whole track over one broken row would throw away every good
    sample before it. Bad rows are skipped and counted, never guessed at.
    """
    p = Path(path)
    if not p.is_file():
        raise FileNotFoundError(f"no cursor track at {path}")

    header: dict[str, Any] = {}
    samples: list[CursorSample] = []
    skipped = 0

    # A binary file handed over as a track (the recording itself, most likely)
    # would otherwise surface as a raw UnicodeDecodeError about byte offsets,
    # which tells the operator nothing about what they actually got wrong.
    try:
        text = p.read_text(encoding="utf-8")
    except UnicodeDecodeError as exc:
        raise ValueError(
            f"{path} is not a text cursor track — it looks like binary data. "
            "Point this at the .cursor.jsonl written beside the recording, not at the recording itself."
        ) from exc

    for index, raw_line in enumerate(text.splitlines()):
        line = raw_line.strip()
        if not line:
            continue
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError:
            # Almost always the truncated last line of an aborted take.
            skipped += 1
            continue
        if index == 0 and isinstance(parsed, dict):
            header = parsed
            continue
        if not isinstance(parsed, list) or len(parsed) < 4:
            skipped += 1
            continue
        try:
            samples.append(
                CursorSample(t_ms=int(parsed[0]), x=float(parsed[1]), y=float(parsed[2]), inside=bool(parsed[3]))
            )
        except (TypeError, ValueError):
            skipped += 1

    if header.get("kind") != "marquee-cursor-track":
        raise ValueError(
            f"{path} is not a marquee cursor track (its header says kind={header.get('kind')!r}). "
            "Point this at the .cursor.jsonl written beside the recording."
        )
    if skipped:
        log.warning("skipped %d unreadable row(s) in %s", skipped, p.name)

    display = header.get("display") or {}
    return CursorTrackFile(display=display, samples=samples, header=header)


# -------------------------------------------------------------------- planning


@dataclass
class ZoomKeyframe:
    """Where to look at a moment in time.

    `scale` is how much of the frame is visible: 1.0 is the whole frame, 0.5 is
    a half-width crop, i.e. a 2x zoom. `x`/`y` are the CENTRE of the crop in
    0..1 of the source frame.
    """

    t_ms: int
    x: float
    y: float
    scale: float

    def as_dict(self) -> dict[str, Any]:
        return {"tMs": self.t_ms, "x": round(self.x, 4), "y": round(self.y, 4), "scale": round(self.scale, 4)}


@dataclass
class ZoomPlan:
    keyframes: list[ZoomKeyframe]
    notes: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return {"keyframes": [k.as_dict() for k in self.keyframes], "notes": self.notes}


def _mean(values: Sequence[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def plan_zooms(
    samples: Sequence[CursorSample],
    duration_ms: int,
    *,
    zoom_scale: float = 0.5,
    dwell_ms: int = 700,
    dwell_radius: float = 0.06,
    min_hold_ms: int = 1200,
    ease_ms: int = 450,
) -> ZoomPlan:
    """Cursor samples -> zoom keyframes. Pure, and the interesting half of this file.

    The rules, each of which exists because its absence looks broken:

    - A DWELL is `dwell_ms` of the cursor staying inside `dwell_radius`. That is
      someone working somewhere, which is what a viewer wants to see closely.
    - A zoom is held for at least `min_hold_ms`. Without a floor, a cursor that
      pauses twice in quick succession produces two zooms half a second apart,
      which is nauseating to watch.
    - Leaving the display ends the zoom. The track flags this, and chasing a
      clamped edge coordinate would slam the crop into the border.
    - Every change is a PAIR of keyframes, `ease_ms` apart, so the renderer
      interpolates a move instead of cutting.
    - The centre of a dwell is the MEAN of its samples, not the last one: the
      final sample of a dwell is often the start of the movement out of it.
    """
    if zoom_scale <= 0 or zoom_scale > 1:
        raise ValueError(f"zoom_scale must be in (0, 1]; got {zoom_scale}")

    plan = ZoomPlan(keyframes=[])
    wide = 1.0

    # Always start wide. A recording that opens mid-zoom gives the viewer no
    # idea what they are looking at.
    plan.keyframes.append(ZoomKeyframe(t_ms=0, x=0.5, y=0.5, scale=wide))

    if not samples:
        plan.notes.append("The cursor track has no samples, so the edit stays wide throughout.")
        return plan

    usable = [s for s in samples if s.inside]
    if not usable:
        plan.notes.append(
            "The cursor was never on the captured display, so there was nothing to zoom toward."
        )
        return plan

    # Walk the samples, accumulating candidate dwells.
    dwell_start = 0
    zoomed_until = -1  # end of the current hold, in ms
    zooms = 0

    i = 0
    while i < len(usable):
        anchor = usable[dwell_start]
        current = usable[i]

        drifted = math.hypot(current.x - anchor.x, current.y - anchor.y) > dwell_radius
        if drifted or not current.inside:
            dwell_start = i
            i += 1
            continue

        held_for = current.t_ms - anchor.t_ms
        if held_for < dwell_ms:
            i += 1
            continue

        # A dwell. Collect every sample in it so the centre is the mean.
        window = [s for s in usable[dwell_start : i + 1]]
        cx, cy = _mean([s.x for s in window]), _mean([s.y for s in window])
        start_ms = anchor.t_ms

        if start_ms < zoomed_until:
            # Already zoomed and still inside the hold: extend rather than
            # re-zoom, so a long working period is one steady shot.
            i += 1
            continue

        # Zoom in: wide at the dwell's start, tight one ease later.
        plan.keyframes.append(ZoomKeyframe(t_ms=start_ms, x=cx, y=cy, scale=wide))
        plan.keyframes.append(ZoomKeyframe(t_ms=start_ms + ease_ms, x=cx, y=cy, scale=zoom_scale))
        zooms += 1

        # Find where the dwell ends: the first sample that leaves the radius or
        # the display.
        j = i
        while j < len(usable):
            s = usable[j]
            if math.hypot(s.x - cx, s.y - cy) > dwell_radius:
                break
            j += 1
        end_ms = usable[j].t_ms if j < len(usable) else duration_ms
        end_ms = max(end_ms, start_ms + min_hold_ms)

        # Zoom back out, eased.
        plan.keyframes.append(ZoomKeyframe(t_ms=end_ms, x=cx, y=cy, scale=zoom_scale))
        plan.keyframes.append(ZoomKeyframe(t_ms=end_ms + ease_ms, x=0.5, y=0.5, scale=wide))

        zoomed_until = end_ms + ease_ms
        dwell_start = j
        i = max(j, i + 1)

    if zooms == 0:
        plan.notes.append(
            f"No dwell lasted {dwell_ms}ms within {dwell_radius:.3f} of a point, so the edit stays wide. "
            "The cursor was either always moving or always still off-display."
        )
    else:
        plan.notes.append(f"{zooms} zoom(s) from cursor dwells.")

    # Keyframes must be sorted and strictly increasing for interpolation to be
    # meaningful; overlapping eases can otherwise emit a keyframe out of order.
    plan.keyframes.sort(key=lambda k: k.t_ms)
    deduped: list[ZoomKeyframe] = []
    for frame in plan.keyframes:
        if deduped and frame.t_ms == deduped[-1].t_ms:
            deduped[-1] = frame  # last write wins at a shared timestamp
            continue
        deduped.append(frame)
    plan.keyframes = deduped
    return plan


def ease_in_out(t: float) -> float:
    """Cubic ease. Pure; tested.

    Linear interpolation between framings reads as a machine panning. Easing in
    and out of every move is the difference between "a camera moved" and "the
    crop rectangle changed".
    """
    t = min(1.0, max(0.0, t))
    return 4 * t * t * t if t < 0.5 else 1 - pow(-2 * t + 2, 3) / 2


def sample_plan(keyframes: Sequence[ZoomKeyframe], t_ms: float) -> tuple[float, float, float]:
    """The (x, y, scale) at a moment, eased between keyframes. Pure; tested."""
    if not keyframes:
        return 0.5, 0.5, 1.0
    if t_ms <= keyframes[0].t_ms:
        first = keyframes[0]
        return first.x, first.y, first.scale
    if t_ms >= keyframes[-1].t_ms:
        last = keyframes[-1]
        return last.x, last.y, last.scale

    # Linear scan: plans are tens of keyframes, not thousands.
    for index in range(len(keyframes) - 1):
        a, b = keyframes[index], keyframes[index + 1]
        if a.t_ms <= t_ms <= b.t_ms:
            span = b.t_ms - a.t_ms
            progress = 0.0 if span <= 0 else ease_in_out((t_ms - a.t_ms) / span)
            return (
                a.x + (b.x - a.x) * progress,
                a.y + (b.y - a.y) * progress,
                a.scale + (b.scale - a.scale) * progress,
            )
    last = keyframes[-1]
    return last.x, last.y, last.scale


def crop_rect(
    centre_x: float,
    centre_y: float,
    scale: float,
    source_width: int,
    source_height: int,
    target_aspect: float,
) -> tuple[int, int, int, int]:
    """Centre + scale -> an integer crop rect inside the frame. Pure; tested.

    Three constraints, all of which produce visible damage when broken:

    1. The crop must match the OUTPUT aspect ratio, or the encode stretches.
    2. The crop must stay inside the frame. A crop near an edge is slid back in
       rather than clamped smaller, because changing the crop SIZE mid-move
       changes the zoom level and reads as a lurch.
    3. Width and height must be EVEN. H.264 4:2:0 cannot represent odd
       dimensions -- the same rule the canvas has to obey.
    """
    scale = min(1.0, max(0.05, scale))

    # Start from the largest rect of the target aspect that fits the source,
    # then shrink by `scale`.
    if source_width / source_height > target_aspect:
        base_h = float(source_height)
        base_w = base_h * target_aspect
    else:
        base_w = float(source_width)
        base_h = base_w / target_aspect

    crop_w = base_w * scale
    crop_h = base_h * scale

    # Slide, do not shrink: keeps the zoom level constant near the edges.
    left = centre_x * source_width - crop_w / 2
    top = centre_y * source_height - crop_h / 2
    left = min(max(0.0, left), source_width - crop_w)
    top = min(max(0.0, top), source_height - crop_h)

    even = lambda n: max(2, int(n) // 2 * 2)  # noqa: E731
    return int(left), int(top), even(crop_w), even(crop_h)


# ------------------------------------------------------------------- rendering


@dataclass
class ZoomResult:
    source: str
    output: str
    cursor_track: str
    output_bytes: int
    width: int
    height: int
    frames: int
    keyframes: int
    duration_seconds: Optional[float]
    took_seconds: float
    notes: list[str] = field(default_factory=list)

    outputs: list[dict[str, Any]] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return {
            "source": self.source,
            # `output` stays the primary file so existing callers keep working;
            # `outputs` carries every shape that was rendered.
            "output": self.output,
            "outputs": self.outputs,
            "cursorTrack": self.cursor_track,
            "outputBytes": self.output_bytes,
            "width": self.width,
            "height": self.height,
            "frames": self.frames,
            "keyframes": self.keyframes,
            "durationSeconds": self.duration_seconds,
            "tookSeconds": round(self.took_seconds, 3),
            "notes": self.notes,
        }


@dataclass(frozen=True)
class ZoomTarget:
    """One delivery format: a name and the frame it fills.

    Named rather than inferred, because "9:16" is what a creator asks for and
    "1080x1920" is what the encoder needs. The name also becomes part of the
    filename, so a folder of exports is readable without opening anything.
    """

    label: str
    width: int
    height: int

    @property
    def aspect(self) -> float:
        return self.width / self.height


# The three shapes a creator actually posts. Widescreen keeps the plain name
# because it is the default; the others are suffixed so a folder of exports
# reads at a glance.
TARGET_WIDE = ZoomTarget("16x9", 1920, 1080)
TARGET_SQUARE = ZoomTarget("1x1", 1080, 1080)
TARGET_VERTICAL = ZoomTarget("9x16", 1080, 1920)
DEFAULT_TARGETS = (TARGET_WIDE,)
KNOWN_TARGETS = {t.label: t for t in (TARGET_WIDE, TARGET_SQUARE, TARGET_VERTICAL)}


def target_output_path(source: str, target: ZoomTarget, primary_label: str = "16x9") -> str:
    """Where one target's file goes. Pure; tested.

    The primary shape gets `<name>.zoomed.mp4`; every other shape carries its
    label. Never the source itself, whatever the source's extension.
    """
    stem = str(Path(source).with_suffix(""))
    if target.label == primary_label:
        return f"{stem}.zoomed.mp4"
    return f"{stem}.zoomed-{target.label}.mp4"


def default_output_path(source: str) -> str:
    """`<name>.zoomed.mp4` beside the source. Never the source itself."""
    return target_output_path(source, TARGET_WIDE)


def render_zoom(
    source: str,
    cursor_track: str,
    output: Optional[str] = None,
    *,
    targets: Sequence[ZoomTarget] = DEFAULT_TARGETS,
    zoom_scale: float = 0.5,
    audio_bitrate: int = 160_000,
    video_bitrate: int = 8_000_000,
) -> ZoomResult:
    """Render `source` into one zoomed edit per target shape.

    THE SOURCE IS DECODED ONCE. Rendering three aspect ratios as three separate
    passes would decode a 4K take three times, and decoding is the expensive
    half — so every target gets its own encoder and filter graph, all fed from
    a single decode. The crop CENTRE comes from one shared plan; only the crop
    RECT differs per shape.

    Which is the whole reason vertical is worth offering at all: a 9:16 crop of
    a 16:9 screen throws away 68% of the width, so a blind centre-crop is
    useless. Knowing where the cursor was is what makes it watchable.

    Raises ZoomUnavailable without PyAV, FileNotFoundError for a missing input,
    and ValueError for an input this cannot work with.
    """
    try:
        import av
        import av.audio.resampler
        import av.filter
    except ImportError as exc:
        raise ZoomUnavailable(
            "PyAV is not installed in this runtime, so a zoomed edit cannot be rendered. "
            "Reinstall the runtime's dependencies (pip install -r requirements.txt)."
        ) from exc

    src = Path(source)
    if not src.is_file():
        raise FileNotFoundError(f"no recording at {source}")
    if src.stat().st_size == 0:
        raise ValueError(f"the recording at {source} is empty — nothing was captured")

    if not targets:
        raise ValueError("no output shapes were requested; there is nothing to render")
    for target in targets:
        if target.width % 2 or target.height % 2:
            raise ValueError(
                f"the {target.label} output size must be even on both axes; got {target.width}x{target.height}"
            )

    track = load_cursor_track(cursor_track)

    primary = targets[0]
    # An explicit `output` names the PRIMARY file; the rest are derived, because
    # one caller-supplied path cannot describe three files.
    paths: dict[str, str] = {}
    for target in targets:
        paths[target.label] = (
            output
            if (output and target.label == primary.label)
            else target_output_path(source, target, primary_label=primary.label)
        )
        if Path(paths[target.label]).resolve() == src.resolve():
            raise ValueError(
                f"the {target.label} output path is the source path; refusing to overwrite the recording"
            )
    if len(set(paths.values())) != len(paths):
        raise ValueError(f"two targets resolved to the same output path: {sorted(paths.values())}")

    started = time.monotonic()
    frames = 0
    notes: list[str] = []

    with av.open(str(src)) as inp:
        if not inp.streams.video:
            raise ValueError(f"{source} has no video stream")
        vin = inp.streams.video[0]
        ain = inp.streams.audio[0] if inp.streams.audio else None
        src_w = vin.codec_context.width
        src_h = vin.codec_context.height
        duration_ms = int((inp.duration or 0) / 1000) if inp.duration else 0
        if not duration_ms and track.samples:
            # Matroska from MediaRecorder often reports no container duration;
            # the track's own last timestamp beats zero.
            duration_ms = track.samples[-1].t_ms

        plan = plan_zooms(track.samples, duration_ms, zoom_scale=zoom_scale)
        notes.extend(plan.notes)

        # One sink per target: its own container, streams, resampler and filter
        # graph cache. A graph's parameters are fixed at configure time and PyAV
        # exposes no send_command, so a changing crop needs a new graph —
        # measured at 6.41ms fresh against 1.95ms reused, hence the cache. A
        # HOLD does not change the rect at all, and holds are most of any take.
        sinks: list[dict[str, Any]] = []
        try:
            for target in targets:
                container = av.open(paths[target.label], mode="w", format="mp4")
                vout = container.add_stream("h264", rate=30)
                vout.width = target.width
                vout.height = target.height
                vout.pix_fmt = "yuv420p"
                # Scale the bitrate with the pixel count, so a 1080x1080 square
                # is not given the same budget as a 1920x1080 frame.
                pixel_ratio = (target.width * target.height) / (TARGET_WIDE.width * TARGET_WIDE.height)
                vout.codec_context.bit_rate = max(500_000, int(video_bitrate * pixel_ratio))

                aout = None
                resampler = None
                if ain is not None:
                    aout = container.add_stream("aac", rate=ain.codec_context.rate or 48_000)
                    aout.codec_context.bit_rate = audio_bitrate
                    resampler = av.audio.resampler.AudioResampler(
                        format=aout.codec_context.format,
                        layout=aout.codec_context.layout,
                        rate=aout.codec_context.rate,
                    )

                if target.width > src_w or target.height > src_h:
                    notes.append(
                        f"The {target.label} output ({target.width}x{target.height}) is larger than the source "
                        f"({src_w}x{src_h}) on at least one axis, so zoomed regions are upscaled."
                    )

                sinks.append(
                    {
                        "target": target,
                        "container": container,
                        "vout": vout,
                        "aout": aout,
                        "resampler": resampler,
                        "graph": None,
                        "rect": None,
                        "rebuilds": 0,
                    }
                )

            # Decode through the CONTAINER, not packet.decode().
            #
            # Measured, not stylistic: on PyAV 15 `packet.decode()` yielded ZERO
            # video frames from a MediaRecorder Matroska, because the leading
            # packets carry the codec's SPS/PPS and a loop that skips dts=None
            # packets before decoding starves the decoder of them. That failure
            # is SILENT — an output file with no video stream and no error
            # anywhere — which is why this function reads its results back
            # before reporting success.
            streams = [vin] + ([ain] if ain is not None else [])
            for frame in inp.decode(*streams):
                if isinstance(frame, av.VideoFrame):
                    if frame.pts is not None and frame.time_base:
                        t_ms = float(frame.pts * frame.time_base * 1000)
                    else:
                        t_ms = frames * (1000 / 30)

                    cx, cy, scale = sample_plan(plan.keyframes, t_ms)

                    for sink in sinks:
                        target = sink["target"]
                        rect = crop_rect(cx, cy, scale, src_w, src_h, target.aspect)
                        if rect != sink["rect"] or sink["graph"] is None:
                            left, top, crop_w, crop_h = rect
                            graph = av.filter.Graph()
                            buffer = graph.add_buffer(
                                width=src_w,
                                height=src_h,
                                format=frame.format.name,
                                time_base=frame.time_base,
                            )
                            cropper = graph.add("crop", f"w={crop_w}:h={crop_h}:x={left}:y={top}")
                            scaler = graph.add("scale", f"w={target.width}:h={target.height}")
                            sink_node = graph.add("buffersink")
                            buffer.link_to(cropper)
                            cropper.link_to(scaler)
                            scaler.link_to(sink_node)
                            graph.configure()
                            sink["graph"] = graph
                            sink["rect"] = rect
                            sink["rebuilds"] += 1

                        sink["graph"].push(frame)
                        filtered = sink["graph"].pull()
                        # KEEP the pts and time_base the graph carried through
                        # from the source. Measured both ways: clearing the pts
                        # so "the encoder assigns its own" muxes ~20 frames and
                        # then dies with "Invalid argument" at the flush.
                        for encoded in sink["vout"].encode(filtered):
                            sink["container"].mux(encoded)
                    frames += 1

                elif isinstance(frame, av.AudioFrame):
                    # A zoom does not alter the soundtrack. Every output gets
                    # the same audio, re-encoded once per container because a
                    # stream cannot be shared between them.
                    for sink in sinks:
                        if sink["aout"] is None or sink["resampler"] is None:
                            continue
                        for rframe in sink["resampler"].resample(frame):
                            rframe.pts = None
                            for encoded in sink["aout"].encode(rframe):
                                sink["container"].mux(encoded)

            for sink in sinks:
                for encoded in sink["vout"].encode(None):
                    sink["container"].mux(encoded)
                if sink["aout"] is not None:
                    for encoded in sink["aout"].encode(None):
                        sink["container"].mux(encoded)
        finally:
            # Close every container even if one of them failed, or a half-written
            # MP4 is left with no moov atom and looks like corruption.
            for sink in sinks:
                try:
                    sink["container"].close()
                except Exception as exc:  # pragma: no cover - reported, never swallowed
                    log.error("could not close the %s output: %s", sink["target"].label, exc)

        total_rebuilds = sum(int(s["rebuilds"]) for s in sinks)
        notes.append(
            f"{frames} frame(s) decoded once and filtered into {len(sinks)} shape(s) "
            f"through {total_rebuilds} crop graph(s)."
        )

    took = time.monotonic() - started

    # Read every RESULT back rather than trusting what was just written.
    outputs: list[dict[str, Any]] = []
    primary_duration: Optional[float] = None
    for sink in sinks:
        target = sink["target"]
        path = paths[target.label]
        with av.open(path) as check:
            if not check.streams.video:
                raise ValueError(
                    f"the rendered {target.label} file has no video stream; the encode produced nothing usable"
                )
            duration = check.duration / 1_000_000 if check.duration else None
            has_audio = bool(check.streams.audio)
        if target.label == primary.label:
            primary_duration = duration
        outputs.append(
            {
                "label": target.label,
                "path": path,
                "width": target.width,
                "height": target.height,
                "bytes": Path(path).stat().st_size,
                "durationSeconds": round(duration, 3) if duration else None,
                "hasAudio": has_audio,
                "cropGraphs": int(sink["rebuilds"]),
            }
        )

    result = ZoomResult(
        source=str(src),
        output=paths[primary.label],
        cursor_track=cursor_track,
        output_bytes=Path(paths[primary.label]).stat().st_size,
        width=primary.width,
        height=primary.height,
        frames=frames,
        keyframes=len(plan.keyframes),
        duration_seconds=round(primary_duration, 3) if primary_duration else None,
        took_seconds=took,
        notes=notes,
        outputs=outputs,
    )
    log.info(
        "rendered %d zoomed shape(s) from %s (%d frames, %d keyframes, %.1fs)",
        len(outputs), src.name, frames, len(plan.keyframes), took,
    )
    return result


def library_versions() -> Optional[dict[str, Any]]:
    """What this pass needs: PyAV, and the crop/scale filters it drives."""
    try:
        import av
        import av.filter
    except ImportError:
        return None
    available = getattr(av.filter, "filters_available", set()) or set()
    return {
        "pyav": av.__version__,
        "crop": "crop" in available,
        "scale": "scale" in available,
    }
