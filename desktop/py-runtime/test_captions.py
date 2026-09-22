"""
Caption formatting and cue grouping. Stdlib only — faster-whisper is an
optional extra, and the half that decides whether a caption file WORKS is pure
string and timing arithmetic that must be testable without a 262MB dependency.

Run: python3 -m unittest test_captions -v
"""

from __future__ import annotations

import unittest

import captions
from captions import Cue, Word


class Timestamps(unittest.TestCase):
    def test_srt_uses_a_comma_and_vtt_uses_a_period(self):
        # This single character is the difference between a caption file that
        # loads and one that silently shows nothing. Neither format complains
        # about the other's separator; the cues just never appear.
        self.assertEqual(captions.format_timestamp(0, comma=True), "00:00:00,000")
        self.assertEqual(captions.format_timestamp(0, comma=False), "00:00:00.000")
        self.assertEqual(captions.format_timestamp(1.5, comma=True), "00:00:01,500")
        self.assertEqual(captions.format_timestamp(1.5, comma=False), "00:00:01.500")

    def test_hours_minutes_and_milliseconds_all_carry(self):
        self.assertEqual(captions.format_timestamp(61.25, comma=True), "00:01:01,250")
        self.assertEqual(captions.format_timestamp(3661.007, comma=True), "01:01:01,007")
        self.assertEqual(captions.format_timestamp(59.9999, comma=True), "00:01:00,000")
        # Ten hours must not overflow the field.
        self.assertEqual(captions.format_timestamp(36000, comma=True), "10:00:00,000")

    def test_nonsense_times_become_zero_rather_than_a_broken_file(self):
        self.assertEqual(captions.format_timestamp(-5, comma=True), "00:00:00,000")
        self.assertEqual(captions.format_timestamp(float("nan"), comma=True), "00:00:00,000")


class Wrapping(unittest.TestCase):
    def test_a_short_caption_is_one_line(self):
        self.assertEqual(captions.wrap_caption("Recording is the primary function."), ["Recording is the primary function."])

    def test_a_long_caption_breaks_into_two_readable_lines(self):
        text = "This take was captured at the display's native resolution"
        lines = captions.wrap_caption(text, 42)
        self.assertEqual(len(lines), 2)
        for line in lines:
            self.assertLessEqual(len(line), 42, f"line too long: {line!r}")
        # Nothing may be lost or duplicated in the rewrap.
        self.assertEqual(" ".join(lines), text)

    def test_words_are_never_split(self):
        # A hyphenated word mid-caption reads as a glitch.
        lines = captions.wrap_caption("supercalifragilisticexpialidocious and more words here", 20)
        self.assertIn("supercalifragilisticexpialidocious", lines[0])
        for line in lines:
            self.assertNotIn("-", line)

    def test_empty_text_is_no_lines_not_one_empty_line(self):
        # An empty line in an SRT block is a cue separator; emitting one would
        # corrupt every cue after it.
        self.assertEqual(captions.wrap_caption(""), [])
        self.assertEqual(captions.wrap_caption("   "), [])


def words(*specs: tuple[float, float, str]) -> list[Word]:
    return [Word(start=s, end=e, text=t) for s, e, t in specs]


