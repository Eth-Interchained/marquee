import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  extractHandle,
  parseAccountId,
  resolveIdentity,
  type IdentityConfig,
  type IdentitySources,
} from "../src/publisher/identity";

/**
 * These tests exist because the thing being decided is what the app tells
 * someone about their own account. A wrong answer here puts a real name — or a
 * fictional one — next to a green tick, which is how the owner ended up being
 * told he was posting as an account that had never existed.
 */

function sources(over: Partial<IdentitySources> = {}): IdentitySources {
  return {
    async cookie() {
      return undefined;
    },
    async pageText() {
      return null;
    },
    ...over,
  };
}

const X: IdentityConfig = {
  idCookie: { name: "twid", pattern: "u=(\\d+)" },
  handle: { selectors: ['[data-testid="SideNav_AccountSwitcher_Button"]'] },
};

describe("reading an account id from a cookie", () => {
  test("X's twid arrives percent-encoded and yields the id", () => {
    assert.equal(parseAccountId("u%3D1550000000000000000", "u=(\\d+)"), "1550000000000000000");
  });

  test("a quoted cookie value is unwrapped", () => {
    assert.equal(parseAccountId('"u%3D42"', "u=(\\d+)"), "42");
  });

  test("a bare numeric id needs no pattern", () => {
    assert.equal(parseAccountId("17841400000000000"), "17841400000000000");
  });

  test("a value that does not match yields nothing rather than a fragment", () => {
    assert.equal(parseAccountId("u%3Dnot-a-number", "u=(\\d+)"), undefined);
    assert.equal(parseAccountId("session-token-abc"), undefined);
    assert.equal(parseAccountId(""), undefined);
    assert.equal(parseAccountId(undefined), undefined);
  });

  test("a malformed escape does not throw", () => {
    assert.doesNotThrow(() => parseAccountId("%E0%A4%A", "u=(\\d+)"));
  });
});

describe("reading a handle from a page", () => {
  test("a handle is found in the surrounding text of a real control", () => {
    assert.equal(
      extractHandle("Interchained | $ITC | AiAssist Secure @interchained"),
      "@interchained",
    );
  });

  test("text with no handle yields nothing", () => {
    assert.equal(extractHandle("Account switcher"), undefined);
    assert.equal(extractHandle(""), undefined);
    assert.equal(extractHandle(undefined), undefined);
  });

  test("a trailing separator is not part of the handle", () => {
    assert.equal(extractHandle("@some.name."), "@some.name");
  });
});

describe("resolving who is signed in", () => {
  test("the id comes from the cookie and the handle from the page", async () => {
    const identity = await resolveIdentity(
      X,
      sources({
        async cookie(name) {
          return name === "twid" ? "u%3D99" : undefined;
        },
        async pageText() {
          return "Interchained @interchained";
        },
      }),
    );

    assert.equal(identity.accountId, "99");
    assert.equal(identity.accountHandle, "@interchained");
    assert.equal(identity.handleSource, "session");
    assert.equal(identity.handleUnknown, undefined);
  });

  test("the handle is always marked as having come from the session", async () => {
    // The field is what stops a caller treating a stored label as verified.
    const identity = await resolveIdentity(
      X,
      sources({ async pageText() { return "@someone"; } }),
    );
    assert.equal(identity.handleSource, "session");
  });

  test("no loaded page means unknown, and says how to fix it", async () => {
    const identity = await resolveIdentity(X, sources());

    assert.equal(identity.accountHandle, undefined);
    assert.equal(identity.handleSource, undefined);
    assert.match(identity.handleUnknown ?? "", /network view/);
  });

  test("a page with no match means unknown, not a guess", async () => {
    const identity = await resolveIdentity(
      X,
      sources({ async pageText() { return "Account switcher"; } }),
    );

    assert.equal(identity.accountHandle, undefined);
    assert.equal(identity.handleSource, undefined);
    assert.match(identity.handleUnknown ?? "", /moved where it shows it/);
  });

  test("an id with no readable handle still reports the id", async () => {
    // Facebook's case: the cookie proves which account, the page will not say
    // its name. Half an answer is worth reporting; a made-up name is not.
    const identity = await resolveIdentity(
      { idCookie: { name: "c_user" } },
      sources({ async cookie() { return "6100000"; } }),
    );

    assert.equal(identity.accountId, "6100000");
    assert.equal(identity.accountHandle, undefined);
    assert.ok(identity.handleUnknown);
  });

  test("a network with no identity config reports unknown rather than nothing", async () => {
    const identity = await resolveIdentity(undefined, sources());
    assert.equal(identity.accountHandle, undefined);
    assert.ok(identity.handleUnknown);
  });

  test("nothing anywhere returns a handle", async () => {
    // The property that matters most: there is no code path in which a value
    // the operator typed comes back out of here as a verified account.
    for (const config of [undefined, X, { idCookie: { name: "twid" } }]) {
      const identity = await resolveIdentity(config, sources());
      assert.equal(identity.accountHandle, undefined);
    }
  });
});
