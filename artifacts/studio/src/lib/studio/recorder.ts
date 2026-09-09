/**
 * Recording the composited scene to disk. This is the app's primary function:
 * going live is the option, recording is the job.
 *
 * WHAT CHROMIUM ACTUALLY DOES — measured in Electron 44 / Chromium 152 by
 * recording real bytes and probing them, not by trusting
 * `MediaRecorder.isTypeSupported`, which lies by omission:
 *
 *   video/mp4                            -> a real MP4 containing VP9/opus.
 *                                           Legal; QuickTime and most NLEs
 *                                           refuse it.
 *   video/mp4;codecs="avc1…,mp4a…"       -> the constructor THROWS.
 *   video/webm;codecs="h264,opus"        -> silently becomes
 *                                           video/x-matroska;codecs=avc1,opus.
 *   video/webm;codecs="vp9,opus"         -> webm vp9/opus.
 *   (no type)                            -> webm vp8/opus.
 *
 * You get the right codec or the right container, never both. So: record
 * H.264/opus into Matroska — the best codec on offer — and let the bundled
 * Python remux it to an MP4 by COPYING the video stream. No second generation
 * of loss, and it runs at roughly 24x realtime.
 *
 * Every chunk goes straight to the shell and onto disk. Nothing accumulates in
 * the page, so a long take costs the renderer nothing and a crash costs the
 * tail rather than the whole recording.
 */

import type { ShellRecording, ShellRecordingClosed } from '../shell-bridge';

/** What a chosen recording format means downstream. */
export type RecordingFormat = {
  /** Pass to the MediaRecorder constructor. Empty string means "browser default". */
  mimeType: string;
  /** The codec we expect in the file. */
  videoCodec: 'h264' | 'vp9' | 'vp8' | 'unknown';
  /**
   * True when the file can become an MP4 by stream copy. False means the only
   * route to MP4 is a full re-encode, which the runtime deliberately refuses —
   * it would be slow and lossy, and the operator should know that up front.
   */
  canStreamCopyToMp4: boolean;
  /** Shown in the UI, verbatim. */
  note: string;
};

/**
 * Preference order, best first. Each entry says why it is where it is.
 * Pure; takes the support predicate so it is testable without a browser.
 */
export const RECORDING_FORMATS: RecordingFormat[] = [
  {
    // What Chromium actually produces for an H.264 request. Asking for it by
    // name means the type we hand the shell matches the bytes it will receive,
    // so the file gets the right extension.
    mimeType: 'video/x-matroska;codecs=avc1,opus',
    videoCodec: 'h264',
    canStreamCopyToMp4: true,
    note: 'H.264 in Matroska — finalises to MP4 by copying the video, so there is no quality loss.',
  },
  {
    // Same bytes by another name: Chromium rewrites this to Matroska.
    mimeType: 'video/webm;codecs=h264,opus',
    videoCodec: 'h264',
    canStreamCopyToMp4: true,
    note: 'H.264 requested as WebM — Chromium writes Matroska, which finalises to MP4 losslessly.',
  },
  {
    mimeType: 'video/webm;codecs=vp9,opus',
    videoCodec: 'vp9',
    canStreamCopyToMp4: false,
    note: 'VP9 WebM. This machine has no H.264 encoder, so the recording cannot be turned into an MP4 without re-encoding.',
  },
  {
    mimeType: 'video/webm;codecs=vp8,opus',
    videoCodec: 'vp8',
    canStreamCopyToMp4: false,
    note: 'VP8 WebM — the last resort on this machine. MP4 would need a full re-encode.',
  },
];

/**
 * Picks the best format this machine can actually record. Pure; tested.
 * Returns null when the browser supports none of them, which is a real answer
 * and not an exception to swallow.
 */
export function pickRecordingFormat(isSupported: (type: string) => boolean): RecordingFormat | null {
  for (const format of RECORDING_FORMATS) {
    if (isSupported(format.mimeType)) return format;
  }
  return null;
}

export type RecorderState =
  | { kind: 'idle' }
  | { kind: 'recording'; id: string; path: string; since: number; bytes: number; chunks: number }
  | { kind: 'paused'; id: string; path: string; since: number; bytes: number; chunks: number }
  | { kind: 'finalising'; path: string; detail: string }
  | { kind: 'stopped'; path: string; bytes: number; durationMs: number; mp4Path: string | null; note: string }
  | { kind: 'error'; message: string; /** Kept whenever a partial take survived. */ path: string | null };

