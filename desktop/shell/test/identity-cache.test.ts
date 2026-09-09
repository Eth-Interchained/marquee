import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createIdentityCache,
  identityCacheKey,
} from "../src/publisher/identity-cache";

/** A clock the tests move by hand, so nothing here waits on real time. */
function clock(start = 1_000) {
  let t = start;
  return {
    now: () => t,
    advance(ms: number) {
      t += ms;
    },
  };
}

const cacheWith = (c: { now: () => number }) =>
  createIdentityCache({ ttlMs: 30_000, failureTtlMs: 4_000, now: c.now });

const KEY = identityCacheKey("ws-x", "x");
const HANDLE = { accountHandle: "@interchained", handleSource: "session" as const };

test("a handle that was read is reused", () => {
  const c = clock();
  const cache = cacheWith(c);

  cache.set(KEY, "1441", HANDLE);
  assert.deepEqual(cache.get(KEY, "1441"), HANDLE);
});

test("nothing is returned for a key that was never stored", () => {
  const cache = cacheWith(clock());
  assert.equal(cache.get(KEY, "1441"), undefined);
});

test("a handle is dropped the moment the account behind it changes", () => {
  // The reason this cache is bound to an account id at all. Signing a
  // workspace into a different account must never surface the previous
  // account's handle — a wrong name beside a green tick is the exact failure
  // this whole area of the code was written to prevent.
  const c = clock();
  const cache = cacheWith(c);

  cache.set(KEY, "1441", HANDLE);

  assert.equal(
    cache.get(KEY, "9987"),
    undefined,
    "a different account must not inherit the stored handle",
  );
  assert.equal(cache.size(), 0, "and the stale entry is gone, not just hidden");
});

test("the account binding is checked before the clock", () => {
  // A handle belonging to someone else is wrong immediately, not once it has
  // aged. Nothing may hand it back inside the TTL.
  const c = clock();
  const cache = cacheWith(c);

  cache.set(KEY, "1441", HANDLE);
  c.advance(1);

  assert.equal(cache.get(KEY, "9987"), undefined);
});

test("a stored handle expires", () => {
  const c = clock();
  const cache = cacheWith(c);

  cache.set(KEY, "1441", HANDLE);

  c.advance(29_999);
  assert.deepEqual(cache.get(KEY, "1441"), HANDLE, "still fresh just before");

  c.advance(1);
  assert.equal(cache.get(KEY, "1441"), undefined, "gone once the TTL is reached");
});

test("an unreadable handle expires far sooner than a real one", () => {
  // A miss usually means the page had not finished arriving, which resolves on
  // its own. Holding it as long as a real answer would turn a passing miss
  // into a lasting "unknown".
  const c = clock();
  const cache = cacheWith(c);

  cache.set(KEY, "1441", { handleUnknown: "The page was too busy." });

  c.advance(3_999);
  assert.ok(cache.get(KEY, "1441"), "held briefly, so a poll storm costs one read");

  c.advance(1);
  assert.equal(cache.get(KEY, "1441"), undefined, "then retried");
});

test("an empty handle counts as unreadable, not as a name", () => {
  const c = clock();
  const cache = cacheWith(c);

  cache.set(KEY, "1441", { accountHandle: "" });

  c.advance(4_000);
  assert.equal(
    cache.get(KEY, "1441"),
    undefined,
    "an empty string is a failed read and must expire on the failure clock",
  );
});

test("a network with no id cookie still caches, on the clock alone", () => {
  // Bluesky and Mastodon keep no account id in a cookie. They have nothing to
  // bind to, which is exactly why the TTL is seconds rather than minutes.
  const c = clock();
  const cache = cacheWith(c);

  cache.set(KEY, undefined, HANDLE);
  assert.deepEqual(cache.get(KEY, undefined), HANDLE);

  c.advance(30_000);
  assert.equal(cache.get(KEY, undefined), undefined);
});

test("an account appearing where there was none invalidates the entry", () => {
  // Reading no id and then reading one is a change of account, not a refinement
  // of the same one.
  const c = clock();
  const cache = cacheWith(c);

  cache.set(KEY, undefined, HANDLE);
  assert.equal(cache.get(KEY, "1441"), undefined);
});

test("two networks in one workspace never share a handle", () => {
  // A workspace is one identity holding several accounts. A session on one
  // network is no evidence at all about another.
  const c = clock();
  const cache = cacheWith(c);

  const onX = identityCacheKey("ws-x", "x");
  const onInstagram = identityCacheKey("ws-x", "instagram");

  cache.set(onX, "1441", HANDLE);

  assert.equal(cache.get(onInstagram, "1441"), undefined);
  assert.notEqual(onX, onInstagram);
});

test("two workspaces on the same network never share a handle", () => {
  const c = clock();
  const cache = cacheWith(c);

  const desk = identityCacheKey("ws-desk", "x");
  const studio = identityCacheKey("ws-studio", "x");

  cache.set(desk, "1441", HANDLE);
  assert.equal(cache.get(studio, "1441"), undefined);
});

test("invalidating forgets a key outright", () => {
  // Used when the operator is sent to sign in: whoever is signed in may not be
  // in a moment, so the next read must go back to the session.
  const c = clock();
  const cache = cacheWith(c);

  cache.set(KEY, "1441", HANDLE);
  cache.invalidate(KEY);

  assert.equal(cache.get(KEY, "1441"), undefined);
  assert.equal(cache.size(), 0);
});
