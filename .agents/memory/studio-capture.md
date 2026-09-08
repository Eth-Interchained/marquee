---
name: Studio screen capture
description: Why getDisplayMedia() needs the shell's picker, why the handler is one-shot, and where system audio genuinely stops.
---

The Studio section composites a screen or window, a camera, and a mixer onto
one canvas (`src/lib/studio/*`, pure and tested). Capturing the screen inside
the shell goes through `desktop/ua-shell/src/capture.ts`.

## Electron has no screen picker; a page cannot pick for itself

`getDisplayMedia()` in the privileged view resolves only through a
display-media handler on the default session, and that handler is the only
place a source is chosen.

**Why:** without a handler the call fails flat; with a handler that guesses
(first screen, primary display) the operator can broadcast the wrong screen —
worse than no stream.

**How to apply:** the UI calls `uaShell.studio.listCaptureSources()`, shows its
own thumbnails, then `selectCaptureSource({ sourceId, withAudio })` to ARM the
handler, then `getDisplayMedia()`. The handler resolves with exactly that source
and disarms. An unarmed request is refused and logged with the fix.

## The armed choice is one-shot

`CaptureBroker.install` clears the selection on every resolution, success or
refusal.

**Why:** a lingering selection would hand a later, unrelated request the old
screen.

**How to apply:** every capture is pick → arm → capture. Do not cache the
selection on the page either; re-pick.

## System audio is Chromium's line, not ours

`loopback` audio capture exists on Windows only. `resolveStreams` (pure,
tested) drops audio elsewhere and returns a `note` naming the platform.

**Why:** a stream that silently arrives without the audio the operator asked
for is indistinguishable from a bug. The note is shown; the downgrade is never
silent.

**How to apply:** on macOS/Linux, game audio reaches the mix through the mic
input or a virtual audio device. Do not "fix" this by faking an audio track.

## Without the shell, the browser's picker is the truth

On the web surface `window.uaShell` is absent, so the Studio uses the browser's
built-in `getDisplayMedia()` picker and says so. Browser audio comes only with
a Chrome TAB share, and the panel says that too.