export type RecorderOptions = {
  stream: MediaStream;
  recording: ShellRecording;
  format: RecordingFormat;
  label?: string;
  /**
   * How often MediaRecorder hands over a chunk. One second keeps the write
   * volume sane while bounding what a hard crash can cost.
   */
  timesliceMs?: number;
  onState?: (state: RecorderState) => void;
  /** Injected in tests; defaults to the global. */
  recorderFactory?: (stream: MediaStream, options: { mimeType?: string }) => MediaRecorder;
};

/**
 * Human-readable size. Pure; tested — the UI shows this while recording and a
 * wrong unit here reads as a broken recorder.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

/** `mm:ss`, or `h:mm:ss` past an hour. Pure; tested. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

/**
 * One take. Owns a MediaRecorder and the file behind it.
 *
 * Chunks are written in strict order through a single promise chain: the
 * `dataavailable` handler is synchronous while the write is not, so without
 * the chain a slow disk would interleave chunks and corrupt the container.
 */
export class RecordingSession {
  private readonly options: RecorderOptions;
  private recorder: MediaRecorder | null = null;
  private handleId: string | null = null;
  private filePath: string | null = null;
  private startedAt = 0;
  private bytes = 0;
  private chunks = 0;
  /** The write chain. Every chunk waits for the previous one. */
  private queue: Promise<void> = Promise.resolve();
  private failure: string | null = null;
  private state: RecorderState = { kind: 'idle' };

  constructor(options: RecorderOptions) {
    this.options = options;
  }

  get current(): RecorderState {
    return this.state;
  }

  private emit(state: RecorderState): void {
    this.state = state;
    this.options.onState?.(state);
  }

  async start(): Promise<{ id: string; path: string }> {
    if (this.recorder) throw new Error('This take is already recording.');
    if (this.options.stream.getVideoTracks().length === 0) {
      throw new Error('There is nothing to record — add a screen, window, or camera to the scene first.');
    }

    const { format, recording, label } = this.options;
    // Open the file BEFORE starting the recorder. If the disk refuses, the
    // operator finds out now instead of after a take that went nowhere.
    const begun = await recording.begin(format.mimeType, label);
    this.handleId = begun.id;
    this.filePath = begun.path;
    this.startedAt = Date.now();

    const factory =
      this.options.recorderFactory ??
      ((stream: MediaStream, opts: { mimeType?: string }) => new MediaRecorder(stream, opts));

    try {
      this.recorder = factory(this.options.stream, format.mimeType ? { mimeType: format.mimeType } : {});
    } catch (error) {
      // The file is already open; close it so there is no zero-byte orphan
      // holding a descriptor. The file itself is kept, as always.
      const detail = error instanceof Error ? error.message : String(error);
      await recording.abort(begun.id).catch((closeError: unknown) => {
        // Two independent failures — say both, or the second hides the first.
        console.error('[marquee] the recording file could not be closed after the recorder refused to start', closeError);
      });
      this.recorder = null;
      this.handleId = null;
      const message = `This machine refused to record ${format.mimeType || 'the default format'}: ${detail}`;
      this.emit({ kind: 'error', message, path: begun.path });
      throw new Error(message);
    }

    this.recorder.ondataavailable = (event: BlobEvent) => {
      if (!event.data || event.data.size === 0) return;
      this.enqueue(event.data);
    };
    this.recorder.onerror = (event: Event) => {
      const detail = (event as unknown as { error?: { message?: string; name?: string } }).error;
      this.fail(
        `The recorder stopped: ${detail?.name ?? 'unknown error'}${detail?.message ? ` — ${detail.message}` : ''}`,
      );
    };

    this.recorder.start(this.options.timesliceMs ?? 1000);
    this.emit({ kind: 'recording', id: begun.id, path: begun.path, since: this.startedAt, bytes: 0, chunks: 0 });
    return { id: begun.id, path: begun.path };
  }

