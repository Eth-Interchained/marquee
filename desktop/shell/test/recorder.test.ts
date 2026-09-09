/**
 * Recording to disk. These run against a real filesystem in a temp directory,
 * because the entire point of the module is what ends up on disk — a mocked
 * fs would assert that the code calls itself.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { RecordingSink, extensionForMimeType, recordingFilename } from "../src/recorder";

const tmp = () => mkdtempSync(path.join(tmpdir(), "marquee-rec-"));
const bytes = (...values: number[]) => new Uint8Array(values);

test("extensionForMimeType follows the container, not the codecs", () => {
  // This is the mapping the whole recording path depends on: Chromium answers
  // a webm request with Matroska, and the file has to say so or ffmpeg's probe
  // is being lied to.
  assert.equal(extensionForMimeType('video/x-matroska;codecs=avc1,opus'), ".mkv");
  assert.equal(extensionForMimeType("video/webm;codecs=vp9,opus"), ".webm");
  assert.equal(extensionForMimeType("video/mp4"), ".mp4");
  assert.equal(extensionForMimeType("VIDEO/X-MATROSKA"), ".mkv");
  // Unknown container gets an honest .bin rather than a plausible lie.
  assert.equal(extensionForMimeType("video/quicktime"), ".bin");
  assert.equal(extensionForMimeType(""), ".bin");
});

test("recordingFilename is sortable, labelled, and safe on Windows", () => {
  const at = new Date("2026-09-09T14:03:07.512Z");
  const plain = recordingFilename(at, undefined, "video/x-matroska");
  assert.equal(plain, "marquee_2026-09-09_14-03-07-512.mkv");
  // No colon: Windows refuses one, and macOS Finder renders it as a slash.
  assert.ok(!plain.includes(":"));

  const labelled = recordingFilename(at, 'Boss fight: "final" run/take?', "video/webm");
  assert.equal(labelled, "marquee_2026-09-09_14-03-07-512_Boss-fight-final-runtake.webm");
  assert.ok(!/[<>:"/\\|?*]/.test(labelled));

  // A label made entirely of punctuation collapses to nothing rather than
  // leaving a dangling separator.
  assert.equal(recordingFilename(at, "???", "video/mp4"), "marquee_2026-09-09_14-03-07-512.mp4");
  // Long labels are cut, so no path exceeds a filesystem's name limit.
  assert.ok(recordingFilename(at, "x".repeat(300), "video/mp4").length < 120);
});

test("chunks are appended in order and the bytes on disk are exactly what was sent", async () => {
  const dir = tmp();
  const sink = new RecordingSink(dir);
  const handle = sink.begin({ mimeType: "video/x-matroska;codecs=avc1,opus", label: "take one" });

  assert.ok(handle.path.startsWith(dir));
  assert.ok(handle.path.endsWith(".mkv"));
  assert.ok(handle.id.startsWith("rec_"));

  assert.deepEqual(sink.write(handle.id, bytes(0x1a, 0x45, 0xdf, 0xa3)), { bytes: 4, chunks: 1 });
  assert.deepEqual(sink.write(handle.id, bytes(1, 2, 3)), { bytes: 7, chunks: 2 });
  // MediaRecorder does emit empty chunks; they must not count as a chunk.
  assert.deepEqual(sink.write(handle.id, bytes()), { bytes: 7, chunks: 2 });

  const result = await sink.finish(handle.id);
  assert.equal(result.bytes, 7);
  assert.equal(result.chunks, 2);
  assert.equal(result.clean, true);
  assert.equal(result.path, handle.path);
  assert.deepEqual([...readFileSync(handle.path)], [0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3]);
});

test("a chunk written to a view of a larger buffer sends only that view", async () => {
  // MediaRecorder's Blob -> arrayBuffer -> Uint8Array path can hand over a
  // view with a non-zero byteOffset. Copying the whole underlying buffer would
  // corrupt the stream, so this is asserted rather than assumed.
  const dir = tmp();
  const sink = new RecordingSink(dir);
  const handle = sink.begin({ mimeType: "video/webm" });
  const backing = new Uint8Array([9, 9, 42, 43, 9]);
  sink.write(handle.id, backing.subarray(2, 4));
  await sink.finish(handle.id);
  assert.deepEqual([...readFileSync(handle.path)], [42, 43]);
});

test("abort keeps the partial file and reports it as unclean", async () => {
  const dir = tmp();
  const sink = new RecordingSink(dir);
  const handle = sink.begin({ mimeType: "video/x-matroska" });
  sink.write(handle.id, bytes(1, 2, 3, 4, 5));

  const result = await sink.abort(handle.id);
  assert.equal(result.clean, false);
  assert.equal(result.bytes, 5);
  // The rule that matters: a take is never deleted to tidy up after a failure.
  assert.ok(existsSync(handle.path), "an aborted recording must still be on disk");
});

test("writing to a finished recording throws instead of vanishing", async () => {
  const dir = tmp();
  const sink = new RecordingSink(dir);
  const handle = sink.begin({ mimeType: "video/webm" });
  await sink.finish(handle.id);

  assert.throws(() => sink.write(handle.id, bytes(1)), /is not open/);
  await assert.rejects(sink.finish(handle.id), /is not open/);
  await assert.rejects(sink.finish("rec_nope"), /is not open/);
});

test("two takes at once get separate files and never share a byte", async () => {
  const dir = tmp();
  const sink = new RecordingSink(dir);
  const a = sink.begin({ mimeType: "video/webm", label: "a" });
  const b = sink.begin({ mimeType: "video/webm", label: "b" });
  assert.notEqual(a.path, b.path);
  assert.deepEqual(sink.openIds().sort(), [a.id, b.id].sort());

  sink.write(a.id, bytes(0xaa, 0xaa));
  sink.write(b.id, bytes(0xbb));
  sink.write(a.id, bytes(0xaa));

  await sink.finish(a.id);
  await sink.finish(b.id);
  assert.deepEqual([...readFileSync(a.path)], [0xaa, 0xaa, 0xaa]);
  assert.deepEqual([...readFileSync(b.path)], [0xbb]);
  assert.equal(readdirSync(dir).length, 2);
});

test("two takes started in the same millisecond do not overwrite each other", async () => {
  // A frozen clock forces the exact collision: identical timestamp, identical
  // label, therefore identical filename. Without a suffix the second open
  // would either fail or truncate the first take.
  const dir = tmp();
  const frozen = new Date("2026-09-09T14:03:07.512Z");
  const sink = new RecordingSink(dir, () => frozen);
  const a = sink.begin({ mimeType: "video/webm", label: "same" });
  const b = sink.begin({ mimeType: "video/webm", label: "same" });
  const c = sink.begin({ mimeType: "video/webm", label: "same" });

  assert.equal(a.path, path.join(dir, "marquee_2026-09-09_14-03-07-512_same.webm"));
  assert.equal(b.path, path.join(dir, "marquee_2026-09-09_14-03-07-512_same-2.webm"));
  assert.equal(c.path, path.join(dir, "marquee_2026-09-09_14-03-07-512_same-3.webm"));

  sink.write(a.id, bytes(0xa1));
  sink.write(b.id, bytes(0xb2));
  sink.write(c.id, bytes(0xc3));
  await sink.closeAll();
  // The point of the suffix: every take's bytes are its own.
  assert.deepEqual([...readFileSync(a.path)], [0xa1]);
  assert.deepEqual([...readFileSync(b.path)], [0xb2]);
  assert.deepEqual([...readFileSync(c.path)], [0xc3]);
  assert.equal(readdirSync(dir).length, 3);
});

test("closeAll flushes every open take on shutdown and keeps them all", async () => {
  const dir = tmp();
  const sink = new RecordingSink(dir);
  const a = sink.begin({ mimeType: "video/webm" });
  const b = sink.begin({ mimeType: "video/x-matroska" });
  sink.write(a.id, bytes(1, 1, 1));
  sink.write(b.id, bytes(2, 2));

  const closed = await sink.closeAll();
  assert.equal(closed.length, 2);
  assert.ok(closed.every((r) => r.clean === false));
  assert.deepEqual(sink.openIds(), []);
  assert.deepEqual([...readFileSync(a.path)], [1, 1, 1]);
  assert.deepEqual([...readFileSync(b.path)], [2, 2]);
  // Idempotent: quitting twice must not throw.
  assert.deepEqual(await sink.closeAll(), []);
});

test("the directory is created on demand, not at construction", () => {
  const dir = path.join(tmp(), "does", "not", "exist", "yet");
  const sink = new RecordingSink(dir);
  assert.equal(sink.directory, dir);
  assert.equal(existsSync(dir), false, "constructing a sink must not touch the filesystem");
  const handle = sink.begin({ mimeType: "video/webm" });
  assert.ok(existsSync(dir));
  assert.ok(existsSync(handle.path));
});

test("an unwritable directory fails loudly at begin, naming the path", () => {
  // A file where the directory should be: mkdir cannot proceed, and the
  // operator needs to hear that now — not after a five-minute take.
  const base = tmp();
  const blocked = path.join(base, "blocked");
  writeFileSync(blocked, "not a directory");
  const sink = new RecordingSink(blocked);
  assert.throws(() => sink.begin({ mimeType: "video/webm" }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /blocked/);
    return true;
  });
});

test("the reported byte count comes from the filesystem, not the counter", async () => {
  const dir = tmp();
  const sink = new RecordingSink(dir);
  const handle = sink.begin({ mimeType: "video/webm" });
  sink.write(handle.id, bytes(...new Array(2048).fill(7)));
  const result = await sink.finish(handle.id);
  assert.equal(result.bytes, 2048);
  assert.equal(result.bytes, readFileSync(handle.path).byteLength);
  assert.ok(result.durationMs >= 0);
});
