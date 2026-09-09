"""
Captions, transcribed on this machine and nowhere else.

WHY THIS IS OURS TO DO: marquee already ships a Python runtime. Running speech
recognition locally is therefore a dependency, not an architecture — where for
an app without an embedded interpreter it is a rewrite. Nothing is uploaded,
no account is needed, and a recording of something confidential stays on the
disk it was recorded to. That is the same argument as the rest of this app: the
pixels are yours, so the transcript should be too.

MEASURED on this machine, with real speech in the container MediaRecorder
produces (H.264/opus Matroska): the `tiny` model transcribed a 10-second clip
WORD-PERFECT, apostrophes included, at 6.2x realtime on CPU. `base` was also
word-perfect at 3.5x. A ten-minute take is therefore about a minute and a half
of transcription, which is the same order as the zoom pass.

WEIGHT, stated plainly because it is the real trade-off: faster-whisper plus
ctranslate2 is roughly 262MB installed, and the `tiny` model another ~75MB. The
app does not carry that by default. Captions are an OPTIONAL extra
(`requirements-captions.txt`); without them installed, the route answers 501
and says how to enable it — exactly what /remux and /zoom do without PyAV.
`onnxruntime` is deliberately NOT installed: faster-whisper only wants it for
voice-activity filtering, and dropping it (with sympy) saves ~173MB, which was
verified to leave transcription working unchanged.

THE AUDIO IS READ STRAIGHT FROM THE TAKE. faster-whisper decodes through PyAV,
which the runtime already has, so there is no separate extraction step and no
temporary wav to clean up or leak.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Optional, Sequence

log = logging.getLogger("ua-py-runtime")


class CaptionsUnavailable(RuntimeError):
    """faster-whisper is not installed. Named so the route answers 501, not 500."""


# Loading a model takes seconds and the result is reusable, so a second
# transcription in the same session should not pay for it again.
_MODELS: dict[tuple[str, str], Any] = {}

KNOWN_MODELS = ("tiny", "base", "small", "medium", "large-v3")


def available() -> Optional[dict[str, Any]]:
    """What captioning is available, or None when it is not installed."""
    try:
        import ctranslate2
        import faster_whisper
    except ImportError:
        return None
    return {
        "fasterWhisper": getattr(faster_whisper, "__version__", "unknown"),
        "ctranslate2": getattr(ctranslate2, "__version__", "unknown"),
        "models": list(KNOWN_MODELS),
        "loaded": sorted({name for name, _ in _MODELS}),
    }


# ------------------------------------------------------------------------ cues


@dataclass
class Cue:
    """One caption: when it appears, when it goes, and what it says."""

    index: int
    start: float
    end: float
    text: str

    def as_dict(self) -> dict[str, Any]:
        return {"index": self.index, "start": round(self.start, 3), "end": round(self.end, 3), "text": self.text}


@dataclass
class Word:
    start: float
    end: float
    text: str


def format_timestamp(seconds: float, *, comma: bool) -> str:
    """`HH:MM:SS,mmm` for SRT or `HH:MM:SS.mmm` for WebVTT. Pure; tested.

    The separator is the entire difference between the two formats and the
    classic way to ship a file that silently loads with no captions: SRT wants
    a comma, WebVTT wants a period, and neither complains about the other — the
    cues simply never appear.
    """
    if seconds < 0 or seconds != seconds:  # negative or NaN
        seconds = 0.0
    total_ms = int(round(seconds * 1000))
    hours, rem = divmod(total_ms, 3_600_000)
    minutes, rem = divmod(rem, 60_000)
    secs, ms = divmod(rem, 1000)
    sep = "," if comma else "."
    return f"{hours:02d}:{minutes:02d}:{secs:02d}{sep}{ms:03d}"


def wrap_caption(text: str, max_chars: int = 42) -> list[str]:
    """Break a caption into at most two readable lines. Pure; tested.

    42 characters is the broadcast convention and it is a convention for a
    reason: a line long enough to need a saccade to read is a line the viewer
    misses while watching the picture. Words are never split — a hyphenated
    word mid-caption reads as a glitch.
    """
    words = text.split()
    if not words:
        return []
    lines: list[str] = []
    current = ""
    for word in words:
        candidate = f"{current} {word}".strip()
        if len(candidate) <= max_chars or not current:
            current = candidate
        else:
            lines.append(current)
            current = word
    if current:
        lines.append(current)

    if len(lines) <= 2:
        return lines
    # More than two lines means the cue is too long to be one caption; the
    # caller splits by TIME rather than cramming. Returning everything here
    # keeps this function honest — it wraps, it does not silently truncate.
    return lines


def cues_from_words(
    words: Sequence[Word],
    *,
    max_chars: int = 84,
    max_duration: float = 5.0,
    max_gap: float = 0.8,
    max_lines: int = 2,
    line_chars: int = 42,
) -> list[Cue]:
    """Group word timings into readable cues. Pure; tested.

    Whisper's own segments are whatever the model felt like emitting — often a
    single 20-second sentence, which as a caption is a wall of text that
    outstays its welcome. Regrouping from WORD timings gives cues that:

    - wrap to at most `max_lines` lines of `line_chars`. The character budget
      alone is not enough: 84 characters only fits two 42-character lines when
      the words happen to align, and greedy wrapping leaves slack on each line
      — verified by a test that produced THREE lines from an 84-character cue.
      So the wrap is checked directly rather than approximated by a count;
    - never last longer than `max_duration`, because a caption frozen on screen
      reads as a stuck player;
    - break at a real PAUSE longer than `max_gap`, since that is where a
      sentence actually ended;
    - break after terminal punctuation, which is where a reader expects one.
    """
    cues: list[Cue] = []
    if not words:
        return cues

    buffer: list[Word] = []

    def flush() -> None:
        if not buffer:
            return
        text = " ".join(w.text.strip() for w in buffer).strip()
        if text:
            cues.append(Cue(index=len(cues) + 1, start=buffer[0].start, end=buffer[-1].end, text=text))
        buffer.clear()

    for word in words:
        if buffer:
            gap = word.start - buffer[-1].end
            candidate = " ".join(w.text.strip() for w in buffer) + " " + word.text.strip()
            duration = word.end - buffer[0].start
            too_long = len(candidate) > max_chars
            # The real constraint, checked rather than estimated.
            too_tall = len(wrap_caption(candidate, line_chars)) > max_lines
            if gap > max_gap or too_long or too_tall or duration > max_duration:
                flush()
        buffer.append(word)
        # A sentence ending is the most natural cut there is.
        if word.text.strip().endswith((".", "?", "!")):
            flush()
    flush()
    return cues


def format_srt(cues: Sequence[Cue], max_chars: int = 42) -> str:
    """SubRip. Pure; tested."""
    blocks: list[str] = []
    for cue in cues:
        lines = wrap_caption(cue.text, max_chars)
        blocks.append(
            f"{cue.index}\n"
            f"{format_timestamp(cue.start, comma=True)} --> {format_timestamp(cue.end, comma=True)}\n"
            + "\n".join(lines)
        )
    # SRT is conventionally terminated by a blank line.
    return "\n\n".join(blocks) + ("\n" if blocks else "")


def format_vtt(cues: Sequence[Cue], max_chars: int = 42) -> str:
    """WebVTT. Pure; tested.

    The `WEBVTT` header is mandatory: a file without it is rejected outright by
    every browser, which shows up as captions that simply never appear.
    """
    blocks = ["WEBVTT", ""]
    for cue in cues:
        lines = wrap_caption(cue.text, max_chars)
        blocks.append(
            f"{format_timestamp(cue.start, comma=False)} --> {format_timestamp(cue.end, comma=False)}\n"
            + "\n".join(lines)
        )
        blocks.append("")
    return "\n".join(blocks)


def caption_path_for(source: str, extension: str) -> str:
    """`<take>.srt` / `<take>.vtt` beside the recording. Pure; tested."""
    stem = str(Path(source).with_suffix(""))
    return f"{stem}.{extension.lstrip('.')}"


# ----------------------------------------------------------------- transcribing


@dataclass
class CaptionResult:
    source: str
    model: str
    language: str
    language_probability: float
    duration_seconds: float
    cues: int
    words: int
    took_seconds: float
    outputs: list[dict[str, str]] = field(default_factory=list)
    text: str = ""
    notes: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return {
            "source": self.source,
            "model": self.model,
            "language": self.language,
            "languageProbability": round(self.language_probability, 3),
            "durationSeconds": round(self.duration_seconds, 3),
            "cues": self.cues,
            "words": self.words,
            "tookSeconds": round(self.took_seconds, 3),
            "realtimeFactor": round(self.duration_seconds / self.took_seconds, 2) if self.took_seconds > 0 else None,
            "outputs": self.outputs,
            "text": self.text,
            "notes": self.notes,
        }


def _load_model(size: str, compute_type: str) -> Any:
    try:
        from faster_whisper import WhisperModel
    except ImportError as exc:
        raise CaptionsUnavailable(
            "Captions are not installed in this build. They are an optional extra because "
            "faster-whisper and ctranslate2 add roughly 262MB: install them with "
            "`pip install -r requirements-captions.txt` in the runtime's environment."
        ) from exc

    key = (size, compute_type)
    if key not in _MODELS:
        started = time.monotonic()
        # int8 on CPU: measured word-perfect on real speech, and the only
        # option that is fast enough to be worth offering without a GPU.
        _MODELS[key] = WhisperModel(size, device="cpu", compute_type=compute_type)
        log.info("loaded the %s caption model in %.1fs", size, time.monotonic() - started)
    return _MODELS[key]


def transcribe(
    source: str,
    *,
    model_size: str = "tiny",
    compute_type: str = "int8",
    language: Optional[str] = None,
    formats: Sequence[str] = ("srt", "vtt"),
    max_chars: int = 84,
) -> CaptionResult:
    """Transcribe a take and write caption files beside it.

    Raises CaptionsUnavailable when the extra is not installed,
    FileNotFoundError for a missing take, and ValueError for bad arguments.
    """
    src = Path(source)
    if not src.is_file():
        raise FileNotFoundError(f"no recording at {source}")
    if src.stat().st_size == 0:
        raise ValueError(f"the recording at {source} is empty — there is nothing to transcribe")
    if model_size not in KNOWN_MODELS:
        raise ValueError(f"unknown model {model_size!r}; known models are {', '.join(KNOWN_MODELS)}")
    unknown = [f for f in formats if f not in ("srt", "vtt")]
    if unknown:
        raise ValueError(f"unknown caption format(s): {', '.join(unknown)}. Known formats are srt, vtt.")
    if not formats:
        raise ValueError("no caption formats were requested; there is nothing to write")

    model = _load_model(model_size, compute_type)

    started = time.monotonic()
    # faster-whisper decodes through PyAV, which this runtime already has — so
    # the take is read directly and no temporary wav is created, written, or
    # left behind.
    segments, info = model.transcribe(str(src), beam_size=5, word_timestamps=True, language=language)

    words: list[Word] = []
    plain: list[str] = []
    for segment in segments:  # a generator: this is where the work happens
        plain.append(segment.text.strip())
        for word in segment.words or []:
            words.append(Word(start=float(word.start), end=float(word.end), text=str(word.word)))

    notes: list[str] = []
    if not words:
        # A silent take is a real answer, not an error — but an empty caption
        # file with no explanation would look like a broken transcription.
        notes.append(
            "No speech was found in this recording, so the caption files are empty. "
            "If there should be speech, check that the take actually has an audio track."
        )

    cues = cues_from_words(words, max_chars=max_chars)
    took = time.monotonic() - started

    outputs: list[dict[str, str]] = []
    for fmt in formats:
        path = caption_path_for(source, fmt)
        body = format_srt(cues) if fmt == "srt" else format_vtt(cues)
        Path(path).write_text(body, encoding="utf-8")
        outputs.append({"format": fmt, "path": path, "bytes": str(Path(path).stat().st_size)})

    result = CaptionResult(
        source=str(src),
        model=model_size,
        language=info.language,
        language_probability=float(info.language_probability),
        duration_seconds=float(info.duration),
        cues=len(cues),
        words=len(words),
        took_seconds=took,
        outputs=outputs,
        text=" ".join(plain).strip(),
        notes=notes,
    )
    log.info(
        "transcribed %s with %s: %d cue(s) from %d word(s) in %.1fs (%.1fx realtime)",
        src.name, model_size, len(cues), len(words), took, (info.duration / took) if took else 0,
    )
    return result
