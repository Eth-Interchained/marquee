import { test } from "node:test";
import assert from "node:assert/strict";
import {
  box16x9,
  bringToFront,
  canvasForSource,
  clampRect,
  containFit,
  coverCrop,
  defaultScene,
  hitHandle,
  hitTest,
  moveRect,
  RECORD_PIXEL_BUDGET,
  resizeRect,
  resizeScene,
  toNormalised,
  toPixels,
  updateLayer,
} from "./scene.ts";

test("default scene has a full-bleed screen under a mirrored camera corner", () => {
  const s = defaultScene();
  assert.equal(s.layers.length, 2);
  assert.equal(s.layers[0].kind, "screen");
  assert.deepEqual(s.layers[0].rect, { x: 0, y: 0, w: 1, h: 1 });
  const cam = s.layers[1];
  assert.equal(cam.kind, "camera");
  assert.equal(cam.mirror, true);
  // camera sits inside the canvas
  assert.ok(cam.rect.x + cam.rect.w <= 1 && cam.rect.y + cam.rect.h <= 1);
  // camera box is 16:9 in PIXELS (normalised h is scaled by canvas aspect)
  const px = toPixels(cam.rect, s.width, s.height);
  assert.ok(Math.abs(px.w / px.h - 16 / 9) < 1e-9, `camera aspect ${px.w / px.h}`);
});

test("clampRect keeps rects inside the canvas and above the minimum size", () => {
  assert.deepEqual(clampRect({ x: 0.9, y: 0.9, w: 0.3, h: 0.3 }), { x: 0.7, y: 0.7, w: 0.3, h: 0.3 });
  assert.deepEqual(clampRect({ x: -0.5, y: -0.5, w: 0.2, h: 0.2 }), { x: 0, y: 0, w: 0.2, h: 0.2 });
  const tiny = clampRect({ x: 0.5, y: 0.5, w: 0, h: 0 });
  assert.equal(tiny.w, 0.04);
  assert.equal(tiny.h, 0.04);
  const huge = clampRect({ x: 0, y: 0, w: 5, h: 5 });
  assert.deepEqual(huge, { x: 0, y: 0, w: 1, h: 1 });
});

test("toPixels / toNormalised round-trip", () => {
  const r = { x: 0.25, y: 0.5, w: 0.1, h: 0.2 };
  const px = toPixels(r, 1920, 1080);
  assert.deepEqual(px, { x: 480, y: 540, w: 192, h: 216 });
  const n = toNormalised(px.x, px.y, 1920, 1080);
  assert.equal(n.x, 0.25);
  assert.equal(n.y, 0.5);
});

test("hitTest returns the TOPMOST visible layer (later = on top)", () => {
  const s = defaultScene();
  const cam = s.layers[1];
  const inCam = hitTest(s, cam.rect.x + cam.rect.w / 2, cam.rect.y + cam.rect.h / 2);
  assert.equal(inCam?.id, "camera");
  const onScreen = hitTest(s, 0.1, 0.1);
  assert.equal(onScreen?.id, "screen");
  const hidden = updateLayer(s, "camera", { visible: false });
  assert.equal(hitTest(hidden, cam.rect.x + 0.01, cam.rect.y + 0.01)?.id, "screen");
  assert.equal(hitTest(s, 1.5, 1.5), null);
});

test("hitHandle detects each corner within tolerance and nothing in the middle", () => {
  const r = { x: 0.2, y: 0.2, w: 0.4, h: 0.4 };
  assert.equal(hitHandle(r, 0.2, 0.2, 0.01, 0.01), "nw");
  assert.equal(hitHandle(r, 0.6, 0.2, 0.01, 0.01), "ne");
  assert.equal(hitHandle(r, 0.2, 0.6, 0.01, 0.01), "sw");
  assert.equal(hitHandle(r, 0.605, 0.605, 0.01, 0.01), "se");
  assert.equal(hitHandle(r, 0.4, 0.4, 0.01, 0.01), null);
  assert.equal(hitHandle(r, 0.62, 0.62, 0.01, 0.01), null);
});

test("moveRect translates and clamps", () => {
  const r = { x: 0.5, y: 0.5, w: 0.2, h: 0.2 };
  assert.deepEqual(moveRect(r, 0.1, -0.1), { x: 0.6, y: 0.4, w: 0.2, h: 0.2 });
  const edge = moveRect(r, 1, 1);
  assert.deepEqual(edge, { x: 0.8, y: 0.8, w: 0.2, h: 0.2 });
});

