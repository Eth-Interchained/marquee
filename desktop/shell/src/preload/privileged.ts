/**
 * Preload for the privileged workspace UI, and only for it.
 *
 * This file is attached to exactly one view: the one that loads the workspace
 * sidebar. Workspace surfaces and workspace tabs are created without a preload,
 * so page content on a social network has no `window.marqueeShell`, no IPC, and no
 * route to the workspace API, the UA profile table, or the publisher.
 */

import { contextBridge, ipcRenderer } from "electron";
import {
  BRIDGE_VERSION,
  CHANNELS,
  type CaptureSelection,
  type CaptureSource,
  type PermissionKind,
  type PermissionState,
  type Rect,
  type RecordingBegun,
  type RecordingClosed,
  type SurfaceAttachResult,
  type SurfaceOptions,
} from "../ipc";
import { installUaShellMainWorld } from "./install-main-world";

const host = {
  version: BRIDGE_VERSION,
  attach: (options: SurfaceOptions, bounds: Rect): Promise<SurfaceAttachResult> =>
    ipcRenderer.invoke(CHANNELS.surfaceAttach, { options, bounds }),
  setBounds: (id: string, bounds: Rect): Promise<void> =>
    ipcRenderer.invoke(CHANNELS.surfaceBounds, { id, bounds }),
  navigate: (id: string, url: string): Promise<void> =>
    ipcRenderer.invoke(CHANNELS.surfaceNavigate, { id, url }),
  reload: (id: string): Promise<void> => ipcRenderer.invoke(CHANNELS.surfaceReload, { id }),
  close: (id: string): Promise<void> => ipcRenderer.invoke(CHANNELS.surfaceClose, { id }),
  openInWorkspaceTab: (workspaceId: string, url: string): Promise<void> =>
    ipcRenderer.invoke(CHANNELS.tabOpen, { workspaceId, url }),
  sessionStatus: (workspaceId: string): Promise<unknown> =>
    ipcRenderer.invoke(CHANNELS.sessionStatus, { workspaceId }),
  captureSources: (): Promise<CaptureSource[]> => ipcRenderer.invoke(CHANNELS.captureSources),
  captureSelect: (selection: CaptureSelection | null): Promise<void> =>
    ipcRenderer.invoke(CHANNELS.captureSelect, { selection }),
  permissionsStatus: (): Promise<PermissionState[]> => ipcRenderer.invoke(CHANNELS.permissionsStatus),
  permissionsRequest: (kind: PermissionKind): Promise<PermissionState> =>
    ipcRenderer.invoke(CHANNELS.permissionsRequest, { kind }),
  permissionsOpenSettings: (kind: PermissionKind): Promise<{ opened: boolean; detail: string }> =>
    ipcRenderer.invoke(CHANNELS.permissionsOpenSettings, { kind }),
  recordingBegin: (mimeType: string, label?: string): Promise<RecordingBegun> =>
    ipcRenderer.invoke(CHANNELS.recordingBegin, { mimeType, label }),
  // Takes an ArrayBuffer, not a typed array: ArrayBuffer is the shape
  // contextBridge is documented to clone, and the Uint8Array the main process
  // expects is built here on the privileged side.
  recordingWrite: (id: string, chunk: ArrayBuffer): Promise<{ bytes: number; chunks: number }> =>
    ipcRenderer.invoke(CHANNELS.recordingWrite, { id, chunk: new Uint8Array(chunk) }),
  recordingFinish: (id: string): Promise<RecordingClosed> =>
    ipcRenderer.invoke(CHANNELS.recordingFinish, { id }),
  recordingAbort: (id: string): Promise<RecordingClosed> =>
    ipcRenderer.invoke(CHANNELS.recordingAbort, { id }),
  recordingReveal: (recordingPath: string): Promise<{ revealed: boolean; path: string }> =>
    ipcRenderer.invoke(CHANNELS.recordingReveal, { path: recordingPath }),
};

contextBridge.exposeInMainWorld("__marqueeShellHost", host);

// `executeInMainWorld` is how the element-taking part of the contract is met
// without dropping context isolation. If it is ever missing, the page must be
// left with no `window.marqueeShell` at all: the UI already treats an absent shell
// as "cannot post here", which is the truth in that situation.
if (typeof contextBridge.executeInMainWorld === "function") {
  const installed = contextBridge.executeInMainWorld({ func: installUaShellMainWorld });
  if (!installed) {
    console.error("[marquee-shell] window.marqueeShell could not be installed in the page world.");
  }
} else {
  console.error(
    "[marquee-shell] This Electron build has no contextBridge.executeInMainWorld; the shell bridge is unavailable.",
  );
}
