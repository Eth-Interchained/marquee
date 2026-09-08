/**
 * marquee — capture sources.
 *
 * Thin, honest wrappers over getDisplayMedia / getUserMedia. Every failure
 * path names itself: the browser's DOMException name, what the user likely
 * did (dismissed the picker, denied permission) and what to do next. A
 * silent null here is indistinguishable from a broken pipeline.
 */

export type CaptureError = {
  code: "denied" | "dismissed" | "unsupported" | "notfound" | "inuse" | "unknown";
  message: string;
  raw: string;
};

function classify(err: unknown, what: string): CaptureError {
  const e = err as { name?: string; message?: string };
  const raw = `${e?.name ?? "Error"}: ${e?.message ?? String(err)}`;
  switch (e?.name) {
    case "NotAllowedError":
      // Chrome uses NotAllowedError for both "denied" and "dismissed the picker".
      return {
        code: /dismiss|cancel/i.test(e.message ?? "") ? "dismissed" : "denied",
        message: `${what} was not allowed. If you dismissed the picker, try again; if you denied it, allow ${what} for this site in the browser's site settings.`,
        raw,
      };
    case "NotFoundError":
      return { code: "notfound", message: `No device found for ${what}.`, raw };
    case "NotReadableError":
    case "AbortError":
      return { code: "inuse", message: `${what} could not be read — another app may be using the device.`, raw };
    case "TypeError":
    case "NotSupportedError":
      return { code: "unsupported", message: `${what} is not supported in this browser.`, raw };
    default:
      return { code: "unknown", message: `${what} failed: ${raw}`, raw };
  }
}

export interface ScreenCapture {
  stream: MediaStream;
  hasAudio: boolean;
  /** "monitor" | "window" | "browser" per displaySurface, or "unknown". */
  surface: string;
}

export async function captureScreen(withAudio = true): Promise<ScreenCapture> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getDisplayMedia) {
    throw <CaptureError>{ code: "unsupported", message: "Screen capture is not supported in this browser.", raw: "getDisplayMedia missing" };
  }
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 60, max: 60 } },
      audio: withAudio,
    });
    const vt = stream.getVideoTracks()[0];
    const settings = (vt?.getSettings?.() ?? {}) as MediaTrackSettings & { displaySurface?: string };
    return {
      stream,
      hasAudio: stream.getAudioTracks().length > 0,
      surface: settings.displaySurface ?? "unknown",
    };
  } catch (err) {
    throw classify(err, "Screen capture");
  }
}

export interface CameraCapture {
  stream: MediaStream;
  label: string;
}

export async function captureCamera(deviceId?: string): Promise<CameraCapture> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    throw <CaptureError>{ code: "unsupported", message: "Camera capture is not supported in this browser.", raw: "getUserMedia missing" };
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: deviceId ? { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } } : { width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    return { stream, label: stream.getVideoTracks()[0]?.label ?? "Camera" };
  } catch (err) {
    throw classify(err, "Camera");
  }
}

export interface MicCapture {
  stream: MediaStream;
  label: string;
}

export async function captureMic(deviceId?: string): Promise<MicCapture> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    throw <CaptureError>{ code: "unsupported", message: "Microphone capture is not supported in this browser.", raw: "getUserMedia missing" };
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: deviceId
        ? { deviceId: { exact: deviceId }, echoCancellation: true, noiseSuppression: true }
        : { echoCancellation: true, noiseSuppression: true },
      video: false,
    });
    return { stream, label: stream.getAudioTracks()[0]?.label ?? "Microphone" };
  } catch (err) {
    throw classify(err, "Microphone");
  }
}

export function stopStream(stream: MediaStream | null | undefined): void {
  stream?.getTracks().forEach((t) => t.stop());
}

/** Attach a MediaStream to a hidden <video> so the compositor can drawImage it. */
export function videoFor(stream: MediaStream): HTMLVideoElement {
  const v = document.createElement("video");
  v.srcObject = stream;
  v.muted = true;
  v.playsInline = true;
  v.autoplay = true;
  // Never swallow the play() rejection — a blocked play means a black layer
  // and the user deserves to know why.
  v.play().catch((err: unknown) => {
    const e = err as { name?: string; message?: string };
    console.error(`[capture] hidden video play() rejected: ${e?.name}: ${e?.message}`);
  });
  return v;
}
