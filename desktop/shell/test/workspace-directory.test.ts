import assert from "node:assert/strict";
import { test } from "node:test";

import { EMPTY_DIRECTORY, parseDirectory } from "../src/workspace-directory";

const payload = {
  state: {
    activeWorkspaceId: "ws-a",
    workspaces: [
      {
        id: "ws-a",
        name: "Acme Studio",
        platform: "x",
        accountHandle: "@acme",
        profileId: "profile-mac",
      },
      { id: "ws-b", name: "Side Project", platform: "reddit", profileId: "missing" },
      { name: "no id here", platform: "x" },
    ],
    uaProfiles: [
      {
        id: "profile-mac",
        name: "Mac desktop",
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/131.0.0.0 Safari/537.36",
        locale: "en-GB",
        timezone: "Europe/London",
        clientHints: true,
      },
      { id: "broken", name: "no user agent" },
    ],
  },
  integrity: { ok: true },
};

test("reads workspaces and joins them to their UA profile", () => {
  const directory = parseDirectory(payload);

  assert.equal(directory.activeWorkspaceId, "ws-a");
  // The entry with no id is dropped rather than being given a made-up one.
  assert.equal(directory.workspaces.length, 2);

  const [acme] = directory.workspaces;
  assert.equal(acme?.name, "Acme Studio");
  assert.equal(acme?.accountHandle, "@acme");
  assert.equal(acme?.profile?.acceptLanguage, "en-GB");
  assert.equal(acme?.profile?.timezone, "Europe/London");
  assert.equal(acme?.profile?.clientHints, true);
});

test("a workspace pointing at an unknown profile has none, not a default one", () => {
  const directory = parseDirectory(payload);
  const side = directory.workspaces.find((entry) => entry.id === "ws-b");
  assert.equal(side?.profile, null);
  assert.equal(side?.accountHandle, null);
});

test("junk payloads produce an empty directory instead of throwing", () => {
  assert.deepEqual(parseDirectory(null), EMPTY_DIRECTORY);
  assert.deepEqual(parseDirectory({}), EMPTY_DIRECTORY);
  assert.deepEqual(parseDirectory({ state: "nope" }), EMPTY_DIRECTORY);
  assert.deepEqual(parseDirectory({ state: {} }), {
    activeWorkspaceId: null,
    workspaces: [],
  });
});
