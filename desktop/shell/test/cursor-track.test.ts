/**
 * The cursor track. Real filesystem, fake clock, fake cursor — the sampler is
 * only assertable if time and the mouse are both under the test's control.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  CursorTrack,
  isWorthSampling,
  normaliseCursor,
  parseDisplayId,
  trackPathFor,
} from "../src/cursor-track";

const tmp = () => mkdtempSync(path.join(tmpdir(), "marquee-cursor-"));
const laptop = { x: 0, y: 0, width: 1920, height: 1080 };
/** A second display to the right, as macOS lays them out. */
const secondary = { x: 1920, y: 0, width: 2560, height: 1440 };

test("normaliseCursor maps a global point into the captured display", () => {
  assert.deepEqual(normaliseCursor({ x: 960, y: 540 }, laptop), { x: 0.5, y: 0.5, inside: true });
  assert.deepEqual(normaliseCursor({ x: 0, y: 0 }, laptop), { x: 0, y: 0, inside: true });
  assert.deepEqual(normaliseCursor({ x: 1920, y: 1080 }, laptop), { x: 1, y: 1, inside: true });

  // A display with an offset: the same global point means something different.
  assert.deepEqual(normaliseCursor({ x: 3200, y: 720 }, secondary), { x: 0.5, y: 0.5, inside: true });
});

test("a cursor on another monitor is clamped AND flagged, never silently clamped", () => {
  // This is the distinction that matters: a zoom chasing a clamped edge value
  // would lurch to the border every time the operator looks at their other
  // screen. `inside: false` tells the consumer to hold still.
  const off = normaliseCursor({ x: 2400, y: 540 }, laptop);
  assert.equal(off.inside, false);
  assert.equal(off.x, 1, "clamped so consumers never see out-of-range values");

  const above = normaliseCursor({ x: 960, y: -50 }, laptop);
  assert.equal(above.inside, false);
  assert.equal(above.y, 0);

  // On the primary while the SECONDARY is being recorded — also outside.
  assert.equal(normaliseCursor({ x: 100, y: 100 }, secondary).inside, false);

  // A degenerate display must not produce NaN; it produces an honest centre.
  assert.deepEqual(normaliseCursor({ x: 5, y: 5 }, { x: 0, y: 0, width: 0, height: 0 }), {
    x: 0.5,
    y: 0.5,
    inside: false,
  });
});

test("isWorthSampling drops a still cursor but never drops leaving the display", () => {
  const at = (x: number, y: number, inside = true) => ({ x, y, inside });

  assert.equal(isWorthSampling(null, at(0.5, 0.5)), true, "the first sample always counts");
  // Sub-threshold jitter is not movement.
  assert.equal(isWorthSampling(at(0.5, 0.5), at(0.5, 0.5)), false);
  assert.equal(isWorthSampling(at(0.5, 0.5), at(0.5005, 0.5005)), false);
  // Real movement on either axis alone counts.
  assert.equal(isWorthSampling(at(0.5, 0.5), at(0.52, 0.5)), true);
  assert.equal(isWorthSampling(at(0.5, 0.5), at(0.5, 0.48)), true);

  // Crossing off the display is an EVENT, so it is recorded even though the
  // clamped position did not move at all.
  assert.equal(isWorthSampling(at(1, 0.5, true), at(1, 0.5, false)), true);
  assert.equal(isWorthSampling(at(1, 0.5, false), at(1, 0.5, true)), true);

  // A caller can demand finer resolution.
  assert.equal(isWorthSampling(at(0.5, 0.5), at(0.5005, 0.5), 0.0001), true);
});

test("parseDisplayId reads Electron's display_id, which is NOT in the source id", () => {
  // This test replaced one that parsed `screen:<n>:0` for the display id and
  // asserted n was it. That assumption was wrong and the assertion enshrined
  // it: measured on a real shell, desktopCapturer reported `screen:400:0`
  // while `screen.getAllDisplays()` held exactly one display, id 60. Parsing
  // the source id resolved to NO display, and on a multi-monitor machine it
  // would have resolved to the wrong one and normalised every cursor sample
  // against the wrong coordinate space.
  assert.equal(parseDisplayId("60"), 60);
  assert.equal(parseDisplayId("69732800"), 69732800);
  assert.equal(parseDisplayId("-2"), -2, "display ids are opaque; sign is not ours to judge");

  // A window source carries no display_id at all.
  assert.equal(parseDisplayId(null), null);
  assert.equal(parseDisplayId(undefined), null);
  assert.equal(parseDisplayId(""), null);
  assert.equal(parseDisplayId("   "), null);
  // Anything non-integer is a source we do not understand — null, never a guess.
  assert.equal(parseDisplayId("abc"), null);
  assert.equal(parseDisplayId("60.5"), null);
  assert.equal(parseDisplayId("screen:400:0"), null);
});