class Grouping(unittest.TestCase):
    def test_no_words_is_no_cues(self):
        self.assertEqual(captions.cues_from_words([]), [])

    def test_a_sentence_ending_closes_a_cue(self):
        # The most natural cut there is, and where a reader expects one.
        got = captions.cues_from_words(
            words((0.0, 0.4, "Recording"), (0.4, 0.8, "works."), (0.9, 1.3, "Going"), (1.3, 1.7, "live"))
        )
        self.assertEqual(len(got), 2)
        self.assertEqual(got[0].text, "Recording works.")
        self.assertEqual(got[0].end, 0.8)
        self.assertEqual(got[1].text, "Going live")

    def test_a_real_pause_breaks_a_cue(self):
        # Two seconds of silence is where a thought ended, punctuation or not.
        got = captions.cues_from_words(words((0.0, 0.5, "one"), (0.5, 1.0, "two"), (3.0, 3.5, "three")))
        self.assertEqual(len(got), 2)
        self.assertEqual(got[0].text, "one two")
        self.assertEqual(got[1].text, "three")

    def test_a_cue_never_outstays_max_duration(self):
        # A caption frozen on screen reads as a stuck player.
        slow = words(*[(i * 1.0, i * 1.0 + 0.9, f"w{i}") for i in range(12)])
        got = captions.cues_from_words(slow, max_duration=5.0, max_gap=10.0, max_chars=500)
        self.assertGreater(len(got), 1)
        for cue in got:
            self.assertLessEqual(cue.end - cue.start, 5.5, f"cue too long: {cue}")

    def test_a_cue_never_exceeds_two_lines_worth_of_text(self):
        many = words(*[(i * 0.2, i * 0.2 + 0.15, "word") for i in range(60)])
        got = captions.cues_from_words(many, max_chars=84)
        self.assertGreater(len(got), 1)
        for cue in got:
            self.assertLessEqual(len(cue.text), 90, f"cue too long: {cue.text!r}")
            # And it must actually wrap into at most two lines.
            self.assertLessEqual(len(captions.wrap_caption(cue.text, 42)), 2)

    def test_cues_are_numbered_from_one_and_ordered(self):
        got = captions.cues_from_words(
            words((0.0, 0.4, "a."), (1.0, 1.4, "b."), (2.0, 2.4, "c."))
        )
        self.assertEqual([c.index for c in got], [1, 2, 3])
        for earlier, later in zip(got, got[1:]):
            self.assertLessEqual(earlier.end, later.start)

    def test_a_cue_never_has_empty_text(self):
        # Whitespace-only words would otherwise produce a blank cue, which in
        # SRT is an extra separator that breaks the rest of the file.
        got = captions.cues_from_words(words((0.0, 0.1, "   "), (0.2, 0.4, "real")))
        self.assertTrue(all(c.text.strip() for c in got))


class Serialising(unittest.TestCase):
    def _cues(self) -> list[Cue]:
        return [
            Cue(index=1, start=0.0, end=1.5, text="Recording is the primary function of this app."),
            Cue(index=2, start=1.6, end=3.2, text="Going live is the option."),
        ]

    def test_srt_has_index_arrow_and_comma_times(self):
        out = captions.format_srt(self._cues())
        lines = out.split("\n")
        self.assertEqual(lines[0], "1")
        self.assertEqual(lines[1], "00:00:00,000 --> 00:00:01,500")
        self.assertIn("-->", out)
        # Blocks are separated by exactly one blank line.
        self.assertIn("\n\n2\n", out)
        self.assertTrue(out.endswith("\n"))

    def test_vtt_starts_with_the_mandatory_header(self):
        out = captions.format_vtt(self._cues())
        # A WebVTT file without this header is rejected outright by every
        # browser, which shows up as captions that never appear.
        self.assertTrue(out.startswith("WEBVTT\n"))
        self.assertIn("00:00:00.000 --> 00:00:01.500", out)
        self.assertNotIn(",", out.split("-->")[0].split("\n")[-1])

    def test_no_cues_produces_a_valid_empty_file_in_both_formats(self):
        # An empty transcript is a real outcome (a silent take); the files must
        # still be loadable rather than malformed.
        self.assertEqual(captions.format_srt([]), "")
        self.assertTrue(captions.format_vtt([]).startswith("WEBVTT"))

    def test_a_long_cue_is_wrapped_inside_its_block(self):
        long_cue = [Cue(index=1, start=0, end=4, text="This take was captured at the display's native resolution so the zoom has real pixels")]
        srt = captions.format_srt(long_cue, max_chars=42)
        body = srt.split("\n")[2:]
        self.assertGreaterEqual(len([l for l in body if l.strip()]), 2, "a long cue should wrap")
        for line in body:
            self.assertLessEqual(len(line), 42)


class Paths(unittest.TestCase):
    def test_caption_files_sit_beside_the_take_and_never_replace_it(self):
        self.assertEqual(captions.caption_path_for("/v/take.mkv", "srt"), "/v/take.srt")
        self.assertEqual(captions.caption_path_for("/v/take.mkv", ".vtt"), "/v/take.vtt")
        self.assertEqual(captions.caption_path_for("/v/a.b.mp4", "srt"), "/v/a.b.srt")
        for ext in ("srt", "vtt"):
            self.assertNotEqual(captions.caption_path_for("/v/take.mkv", ext), "/v/take.mkv")


class Availability(unittest.TestCase):
    def test_available_reports_a_shape_or_none_but_never_throws(self):
        # The route reads this to decide between working and answering 501, so
        # it must survive the extra being absent.
        got = captions.available()
        self.assertTrue(got is None or isinstance(got, dict))
        if got is not None:
            self.assertIn("models", got)
            self.assertIn("tiny", got["models"])


if __name__ == "__main__":
    unittest.main()
