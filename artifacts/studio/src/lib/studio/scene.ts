/**
 * marquee — scene graph.
 *
 * A Scene is an ordered list of Layers composited onto a fixed 16:9 canvas.
 * Everything here is pure data + pure math so it can be tested without a
 * browser, versioned into NEDB as-is (a scene document IS a Scene), and
 * replayed AS OF any seq later.
 *
 * Coordinates are NORMALISED (0..1) relative to the canvas so a layout
 * survives a resolution change: 720p preview and 1080p broadcast render the
 * same scene without re-authoring.
 */

export type LayerKind = "screen" | "camera" | "image" | "text" | "widget";

export interface Rect {
  /** left edge, 0..1 of canvas width */
  x: number;
  /** top edge, 0..1 of canvas height */
  y: number;
  /** width, 0..1 of canvas width */
  w: number;
  /** height, 0..1 of canvas height */
  h: number;
}

export type Shape = "rect" | "rounded" | "circle";

export interface Layer {
  id: string;
  kind: LayerKind;
  name: string;
  rect: Rect;
  visible: boolean;
  /** Only meaningful for camera/image; ignored elsewhere. */
  shape: Shape;
  /** Mirror horizontally (webcams look wrong to the streamer otherwise). */
  mirror: boolean;
  /** Text layers only. */
  text?: string;
  /** Widget layers: which widget this is (feed | alerts | chat | live-board). */
  widget?: string;
}

export interface Scene {
  id: string;
  name: string;
  /** Broadcast canvas size in pixels. Preview scales this down uniformly. */
  width: number;
  height: number;
  background: string;
  layers: Layer[];
}

export const CANVAS_1080 = { width: 1920, height: 1080 } as const;

/**
 * The most pixels we will composite and record — 4K's worth.
 *
 * Not an arbitrary limit. The canvas is drawn every frame and then encoded by
 * MediaRecorder in the same process, so the ceiling is what a machine can
 * composite AND encode at 30fps without dropping frames. A 5K iMac's display
 * is 14.7M pixels, nearly double this; recording it 1:1 costs more than the
 * sharpness is worth. Scaling to fit this budget keeps the aspect ratio exact.
 */
export const RECORD_PIXEL_BUDGET = 3840 * 2160;

/**
 * Canvas size for a captured source, preserving its aspect ratio exactly.
 * Pure; tested.
 *
 * Two rules that are not negotiable:
 *
 *  1. **Both dimensions must be even.** H.264 with 4:2:0 chroma subsampling
 *     cannot represent an odd width or height — the encoder either refuses the
 *     frame or silently pads it, and a padded frame is a green edge on one side
 *     of every recording.
 *  2. **The aspect ratio comes from the SOURCE, not from 16:9.** A 16:10
 *     laptop display recorded onto a 16:9 canvas is letterboxed, and letterbox
 *     bars burned into a file cannot be removed later.
 */
export function canvasForSource(sourceWidth: number, sourceHeight: number): { width: number; height: number } {
  // A source that reports nothing usable still has to produce a valid canvas;
  // 1080p is the honest fallback rather than a zero-sized surface.
  if (!Number.isFinite(sourceWidth) || !Number.isFinite(sourceHeight) || sourceWidth < 2 || sourceHeight < 2) {
    return { width: CANVAS_1080.width, height: CANVAS_1080.height };
  }

  let width = sourceWidth;
  let height = sourceHeight;
  const pixels = width * height;
  if (pixels > RECORD_PIXEL_BUDGET) {
    const scale = Math.sqrt(RECORD_PIXEL_BUDGET / pixels);
    width = width * scale;
    height = height * scale;
  }

  // Round DOWN to even so we never scale up past the source and never exceed
  // the budget by rounding.
  const even = (n: number) => Math.max(2, Math.floor(n / 2) * 2);
  return { width: even(width), height: even(height) };
}

