import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { adapterFor } from "../src/publisher/adapters";
import { composerConfigFor } from "../src/publisher/adapters";

/**
 * X moved off its own hand-written `xSubmit` and onto the shared composer
 * flow. The whole justification for that move is that the shared flow refuses
 * a case X's own code called a success — so the thing worth testing is that
 * every *other* signal still means what it meant, expressed in the schema.
 *
 * X is the one adapter anybody has watched land a real post. A refactor of it
 * that nobody checked would trade a known-good path for a tidier one, which is
 * a bad trade. These assertions are the check.
 *
 * The selectors themselves remain unverifiable here — no display, no session —
 * exactly as before. What is verifiable is that the config says what `xSubmit`
 * said, and that its regexes fire on X's actual wording.
 */

const x = composerConfigFor("x")!;

describe("X's composer config carries over what xSubmit did", () => {
  test("it is driven by the shared flow at all, not a bespoke submit", () => {
    // If this fails, X has been forked again and will start missing fixes.
    assert.ok(x, "X must have a composer config");
    assert.ok(adapterFor("x"), "X must still be a known platform");
  });

  test("the same editor, submit and file-input hooks as before", () => {
    assert.equal(x.editor, '[data-testid="tweetTextarea_0"]');
    assert.equal(
      x.submit,
      '[data-testid="tweetButton"], [data-testid="tweetButtonInline"]',
    );
    assert.equal(
      x.fileInput,
      '[data-testid="fileInput"], input[type="file"][accept*="image"]',
    );
    assert.equal(x.editorKind, "contenteditable");
  });

  test("no keyboard fallback, because xSubmit never had one", () => {
    // `submitHotkey` changes how the submit budget is split, so turning it on
    // by accident would shorten the window X spends looking for its button.
    assert.notEqual(x.submitHotkey, true);
  });

  test("X is not upload-first and does not require media", () => {
    // A text-only post is X's normal case; either flag would break it.
    assert.notEqual(x.mediaFirst, true);
    assert.notEqual(x.mediaRequired, true);
    assert.equal(x.afterAttach, undefined);
  });
});

describe("the post link is read from inside the toast", () => {
  test("the selector is scoped to the toast, never document-wide", () => {
    // This is the detail that would silently break everything: `xSubmit` read
    // the link as `toast.querySelector(...)`, but the shared driver's lookup is
    // document-wide. An unscoped `a[href*="/status/"]` matches any post in the
    // timeline sitting behind the composer, so every attempt would report
    // success instantly — a phantom post on every send.
    assert.ok(
      x.confirmation.postLink?.startsWith('[data-testid="toast"]'),
      `postLink must be scoped inside the toast, got: ${x.confirmation.postLink}`,
    );
  });

  test("the post id is extracted from a real X status URL", () => {
    const pattern = new RegExp(x.confirmation.postUrlPattern!);
    const match = "https://x.com/interchained/status/2095268232227".match(pattern);
    assert.equal(match?.[1], "2095268232227");
  });

  test("a URL with no status id yields no id rather than a wrong one", () => {
    const pattern = new RegExp(x.confirmation.postUrlPattern!);
    assert.equal("https://x.com/home".match(pattern), null);
  });
});

describe("X's own wording still classifies correctly", () => {
  const success = new RegExp(x.confirmation.successText!, "i");
  const error = new RegExp(x.confirmation.errorText!, "i");

  test("X's success toasts are recognised", () => {
    for (const toast of ["Your post was sent.", "Your Post was sent", "Posted"]) {
      assert.ok(success.test(toast), `should read as sent: ${toast}`);
    }
  });

  test("X's failure toasts are recognised", () => {
    for (const toast of [
      "Something went wrong. Try again.",
      "Could not send post",
      "Whoops! Something went wrong.",
      "Tweet failed to send",
    ]) {
      assert.ok(error.test(toast), `should read as error: ${toast}`);
    }
  });

  test("an error toast is not also read as a success", () => {
    // Order matters in the driver — error is checked first — but a string that
    // matched both would make the outcome depend on that ordering rather than
    // on what happened, so it is worth knowing when one does.
    const both = ["Something went wrong. Try again."].filter(
      (t) => success.test(t) && error.test(t),
    );
    assert.deepEqual(both, [], "no toast should match both classes");
  });
});

describe("the login guard X was missing", () => {
  test("a login page is recognised by selector", () => {
    assert.ok(x.login.selectors);
    for (const selector of x.login.selectors!.split(",").map((s) => s.trim())) {
      assert.ok(selector.length > 0);
    }
    assert.match(x.login.selectors!, /autocomplete="username"/);
  });

  test("X's login paths are recognised, unanchored as the original was", () => {
    const pattern = new RegExp(x.login.pathPattern!);
    // Both of the paths xSubmit's own regex matched.
    assert.ok(pattern.test("/i/flow/login"), "the flow login path");
    assert.ok(pattern.test("/login"), "the bare login path");
  });

  test("the composer path is not mistaken for a login", () => {
    const pattern = new RegExp(x.login.pathPattern!);
    assert.ok(!pattern.test("/compose/post"), "composing is not signing in");
    assert.ok(!pattern.test("/home"), "the timeline is not signing in");
  });
});

describe("still-composing detection", () => {
  test("/compose/ means the post has not left, exactly as before", () => {
    const pattern = new RegExp(x.confirmation.stillComposingPath!);
    assert.ok(pattern.test("/compose/post"));
    assert.ok(!pattern.test("/home"));
  });
});
