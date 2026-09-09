/**
 * Guards on the Instagram composer config, and on the shape of every config
 * that drives a multi-screen composer.
 *
 * Instagram's adapter was written from product knowledge and could never have
 * worked. Three of its selectors were wrong in ways reading could not catch,
 * and each was only found by driving a real signed-in account on 2026-09-03:
 *
 *  - `opener` matched `svg[aria-label="New post"]` rather than the
 *    `<a role="link">` around it. `SVGElement` has no `.click()`, so opening
 *    the composer threw a TypeError every time.
 *  - the crop and filter steps clicked "the first enabled `div[role=button]`",
 *    which on both screens is **Back** — five matches on crop, six on the
 *    caption screen, Back first in document order.
 *  - `mediaAttached` looked for an `<img>` or `<canvas>`; Instagram uses a
 *    `background-image: url(blob:…)` on a bare div, so the dialog contains no
 *    image element at all.
 *
 * These tests do not re-verify the DOM — nothing here can, without an account.
 * They lock in the *properties* that made the old config unsafe, so the next
 * person cannot reintroduce a step that clicks whatever comes first or a step
 * whose success cannot be checked.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { COMPOSERS, composerConfigFor, graphedDeviceClasses } from "../src/publisher/adapters";

/** The graph actually in use for both classes: route-driven, no navigation. */
const instagram = composerConfigFor("instagram")!;

/**
 * The dialog graph — what a desktop browser gets from the feed.
 *
 * Still verified, still kept as the fallback if the create routes ever stop
 * being addressable, so its guards stay. They point here explicitly now that
 * `composerConfigFor` resolves to the route graph.
 */
const instagramDialog = COMPOSERS.instagram!;

/**
 * Whether a selector could match several controls on one screen.
 *
 * Precision matters here or the guard cries wolf: a first draft flagged
 * Pinterest, whose submit is `[data-test-id="board-dropdown-save-button"]
 * button, button[type="submit"]` — both alternatives genuinely narrowed. It
 * matched on the bare word "button".
 *
 * The real test is whether anything *other than a generic role* narrows the
 * selector. `div[role="dialog"] div[role="button"]` names no attribute that
 * distinguishes one control from its neighbours, so it matches Back, Next and
 * everything else. Anything carrying an id, a class, a data attribute, an
 * aria-label or a type is picking out a specific control.
 */