/**
 * Normalised rect for a box that should read as 16:9 *in pixels* on a canvas
 * of any aspect ratio. Pure; tested.
 *
 * Normalised coordinates are relative to each axis independently, so a square
 * normalised box is only square when the canvas is. Without this, moving from
 * a 16:9 canvas to a 16:10 one silently stretches the camera.
 */
export function box16x9(normalisedWidth: number, canvasWidth: number, canvasHeight: number): { w: number; h: number } {
  const aspect = canvasWidth / canvasHeight;
  return { w: normalisedWidth, h: normalisedWidth * aspect * (9 / 16) };
}

/** The two things every gamer and creator needs on screen, out of the box. */
export function defaultScene(): Scene {
  return {
    id: "main",
    name: "Main",
    width: CANVAS_1080.width,
    height: CANVAS_1080.height,
    background: "#0b0b10",
    layers: [
      {
        id: "screen",
        kind: "screen",
        name: "Screen",
        rect: { x: 0, y: 0, w: 1, h: 1 },
        visible: true,
        shape: "rect",
        mirror: false,
      },
      {
        id: "camera",
        kind: "camera",
        name: "Camera",
        // bottom-right corner, 16:9 box at ~24% width
        rect: {
          x: 0.735,
          y: 0.69,
          ...box16x9(0.24, CANVAS_1080.width, CANVAS_1080.height),
        },
        visible: true,
        shape: "rounded",
        mirror: true,
      },
    ],
  };
}

/**
 * Re-fit a scene onto a new canvas size, keeping every layer looking the way
 * it looked. Pure; tested.
 *
 * Normalised rects are relative to each axis independently, so simply changing
 * the canvas dimensions stretches everything when the ASPECT changes. This
 * preserves each layer's pixel aspect ratio instead:
 *
 *   newH = h * (newWidth / oldWidth) * (oldHeight / newHeight)
 *
 * which collapses to `h` unchanged when the aspect is the same, however much
 * the resolution grows.
 *
 * A layer that fills the canvas is the deliberate exception — it stays filling.
 * Preserving the pixel aspect of a full-bleed screen layer would letterbox it,
 * which is the opposite of what "fill" means.
 */
export function resizeScene(scene: Scene, width: number, height: number): Scene {
  if (width === scene.width && height === scene.height) return scene;
  const wRatio = width / scene.width;
  const hRatio = scene.height / height;
  return {
    ...scene,
    width,
    height,
    layers: scene.layers.map((layer) => {
      const fills = layer.rect.w >= 1 && layer.rect.h >= 1;
      if (fills) return layer;
      return { ...layer, rect: clampRect({ ...layer.rect, h: layer.rect.h * wRatio * hRatio }) };
    }),
  };
}

/** Clamp a rect so it stays fully inside the canvas and keeps a sane minimum size. */
export function clampRect(r: Rect, minW = 0.04, minH = 0.04): Rect {
  const w = Math.min(1, Math.max(minW, r.w));
  const h = Math.min(1, Math.max(minH, r.h));
  const x = Math.min(1 - w, Math.max(0, r.x));
  const y = Math.min(1 - h, Math.max(0, r.y));
  return { x, y, w, h };
}

/** Normalised rect → pixel rect for a given render size. */
export function toPixels(r: Rect, width: number, height: number): { x: number; y: number; w: number; h: number } {
  return { x: r.x * width, y: r.y * height, w: r.w * width, h: r.h * height };
}

/** Pixel point → normalised point. */
export function toNormalised(px: number, py: number, width: number, height: number): { x: number; y: number } {
  return { x: px / width, y: py / height };
}

/** Topmost visible layer under a normalised point, or null. Later layers are on top. */
export function hitTest(scene: Scene, nx: number, ny: number): Layer | null {
  for (let i = scene.layers.length - 1; i >= 0; i--) {
    const l = scene.layers[i];
    if (!l.visible) continue;
    const { x, y, w, h } = l.rect;
    if (nx >= x && nx <= x + w && ny >= y && ny <= y + h) return l;
  }
  return null;
}

