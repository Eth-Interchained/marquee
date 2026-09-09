---
name: OS capture permissions
description: Why screen recording gets a button instead of a prompt, and why this module must not import Electron at the top level.
---

`desktop/shell/src/permissions.ts` reads and (where possible) requests the OS
gates for camera, microphone and screen recording, and the Studio raises
`PermissionDialog` when the OS is actually in the way.

## macOS cannot be asked for screen recording. At all.

`systemPreferences.askForMediaAccess` takes `'microphone' | 'camera'` — screen
is not in the type, and there is no other API. The only honest move is to read
the status and deep-link into
`x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture`.

**Why it matters:** a UI with a "click to allow" button for screen recording
leaves the operator waiting for a prompt macOS will never show. So
`canRequest` is false for `screen` on every platform, the UI only renders
"Allow…" when `canRequest` is true, and a test asserts the screen copy says
"Open Settings" and never the word "prompt".

**Also:** a screen-recording grant applies on the next launch, not to the
running process — `needsRestart` is true for that case and the dialog says so.

## The copy lives in the shell, not the renderer

`describePermission` returns the sentence, and the shell's tests assert it. The
renderer shows `state.detail` verbatim.

**Why:** copy that promises a prompt is a correctness bug, not a wording
preference, so it belongs somewhere a test can hold it.

## Never import Electron at the top of a module with pure logic

The first version did `import { shell, systemPreferences } from "electron"` and
the whole test file died with *"does not provide an export named 'shell'"* —
under plain Node that module cannot load at all.

**How to apply:** `import type` only at the top; reach for Electron with
`require("electron")` / `await import("electron")` *inside* the function that
needs it. `capture.ts` already did this — that is why `capture.test.ts` works.
Any new shell module with testable logic follows the same shape.

## An empty capture-source list is usually a permission, not a bug

`desktopCapturer.getSources` returns `[]` when macOS Screen Recording is off —
it does not throw. The Studio re-reads the permission status on an empty list
and raises the dialog with that reason instead of showing an empty grid.
