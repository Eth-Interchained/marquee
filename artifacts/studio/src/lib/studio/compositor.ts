/**
 * marquee — canvas compositor.
 *
 * Renders a Scene onto a <canvas> every animation frame from a map of live
 * sources (layer id → HTMLVideoElement | HTMLImageElement). The canvas is
 * the broadcast surface: `canvas.captureStream(fps)` becomes the video track
 * we send out. Preview is the same canvas scaled by CSS — one render path.
 */

import { coverCrop, toPixels, type Layer, type Scene } from "./scene.ts";

export type Source = HTMLVideoElement | HTMLImageElement;

export interface CompositorStats {
  fps: number;
  frames: number;
  lastFrameMs: number;
}

export class Compositor {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private scene: Scene;
  private sources = new Map<string, Source>();
  private raf = 0;
  private running = false;
  private frames = 0;
  private fpsWindowStart = 0;
  private fpsWindowFrames = 0;
  stats: CompositorStats = { fps: 0, frames: 0, lastFrameMs: 0 };
  /** Selected layer id gets a selection outline drawn in PREVIEW only (see drawSelection). */
  selected: string | null = null;
  /** When true, the selection outline is drawn. Turn off for the broadcast canvas. */
  drawSelection = true;

  constructor(canvas: HTMLCanvasElement, scene: Scene) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });
    if (!ctx) throw new Error("[compositor] 2d context unavailable");
    this.ctx = ctx;
    this.scene = scene;
    this.canvas.width = scene.width;
    this.canvas.height = scene.height;
  }

  setScene(scene: Scene): void {
    if (scene.width !== this.canvas.width || scene.height !== this.canvas.height) {
      this.canvas.width = scene.width;
      this.canvas.height = scene.height;
    }
    this.scene = scene;
  }

  getScene(): Scene {
    return this.scene;
  }

  setSource(layerId: string, src: Source | null): void {
    if (src) this.sources.set(layerId, src);
    else this.sources.delete(layerId);
  }

  hasSource(layerId: string): boolean {
    return this.sources.has(layerId);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.fpsWindowStart = performance.now();
    const loop = () => {
      if (!this.running) return;
      this.renderFrame();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  /** One frame. Public so tests and screenshot tools can drive it manually. */
  renderFrame(): void {
    const t0 = performance.now();
    const { ctx, scene } = this;
    const W = scene.width;
    const H = scene.height;
    ctx.fillStyle = scene.background;
    ctx.fillRect(0, 0, W, H);

    for (const layer of scene.layers) {
      if (!layer.visible) continue;
      this.drawLayer(layer, W, H);
    }

    if (this.drawSelection && this.selected) {
      const l = scene.layers.find((x) => x.id === this.selected);
      if (l) this.drawOutline(l, W, H);
    }

    this.frames++;
    this.fpsWindowFrames++;
    const now = performance.now();
    if (now - this.fpsWindowStart >= 1000) {
      this.stats.fps = Math.round((this.fpsWindowFrames * 1000) / (now - this.fpsWindowStart));
      this.fpsWindowStart = now;
      this.fpsWindowFrames = 0;
    }
    this.stats.frames = this.frames;
    this.stats.lastFrameMs = now - t0;
  }

  private sourceSize(src: Source): { w: number; h: number } {
    if (src instanceof HTMLVideoElement) return { w: src.videoWidth, h: src.videoHeight };
    return { w: src.naturalWidth, h: src.naturalHeight };
  }

  private drawLayer(layer: Layer, W: number, H: number): void {
    const { ctx } = this;
    const box = toPixels(layer.rect, W, H);

    if (layer.kind === "text") {
      ctx.save();
      ctx.fillStyle = "#ffffff";
      ctx.font = `${Math.round(box.h * 0.6)}px Inter, system-ui, sans-serif`;
      ctx.textBaseline = "middle";
      ctx.fillText(layer.text ?? "", box.x, box.y + box.h / 2, box.w);
      ctx.restore();
      return;
    }

    if (layer.kind === "widget") {
      // Placeholder until the SSE-fed widgets land (build step 3).
      ctx.save();
      ctx.fillStyle = "rgba(255,255,255,0.06)";
      ctx.fillRect(box.x, box.y, box.w, box.h);
      ctx.strokeStyle = "rgba(255,255,255,0.25)";
      ctx.setLineDash([8, 6]);
      ctx.strokeRect(box.x + 1, box.y + 1, box.w - 2, box.h - 2);
      ctx.fillStyle = "rgba(255,255,255,0.6)";
      ctx.font = `${Math.max(14, Math.round(box.h * 0.12))}px JetBrains Mono, ui-monospace, monospace`;
      ctx.fillText(`widget: ${layer.widget ?? "?"}`, box.x + 12, box.y + 24);
      ctx.restore();
      return;
    }

    const src = this.sources.get(layer.id);
    if (!src) {
      this.drawEmpty(layer, box);
      return;
    }
    const { w: sw, h: sh } = this.sourceSize(src);
    if (sw === 0 || sh === 0) {
      this.drawEmpty(layer, box, "waiting for frames…");
      return;
    }

    ctx.save();
    this.clipShape(layer, box);
    if (layer.mirror) {
      ctx.translate(box.x + box.w, box.y);
      ctx.scale(-1, 1);
      ctx.translate(-box.x, -box.y);
    }
    if (layer.kind === "screen") {
      // Screen: letterbox (contain) — never crop someone's game.
      const scale = Math.min(box.w / sw, box.h / sh);
      const dw = sw * scale;
      const dh = sh * scale;
      ctx.drawImage(src, box.x + (box.w - dw) / 2, box.y + (box.h - dh) / 2, dw, dh);
    } else {
      // Camera/image: cover — fill the shape, crop the edges.
      const c = coverCrop(sw, sh, box.w, box.h);
      ctx.drawImage(src, c.sx, c.sy, c.sw, c.sh, box.x, box.y, box.w, box.h);
    }
    ctx.restore();
  }

  private clipShape(layer: Layer, box: { x: number; y: number; w: number; h: number }): void {
    const { ctx } = this;
    if (layer.kind === "screen" || layer.shape === "rect") return;
    ctx.beginPath();
    if (layer.shape === "circle") {
      const r = Math.min(box.w, box.h) / 2;
      ctx.arc(box.x + box.w / 2, box.y + box.h / 2, r, 0, Math.PI * 2);
    } else {
      const r = Math.min(box.w, box.h) * 0.08;
      ctx.roundRect(box.x, box.y, box.w, box.h, r);
    }
    ctx.closePath();
    ctx.clip();
  }

  private drawEmpty(layer: Layer, box: { x: number; y: number; w: number; h: number }, note?: string): void {
    const { ctx } = this;
    ctx.save();
    this.clipShape(layer, box);
    ctx.fillStyle = layer.kind === "screen" ? "#101018" : "#1a1a24";
    ctx.fillRect(box.x, box.y, box.w, box.h);
    ctx.fillStyle = "rgba(255,255,255,0.45)";
    const size = Math.max(14, Math.round(Math.min(box.w, box.h) * 0.08));
    ctx.font = `${size}px Inter, system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(note ?? `${layer.name}: no source`, box.x + box.w / 2, box.y + box.h / 2);
    ctx.restore();
  }

  private drawOutline(layer: Layer, W: number, H: number): void {
    const { ctx } = this;
    const b = toPixels(layer.rect, W, H);
    ctx.save();
    ctx.strokeStyle = "#22d3ee";
    ctx.lineWidth = Math.max(2, W / 640);
    ctx.setLineDash([]);
    ctx.strokeRect(b.x, b.y, b.w, b.h);
    const hs = Math.max(8, W / 160);
    ctx.fillStyle = "#22d3ee";
    for (const [cx, cy] of [
      [b.x, b.y],
      [b.x + b.w, b.y],
      [b.x, b.y + b.h],
      [b.x + b.w, b.y + b.h],
    ]) {
      ctx.fillRect(cx - hs / 2, cy - hs / 2, hs, hs);
    }
    ctx.restore();
  }

  /** The broadcast video track. */
  captureStream(fps = 30): MediaStream {
    return this.canvas.captureStream(fps);
  }
}
