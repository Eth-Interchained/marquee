/**
 * Contract between the privileged sidebar page and the native shell.
 *
 * The shell injects `window.marqueeShell` into this page only. Page content loaded
 * inside a workspace surface never receives it, so a social network cannot
 * reach the workspace API, the UA profile table, or the publisher.
 *
 * On the web development surface `window.marqueeShell` is absent. Every consumer
 * must handle that explicitly rather than pretending a session exists.
 */

export type ShellSessionStatus = {
  workspaceId: string;
  authenticated: boolean;
  accountHandle?: string;
  detail: string;
};

export type ShellSurfaceOptions = {
  workspaceId: string;
  url: string;
  userAgent: string;
  acceptLanguage: string;
  timezone: string;
  clientHints: boolean;
};

export type ShellSurfaceHandle = {
  id: string;
  /**
   * Partition key of the cookie/storage jar this surface was given. Derived by
   * the shell from the workspace id — this page cannot choose it, and must not
   * try to reconstruct it, or the two can disagree about which jar is in use.
   */
  partition: string;
  navigate(url: string): Promise<void>;
  reload(): Promise<void>;
  close(): Promise<void>;
};

/** A screen or window the Studio may capture. Mirrors `CaptureSource` in the shell's ipc.ts. */
export type ShellCaptureSource = {
  id: string;
  name: string;
  kind: 'screen' | 'window';
  /** data: URL thumbnail. */
  thumbnail: string;
  appIcon: string | null;
};

export type ShellCaptureSelection = {
  sourceId: string;
  /** System-audio loopback. Only Windows honours it; the shell says which. */
  withAudio: boolean;
};

/** What the shell reports when a take opens. Mirrors `RecordingBegun` in ipc.ts. */
export type ShellRecordingBegun = {
  id: string;
  /** The real path on disk. Shown to the operator — never guessed at here. */
  path: string;
  startedAt: string;
};

/** Mirrors `RecordingClosed` in ipc.ts. */
export type ShellRecordingClosed = {
  id: string;
  path: string;
  bytes: number;
  durationMs: number;
  chunks: number;
  /** False when the shell closed the take itself (quit mid-recording). */
  clean: boolean;
};

export type ShellRecording = {
  /** Opens a file and returns its real path. */
  begin(mimeType: string, label?: string): Promise<ShellRecordingBegun>;
  /** Appends one MediaRecorder chunk. Pass the Blob; the bridge reads it. */
  writeChunk(id: string, blob: Blob): Promise<{ bytes: number; chunks: number }>;
  finish(id: string): Promise<ShellRecordingClosed>;
  /** Ends a take that went wrong. The partial file is KEPT. */
  abort(id: string): Promise<ShellRecordingClosed>;
  revealInFolder(path: string): Promise<{ revealed: boolean; path: string }>;
};

export type MarqueeShellBridge = {
  readonly version: string;
  /** Mounts a workspace-isolated browsing surface into the given element. */
  attachSurface(
    container: HTMLElement,
    options: ShellSurfaceOptions,
  ): Promise<ShellSurfaceHandle>;
  /** Opens the platform in a normal workspace tab. */
  openInWorkspaceTab(workspaceId: string, url: string): Promise<void>;
  getSessionStatus(workspaceId: string): Promise<ShellSessionStatus>;
  /**
   * Studio capture. Absent on shells older than this contract — check before
   * use, and fall back to the browser's own getDisplayMedia() picker.
   */
  studio?: {
    listCaptureSources(): Promise<ShellCaptureSource[]>;
    /** Arms the shell's display-media handler for the NEXT getDisplayMedia(). `null` disarms. */
    selectCaptureSource(selection: ShellCaptureSelection | null): Promise<void>;
    /**
     * Recording straight to disk. Absent on shells before bridge 1.1.0 —
     * check for it and say recording is unavailable rather than throwing,
     * because this is the app's primary function and a silent failure here is
     * a lost take.
     */
    recording?: ShellRecording;
  };
  /** OS capture permissions. Absent on older shells. */
  permissions?: {
    status(): Promise<ShellPermissionState[]>;
    /**
     * Asks the OS where it has an API. Screen recording on macOS has none, so
     * this returns the unchanged state — read `canRequest` first and use
     * `openSettings` instead of waiting for a prompt.
     */
    request(kind: ShellPermissionKind): Promise<ShellPermissionState>;
    openSettings(kind: ShellPermissionKind): Promise<{ opened: boolean; detail: string }>;
  };
};

export type ShellPermissionKind = 'camera' | 'microphone' | 'screen';

/** Mirrors `PermissionState` in the shell's permissions.ts. */
export type ShellPermissionState = {
  kind: ShellPermissionKind;
  status: 'not-determined' | 'granted' | 'denied' | 'restricted' | 'unknown' | 'not-applicable';
  /** True when the OS will show its own prompt if asked. False for screen on every platform. */
  canRequest: boolean;
  settingsUrl: string | null;
  /** True when a grant only takes effect after marquee restarts (macOS screen recording). */
  needsRestart: boolean;
  /** The sentence to show. Comes from the shell so the copy is asserted by its tests. */
  detail: string;
};

declare global {
  interface Window {
    marqueeShell?: MarqueeShellBridge;
  }
}

export function getShell(): MarqueeShellBridge | null {
  return typeof window !== 'undefined' && window.marqueeShell ? window.marqueeShell : null;
}

export function isShellAvailable(): boolean {
  return getShell() !== null;
}
