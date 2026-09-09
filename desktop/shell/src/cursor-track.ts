/**
 * The cursor's path during a recording, written beside the take.
 *
 * WHY THIS EXISTS: a follow-cursor zoom needs to know where the cursor was at
 * every moment, and the page cannot find out. `getDisplayMedia` paints the
 * cursor into the pixels but reports no coordinates, and a renderer only sees
 * pointer events inside its own window — useless when the whole point is
 * recording some *other* application. Only the main process can ask the OS,
 * via `screen.getCursorScreenPoint()`.
 *
 * So the shell samples the global cursor while a take is open and writes a
 * sidecar track. Nothing consumes it yet; recording it now is what makes the
 * zoom pass possible later, and a take recorded without it can never be
 * zoomed retroactively.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: clicks. Global mouse-button events need
 * a native hook Electron does not provide, so click-triggered zoom fragments
 * are out of reach without a native module. Position, velocity and dwell are
 * available and carry most of the signal.
 *
 * The format is JSON Lines: one header object, then one array per sample.
 * Append-only and streamed, so a take that ends badly still leaves a readable
 * track for everything up to that point — the same rule the recording itself
 * follows.
 */

import { createWriteStream, mkdirSync, openSync, statSync, type WriteStream } from "node:fs";
import path from "node:path";
import { createLogger, errorFields } from "./logger";

const log = createLogger("cursor-track");

/** A display's position and size in the OS's global coordinate space. */
export type DisplayBounds = { x: number; y: number; width: number; height: number };

export type CursorPoint = { x: number; y: number };

/**
 * A sample, normalised to the captured display: `x`/`y` in 0..1, and whether
 * the cursor was actually on that display when sampled.
 */
export type NormalisedCursor = { x: number; y: number; inside: boolean };

/**
 * Global screen point -> position within the captured display. Pure; tested.
 *
 * `inside` is not decoration. On a multi-monitor setup the cursor leaves the
 * recorded display constantly, and a zoom that chased a clamped edge value
 * would lurch to the border every time the operator glanced at their other
 * screen. The consumer needs to know to hold still instead.
 */
export function normaliseCursor(point: CursorPoint, bounds: DisplayBounds): NormalisedCursor {
  if (bounds.width <= 0 || bounds.height <= 0) return { x: 0.5, y: 0.5, inside: false };
  const rawX = (point.x - bounds.x) / bounds.width;
  const rawY = (point.y - bounds.y) / bounds.height;
  const inside = rawX >= 0 && rawX <= 1 && rawY >= 0 && rawY <= 1;
  // Clamped so a consumer never has to defend against out-of-range values,
  // but flagged so it can tell a clamp from a real edge position.
  return {
    x: Math.min(1, Math.max(0, rawX)),
    y: Math.min(1, Math.max(0, rawY)),
    inside,
  };
}

/**
 * Is this sample worth writing? Pure; tested.
 *
 * A still cursor at 60Hz would write 3,600 identical rows a minute. Dropping
 * samples that moved less than a threshold collapses that to nothing while
 * keeping every real movement — and because each row carries its own
 * timestamp, dropping rows loses no timing information at all.
 *
 * A change in `inside` is ALWAYS worth writing even without movement: leaving
 * the display is an event, not a position.
 */
export function isWorthSampling(
  previous: NormalisedCursor | null,
  next: NormalisedCursor,
  minDelta = 0.0015,
): boolean {
  if (!previous) return true;
  if (previous.inside !== next.inside) return true;
  return Math.abs(next.x - previous.x) >= minDelta || Math.abs(next.y - previous.y) >= minDelta;
}

/**
 * Electron's `display_id` (a string) -> the numeric id `screen.getAllDisplays()`
 * uses. Pure; tested.
 *
 * DO NOT go back to parsing the desktopCapturer source id for this. It looks
 * like it carries the display id — `screen:400:0` — but that number is
 * Chromium's internal media device id. Measured on a machine whose only
 * display was id 60 while the source said 400: parsing the id resolved to no
 * display at all, and on a multi-monitor setup it would resolve to the WRONG
 * one and normalise every cursor sample against the wrong coordinate space.
 * `display_id` from the source object is the documented join.
 */
export function parseDisplayId(displayId: string | null | undefined): number | null {
  if (typeof displayId !== "string" || displayId.trim() === "") return null;
  const id = Number(displayId);
  return Number.isInteger(id) ? id : null;
}

export type CursorTrackResult = {
  path: string;
  samples: number;
  /** Samples dropped because the cursor had not meaningfully moved. */
  skipped: number;
  bytes: number;
  durationMs: number;
};

