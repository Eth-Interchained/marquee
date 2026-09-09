import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  DEFAULT_PUBLISH_VIEWPORT,
  deviceClassFor,
  parseViewport,
  publishViewportFor,
} from "../src/publisher/device";

/** The four profiles a fresh install ships with, verbatim from `data.ts`. */
const PROFILES = [
  {
    name: "Chrome · macOS",
    viewport: "1440 × 900",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
    expected: "desktop" as const,
  },
  {
    name: "Chrome · Windows",
    viewport: "1536 × 864",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
    expected: "desktop" as const,
  },
  {
    name: "Safari · iPhone 16",
    viewport: "393 × 852",
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1",
    expected: "mobile" as const,
  },
  {
    name: "Chrome · Pixel 9",
    viewport: "412 × 915",
    userAgent:
      "Mozilla/5.0 (Linux; Android 15; Pixel 9 Pro) AppleWebKit/537.36 Chrome/131.0.0.0 Mobile Safari/537.36",
    expected: "mobile" as const,
  },
];

describe("the shipped UA profiles", () => {
  for (const profile of PROFILES) {
    test(`${profile.name} is classed as ${profile.expected}`, () => {
      assert.equal(deviceClassFor(profile.userAgent), profile.expected);
    });

    test(`${profile.name} declares a viewport this can read`, () => {
      // The declaration was decorative until now; if any of these stopped
      // parsing, a profile would silently fall back to a desktop window while
      // still sending its own user agent.
      const viewport = parseViewport(profile.viewport);
      assert.ok(viewport, `${profile.viewport} must parse`);
      assert.ok(viewport.width > 0 && viewport.height > 0);
    });
  }

  test("the four profiles cover both graphs", () => {
    const classes = new Set(PROFILES.map((p) => deviceClassFor(p.userAgent)));
    assert.deepEqual([...classes].sort(), ["desktop", "mobile"]);
  });
});

describe("reading a declared viewport", () => {
  test("the UI's multiplication sign is understood", () => {
    assert.deepEqual(parseViewport("393 × 852"), { width: 393, height: 852 });
  });

  test("a hand-typed x works too", () => {
    // This string is shown to the operator, so someone will eventually type it.
    assert.deepEqual(parseViewport("393x852"), { width: 393, height: 852 });
    assert.deepEqual(parseViewport("1440 X 900"), { width: 1440, height: 900 });
  });

  test("nonsense produces nothing rather than a guess", () => {
    // A made-up viewport is worse than the window's default: it would be a
    // claim about the client that nothing checked.
    for (const raw of ["", "  ", "big", "1440", "1440 ×", "× 900", "abc × def", null, undefined]) {
      assert.equal(parseViewport(raw), null, `${JSON.stringify(raw)} must not parse`);
    }
  });

  test("implausible dimensions are refused", () => {
    assert.equal(parseViewport("10 × 10"), null, "nothing renders at 10px");
    assert.equal(parseViewport("99999 × 99999"), null, "no device is this big");
  });

  test("a profile with an unreadable viewport keeps today's behaviour", () => {
    assert.deepEqual(publishViewportFor("nonsense"), DEFAULT_PUBLISH_VIEWPORT);
    assert.deepEqual(publishViewportFor(null), DEFAULT_PUBLISH_VIEWPORT);
  });

  test("a readable declaration wins over the default", () => {
    assert.deepEqual(publishViewportFor("393 × 852"), { width: 393, height: 852 });
  });
});

describe("classing a user agent", () => {
  test("the class comes from the string, not from a label", () => {
    // The string is what the network sees. The profile's name is decoration,
    // and a profile called "Desk" can carry a phone's user agent.
    assert.equal(
      deviceClassFor(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148",
      ),
      "mobile",
    );
  });

  test("a missing user agent is treated as a desktop", () => {
    // A workspace with no profile runs under the shell's own Chromium, which
    // is a desktop.
    assert.equal(deviceClassFor(null), "desktop");
    assert.equal(deviceClassFor(""), "desktop");
  });

  test("a desktop string is never mistaken for a phone", () => {
    // "Mobile" must be matched as a token: plenty of desktop strings contain
    // substrings that would fool a looser check.
    assert.equal(
      deviceClassFor(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
      ),
      "desktop",
    );
    assert.equal(
      deviceClassFor("Mozilla/5.0 (X11; Linux x86_64) Chrome/131.0.0.0 Safari/537.36"),
      "desktop",
    );
  });
});
