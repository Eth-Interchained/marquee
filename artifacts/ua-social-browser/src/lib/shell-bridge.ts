/**
 * Contract between the privileged sidebar page and the native shell.
 *
 * The shell injects `window.uaShell` into this page only. Page content loaded
 * inside a workspace surface never receives it, so a social network cannot
 * reach the workspace API, the UA profile table, or the publisher.
 *
 * On the web development surface `window.uaShell` is absent. Every consumer
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

export type UAShellBridge = {
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
  };
};

declare global {
  interface Window {
    uaShell?: UAShellBridge;
  }
}

export function getShell(): UAShellBridge | null {
  return typeof window !== 'undefined' && window.uaShell ? window.uaShell : null;
}

export function isShellAvailable(): boolean {
  return getShell() !== null;
}