/** Where the track goes for a given take: `<take>.cursor.jsonl`. Pure; tested. */
export function trackPathFor(recordingPath: string): string {
  const parsed = path.parse(recordingPath);
  return path.join(parsed.dir, `${parsed.name}.cursor.jsonl`);
}

/**
 * Samples the global cursor for the life of one take.
 *
 * `now` and `readCursor` are injected so the whole thing is testable without
 * Electron and without real time — a sampler you can only observe through a
 * real 60Hz timer is a sampler you cannot assert anything about.
 */
export class CursorTrack {
  private stream: WriteStream | null = null;
  private readonly filePath: string;
  private readonly bounds: DisplayBounds;
  private readonly readCursor: () => CursorPoint;
  private readonly now: () => number;
  private readonly minDelta: number;
  private timer: NodeJS.Timeout | null = null;
  private startedAt = 0;
  private previous: NormalisedCursor | null = null;
  private samples = 0;
  private skipped = 0;
  private writeError: string | null = null;

  constructor(options: {
    recordingPath: string;
    bounds: DisplayBounds;
    readCursor: () => CursorPoint;
    now?: () => number;
    minDelta?: number;
  }) {
    this.filePath = trackPathFor(options.recordingPath);
    this.bounds = options.bounds;
    this.readCursor = options.readCursor;
    this.now = options.now ?? (() => Date.now());
    this.minDelta = options.minDelta ?? 0.0015;
  }

  get path(): string {
    return this.filePath;
  }

  /**
   * Opens the track and writes its header. Synchronous open for the same
   * reason the recording itself uses one: a path that cannot be written should
   * fail now, not silently at the end of a take.
   */
  start(): void {
    if (this.stream) throw new Error("this cursor track is already open");
    mkdirSync(path.dirname(this.filePath), { recursive: true });
    const fd = openSync(this.filePath, "w");
    this.stream = createWriteStream("", { fd, autoClose: true });
    this.stream.on("error", (error) => {
      this.writeError = error instanceof Error ? error.message : String(error);
      log.error("cursor track write failed", { path: this.filePath, ...errorFields(error) });
    });
    this.startedAt = this.now();
    // The header records what the coordinates MEAN. Without the bounds and the
    // scale, a track is a list of numbers nobody can interpret later.
    this.stream.write(
      `${JSON.stringify({
        v: 1,
        kind: "marquee-cursor-track",
        startedAt: new Date(this.startedAt).toISOString(),
        display: this.bounds,
        minDelta: this.minDelta,
        note: "rows are [msSinceStart, x, y, inside] with x/y normalised 0..1 to the display above",
      })}\n`,
    );
  }

  /** Takes one sample. Returns true when it was written rather than skipped. */
  sample(): boolean {
    if (!this.stream) return false;
    const point = this.readCursor();
    const normalised = normaliseCursor(point, this.bounds);
    if (!isWorthSampling(this.previous, normalised, this.minDelta)) {
      this.skipped += 1;
      return false;
    }
    this.previous = normalised;
    this.samples += 1;
    const t = this.now() - this.startedAt;
    // Four decimals is ~0.4px on a 4K display: finer than anything a zoom can
    // act on, and it keeps the file a third the size of full float output.
    this.stream.write(
      `[${t},${normalised.x.toFixed(4)},${normalised.y.toFixed(4)},${normalised.inside ? 1 : 0}]\n`,
    );
    return true;
  }

  /** Starts sampling on a timer. 60Hz by default — one sample per frame. */
  startSampling(intervalMs = 1000 / 60): void {
    if (this.timer) return;
    this.sample();
    this.timer = setInterval(() => this.sample(), intervalMs);
  }

  /** Closes the track. The file is KEPT even when a write failed. */
  async stop(): Promise<CursorTrackResult> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    const stream = this.stream;
    this.stream = null;
    if (stream) await new Promise<void>((resolve) => stream.end(resolve));

    let bytes = 0;
    try {
      bytes = statSync(this.filePath).size;
    } catch (error) {
      // Report it rather than reporting a zero that looks like an empty track.
      log.warn("could not stat the cursor track", { path: this.filePath, ...errorFields(error) });
    }

    const result: CursorTrackResult = {
      path: this.filePath,
      samples: this.samples,
      skipped: this.skipped,
      bytes,
      durationMs: this.now() - this.startedAt,
    };

    if (this.writeError) {
      log.error("the cursor track hit a write error; the partial file is kept", {
        ...result,
        detail: this.writeError,
      });
    } else {
      log.info("cursor track written", result);
    }
    return result;
  }
}
