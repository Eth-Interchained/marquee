/**
 * The pure half of screen capture: how a picked source and a page's request
 * become the streams Chromium is handed. No Electron needed.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveStreams, toCaptureSource, type RawSource } from "../src/capture";

const img = (data: string) => ({ isEmpty: () => data === "", toDataURL: () => data });

const sources = [
  { id: "screen:0:0", name: "Entire Screen" },
  { id: "window:42:0", name: "Elden Ring" },
];
const video = { videoRequested: true, audioRequested: false };
const videoAndAudio = { videoRequested: true, audioRequested: true };

test("toCaptureSource carries Electron's display_id, and only for screens", () => {
  // Load-bearing: this field is the ONLY reliable join from a picked source to
  // `screen.getAllDisplays()`, and therefore to the cursor track's coordinate
  // space. The number inside the source id looks like a display id and is not
  // one — measured on a real shell, a source said `screen:400:0` while the
  // machine's only display had id 60.
  const screen = toCaptureSource({
    id: "screen:400:0",
    name: "Display 1",
    thumbnail: img("data:thumb"),
    appIcon: null,
    display_id: "60",
  } as RawSource);
  assert.equal(screen.displayId, "60", "the display id must come from display_id, not the source id");
  assert.notEqual(screen.displayId, "400");

  // A window has no display to normalise against, so it must report null even
  // if the platform hands us something in that field.
  const win = toCaptureSource({
    id: "window:1234:0",
    name: "Terminal",
    thumbnail: img("data:t"),
    appIcon: null,
    display_id: "60",
  } as RawSource);
  assert.equal(win.displayId, null);

  // A screen source with no display_id is honest about it rather than falling
  // back to parsing the id.
  const bare = toCaptureSource({
    id: "screen:400:0",
    name: "Display 1",
    thumbnail: img("data:t"),
    appIcon: null,
  } as RawSource);
  assert.equal(bare.displayId, null);
});

test("toCaptureSource classifies by id prefix and drops empty images to null/empty", () => {
  const screen = toCaptureSource({ id: "screen:1:0", name: "Display 2", thumbnail: img("data:thumb"), appIcon: null } as RawSource);
  assert.equal(screen.kind, "screen");
  assert.equal(screen.thumbnail, "data:thumb");
  assert.equal(screen.appIcon, null);
  const win = toCaptureSource({ id: "window:7:0", name: "Terminal", thumbnail: img(""), appIcon: img("data:icon") } as RawSource);
  assert.equal(win.kind, "window");
  assert.equal(win.thumbnail, "");
  assert.equal(win.appIcon, "data:icon");
  const winNoIcon = toCaptureSource({ id: "window:8:0", name: "X", thumbnail: img("t"), appIcon: img("") } as RawSource);
  assert.equal(winNoIcon.appIcon, null);
});

test("nothing armed → refused with a reason naming the fix", () => {
  const r = resolveStreams(null, video, sources, "darwin");
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /selectCaptureSource/);
});

test("an armed source that vanished → refused, says to pick again", () => {
  const r = resolveStreams({ sourceId: "window:999:0", withAudio: false }, video, sources, "darwin");
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /no longer exists/);
});

test("armed + video-only request → that exact source, no audio", () => {
  const r = resolveStreams({ sourceId: "window:42:0", withAudio: true }, video, sources, "win32");
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.video.id, "window:42:0");
    assert.equal(r.audio, undefined);
    assert.equal(r.note, null);
  }
});

test("audio wanted on Windows → loopback", () => {
  const r = resolveStreams({ sourceId: "screen:0:0", withAudio: true }, videoAndAudio, sources, "win32");
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.audio, "loopback");
    assert.equal(r.note, null);
  }
});

test("audio wanted on macOS/Linux → video only, with the platform note (never a silent downgrade)", () => {
  for (const platform of ["darwin", "linux"] as const) {
    const r = resolveStreams({ sourceId: "screen:0:0", withAudio: true }, videoAndAudio, sources, platform);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.audio, undefined);
      assert.match(r.note ?? "", /Windows-only/);
      assert.match(r.note ?? "", new RegExp(platform));
    }
  }
});

test("audio not wanted by the selection → none even when the page asks", () => {
  const r = resolveStreams({ sourceId: "screen:0:0", withAudio: false }, videoAndAudio, sources, "win32");
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.audio, undefined);
});

test("a request with no video is refused", () => {
  const r = resolveStreams({ sourceId: "screen:0:0", withAudio: false }, { videoRequested: false, audioRequested: true }, sources, "win32");
  assert.equal(r.ok, false);
});
