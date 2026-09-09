/**
 * Where a recording actually lands.
 *
 * `MediaRecorder` in the renderer hands us a chunk every timeslice; this
 * appends each one to a file and never holds the recording in memory. That is
 * the whole point: an hour of 1080p is several gigabytes, and the obvious
 * implementation — collect Blobs, join at the end, download — loses the lot
 * the moment the tab is reloaded or the machine runs out of RAM.
 *
 * Two rules this module will not bend:
 *
 *   1. **A recording is never deleted here.** Not on abort, not on a failed
 *      finalise, not to reclaim space. If a recording stops badly the partial
 *      file stays on disk and its path is reported — a partial Matroska is
 *      usually still playable, and it is the operator's footage either way.
 *   2. **A write is never silently dropped.** Every failure path reports which
 *      file, how many bytes made it, and what the OS said.
 */

import { createWriteStream, mkdirSync, openSync, statSync, type WriteStream } from "node:fs";
import path from "node:path";
import { createLogger, errorFields } from "./logger";

const log = createLogger("recorder");

export type RecordingHandle = {
  id: string;
  path: string;
  startedAt: string;
};

export type RecordingResult = {
  id: string;
  path: string;
  bytes: number;
  durationMs: number;
  chunks: number;
  /** True when the renderer stopped cleanly rather than the app tearing down. */
  clean: boolean;
};

type Active = {
  id: string;
  path: string;
  stream: WriteStream;
  startedAt: number;
  bytes: number;
  chunks: number;
  /** Set when a write fails; reported at finish rather than thrown mid-stream. */
  writeError: string | null;
};

/**
 * `video/x-matroska;codecs=avc1,opus` -> `.mkv`. Pure; exported for tests.
 *
 * The extension has to match what the muxer actually produced, because the
 * finalise step reads it back with ffmpeg and a lying extension is how you get
 * a "moov atom not found" that looks like corruption.
 */
export function extensionForMimeType(mimeType: string): string {
  const base = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  switch (base) {
    case "video/x-matroska":
      return ".mkv";
    case "video/mp4":
      return ".mp4";
    case "video/webm":
      return ".webm";
    default:
      // Better an honest .bin that ffmpeg will probe than a .mp4 that lies.
      return ".bin";
  }
}

/**
 * A filename that is safe on every platform, sorts chronologically, and cannot
 * collide within a second. Pure; exported for tests.
 */
export function recordingFilename(now: Date, label: string | undefined, mimeType: string, suffix = ""): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-").replace("T", "_").replace("Z", "");
  // Windows forbids <>:"/\|?* and trailing dots; keep it to a conservative set.
  const safe = (label ?? "")
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9 _-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 48);
  const middle = safe ? `_${safe}` : "";
  return `marquee_${stamp}${middle}${suffix}${extensionForMimeType(mimeType)}`;
}

export class RecordingSink {
  private readonly dir: string;
  private readonly now: () => Date;
  private readonly active = new Map<string, Active>();
  private counter = 0;

  /**
   * `now` exists so the filename-collision path can be tested deterministically:
   * two takes only collide when they start in the same millisecond, which a
   * test cannot arrange by waiting.
   */
  constructor(directory: string, now: () => Date = () => new Date()) {
    this.dir = directory;
    this.now = now;
  }

  /** The directory recordings land in. Created lazily so construction cannot fail. */
  get directory(): string {
    return this.dir;
  }