function isLoose(selector: string): boolean {
  return selector.split(",").some((alternative) => {
    const withoutGenericRoles = alternative.replace(
      /\[role="(button|link|dialog|textbox|heading)"\]/g,
      "",
    );
    // Nothing left that narrows it: no attribute, class or id.
    return !/[[.#]/.test(withoutGenericRoles) && /\w/.test(withoutGenericRoles);
  });
}

describe("the Instagram composer config", () => {
  test("the dialog graph's opener can reach the clickable ancestor, not only the icon", () => {
    // The bare `svg[...]` alternative may stay — the driver walks up from any
    // match — but something in the list has to name a real control, or the
    // config is relying entirely on that walk.
    assert.ok(instagramDialog.opener, "the dialog graph is reached by a button");
    assert.match(
      instagramDialog.opener,
      /a\[role="link"\]|div\[role="button"\]/,
      "the opener must name the anchor or button that carries the click handler",
    );
  });

  test("the attached-picture check does not look for an image element", () => {
    // There is no <img> or <canvas> in Instagram's dialog. A check that looks
    // for one never fires, and the flow would submit before the picture is in
    // — a different post from the approved one.
    assert.ok(instagram.mediaAttached);
    assert.doesNotMatch(
      instagram.mediaAttached,
      /\bimg\b|\bcanvas\b/,
      "Instagram renders the attachment as a blob background, not an element",
    );
    assert.match(instagram.mediaAttached, /blob:/);
  });

  test("the submit names Share, because the selector alone finds Back first", () => {
    assert.equal(instagram.submitText, "Share");
    assert.ok(
      isLoose(instagram.submit),
      "if this selector ever becomes specific, the text qualifier can go",
    );
  });

  test("the dialog graph's two screens both name their control", () => {
    const steps = instagramDialog.afterAttach ?? [];
    assert.equal(steps.length, 2, "crop and filter");

    for (const step of steps) {
      assert.equal(
        step.clickText,
        "Next",
        `the ${step.label} step must say which control it means`,
      );
    }
  });

  test("neither step waits on something that is already true", () => {
    // `waitFor: 'div[role="dialog"]'` was the original bug: the dialog is on
    // screen for the whole flow, so the step passed without advancing.
    for (const step of instagramDialog.afterAttach ?? []) {
      assert.notEqual(
        step.waitFor,
        'div[role="dialog"]',
        `the ${step.label} step cannot be satisfied by the dialog it is already in`,
      );
    }
  });
});

describe("every multi-screen composer", () => {
  const withSteps = Object.entries(COMPOSERS).filter(
    ([, cfg]) => (cfg?.afterAttach?.length ?? 0) > 0,
  );

  test("there is at least one, or these guards are vacuous", () => {
    assert.ok(withSteps.length > 0);
  });

  for (const [network, cfg] of withSteps) {
    test(`${network}: each step can prove it landed`, () => {
      for (const step of cfg!.afterAttach!) {
        assert.ok(
          step.waitFor || step.waitForHeading,
          `${network}'s ${step.label} step has nothing to wait for, so a click on it could never be verified`,
        );
      }
    });

    test(`${network}: a step using a loose selector names its control`, () => {
      for (const step of cfg!.afterAttach!) {
        if (!isLoose(step.click)) continue;
        assert.ok(
          step.clickText,
          `${network}'s ${step.label} step would click whichever control comes first`,
        );
      }
    });
  }
});

describe("every composer's submit", () => {
  test("a loose submit selector is always qualified by text", () => {
    // The failure this prevents is not cosmetic: clicking the wrong control on
    // a caption screen leaves the composer, and the flow then reports that the
    // post could not be sent while the operator watches it do nothing.
    for (const [network, cfg] of Object.entries(COMPOSERS)) {
      if (!cfg) continue;
      if (!isLoose(cfg.submit)) continue;
      assert.ok(
        cfg.submitText || cfg.submitHotkey,
        `${network}'s submit selector is loose and has neither a text qualifier nor a hotkey fallback`,
      );
    }
  });
});

describe("the UA profile picks the graph", () => {
  test("Instagram has a graph written for both classes", () => {
    // The case that started this: the operator's workspace runs the iPhone
    // profile, Instagram served the mobile layout, and the desktop navigation
    // selector had nothing to match. A network that serves two composers needs
    // two graphs, chosen by what the network will actually send.
    assert.deepEqual(graphedDeviceClasses("instagram").sort(), ["desktop", "mobile"]);
  });

  test("each class resolves to a usable graph", () => {
    for (const device of ["desktop", "mobile"] as const) {
      const graph = composerConfigFor("instagram", device);
      assert.ok(graph, `${device} must resolve`);
      assert.ok(graph.submit, `${device}'s graph needs a submit`);
      assert.ok(graph.fileInput, `${device}'s graph needs an upload control`);
    }
  });

  test("the graph in use needs no navigation click", () => {
    // The whole reason it is route-driven: navigation is exactly what differs
    // between a phone layout and a desktop one, so a flow that never touches
    // it cannot be broken by that difference.
    for (const device of ["desktop", "mobile"] as const) {
      assert.equal(
        composerConfigFor("instagram", device)!.opener,
        undefined,
        `${device}'s graph must not depend on finding a nav control`,
      );
    }
  });

  test("its steps are proven by the URL rather than by markup or wording", () => {
    const steps = composerConfigFor("instagram", "mobile")!.afterAttach ?? [];
    assert.ok(steps.length > 0);
    for (const step of steps) {
      assert.ok(
        step.waitForPath,
        `the ${step.label} step should use the URL, which cannot drift with a rename or a translation`,
      );
    }
  });

  test("a network with one composer ignores the class", () => {
    // Only Instagram is known to serve two. Everything else must resolve
    // identically for both, not become unpostable on a phone profile.
    for (const platform of ["x", "linkedin", "pinterest", "tumblr"]) {
      const desktop = composerConfigFor(platform, "desktop");
      const mobile = composerConfigFor(platform, "mobile");
      assert.ok(desktop, `${platform} must resolve for desktop`);
      assert.equal(mobile, desktop, `${platform} must resolve identically for mobile`);
    }
  });

  test("an unmapped class falls back rather than refusing", () => {
    // A wrong-shaped graph fails loudly at the first probe. A network becoming
    // unpostable because a class is unmapped is the worse outcome.
    assert.ok(composerConfigFor("x", "mobile"));
  });

  test("an unknown network is still null", () => {
    assert.equal(composerConfigFor("myspace", "desktop"), null);
    assert.equal(composerConfigFor("myspace", "mobile"), null);
  });
});