test("resizeRect from SE grows freely; with keepAspect the ratio is preserved", () => {
  const r = { x: 0.1, y: 0.1, w: 0.4, h: 0.2 };
  const free = resizeRect(r, "se", 0.1, 0.05, false);
  assert.deepEqual(free, { x: 0.1, y: 0.1, w: 0.5, h: 0.25 });
  const kept = resizeRect(r, "se", 0.1, 0, true);
  assert.ok(Math.abs(kept.w / kept.h - 2) < 1e-9, `aspect ${kept.w / kept.h}`);
  assert.equal(kept.w, 0.5);
  assert.equal(kept.x, 0.1);
  assert.equal(kept.y, 0.1);
});

test("resizeRect from NW moves the origin and keeps the far corner fixed", () => {
  const r = { x: 0.3, y: 0.3, w: 0.4, h: 0.4 };
  const out = resizeRect(r, "nw", -0.1, -0.1, false);
  const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-12, `${a} !== ${b}`);
  close(out.x, 0.2);
  close(out.y, 0.2);
  close(out.w, 0.5);
  close(out.h, 0.5);
  // far corner unchanged
  assert.ok(Math.abs(out.x + out.w - (r.x + r.w)) < 1e-12);
  assert.ok(Math.abs(out.y + out.h - (r.y + r.h)) < 1e-12);
});

test("resizeRect never lets a layer collapse below the minimum", () => {
  const r = { x: 0.3, y: 0.3, w: 0.1, h: 0.1 };
  const out = resizeRect(r, "se", -0.5, -0.5, false);
  assert.equal(out.w, 0.04);
  assert.equal(out.h, 0.04);
});

test("bringToFront reorders without losing layers; no-op when already on top", () => {
  const s = defaultScene();
  const flipped = bringToFront(s, "screen");
  assert.deepEqual(
    flipped.layers.map((l) => l.id),
    ["camera", "screen"],
  );
  assert.equal(bringToFront(s, "camera"), s);
  assert.equal(bringToFront(s, "nope"), s);
});

test("coverCrop crops the wider axis, centred", () => {
  // 16:9 source into a square box → crop sides
  const c = coverCrop(1920, 1080, 500, 500);
  assert.equal(c.sh, 1080);
  assert.equal(c.sw, 1080);
  assert.equal(c.sx, 420);
  assert.equal(c.sy, 0);
  // portrait source into 16:9 box → crop top/bottom
  const p = coverCrop(720, 1280, 1600, 900);
  assert.equal(p.sw, 720);
  assert.equal(p.sh, 405);
  assert.equal(p.sx, 0);
  assert.equal(p.sy, (1280 - 405) / 2);
  // degenerate input returns the source untouched instead of NaN
  assert.deepEqual(coverCrop(0, 0, 100, 100), { sx: 0, sy: 0, sw: 0, sh: 0 });
});

test("containFit letterboxes and centres", () => {
  const f = containFit(1920, 1080, { x: 0, y: 0, w: 1000, h: 1000 });
  assert.ok(Math.abs(f.w - 1000) < 1e-9, `w ${f.w}`);
  assert.ok(Math.abs(f.h - 562.5) < 1e-9, `h ${f.h}`);
  assert.ok(Math.abs(f.y - (1000 - 562.5) / 2) < 1e-9, `y ${f.y}`);
});

// ---------------------------------------------------------------- resolution