  begin(options: { mimeType: string; label?: string }): RecordingHandle {
    mkdirSync(this.dir, { recursive: true });
    this.counter += 1;
    const id = `rec_${Date.now().toString(36)}_${this.counter}`;
    // Open the descriptor SYNCHRONOUSLY and hand the stream an fd. Letting
    // createWriteStream open the path itself defers the open to the event
    // loop, which means begin() returns before the file exists and a
    // permission error arrives as an 'error' event minutes later — i.e. after
    // the take. This way a path that cannot be written throws here, while the
    // operator is still looking at the button.
    const now = this.now();
    let filePath = "";
    let fd = -1;
    // "wx" refuses to open an existing file, so a collision can never truncate
    // an earlier take. Two takes started in the same millisecond with the same
    // label collide, so the name gets a suffix and tries again.
    for (let attempt = 0; ; attempt += 1) {
      const suffix = attempt === 0 ? "" : `-${attempt + 1}`;
      filePath = path.join(this.dir, recordingFilename(now, options.label, options.mimeType, suffix));
      try {
        fd = openSync(filePath, "wx");
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // Only a collision is worth retrying; EACCES, ENOSPC and friends are
        // the operator's problem to see immediately.
        if (code !== "EEXIST" || attempt >= 99) throw error;
      }
    }
    const stream = createWriteStream("", { fd, autoClose: true });
    const entry: Active = {
      id,
      path: filePath,
      stream,
      startedAt: Date.now(),
      bytes: 0,
      chunks: 0,
      writeError: null,
    };
    stream.on("error", (error) => {
      // Do not throw from the stream's own event — record it and let finish()
      // report it, so a disk-full at minute 50 does not vanish into stderr.
      entry.writeError = error instanceof Error ? error.message : String(error);
      log.error("recording write stream failed", { id, path: filePath, ...errorFields(error) });
    });
    this.active.set(id, entry);
    log.info("recording started", { id, path: filePath, mimeType: options.mimeType });
    return { id, path: filePath, startedAt: new Date(entry.startedAt).toISOString() };
  }

  /** Appends one chunk. Returns the running byte count. */
  write(id: string, chunk: Uint8Array): { bytes: number; chunks: number } {
    const entry = this.active.get(id);
    if (!entry) throw new Error(`recording ${id} is not open (already finished, or never started)`);
    if (chunk.byteLength === 0) return { bytes: entry.bytes, chunks: entry.chunks };
    entry.stream.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    entry.bytes += chunk.byteLength;
    entry.chunks += 1;
    return { bytes: entry.bytes, chunks: entry.chunks };
  }

  private async close(id: string, clean: boolean): Promise<RecordingResult> {
    const entry = this.active.get(id);
    if (!entry) throw new Error(`recording ${id} is not open`);
    this.active.delete(id);
    await new Promise<void>((resolve) => entry.stream.end(resolve));
    // Trust the filesystem over our own counter.
    let bytes = entry.bytes;
    try {
      bytes = statSync(entry.path).size;
    } catch (error) {
      log.warn("could not stat a finished recording; reporting the counted bytes", { id, ...errorFields(error) });
    }
    if (entry.writeError) {
      log.error("recording finished with a write error; the partial file is kept", {
        id,
        path: entry.path,
        bytes,
        detail: entry.writeError,
      });
      throw new Error(
        `the recording at ${entry.path} hit a write error after ${bytes} bytes: ${entry.writeError}. ` +
          "The partial file has been kept.",
      );
    }
    log.info(clean ? "recording finished" : "recording aborted; partial file kept", {
      id,
      path: entry.path,
      bytes,
      chunks: entry.chunks,
    });
    return {
      id,
      path: entry.path,
      bytes,
      durationMs: Date.now() - entry.startedAt,
      chunks: entry.chunks,
      clean,
    };
  }

  finish(id: string): Promise<RecordingResult> {
    return this.close(id, true);
  }

  /** Ends a recording that did not stop cleanly. The file is KEPT. */
  abort(id: string): Promise<RecordingResult> {
    return this.close(id, false);
  }

  /** Ids still open. Used on shutdown so nothing is left half-written. */
  openIds(): string[] {
    return [...this.active.keys()];
  }

  /** Closes everything on the way down, keeping every partial file. */
  async closeAll(): Promise<RecordingResult[]> {
    const results: RecordingResult[] = [];
    for (const id of this.openIds()) {
      try {
        results.push(await this.abort(id));
      } catch (error) {
        log.warn("a recording could not be closed cleanly on shutdown", { id, ...errorFields(error) });
      }
    }
    return results;
  }
}