  private enqueue(blob: Blob): void {
    const id = this.handleId;
    if (!id) return;
    this.queue = this.queue.then(async () => {
      // A take that has already failed must not keep writing into a file the
      // shell has closed; the first failure is the one worth reporting.
      if (this.failure) return;
      try {
        const written = await this.options.recording.writeChunk(id, blob);
        this.bytes = written.bytes;
        this.chunks = written.chunks;
        if (this.state.kind === 'recording' || this.state.kind === 'paused') {
          this.emit({ ...this.state, bytes: written.bytes, chunks: written.chunks });
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        this.fail(`A chunk could not be written to disk after ${formatBytes(this.bytes)}: ${detail}`);
      }
    });
  }

  /** Records the first failure and stops the recorder. The file is kept. */
  private fail(message: string): void {
    if (this.failure) return;
    this.failure = message;
    console.error(`[marquee] ${message}`);
    try {
      if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
    } catch (error) {
      console.error('[marquee] the recorder also refused to stop after the failure', error);
    }
    this.emit({ kind: 'error', message, path: this.filePath });
  }

  pause(): void {
    if (!this.recorder || this.recorder.state !== 'recording') return;
    this.recorder.pause();
    if (this.state.kind === 'recording') this.emit({ ...this.state, kind: 'paused' });
  }

  resume(): void {
    if (!this.recorder || this.recorder.state !== 'paused') return;
    this.recorder.resume();
    if (this.state.kind === 'paused') this.emit({ ...this.state, kind: 'recording' });
  }

  /**
   * Stops the take, drains every outstanding write, and closes the file.
   * Resolves with what is actually on disk.
   */
  async stop(): Promise<ShellRecordingClosed> {
    const id = this.handleId;
    if (!id) throw new Error('Nothing is recording.');

    const recorder = this.recorder;
    if (recorder && recorder.state !== 'inactive') {
      // MediaRecorder flushes a final chunk on stop; that chunk has to reach
      // the queue before the queue is drained, or the tail of the take is lost.
      await new Promise<void>((resolve) => {
        recorder.onstop = () => resolve();
        try {
          recorder.stop();
        } catch (error) {
          console.error('[marquee] the recorder refused to stop; closing the file anyway', error);
          resolve();
        }
      });
    }
    await this.queue;

    this.recorder = null;
    this.handleId = null;

    if (this.failure) {
      // The take failed mid-flight. Close the file, keep it, and report the
      // ORIGINAL failure rather than a tidy "stopped".
      const closed = await this.options.recording.abort(id).catch((error: unknown) => {
        console.error('[marquee] the failed take could not be closed cleanly', error);
        return null;
      });
      throw new Error(
        `${this.failure} The partial recording was kept at ${closed?.path ?? this.filePath ?? 'an unknown path'}.`,
      );
    }

    const closed = await this.options.recording.finish(id);
    this.bytes = closed.bytes;
    this.emit({
      kind: 'stopped',
      path: closed.path,
      bytes: closed.bytes,
      durationMs: closed.durationMs,
      mp4Path: null,
      note: this.options.format.canStreamCopyToMp4
        ? 'Ready to finalise to MP4.'
        : this.options.format.note,
    });
    return closed;
  }
}

/**
 * Hands a finished take to the bundled Python to become a real MP4.
 *
 * The runtime is reached through the shell's authenticated `/runtime` proxy,
 * so the page never holds the capability token. Every failure carries the
 * runtime's own words: a 501 means PyAV is missing, a 422 means the recording
 * cannot become an MP4 and says why, a 404 means the file moved.
 */
export type FinaliseResult = {
  source: string;
  output: string;
  outputBytes: number;
  durationSeconds: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  videoWasCopied: boolean;
  tookSeconds: number;
  notes: string[];
};

export async function finaliseToMp4(
  source: string,
  fetchImpl: typeof fetch = fetch,
): Promise<FinaliseResult> {
  const response = await fetchImpl('/runtime/remux', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source }),
  });
  const text = await response.text();
  if (!response.ok) {
    // The runtime's `detail` is written for the operator; surface it as-is
    // rather than replacing it with a guess about what went wrong.
    let detail = text;
    try {
      const parsed = JSON.parse(text) as { detail?: string };
      if (parsed.detail) detail = parsed.detail;
    } catch {
      // Not JSON — the raw body is more useful than a claim about its shape.
    }
    throw new Error(
      response.status === 501
        ? `This build cannot finalise recordings to MP4: ${detail}`
        : `Finalising failed (HTTP ${response.status}): ${detail}`,
    );
  }
  return JSON.parse(text) as FinaliseResult;
}
