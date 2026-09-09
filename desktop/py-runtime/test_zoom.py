"""
The zoom planner. Stdlib only — no PyAV needed, because the half that decides
what the edit LOOKS like is pure arithmetic over the cursor track.

Run: python3 -m unittest test_zoom -v
"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

import zoom


def track(*rows: tuple[int, float, float, bool]) -> list[zoom.CursorSample]:
    return [zoom.CursorSample(t_ms=t, x=x, y=y, inside=inside) for t, x, y, inside in rows]


def still_at(x: float, y: float, start: int, end: int, step: int = 100) -> list[zoom.CursorSample]:
    """A cursor parked at one point — what a dwell actually looks like."""
    return track(*[(t, x, y, True) for t in range(start, end + 1, step)])


class Easing(unittest.TestCase):
    def test_ease_is_bounded_symmetric_and_actually_eased(self):
        self.assertEqual(zoom.ease_in_out(0), 0)
        self.assertEqual(zoom.ease_in_out(1), 1)
        self.assertAlmostEqual(zoom.ease_in_out(0.5), 0.5, places=6)
        # Out of range must clamp rather than extrapolate into a wild crop.
        self.assertEqual(zoom.ease_in_out(-3), 0)
        self.assertEqual(zoom.ease_in_out(9), 1)
        # The whole point: slow at the ends, fast in the middle. Linear would
        # make every move read as a machine panning.
        self.assertLess(zoom.ease_in_out(0.25), 0.25)
        self.assertGreater(zoom.ease_in_out(0.75), 0.75)
        # Monotonic, or the crop would visibly reverse mid-move.
        values = [zoom.ease_in_out(i / 20) for i in range(21)]
        self.assertEqual(values, sorted(values))


class SamplePlan(unittest.TestCase):
    def test_before_after_and_between_keyframes(self):
        frames = [
            zoom.ZoomKeyframe(t_ms=0, x=0.5, y=0.5, scale=1.0),
            zoom.ZoomKeyframe(t_ms=1000, x=0.2, y=0.8, scale=0.5),
        ]
        # Before the first and after the last: hold, never extrapolate.
        self.assertEqual(zoom.sample_plan(frames, -500), (0.5, 0.5, 1.0))
        self.assertEqual(zoom.sample_plan(frames, 99999), (0.2, 0.8, 0.5))
        # Midpoint of an ease is the midpoint of the values.
        x, y, scale = zoom.sample_plan(frames, 500)
        self.assertAlmostEqual(x, 0.35, places=3)
        self.assertAlmostEqual(y, 0.65, places=3)
        self.assertAlmostEqual(scale, 0.75, places=3)
        # Early in the move, easing means LESS progress than linear.
        x_quarter, _, _ = zoom.sample_plan(frames, 250)
        self.assertGreater(x_quarter, 0.35, "eased start should still be near the origin")

    def test_an_empty_plan_is_a_wide_shot_not_a_crash(self):
        self.assertEqual(zoom.sample_plan([], 1234), (0.5, 0.5, 1.0))

    def test_zero_length_span_does_not_divide_by_zero(self):
        frames = [
            zoom.ZoomKeyframe(t_ms=500, x=0.1, y=0.1, scale=1.0),
            zoom.ZoomKeyframe(t_ms=500, x=0.9, y=0.9, scale=0.5),
        ]
        self.assertEqual(len(zoom.sample_plan(frames, 500)), 3)


class CropRect(unittest.TestCase):
    def test_a_full_scale_crop_is_the_whole_frame(self):
        left, top, w, h = zoom.crop_rect(0.5, 0.5, 1.0, 1920, 1080, 16 / 9)
        self.assertEqual((left, top, w, h), (0, 0, 1920, 1080))

    def test_half_scale_is_a_two_times_zoom(self):
        left, top, w, h = zoom.crop_rect(0.5, 0.5, 0.5, 3840, 2160, 16 / 9)
        self.assertEqual((w, h), (1920, 1080))
        # Centred: equal margins either side.
        self.assertEqual(left, 960)
        self.assertEqual(top, 540)

    def test_the_crop_always_matches_the_output_aspect(self):
        # Otherwise the encode stretches the picture.
        for src_w, src_h in [(3840, 2160), (2560, 1600), (1920, 1080), (3000, 1000)]:
            for scale in (1.0, 0.75, 0.5, 0.25):
                _, _, w, h = zoom.crop_rect(0.5, 0.5, scale, src_w, src_h, 16 / 9)
                self.assertAlmostEqual(w / h, 16 / 9, delta=0.02, msg=f"{src_w}x{src_h} @ {scale}")

    def test_a_crop_near_an_edge_slides_in_rather_than_shrinking(self):
        # Shrinking would change the ZOOM LEVEL mid-move, which reads as a
        # lurch. Sliding keeps the magnification constant.
        _, _, centre_w, centre_h = zoom.crop_rect(0.5, 0.5, 0.5, 3840, 2160, 16 / 9)
        for cx, cy in [(0.0, 0.0), (1.0, 1.0), (0.0, 1.0), (1.0, 0.0), (-5.0, 9.0)]:
            left, top, w, h = zoom.crop_rect(cx, cy, 0.5, 3840, 2160, 16 / 9)
            self.assertEqual((w, h), (centre_w, centre_h), "the zoom level must not change near an edge")
            # And it must stay inside the frame.
            self.assertGreaterEqual(left, 0)
            self.assertGreaterEqual(top, 0)
            self.assertLessEqual(left + w, 3840)
            self.assertLessEqual(top + h, 2160)

    def test_dimensions_are_always_even(self):
        # H.264 4:2:0 cannot represent an odd width or height.
        for scale in [i / 97 for i in range(1, 98)]:
            _, _, w, h = zoom.crop_rect(0.5, 0.5, scale, 3001, 1999, 16 / 9)
            self.assertEqual(w % 2, 0, f"odd width at scale {scale}")
            self.assertEqual(h % 2, 0, f"odd height at scale {scale}")

    def test_absurd_scales_are_clamped_not_obeyed(self):
        _, _, w, h = zoom.crop_rect(0.5, 0.5, 0.0, 1920, 1080, 16 / 9)
        self.assertGreaterEqual(w, 2)
        self.assertGreaterEqual(h, 2)
        _, _, w2, h2 = zoom.crop_rect(0.5, 0.5, 50.0, 1920, 1080, 16 / 9)
        self.assertLessEqual(w2, 1920)
        self.assertLessEqual(h2, 1080)


class Planner(unittest.TestCase):
    def test_a_plan_always_opens_wide(self):
        # A recording that opens mid-zoom gives the viewer no idea what they
        # are looking at.
        for samples in ([], still_at(0.2, 0.2, 0, 3000)):
            plan = zoom.plan_zooms(samples, 5000)
            self.assertEqual(plan.keyframes[0].t_ms, 0)
            self.assertEqual(plan.keyframes[0].scale, 1.0)

    def test_no_samples_stays_wide_and_says_so(self):
        plan = zoom.plan_zooms([], 5000)
        self.assertEqual(len(plan.keyframes), 1)
        self.assertIn("no samples", " ".join(plan.notes).lower())

    def test_a_cursor_never_on_the_display_produces_no_zoom_and_says_why(self):
        samples = track(*[(t, 1.0, 0.5, False) for t in range(0, 4000, 100)])
        plan = zoom.plan_zooms(samples, 4000)
        self.assertEqual(len(plan.keyframes), 1)
        self.assertIn("never on the captured display", " ".join(plan.notes))

    def test_a_dwell_becomes_an_eased_zoom_in_and_back_out(self):
        # Parked at (0.25, 0.75) for two seconds, then gone.
        samples = still_at(0.25, 0.75, 0, 2000) + track((2100, 0.9, 0.1, True), (2200, 0.95, 0.05, True))
        plan = zoom.plan_zooms(samples, 4000, zoom_scale=0.5, dwell_ms=700)

        scales = [k.scale for k in plan.keyframes]
        self.assertIn(0.5, scales, "a dwell must produce a zoomed keyframe")
        self.assertEqual(scales[0], 1.0, "opens wide")
        self.assertEqual(scales[-1], 1.0, "returns wide, so the viewer regains context")

        zoomed = [k for k in plan.keyframes if k.scale == 0.5]
        for k in zoomed:
            self.assertAlmostEqual(k.x, 0.25, delta=0.02)
            self.assertAlmostEqual(k.y, 0.75, delta=0.02)

        # Eased, not cut: the wide and tight keyframes are at DIFFERENT times.
        times = [k.t_ms for k in plan.keyframes]
        self.assertEqual(times, sorted(times), "keyframes must be in time order")
        self.assertEqual(len(times), len(set(times)), "no two keyframes may share a timestamp")

    def test_constant_motion_produces_no_zoom(self):
        # Someone sweeping across the screen is not working anywhere.
        samples = track(*[(t, t / 4000, 0.5, True) for t in range(0, 4000, 100)])
        plan = zoom.plan_zooms(samples, 4000, dwell_ms=700, dwell_radius=0.06)
        self.assertEqual(len(plan.keyframes), 1, "a travelling cursor should stay wide")
        self.assertIn("No dwell", " ".join(plan.notes))

    def test_two_quick_pauses_do_not_produce_two_whiplash_zooms(self):
        # The min-hold floor exists for exactly this: without it, a cursor that
        # settles twice in a second produces two zooms half a second apart,
        # which is nauseating to watch.
        samples = (
            still_at(0.2, 0.2, 0, 800)
            + still_at(0.8, 0.8, 900, 1700)
            + still_at(0.2, 0.2, 1800, 2600)
        )
        plan = zoom.plan_zooms(samples, 5000, dwell_ms=700, min_hold_ms=1500)
        zoom_ins = [k for k in plan.keyframes if k.scale < 1.0]
        # Grouped into holds, not one per pause.
        starts = sorted({k.t_ms for k in zoom_ins})
        for earlier, later in zip(starts, starts[1:]):
            self.assertGreaterEqual(later - earlier, 400, "zooms must not stack on top of each other")

    def test_the_dwell_centre_is_the_mean_not_the_last_sample(self):
        # The final sample of a dwell is often the beginning of the movement
        # out of it, so anchoring on it aims the camera at where the cursor
        # LEFT rather than where the work happened.
        samples = (
            still_at(0.30, 0.30, 0, 1400)
            + track((1500, 0.34, 0.34, True))  # drifting away, still in radius
        )
        plan = zoom.plan_zooms(samples, 3000, dwell_ms=700, dwell_radius=0.08)
        zoomed = [k for k in plan.keyframes if k.scale < 1.0]
        self.assertTrue(zoomed)
        self.assertLess(abs(zoomed[0].x - 0.30), abs(zoomed[0].x - 0.34))

    def test_zoom_scale_is_validated(self):
        with self.assertRaises(ValueError):
            zoom.plan_zooms(still_at(0.5, 0.5, 0, 2000), 3000, zoom_scale=0)
        with self.assertRaises(ValueError):
            zoom.plan_zooms(still_at(0.5, 0.5, 0, 2000), 3000, zoom_scale=1.5)

    def test_every_keyframe_is_inside_the_frame(self):
        # A dwell in a corner must not plan a centre outside 0..1.
        for cx, cy in [(0.0, 0.0), (1.0, 1.0), (0.02, 0.98)]:
            plan = zoom.plan_zooms(still_at(cx, cy, 0, 2500), 4000)
            for k in plan.keyframes:
                self.assertGreaterEqual(k.x, 0.0)
                self.assertLessEqual(k.x, 1.0)
                self.assertGreaterEqual(k.y, 0.0)
                self.assertLessEqual(k.y, 1.0)
                self.assertGreater(k.scale, 0.0)
                self.assertLessEqual(k.scale, 1.0)


class TrackLoading(unittest.TestCase):
    def _write(self, lines: list[str]) -> str:
        d = tempfile.mkdtemp()
        p = Path(d) / "take.cursor.jsonl"
        p.write_text("\n".join(lines), encoding="utf-8")
        return str(p)

    def _header(self) -> str:
        return json.dumps(
            {
                "v": 1,
                "kind": "marquee-cursor-track",
                "display": {"x": 0, "y": 0, "width": 1600, "height": 1000},
            }
        )

    def test_reads_a_real_track(self):
        path = self._write([self._header(), "[0,0.5,0.5,1]", "[100,0.6,0.4,1]", "[200,1.0,0.5,0]"])
        loaded = zoom.load_cursor_track(path)
        self.assertEqual(loaded.display["width"], 1600)
        self.assertEqual(len(loaded.samples), 3)
        self.assertEqual(loaded.samples[0].t_ms, 0)
        self.assertFalse(loaded.samples[2].inside)

    def test_a_truncated_last_line_does_not_lose_the_whole_track(self):
        # This is what an aborted take actually leaves behind, and throwing away
        # every good sample before it would be the wrong trade.
        path = self._write([self._header(), "[0,0.5,0.5,1]", "[100,0.6,0.4,1]", "[200,0.7,0."])
        loaded = zoom.load_cursor_track(path)
        self.assertEqual(len(loaded.samples), 2)

    def test_a_missing_file_and_a_foreign_file_each_fail_clearly(self):
        with self.assertRaises(FileNotFoundError):
            zoom.load_cursor_track("/nope/absent.cursor.jsonl")
        wrong = self._write([json.dumps({"kind": "something-else"}), "[0,0.5,0.5,1]"])
        with self.assertRaises(ValueError) as caught:
            zoom.load_cursor_track(wrong)
        self.assertIn("not a marquee cursor track", str(caught.exception))

    def test_rows_of_the_wrong_shape_are_skipped_not_guessed_at(self):
        path = self._write(
            [self._header(), "[0,0.5,0.5,1]", "[1,2]", '{"stray":"object"}', '["a","b","c","d"]', "[200,0.7,0.3,1]"]
        )
        loaded = zoom.load_cursor_track(path)
        self.assertEqual(len(loaded.samples), 2)


class OutputPath(unittest.TestCase):
    def test_the_zoomed_output_never_collides_with_the_source(self):
        self.assertEqual(zoom.default_output_path("/v/take.mkv"), "/v/take.zoomed.mp4")
        # An MP4 source must not be its own output.
        self.assertEqual(zoom.default_output_path("/v/take.mp4"), "/v/take.zoomed.mp4")
        for source in ("/v/take.mkv", "/v/take.mp4", "/v/a.b.webm"):
            self.assertNotEqual(zoom.default_output_path(source), source)


if __name__ == "__main__":
    unittest.main()
