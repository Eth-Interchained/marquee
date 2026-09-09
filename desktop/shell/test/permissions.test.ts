/**
 * The pure half of OS permissions: which pane to open, what can actually be
 * asked for, and what the operator is told.
 *
 * The rule these guard: macOS has NO API to request screen recording. A UI
 * that implies a prompt is coming leaves the operator waiting for something
 * that will never appear, so the copy has to say "open Settings" and the
 * request path must not pretend it can ask.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { canRequestDirectly, describePermission, settingsUrlFor } from "../src/permissions";

test("macOS deep links point at the right privacy pane", () => {
  assert.equal(settingsUrlFor("screen", "darwin"), "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture");
  assert.equal(settingsUrlFor("camera", "darwin"), "x-apple.systempreferences:com.apple.preference.security?Privacy_Camera");
  assert.equal(settingsUrlFor("microphone", "darwin"), "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone");
});

test("Windows has camera and mic panes but no screen-capture gate; Linux has none", () => {
  assert.equal(settingsUrlFor("camera", "win32"), "ms-settings:privacy-webcam");
  assert.equal(settingsUrlFor("microphone", "win32"), "ms-settings:privacy-microphone");
  assert.equal(settingsUrlFor("screen", "win32"), null);
  for (const kind of ["screen", "camera", "microphone"] as const) {
    assert.equal(settingsUrlFor(kind, "linux"), null);
  }
});

test("screen recording can never be requested programmatically, on any platform", () => {
  for (const platform of ["darwin", "win32", "linux"] as const) {
    assert.equal(canRequestDirectly("screen", platform), false, `screen must not be requestable on ${platform}`);
  }
  // camera/mic: macOS only
  assert.equal(canRequestDirectly("camera", "darwin"), true);
  assert.equal(canRequestDirectly("microphone", "darwin"), true);
  assert.equal(canRequestDirectly("camera", "win32"), false);
  assert.equal(canRequestDirectly("camera", "linux"), false);
});

test("the macOS screen copy says to open Settings and restart — never that a prompt is coming", () => {
  for (const status of ["not-determined", "denied"] as const) {
    const text = describePermission("screen", status, "darwin");
    assert.match(text, /Open Settings/);
    assert.match(text, /restart/);
    assert.doesNotMatch(text, /prompt/i, "must not promise a prompt macOS will never show");
  }
});

test("granted, restricted and not-applicable each read as themselves", () => {
  assert.match(describePermission("camera", "granted", "darwin"), /is allowed/);
  assert.match(describePermission("screen", "restricted", "darwin"), /policy on this device/);
  assert.match(describePermission("screen", "not-applicable", "linux"), /needs no permission/);
});

test("a requestable permission's copy does mention the system prompt", () => {
  assert.match(describePermission("camera", "not-determined", "darwin"), /system's own prompt/);
});