test("trackPathFor sits beside the take and never replaces it", () => {
  assert.equal(
    trackPathFor("/videos/marquee/marquee_2026-09-09_take.mkv"),
    "/videos/marquee/marquee_2026-09-09_take.cursor.jsonl",
  );
  // A dotted name keeps its stem rather than losing everything after the dot.
  assert.equal(trackPathFor("/v/a.b.mkv"), "/v/a.b.cursor.jsonl");
  // Critically, the track path is never the recording path.
  const take = "/v/take.mkv";
  assert.notEqual(trackPathFor(take), take);
});

test("a track records the header, the samples, and the timing", async () => {
  const dir = tmp();
  const take = path.join(dir, "take.mkv");
  let clock = 1_000_000;
  let cursor = { x: 960, y: 540 };
  const track = new CursorTrack({
    recordingPath: take,
    bounds: laptop,
    readCursor: () => cursor,
    now: () => clock,
  });

  track.start();
  assert.ok(existsSync(track.path), "the file must exist as soon as start() returns");

  assert.equal(track.sample(), true, "first sample always written");
  clock += 100;
  cursor = { x: 1200, y: 600 };
  assert.equal(track.sample(), true);
  clock += 100;
  // Unmoved: skipped.
  assert.equal(track.sample(), false);
  clock += 100;
  cursor = { x: 3000, y: 600 }; // onto another monitor
  assert.equal(track.sample(), true);

  const result = await track.stop();
  assert.equal(result.samples, 3);
  assert.equal(result.skipped, 1);
  assert.equal(result.durationMs, 300);
  assert.ok(result.bytes > 0);

  const lines = readFileSync(track.path, "utf8").trim().split("\n");
  const header = JSON.parse(lines[0]!);
  assert.equal(header.kind, "marquee-cursor-track");
  assert.equal(header.v, 1);
  // The header must carry the meaning of the coordinates, or the track is
  // just a list of numbers nobody can interpret later.
  assert.deepEqual(header.display, laptop);

  const rows = lines.slice(1).map((l) => JSON.parse(l) as [number, number, number, number]);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], [0, 0.5, 0.5, 1]);
  assert.deepEqual(rows[1], [100, 0.625, 0.5556, 1]);
  // The off-display sample: clamped x, flagged 0.
  assert.equal(rows[2]![0], 300);
  assert.equal(rows[2]![1], 1);
  assert.equal(rows[2]![3], 0);
});

test("timer sampling collapses a still cursor to almost nothing", async () => {
  const dir = tmp();
  let clock = 0;
  const track = new CursorTrack({
    recordingPath: path.join(dir, "still.mkv"),
    bounds: laptop,
    readCursor: () => ({ x: 100, y: 100 }),
    now: () => (clock += 16),
  });
  track.start();
  // 300 samples of a cursor that never moves.
  for (let i = 0; i < 300; i += 1) track.sample();
  const result = await track.stop();

  assert.equal(result.samples, 1, "a still cursor is one row, not three hundred");
  assert.equal(result.skipped, 300 - 1 + 0);
  // Header plus exactly one row.
  assert.equal(readFileSync(track.path, "utf8").trim().split("\n").length, 2);
});

test("sampling after stop is a no-op rather than a throw or a lost write", async () => {
  const dir = tmp();
  const track = new CursorTrack({
    recordingPath: path.join(dir, "t.mkv"),
    bounds: laptop,
    readCursor: () => ({ x: 1, y: 1 }),
  });
  track.start();
  track.sample();
  await track.stop();
  assert.equal(track.sample(), false);
  // The file survives, as every recorded artifact must.
  assert.ok(existsSync(track.path));
});

test("starting the same track twice is refused", () => {
  const dir = tmp();
  const track = new CursorTrack({
    recordingPath: path.join(dir, "t.mkv"),
    bounds: laptop,
    readCursor: () => ({ x: 0, y: 0 }),
  });
  track.start();
  assert.throws(() => track.start(), /already open/);
});

test("startSampling drives the timer and stop clears it", async () => {
  const dir = tmp();
  let x = 0;
  const track = new CursorTrack({
    recordingPath: path.join(dir, "timed.mkv"),
    bounds: laptop,
    // Move enough each read that nothing is skipped.
    readCursor: () => ({ x: (x += 40), y: 500 }),
  });
  track.start();
  track.startSampling(5);
  await new Promise((r) => setTimeout(r, 60));
  const result = await track.stop();
  assert.ok(result.samples >= 3, `expected several samples, got ${result.samples}`);

  // The interval must actually be GONE. A timer that outlives the take keeps
  // firing against a closed stream forever, so this is asserted against the
  // bytes on disk rather than against an internal counter — the file is the
  // only witness that cannot be fooled by a stale variable.
  const bytesAtStop = readFileSync(track.path).byteLength;
  const readsAtStop = x;
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(readFileSync(track.path).byteLength, bytesAtStop, "the track grew after stop()");
  assert.equal(x, readsAtStop, "the cursor was still being read after stop()");
});
