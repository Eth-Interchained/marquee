"""
Finalise a recording into a real MP4.

WHY THIS EXISTS — measured, not assumed. In Electron 44 (Chromium 152),
`MediaRecorder` can give you the right codec or the right container, never
both:

    video/mp4                          -> a real MP4, but VP9/opus inside it.
                                          Legal; QuickTime and most editors
                                          will not touch it.
    video/mp4 + codecs="avc1…,mp4a…"   -> the constructor THROWS.
    video/webm + codecs="h264,opus"    -> silently becomes
                                          video/x-matroska;codecs=avc1,opus.

So the Studio records H.264/opus into Matroska — the best codec available —
and this module remuxes it to H.264/AAC MP4. The video stream is COPIED, so
there is no second generation of loss and it runs at roughly 24x realtime
(measured: 0.17 s for a 4 s 1280x720 clip). Only the audio is re-encoded,
because opus in MP4 is legal but poorly supported.

Verified end to end with an independent tool (ffprobe, not PyAV): the output
reports `format_long_name=QuickTime / MOV`, `codec_name=h264`,
`codec_name=aac`, and a full decode pass produces zero errors.

THE SOURCE FILE IS NEVER DELETED HERE. A recording is the operator's work; the
remux writes a new file beside it and reports both paths. Removing the
intermediate is the operator's call, made in the UI, never a side effect of
finalising.
"""

from __future__ import annotations

import logging
import os
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

log = logging.getLogger("ua-py-runtime")


class RemuxUnavailable(RuntimeError):
    """PyAV is missing. Named so the route can answer 501 rather than 500."""


@dataclass
class RemuxResult:
    source: str
    output: str
    source_bytes: int
    output_bytes: int
    duration_seconds: float | None
    video_codec: str | None
    audio_codec: str | None
    width: int | None
    height: int | None
    video_packets_copied: int
    audio_packets_encoded: int
    took_seconds: float
    video_was_copied: bool
    notes: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return {
            "source": self.source,
            "output": self.output,
            "sourceBytes": self.source_bytes,
            "outputBytes": self.output_bytes,
            "durationSeconds": self.duration_seconds,
            "videoCodec": self.video_codec,
            "audioCodec": self.audio_codec,
            "width": self.width,
            "height": self.height,
            "videoPacketsCopied": self.video_packets_copied,
            "audioPacketsEncoded": self.audio_packets_encoded,
            "tookSeconds": round(self.took_seconds, 3),
            "videoWasCopied": self.video_was_copied,
            "notes": self.notes,
        }


def library_versions() -> dict[str, Any] | None:
    """The bundled ffmpeg versions, or None when PyAV is unavailable."""
    try:
        import av
    except ImportError:
        return None
    return {"pyav": av.__version__, **{k: ".".join(map(str, v)) for k, v in av.library_versions.items()}}


def default_output_path(source: str) -> str:
    """`<name>.mp4` beside the source; `.mp4` input gets `.remuxed.mp4` so an
    input is never used as its own output."""
    p = Path(source)
    if p.suffix.lower() == ".mp4":
        return str(p.with_suffix(".remuxed.mp4"))
    return str(p.with_suffix(".mp4"))


