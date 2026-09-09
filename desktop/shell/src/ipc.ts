/**
 * Channel names and payloads shared by the main process, the privileged
 * preload, and the toolbar.
 *
 * The renderer-facing shapes mirror
 * `artifacts/studio/src/lib/shell-bridge.ts`, which is the source of
 * truth for the contract. The two packages cannot import from each other (leaf
 * workspace packages, different runtimes), so any change there has to be
 * mirrored here — the shell's own test suite asserts the field names.
 */

export const CHANNELS = {
  surfaceAttach: "marquee:surface:attach",
  surfaceBounds: "marquee:surface:bounds",
  surfaceNavigate: "marquee:surface:navigate",
  surfaceReload: "marquee:surface:reload",
  surfaceClose: "marquee:surface:close",
  tabOpen: "marquee:tab:open",
  sessionStatus: "marquee:session:status",
  chromeState: "marquee:chrome:state",
  chromeCommand: "marquee:chrome:command",
  /** Studio: enumerate screens/windows the operator may capture. */
  captureSources: "marquee:capture:sources",
  /** Studio: choose which one the NEXT getDisplayMedia() call receives. */
  captureSelect: "marquee:capture:select",
  /** OS capture permissions: read, request (where possible), open Settings. */
  permissionsStatus: "marquee:permissions:status",
  permissionsRequest: "marquee:permissions:request",
  permissionsOpenSettings: "marquee:permissions:open-settings",
  /**
   * Recording. The renderer runs the MediaRecorder and hands over one chunk
   * per timeslice; the shell appends each to a file. Nothing is buffered in
   * the page, so an hour of 1080p costs the page nothing and survives a
   * reload of everything but the recorder itself.
   */
  recordingBegin: "marquee:recording:begin",
  recordingWrite: "marquee:recording:write",
  recordingFinish: "marquee:recording:finish",
  recordingAbort: "marquee:recording:abort",
  recordingReveal: "marquee:recording:reveal",
} as const;

/** Mirrors `PermissionKind` / `PermissionState` in permissions.ts. */
export type PermissionKind = "camera" | "microphone" | "screen";

export type PermissionState = {
  kind: PermissionKind;
  status: "not-determined" | "granted" | "denied" | "restricted" | "unknown" | "not-applicable";
  canRequest: boolean;
  settingsUrl: string | null;
  needsRestart: boolean;
  detail: string;
};

/**
 * A screen or window offered to the Studio's picker. `id` is Electron's
 * desktopCapturer id (`screen:0:0`, `window:1234:0`); the thumbnail is a data
 * URL small enough to cross IPC without ceremony.
 */
export type CaptureSource = {
  id: string;
  name: string;
  kind: "screen" | "window";
  thumbnail: string;
  /** Present for windows that belong to an app with an icon. */
  appIcon: string | null;
  /**
   * Electron's display id for a screen source; null for a window.
   *
   * This is the ONLY reliable join to `screen.getAllDisplays()`. The number
   * inside the source id is Chromium's media device id and does not match it —
   * verified the hard way, with a source reporting 400 on a machine whose only
   * display was 60.
   */
  displayId: string | null;
};

export type CaptureSelection = {
  sourceId: string;
  /**
   * Ask Chromium for system-audio loopback with the video. Only Windows can
   * honour this; elsewhere the handler leaves audio out and the UI says so.
   */
  withAudio: boolean;
};

/**
 * What the shell answers when a recording starts. Mirrors `RecordingHandle`
 * in recorder.ts.
 */
export type RecordingBegun = {
  id: string;
  path: string;
  startedAt: string;
  /**
   * Where the cursor path is being written, or null when there is nothing to
   * track against — a window capture, or a display the shell could not
   * resolve. Null is a real answer the UI states rather than hides.
   */
  cursorTrackPath: string | null;
};

/** Mirrors `RecordingResult` in recorder.ts. */
export type RecordingClosed = {
  id: string;
  path: string;
  bytes: number;
  durationMs: number;
  chunks: number;
  clean: boolean;
  /** The cursor track, when one was recorded. */
  cursor: { path: string; samples: number; skipped: number; bytes: number } | null;
};

/**
 * `version` is read by the page to decide whether a capability exists. 1.1.0
 * added `studio.recording`; 1.2.0 added the cursor track, which a page detects
 * by `cursorTrackPath` being present on the begin result rather than by parsing
 * this string. A page against an older shell sees `recording` absent and says
 * recording is unavailable rather than throwing.
 */
export const BRIDGE_VERSION = "1.2.0";

export type Rect = { x: number; y: number; width: number; height: number };

export type SurfaceOptions = {
  workspaceId: string;
  url: string;
  userAgent: string;
  acceptLanguage: string;
  timezone: string;
  clientHints: boolean;
};

/**
 * The partition is derived by the shell and reported back, never supplied by
 * the page: only the main process can decide which cookie jar a workspace gets.
 */
export type SurfaceAttachResult = {
  id: string;
  partition: string;
};

export type ShellSessionStatus = {
  workspaceId: string;
  authenticated: boolean;
  accountHandle?: string;
  detail: string;
};

export type ChromeTab = {
  id: string;
  title: string;
  url: string;
  active: boolean;
  workspaceName: string;
};

export type ChromeState = {
  workspaceId: string | null;
  workspaceName: string;
  /** Human label for the UA profile in force, e.g. "Chrome 131 · macOS". */
  profileLabel: string;
  profileName: string | null;
  timezone: string | null;
  address: string | null;
  tabs: ChromeTab[];
  canGoBack: boolean;
  canGoForward: boolean;
  /** True while a workspace tab covers the sidebar. */
  tabActive: boolean;
};

export type ChromeCommand =
  | { kind: "tab:select"; tabId: string }
  | { kind: "tab:close"; tabId: string }
  | { kind: "tab:back" }
  | { kind: "tab:forward" }
  | { kind: "tab:reload" }
  | { kind: "workspace:show" };
