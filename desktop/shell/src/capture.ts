/**
 * Screen and window capture for the Studio.
 *
 * Electron ships no screen picker. A page calling `getDisplayMedia()` gets
 * nothing unless the session has a display-media handler, and the handler is
 * the only place a source can be chosen. So the flow is:
 *
 *   1. the privileged UI asks for the list of sources (thumbnails included),
 *   2. shows its own picker and tells the shell which one was chosen — ARMING
 *      the handler for exactly one upcoming request,
 *   3. calls `getDisplayMedia()`, which the handler resolves with that source
 *      and then disarms.
 *
 * A `getDisplayMedia()` with nothing armed is refused, and the refusal is
 * logged with the reason. Nothing here guesses a source; a stream of the wrong
 * screen is worse than no stream.
 *
 * System audio: Chromium's `loopback` capture exists on Windows only. The pure
 * `resolveStreams` below decides that from the platform so it can be tested
 * without Electron, and the UI is told the truth via `/health`-style facts
 * rather than a silent audio-less stream.
 */

import type { Session } from "electron";
import type { CaptureSelection, CaptureSource } from "./ipc";
import { createLogger, errorFields } from "./logger";

const log = createLogger("capture");

/** The subset of Electron's DesktopCapturerSource this module reads. */
export type RawSource = {
  id: string;
  name: string;
  thumbnail: { isEmpty(): boolean; toDataURL(): string };
  appIcon: { isEmpty(): boolean; toDataURL(): string } | null;
};

export function toCaptureSource(raw: RawSource): CaptureSource {
  const kind: CaptureSource["kind"] = raw.id.startsWith("screen:") ? "screen" : "window";
  return {
    id: raw.id,
    name: raw.name,
    kind,
    thumbnail: raw.thumbnail.isEmpty() ? "" : raw.thumbnail.toDataURL(),
    appIcon: raw.appIcon && !raw.appIcon.isEmpty() ? raw.appIcon.toDataURL() : null,
  };
}

export type ResolvedStreams<TVideo> =
  | { ok: true; video: TVideo; audio: "loopback" | undefined; note: string | null }
  | { ok: false; reason: string };

/**
 * Pure: given what was armed, what the request asked for, and the sources the
 * OS currently reports, decide the streams. Exported for tests.
 */
export function resolveStreams<TVideo extends { id: string }>(
  armed: CaptureSelection | null,
  request: { videoRequested: boolean; audioRequested: boolean },
  sources: TVideo[],
  platform: NodeJS.Platform,
): ResolvedStreams<TVideo> {
  if (!armed) {
    return {
      ok: false,
      reason:
        "getDisplayMedia() was called with no capture source armed. The Studio must call marqueeShell.studio.selectCaptureSource() first.",
    };
  }
  if (!request.videoRequested) {
    return { ok: false, reason: "The request asked for no video; the Studio only captures video sources." };
  }
  const video = sources.find((s) => s.id === armed.sourceId);
  if (!video) {
    return {
      ok: false,
      reason: `The armed source ${armed.sourceId} no longer exists (window closed or display detached). Pick again.`,
    };
  }
  const wantsAudio = armed.withAudio && request.audioRequested;
  if (wantsAudio && platform !== "win32") {
    return {
      ok: true,
      video,
      audio: undefined,
      note: `System-audio loopback is Windows-only in Chromium; on ${platform} the capture carries video only. Route game audio through the mic input or a virtual device.`,
    };
  }
  return { ok: true, video, audio: wantsAudio ? "loopback" : undefined, note: null };
}

export class CaptureBroker {
  private armed: CaptureSelection | null = null;
  private lastNote: string | null = null;

  /** Reads the OS's current screens and windows, with thumbnails. */
  async listSources(): Promise<CaptureSource[]> {
    const { desktopCapturer } = await import("electron");
    const raw = await desktopCapturer.getSources({
      types: ["screen", "window"],
      thumbnailSize: { width: 320, height: 180 },
      fetchWindowIcons: true,
    });
    const sources = raw.map((s) => toCaptureSource(s as unknown as RawSource));
    log.info("capture sources listed", { screens: sources.filter((s) => s.kind === "screen").length, windows: sources.filter((s) => s.kind === "window").length });
    return sources;
  }

  /** Arms (or disarms with null) the next getDisplayMedia() resolution. */
  select(selection: CaptureSelection | null): void {
    this.armed = selection;
    log.info(selection ? "capture source armed" : "capture source disarmed", selection ?? {});
  }

  /** The platform caveat from the last resolution, if any, for the UI to show. */
  get note(): string | null {
    return this.lastNote;
  }

  /**
   * Installs the display-media handler on the session that hosts the
   * privileged UI. One-shot: every resolution disarms, so a stale choice can
   * never leak into a later request.
   */
  install(session: Session, platform: NodeJS.Platform = process.platform): void {
    session.setDisplayMediaRequestHandler((request, callback) => {
      void (async () => {
        try {
          const { desktopCapturer } = await import("electron");
          const sources = await desktopCapturer.getSources({ types: ["screen", "window"], thumbnailSize: { width: 0, height: 0 } });
          const resolved = resolveStreams(this.armed, request, sources, platform);
          this.armed = null;
          if (!resolved.ok) {
            log.warn("display-media request refused", { reason: resolved.reason, origin: request.securityOrigin });
            this.lastNote = resolved.reason;
            // No streams → the page's getDisplayMedia() rejects. Better than the wrong screen.
            callback({} as Electron.Streams);
            return;
          }
          this.lastNote = resolved.note;
          if (resolved.note) log.warn(resolved.note);
          log.info("display-media request resolved", { source: resolved.video.id, audio: resolved.audio ?? "none" });
          callback(resolved.audio ? { video: resolved.video, audio: resolved.audio } : { video: resolved.video });
        } catch (error) {
          this.armed = null;
          log.error("display-media handler failed", errorFields(error));
          callback({} as Electron.Streams);
        }
      })();
    });
  }
}