export type Handle = "nw" | "ne" | "sw" | "se";

/** Which resize handle (if any) a normalised point is over, given a handle size in normalised units. */
export function hitHandle(rect: Rect, nx: number, ny: number, hw: number, hh: number): Handle | null {
  const corners: Array<[Handle, number, number]> = [
    ["nw", rect.x, rect.y],
    ["ne", rect.x + rect.w, rect.y],
    ["sw", rect.x, rect.y + rect.h],
    ["se", rect.x + rect.w, rect.y + rect.h],
  ];
  for (const [h, cx, cy] of corners) {
    if (Math.abs(nx - cx) <= hw && Math.abs(ny - cy) <= hh) return h;
  }
  return null;
}

/** Move a rect by a normalised delta, clamped to the canvas. */
export function moveRect(r: Rect, dx: number, dy: number): Rect {
  return clampRect({ ...r, x: r.x + dx, y: r.y + dy });
}

/**
 * Resize from a corner handle by a normalised delta. When `keepAspect` is set
 * the rect keeps its current aspect ratio (cameras stay 16:9, circles stay round).
 */
export function resizeRect(r: Rect, handle: Handle, dx: number, dy: number, keepAspect: boolean): Rect {
  let { x, y, w, h } = r;
  const aspect = w / h;
  switch (handle) {
    case "se":
      w += dx;
      h += dy;
      break;
    case "sw":
      x += dx;
      w -= dx;
      h += dy;
      break;
    case "ne":
      y += dy;
      w += dx;
      h -= dy;
      break;
    case "nw":
      x += dx;
      y += dy;
      w -= dx;
      h -= dy;
      break;
  }
  if (keepAspect) {
    // Drive by the dominant axis of the drag; recompute the other.
    if (Math.abs(dx) >= Math.abs(dy)) {
      const newH = w / aspect;
      if (handle === "ne" || handle === "nw") y += h - newH;
      h = newH;
    } else {
      const newW = h * aspect;
      if (handle === "sw" || handle === "nw") x += w - newW;
      w = newW;
    }
  }
  return clampRect({ x, y, w, h });
}

/** Bring a layer to the top of the stack (rendered last). */
export function bringToFront(scene: Scene, id: string): Scene {
  const idx = scene.layers.findIndex((l) => l.id === id);
  if (idx < 0 || idx === scene.layers.length - 1) return scene;
  const layers = scene.layers.slice();
  const [l] = layers.splice(idx, 1);
  layers.push(l);
  return { ...scene, layers };
}

export function updateLayer(scene: Scene, id: string, patch: Partial<Layer>): Scene {
  return { ...scene, layers: scene.layers.map((l) => (l.id === id ? { ...l, ...patch } : l)) };
}

/** Fit a source (video) of size sw×sh into a destination box, "cover" style, returning the source crop. */
export function coverCrop(sw: number, sh: number, dw: number, dh: number): { sx: number; sy: number; sw: number; sh: number } {
  if (sw <= 0 || sh <= 0 || dw <= 0 || dh <= 0) return { sx: 0, sy: 0, sw, sh };
  const srcAspect = sw / sh;
  const dstAspect = dw / dh;
  if (srcAspect > dstAspect) {
    // source is wider — crop the sides
    const cw = sh * dstAspect;
    return { sx: (sw - cw) / 2, sy: 0, sw: cw, sh };
  }
  // source is taller — crop top/bottom
  const ch = sw / dstAspect;
  return { sx: 0, sy: (sh - ch) / 2, sw, sh: ch };
}

/** Fit "contain" style: returns the destination rect inside the box that preserves aspect. */
export function containFit(sw: number, sh: number, box: { x: number; y: number; w: number; h: number }) {
  if (sw <= 0 || sh <= 0) return box;
  const scale = Math.min(box.w / sw, box.h / sh);
  const w = sw * scale;
  const h = sh * scale;
  return { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h };
}
