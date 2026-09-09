import assert from "node:assert/strict";
import { test } from "node:test";

import {
  clientHintsFor,
  describeUserAgent,
  lowEntropyHintHeaders,
  summarizeUserAgent,
} from "../src/ua-metadata";

const CHROME_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36";
const CHROME_WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36";
const SAFARI_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const CHROME_ANDROID =
  "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36";
const EDGE_WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36 Edg/130.0.2849.68";
const FIREFOX_LINUX = "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0";

test("reads the browser and platform out of a Chrome UA", () => {
  const mac = summarizeUserAgent(CHROME_MAC);
  assert.equal(mac.engine, "chromium");
  assert.equal(mac.browser, "Chrome");
  assert.equal(mac.majorVersion, "131");
  assert.equal(mac.platform, "macOS");
  assert.equal(mac.mobile, false);

  const windows = summarizeUserAgent(CHROME_WINDOWS);
  assert.equal(windows.platform, "Windows");
  assert.equal(windows.architecture, "x86");
  assert.equal(windows.bitness, "64");
});

test("marks mobile UA strings as mobile and keeps the device model", () => {
  const android = summarizeUserAgent(CHROME_ANDROID);
  assert.equal(android.platform, "Android");
  assert.equal(android.mobile, true);
  assert.equal(android.model, "SM-S918B");

  const iphone = summarizeUserAgent(SAFARI_IPHONE);
  assert.equal(iphone.engine, "webkit");
  assert.equal(iphone.platform, "iOS");
  assert.equal(iphone.mobile, true);
});

test("names the branded Chromium fork rather than calling everything Chrome", () => {
  const edge = summarizeUserAgent(EDGE_WINDOWS);
  assert.equal(edge.engine, "chromium");
  assert.equal(edge.brand, "Microsoft Edge");
  assert.equal(edge.majorVersion, "130");
});

test("client hints agree with the UA string they came from", () => {
  const hints = clientHintsFor(CHROME_MAC);
  assert.ok(hints);
  assert.equal(hints.platform, "macOS");
  assert.equal(hints.mobile, false);
  assert.equal(hints.fullVersion, "131.0.0.0");

  const brands = hints.brands.map((entry) => entry.brand);
  assert.ok(brands.includes("Chromium"));
  assert.ok(brands.includes("Google Chrome"));
  // A grease entry keeps sites from hard-coding the list.
  assert.equal(brands.length, 3);
  for (const entry of hints.brands) {
    if (entry.brand === "Chromium" || entry.brand === "Google Chrome") {
      assert.equal(entry.version, "131");
    }
  }
});

test("non-Chromium UA strings get no client hints at all", () => {
  assert.equal(clientHintsFor(SAFARI_IPHONE), null);
  assert.equal(clientHintsFor(FIREFOX_LINUX), null);
  assert.deepEqual(lowEntropyHintHeaders(clientHintsFor(SAFARI_IPHONE)), {});
});

test("the low-entropy headers are the three Chrome always sends", () => {
  const headers = lowEntropyHintHeaders(clientHintsFor(CHROME_ANDROID));
  assert.deepEqual(Object.keys(headers).sort(), [
    "Sec-CH-UA",
    "Sec-CH-UA-Mobile",
    "Sec-CH-UA-Platform",
  ]);
  assert.equal(headers["Sec-CH-UA-Mobile"], "?1");
  assert.equal(headers["Sec-CH-UA-Platform"], '"Android"');
  assert.match(headers["Sec-CH-UA"] as string, /"Chromium";v="131"/);
});

test("the toolbar label names the profile a person would recognise", () => {
  assert.equal(describeUserAgent(CHROME_MAC), "Chrome 131 · macOS");
  assert.equal(describeUserAgent(EDGE_WINDOWS), "Edge 130 · Windows");
  assert.equal(describeUserAgent(SAFARI_IPHONE), "Safari 17 · iOS");
});
