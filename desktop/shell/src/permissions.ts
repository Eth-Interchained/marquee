/**
 * OS capture permissions, and the honest shape of them.
 *
 * macOS gates the camera, the microphone and screen recording separately, and
 * they are NOT symmetric:
 *
 *   - camera and microphone can be REQUESTED programmatically
 *     (`askForMediaAccess`) — the OS shows its own prompt once, ever;
 *   - **screen recording cannot be requested at all.** There is no API. The
 *     only thing an app may do is read the status and take the operator to the
 *     right Settings pane. Any UI that implies otherwise is lying, and the
 *     operator sits there waiting for a prompt that will never come.
 *
 * So the contract here is: report the real status, request what can be
 * requested, and for the rest hand back a deep link the UI can put behind one
 * button. On Linux there is no such gate at all, which is also reported rather
 * than faked.
 *
 * macOS also caches screen-recording consent per app binary for the life of
 * the process: granting it while the app is running does not retroactively
 * unblock an already-running capture stack. That is why `needsRestart` exists.
 */

// Electron is imported dynamically inside the functions that need it, never at
// the top level: the pure half of this module (which pane, what can be asked,
// what the operator is told) has to be testable under plain Node, and a
// top-level `import { shell } from "electron"` makes the whole file unloadable
// there. Same pattern as capture.ts.
import { createLogger, errorFields } from "./logger";

const log = createLogger("permissions");

export type PermissionKind = "camera" | "microphone" | "screen";
/** Electron's own vocabulary, plus `not-applicable` for platforms with no gate. */
export type PermissionStatus = "not-determined" | "granted" | "denied" | "restricted" | "unknown" | "not-applicable";

export type PermissionState = {
  kind: PermissionKind;
  status: PermissionStatus;
  /** True when the OS will show its own prompt if we ask. */
  canRequest: boolean;
  /** Deep link into the OS settings pane, when one exists. */
  settingsUrl: string | null;
  /** True when a grant only takes effect after the app restarts. */
  needsRestart: boolean;
  /** What the UI should say. Never invented at the call site. */
  detail: string;
};

/**
 * Deep link for a permission pane. Pure — exported for tests.
 * Returns null where the platform has no such pane.
 */
export function settingsUrlFor(kind: PermissionKind, platform: NodeJS.Platform): string | null {
  if (platform === "darwin") {
    const pane = kind === "screen" ? "Privacy_ScreenCapture" : kind === "camera" ? "Privacy_Camera" : "Privacy_Microphone";
    return `x-apple.systempreferences:com.apple.preference.security?${pane}`;
  }
  if (platform === "win32") {
    // Windows has no screen-capture gate; camera and mic have Settings pages.
    if (kind === "screen") return null;
    return kind === "camera" ? "ms-settings:privacy-webcam" : "ms-settings:privacy-microphone";
  }
  return null;
}

/** Whether the OS can be asked directly. Pure — exported for tests. */
export function canRequestDirectly(kind: PermissionKind, platform: NodeJS.Platform): boolean {
  // Only macOS has a request API, and it deliberately excludes screen.
  return platform === "darwin" && kind !== "screen";
}

/** The sentence the UI shows. Pure — exported for tests, so the copy is asserted. */
export function describePermission(kind: PermissionKind, status: PermissionStatus, platform: NodeJS.Platform): string {
  const label = kind === "screen" ? "Screen Recording" : kind === "camera" ? "Camera" : "Microphone";
  if (status === "not-applicable") {
    return `${label} needs no permission on this system.`;
  }
  if (status === "granted") return `${label} is allowed.`;
  if (status === "restricted") {
    return `${label} is restricted by a policy on this device (managed Mac, parental controls). marquee cannot change that.`;
  }
  if (platform === "darwin" && kind === "screen") {
    return status === "denied"
      ? "Screen Recording is turned off for marquee, and macOS gives an app no way to ask. Open Settings, switch marquee on, then restart marquee for it to take effect."
      : "macOS has not been told whether marquee may record the screen, and gives an app no way to ask. Open Settings, switch marquee on, then restart marquee.";
  }
  if (status === "denied") {
    return `${label} is turned off for marquee. Open Settings and switch it back on.`;
  }
  return `${label} has not been granted yet. Allowing it shows the system's own prompt.`;
}

function readStatus(kind: PermissionKind, platform: NodeJS.Platform): PermissionStatus {
  // Only macOS gates all three; Windows reports camera/mic; Linux gates none.
  if (platform !== "darwin" && (platform !== "win32" || kind === "screen")) return "not-applicable";
  try {
    // require, not import: this runs inside Electron's main process (CJS bundle)
    // and must not force the module to load Electron when it is merely imported.
    const { systemPreferences } = require("electron") as typeof import("electron");
    return systemPreferences.getMediaAccessStatus(kind);
  } catch (error) {
    log.warn("could not read a media access status", { kind, ...errorFields(error) });
    return "unknown";
  }
}

export function permissionState(kind: PermissionKind, platform: NodeJS.Platform = process.platform): PermissionState {
  const status = readStatus(kind, platform);
  return {
    kind,
    status,
    canRequest: status !== "granted" && status !== "restricted" && canRequestDirectly(kind, platform),
    settingsUrl: status === "granted" ? null : settingsUrlFor(kind, platform),
    // A screen-recording grant on macOS only applies to a fresh launch.
    needsRestart: platform === "darwin" && kind === "screen" && status !== "granted",
    detail: describePermission(kind, status, platform),
  };
}

export function allPermissions(platform: NodeJS.Platform = process.platform): PermissionState[] {
  return (["screen", "camera", "microphone"] as const).map((kind) => permissionState(kind, platform));
}

/**
 * Asks the OS, where that is possible, and reports the status AFTER asking.
 * Never claims success from the fact that a prompt was shown — the same rule
 * the publish path lives by.
 */
export async function requestPermission(kind: PermissionKind, platform: NodeJS.Platform = process.platform): Promise<PermissionState> {
  if (!canRequestDirectly(kind, platform)) {
    log.info("permission cannot be requested programmatically; returning current state", { kind, platform });
    return permissionState(kind, platform);
  }
  try {
    const { systemPreferences } = await import("electron");
    const granted = await systemPreferences.askForMediaAccess(kind as "camera" | "microphone");
    log.info("asked the OS for a permission", { kind, granted });
  } catch (error) {
    log.warn("asking for a permission failed", { kind, ...errorFields(error) });
  }
  return permissionState(kind, platform);
}

/** Opens the OS settings pane. Returns why it could not, rather than failing silently. */
export async function openPermissionSettings(
  kind: PermissionKind,
  platform: NodeJS.Platform = process.platform,
): Promise<{ opened: boolean; detail: string }> {
  const url = settingsUrlFor(kind, platform);
  if (!url) {
    const detail = `There is no settings pane for ${kind} on ${platform}.`;
    log.info("no settings pane to open", { kind, platform });
    return { opened: false, detail };
  }
  try {
    const { shell } = await import("electron");
    await shell.openExternal(url);
    log.info("opened a settings pane", { kind, url });
    return { opened: true, detail: `Opened the ${kind} settings pane.` };
  } catch (error) {
    const detail = `Could not open the settings pane: ${error instanceof Error ? error.message : String(error)}`;
    log.warn("opening a settings pane failed", { kind, url, ...errorFields(error) });
    return { opened: false, detail };
  }
}