def remux_to_mp4(source: str, output: str | None = None, audio_bitrate: int = 160_000) -> RemuxResult:
    """H.264/opus (any container) -> H.264/AAC MP4, copying the video stream.

    Raises RemuxUnavailable when PyAV is missing, FileNotFoundError for a
    missing source, and ValueError when the source has no video or carries a
    video codec MP4 cannot hold.
    """
    try:
        import av
        import av.audio.resampler
    except ImportError as exc:
        raise RemuxUnavailable(
            "PyAV is not installed in this runtime, so recordings cannot be finalised to MP4. "
            "Reinstall the runtime's dependencies (pip install -r requirements.txt)."
        ) from exc

    src = Path(source)
    if not src.is_file():
        raise FileNotFoundError(f"no recording at {source}")
    if src.stat().st_size == 0:
        raise ValueError(f"the recording at {source} is empty — nothing was captured")

    out_path = output or default_output_path(source)
    if Path(out_path).resolve() == src.resolve():
        raise ValueError("the output path is the source path; refusing to overwrite the recording")

    started = time.monotonic()
    notes: list[str] = []
    video_packets = 0
    audio_packets = 0

    with av.open(str(src)) as inp:
        if not inp.streams.video:
            raise ValueError(f"{source} has no video stream")
        vin = inp.streams.video[0]
        ain = inp.streams.audio[0] if inp.streams.audio else None
        vcodec = vin.codec_context.name
        # MP4 can hold h264/hevc/av1/mpeg4; VP8 cannot go in an MP4 at all and
        # VP9-in-MP4 is what we are trying to get AWAY from.
        if vcodec not in ("h264", "hevc", "av1", "mpeg4"):
            raise ValueError(
                f"{source} holds {vcodec} video, which does not belong in an MP4. "
                "Record with H.264 (the Studio requests it) and finalise again."
            )
        width = vin.codec_context.width
        height = vin.codec_context.height
        acodec_in = ain.codec_context.name if ain else None
        if ain is None:
            notes.append("The recording has no audio track, so the MP4 is video only.")

        with av.open(out_path, mode="w", format="mp4") as out:
            # Stream copy: no second generation of loss, and fast.
            vout = out.add_stream_from_template(vin)
            aout = None
            resampler = None
            if ain is not None:
                aout = out.add_stream("aac", rate=ain.codec_context.rate or 48_000)
                aout.codec_context.bit_rate = audio_bitrate
                resampler = av.audio.resampler.AudioResampler(
                    format=aout.codec_context.format,
                    layout=aout.codec_context.layout,
                    rate=aout.codec_context.rate,
                )
                notes.append(f"Audio re-encoded {acodec_in} -> aac (opus in MP4 is poorly supported).")

            streams = [vin] + ([ain] if ain is not None else [])
            for packet in inp.demux(*streams):
                # A flush packet (dts None) belongs to no stream.
                if packet.dts is None:
                    continue
                if packet.stream is vin:
                    packet.stream = vout
                    out.mux(packet)
                    video_packets += 1
                elif ain is not None and packet.stream is ain:
                    for frame in packet.decode():
                        for rframe in resampler.resample(frame):
                            for encoded in aout.encode(rframe):
                                out.mux(encoded)
                                audio_packets += 1
            if aout is not None:
                for encoded in aout.encode(None):
                    out.mux(encoded)
                    audio_packets += 1

    took = time.monotonic() - started

    # Read the RESULT back rather than trusting what we just wrote.
    duration = None
    out_vcodec = out_acodec = None
    with av.open(out_path) as check:
        if check.duration:
            duration = check.duration / 1_000_000
        if check.streams.video:
            out_vcodec = check.streams.video[0].codec_context.name
        if check.streams.audio:
            out_acodec = check.streams.audio[0].codec_context.name
    if out_vcodec != vcodec:
        notes.append(f"WARNING: expected the video to be copied as {vcodec} but the output reports {out_vcodec}.")

    result = RemuxResult(
        source=str(src),
        output=out_path,
        source_bytes=src.stat().st_size,
        output_bytes=Path(out_path).stat().st_size,
        duration_seconds=round(duration, 3) if duration else None,
        video_codec=out_vcodec,
        audio_codec=out_acodec,
        width=width,
        height=height,
        video_packets_copied=video_packets,
        audio_packets_encoded=audio_packets,
        took_seconds=took,
        video_was_copied=out_vcodec == vcodec,
        notes=notes,
    )
    log.info(
        "remuxed %s -> %s (%s %sx%s, %s packets copied, %.2fs)",
        src.name, Path(out_path).name, out_vcodec, width, height, video_packets, took,
    )
    return result