test('canvasForSource preserves the source aspect exactly and keeps both dimensions even', () => {
  // 1080p and 1440p pass through untouched — under budget, already even.
  assert.deepEqual(canvasForSource(1920, 1080), { width: 1920, height: 1080 });
  assert.deepEqual(canvasForSource(2560, 1440), { width: 2560, height: 1440 });
  // Exactly at the budget is not over it.
  assert.deepEqual(canvasForSource(3840, 2160), { width: 3840, height: 2160 });

  // A 5K iMac (14.7M pixels) scales into the 4K budget, aspect intact.
  const imac5k = canvasForSource(5120, 2880);
  assert.ok(imac5k.width * imac5k.height <= RECORD_PIXEL_BUDGET, 'must not exceed the budget');
  assert.ok(Math.abs(imac5k.width / imac5k.height - 5120 / 2880) < 0.01, 'aspect must survive scaling');

  // A 16:10 MacBook display must NOT be coerced to 16:9 — letterbox bars burned
  // into a file cannot be removed later.
  const mbp = canvasForSource(3024, 1964);
  assert.ok(Math.abs(mbp.width / mbp.height - 3024 / 1964) < 0.01);
  assert.notEqual(mbp.width / mbp.height, 16 / 9);

  // H.264 4:2:0 cannot represent an odd dimension.
  for (const [w, h] of [[1919, 1079], [1001, 999], [5121, 2881], [3, 3]]) {
    const out = canvasForSource(w, h);
    assert.equal(out.width % 2, 0, `${w}x${h} produced an odd width`);
    assert.equal(out.height % 2, 0, `${w}x${h} produced an odd height`);
  }

  // Never scale UP: a small window stays its own size.
  assert.deepEqual(canvasForSource(640, 480), { width: 640, height: 480 });

  // A source that reports nothing usable still yields a valid canvas.
  assert.deepEqual(canvasForSource(0, 0), { width: 1920, height: 1080 });
  assert.deepEqual(canvasForSource(Number.NaN, 1080), { width: 1920, height: 1080 });
  assert.deepEqual(canvasForSource(Infinity, Infinity), { width: 1920, height: 1080 });
});

test('box16x9 gives a box that is 16:9 in PIXELS on any canvas aspect', () => {
  const check = (w: number, cw: number, ch: number) => {
    const box = box16x9(w, cw, ch);
    const pixelAspect = (box.w * cw) / (box.h * ch);
    assert.ok(Math.abs(pixelAspect - 16 / 9) < 0.001, `got ${pixelAspect} on ${cw}x${ch}`);
  };
  check(0.24, 1920, 1080);
  check(0.24, 3024, 1964); // 16:10-ish laptop
  check(0.3, 3840, 2160);
  check(0.5, 2560, 1080); // ultrawide
  // On a 16:9 canvas a 16:9 box has equal normalised dimensions — which is why
  // the original hardcoded constant happened to work, and why it stopped
  // working the moment the canvas could be any other shape.
  assert.ok(Math.abs(box16x9(0.24, 1920, 1080).h - 0.24) < 1e-9);
});

test('resizeScene keeps layers looking the same, and keeps a full-bleed layer filling', () => {
  const scene = defaultScene();
  const camera = () => scene.layers.find((l) => l.id === 'camera')!;
  const cameraOf = (s: Scene) => s.layers.find((l) => l.id === 'camera')!;
  const screenOf = (s: Scene) => s.layers.find((l) => l.id === 'screen')!;

  // Same aspect, more pixels: nothing about the layout changes.
  const bigger = resizeScene(scene, 3840, 2160);
  assert.deepEqual(cameraOf(bigger).rect, camera().rect);
  assert.deepEqual(screenOf(bigger).rect, { x: 0, y: 0, w: 1, h: 1 });

  // Different aspect: the camera's PIXEL aspect ratio must survive.
  const before = camera().rect;
  const beforeAspect = (before.w * scene.width) / (before.h * scene.height);
  const tall = resizeScene(scene, 3024, 1964);
  const after = cameraOf(tall).rect;
  const afterAspect = (after.w * 3024) / (after.h * 1964);
  assert.ok(Math.abs(beforeAspect - afterAspect) < 0.01, `camera stretched: ${beforeAspect} -> ${afterAspect}`);

  // The screen layer stays full-bleed rather than being letterboxed to keep
  // its "aspect" — that is the whole point of filling.
  assert.deepEqual(screenOf(tall).rect, { x: 0, y: 0, w: 1, h: 1 });

  // Resizing to the same size is identity, and returns the very same object so
  // React does not re-render the scene for nothing.
  assert.equal(resizeScene(scene, scene.width, scene.height), scene);

  // Layers never escape the canvas.
  for (const layer of resizeScene(scene, 1280, 1024).layers) {
    assert.ok(layer.rect.x >= 0 && layer.rect.y >= 0);
    assert.ok(layer.rect.x + layer.rect.w <= 1.0001);
    assert.ok(layer.rect.y + layer.rect.h <= 1.0001);
  }
});
