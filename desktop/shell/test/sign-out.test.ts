import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  clearNetworkCookies,
  describeSignOut,
  removalUrlFor,
  type CookieLike,
} from "../src/publisher/sign-out";

describe("the URL a cookie has to be removed with", () => {
  test("a leading dot is not part of the host", () => {
    // `.instagram.com` means "this domain and its subdomains". Passing the dot
    // through produces a URL that matches nothing, the removal silently does
    // nothing, and the session survives a "sign-out" — the exact bug.
    assert.equal(
      removalUrlFor({ name: "sessionid", domain: ".instagram.com", path: "/", secure: true }),
      "https://instagram.com/",
    );
  });

  test("the cookie's own path is used, not the origin's", () => {
    assert.equal(
      removalUrlFor({ name: "s", domain: "x.com", path: "/i/flow", secure: true }),
      "https://x.com/i/flow",
    );
  });

  test("a missing path is treated as the root", () => {
    assert.equal(removalUrlFor({ name: "s", domain: "x.com", secure: true }), "https://x.com/");
  });

  test("a path that is not a path is not trusted", () => {
    assert.equal(
      removalUrlFor({ name: "s", domain: "x.com", path: "nonsense", secure: true }),
      "https://x.com/",
    );
  });

  test("a Secure cookie is addressed over https, a plain one over http", () => {
    assert.match(removalUrlFor({ name: "a", domain: "x.com", secure: true })!, /^https:/);
    assert.match(removalUrlFor({ name: "a", domain: "x.com", secure: false })!, /^http:/);
  });

  test("a cookie with no domain has no removal URL", () => {
    // Reported as a failure rather than skipped: a cookie nobody removed is
    // the difference between signed out and appearing to be.
    assert.equal(removalUrlFor({ name: "a" }), null);
    assert.equal(removalUrlFor({ name: "a", domain: "  " }), null);
  });
});

/** A jar that records what was asked of it. */
function jar(cookies: CookieLike[], failOn: string[] = []) {
  const removed: Array<{ url: string; name: string }> = [];
  return {
    removed,
    sources: {
      async cookiesFor() {
        return cookies;
      },
      async remove(url: string, name: string) {
        if (failOn.includes(name)) throw new Error("locked by the network");
        removed.push({ url, name });
      },
    },
  };
}

describe("clearing a network's cookies", () => {
  test("every cookie the jar holds for that origin is removed", async () => {
    const j = jar([
      { name: "sessionid", domain: ".instagram.com", path: "/", secure: true },
      { name: "ds_user_id", domain: ".instagram.com", path: "/", secure: true },
      { name: "csrftoken", domain: "instagram.com", path: "/", secure: true },
    ]);

    const report = await clearNetworkCookies("https://www.instagram.com", j.sources);

    assert.equal(report.found, 3);
    assert.equal(report.removed, 3);
    assert.deepEqual(report.failed, []);
    assert.deepEqual(
      j.removed.map((r) => r.name).sort(),
      ["csrftoken", "ds_user_id", "sessionid"],
    );
  });

  test("a cookie that will not go is reported, not swallowed", async () => {
    // A partial clear that claims success is how a workspace ends up posting
    // from an account the operator thinks they signed out of.
    const j = jar(
      [
        { name: "sessionid", domain: ".instagram.com", path: "/", secure: true },
        { name: "stubborn", domain: ".instagram.com", path: "/", secure: true },
      ],
      ["stubborn"],
    );

    const report = await clearNetworkCookies("https://www.instagram.com", j.sources);

    assert.equal(report.removed, 1);
    assert.equal(report.failed.length, 1);
    assert.equal(report.failed[0]!.name, "stubborn");
    assert.match(report.failed[0]!.reason, /locked/);
  });

  test("one bad cookie does not stop the others being removed", async () => {
    const j = jar([
      { name: "first", domain: ".x.com", path: "/", secure: true },
      { name: "nodomain" },
      { name: "third", domain: ".x.com", path: "/", secure: true },
    ]);

    const report = await clearNetworkCookies("https://x.com", j.sources);

    assert.equal(report.removed, 2);
    assert.equal(report.failed.length, 1);
    assert.equal(report.failed[0]!.name, "nodomain");
  });

  test("an empty jar is not an error", async () => {
    const report = await clearNetworkCookies("https://x.com", jar([]).sources);
    assert.deepEqual(report, { found: 0, removed: 0, failed: [] });
  });
});

describe("what the operator is told", () => {
  test("success is decided by the session check, not by the count", async () => {
    // The count is diagnosis. Whether the account is gone is a question only
    // re-reading the session can answer.
    const out = describeSignOut("Instagram", { found: 3, removed: 3, failed: [] }, false);
    assert.equal(out.signedOut, true);
    assert.match(out.detail, /3 cookies removed/);
    assert.match(out.detail, /now reads signed out/);
  });

  test("cookies removed but still signed in is a failure, said plainly", async () => {
    const out = describeSignOut(
      "Instagram",
      { found: 4, removed: 4, failed: [] },
      true,
    );
    assert.equal(out.signedOut, false);
    assert.match(out.detail, /still reads signed in/);
    assert.match(
      out.detail,
      /Do not treat this account as signed out/,
      "the operator must not be left thinking it worked",
    );
    assert.match(
      out.detail,
      /would still go out from it/,
      "and must be told the consequence, not just the state",
    );
  });

  test("nothing to remove and already signed out is an honest no-op", () => {
    const out = describeSignOut("X", { found: 0, removed: 0, failed: [] }, false);
    assert.equal(out.signedOut, true);
    assert.match(out.detail, /held no X session/);
  });

  test("nothing to remove but still signed in names the real problem", () => {
    // Bluesky and Mastodon keep their session in local storage, where a cookie
    // sweep cannot reach it. Saying "signed out" here would be a lie.
    const out = describeSignOut("Bluesky", { found: 0, removed: 0, failed: [] }, true);
    assert.equal(out.signedOut, false);
    assert.match(out.detail, /cookies cannot reach/);
  });

  test("failures are named so a stuck sign-out is diagnosable", () => {
    const out = describeSignOut(
      "Instagram",
      { found: 2, removed: 1, failed: [{ name: "sessionid", reason: "locked" }] },
      true,
    );
    assert.match(out.detail, /sessionid/);
    assert.match(out.detail, /locked/);
  });

  test("the singular is not embarrassing", () => {
    const out = describeSignOut("X", { found: 1, removed: 1, failed: [] }, false);
    assert.match(out.detail, /1 cookie removed/);
  });
});
