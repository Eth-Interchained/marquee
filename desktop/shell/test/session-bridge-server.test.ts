/**
 * The bridge is the seam between the API server and the shell, so it is tested
 * against a stub publisher: no Electron, no browser, just the HTTP contract
 * `artifacts/api-server/src/lib/session-bridge.ts` expects.
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import {
  BRIDGE_TOKEN_HEADER,
  startSessionBridge,
  statusForOutcome,
  tokenMatches,
  type PublishOutcome,
  type PublishRequestInput,
  type PublisherPort,
  type SessionBridgeHandle,
  type SessionSnapshot,
  type SignInInvitation,
} from "../src/session-bridge-server";

/** Stands in for the capability the shell mints at startup. */
const TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef";
const auth = { [BRIDGE_TOKEN_HEADER]: TOKEN };

type Recorded = PublishRequestInput;

const calls: Recorded[] = [];
let nextPublish: PublishOutcome = { kind: "published", postUrl: "https://x.com/a/status/1", postId: "1" };
let nextSession: SessionSnapshot = { authenticated: true, accountHandle: "@acme", detail: "signed in" };

const signInCalls: { workspaceId: string; platform?: string }[] = [];
let nextSignIn: SignInInvitation = {
  opened: true,
  alreadySignedIn: false,
  detail: "Sign in to X in this workspace's tab.",
};

const sessionCalls: { workspaceId: string; platform?: string }[] = [];

const stub: PublisherPort = {
  async sessionStatus(workspaceId, platform): Promise<SessionSnapshot> {
    sessionCalls.push({ workspaceId, platform });
    return nextSession;
  },
  async publish(input): Promise<PublishOutcome> {
    calls.push(input);
    return nextPublish;
  },
  async beginSignIn(workspaceId, platform) {
    signInCalls.push({ workspaceId, platform });
    return nextSignIn;
  },
  async signOut() {
    // Nothing in these suites exercises a sign-out; the port
    // requires it, and a fake that lies about succeeding would be
    // worse than one that plainly refuses.
    return { signedOut: false, detail: "not exercised by this test" };
  },
};

let bridge: SessionBridgeHandle;

before(async () => {
  bridge = await startSessionBridge({ publisher: stub, token: TOKEN });
});

after(async () => {
  await bridge.close();
});

const validBody = {
  workspaceId: "ws-1",
  draftId: "draft-1",
  platform: "x",
  body: "hello",
  idempotencyKey: "draft-1:2026-01-01T00:00:00.000Z",
};

async function publish(
  body: unknown,
  headers: Record<string, string> = auth,
): Promise<{ status: number; json: any }> {
  const response = await fetch(`${bridge.url}/publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: await response.json() };
}

test("binds to loopback only", () => {
  assert.match(bridge.url, /^http:\/\/127\.0\.0\.1:\d+$/);
});

test("refuses to start without a real capability token", async () => {
  await assert.rejects(() => startSessionBridge({ publisher: stub, token: "" }), /token/i);
  await assert.rejects(() => startSessionBridge({ publisher: stub, token: "short" }), /token/i);
});

test("another local process cannot publish through the operator's session", async () => {
  const before = calls.length;

  // No token at all — the case that matters: loopback is not a privilege
  // boundary, and the human approval lives in the API server, so an
  // unauthorized caller reaching the publisher would post with no approval.
  const anonymous = await publish(validBody, {});
  assert.equal(anonymous.status, 401);
  assert.match(anonymous.json.detail, /capability token/i);

  // A guessed token.
  const guessed = await publish(validBody, { [BRIDGE_TOKEN_HEADER]: "not-the-token" });
  assert.equal(guessed.status, 401);

  // A token of the right shape but the wrong value.
  const wrong = await publish(validBody, { [BRIDGE_TOKEN_HEADER]: TOKEN.replace(/f$/, "e") });
  assert.equal(wrong.status, 401);

  assert.equal(calls.length, before, "the publisher must never be reached");
});

test("session state is not readable without the token either", async () => {
  const anonymous = await fetch(`${bridge.url}/session/ws-1`);
  assert.equal(anonymous.status, 401);

  const health = await fetch(`${bridge.url}/health`);
  assert.equal(health.status, 401, "even liveness must not confirm what this port is");
});

test("token comparison rejects everything but the exact value", () => {
  assert.equal(tokenMatches(TOKEN, TOKEN), true);
  assert.equal(tokenMatches(TOKEN, `${TOKEN} `), false);
  assert.equal(tokenMatches(TOKEN, TOKEN.slice(0, -1)), false);
  assert.equal(tokenMatches(TOKEN, ""), false);
  assert.equal(tokenMatches(TOKEN, undefined), false);
  assert.equal(tokenMatches(TOKEN, [TOKEN]), false);
});

test("reports session status in the shape the API server reads", async () => {
  const response = await fetch(`${bridge.url}/session/ws-1`, { headers: auth });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    authenticated: true,
    accountHandle: "@acme",
    detail: "signed in",
  });
});

test("a workspace id with a slash in it still resolves", async () => {
  const response = await fetch(`${bridge.url}/session/${encodeURIComponent("ws/2")}`, {
    headers: auth,
  });
  assert.equal(response.status, 200);
});

test("a published post answers 200 with the post url", async () => {
  nextPublish = { kind: "published", postUrl: "https://x.com/acme/status/9", postId: "9" };
  const { status, json } = await publish(validBody);
  assert.equal(status, 200);
  assert.equal(json.postUrl, "https://x.com/acme/status/9");
  assert.equal(json.postId, "9");
  // A request that names no attachments reaches the publisher with an empty
  // list rather than an absent field, so nothing downstream has to decide what
  // "no media key" means.
  assert.deepEqual(calls.at(-1), { ...validBody, media: [] });
});

test("a signed-out workspace answers 401 so the API server can say so", async () => {
  nextPublish = { kind: "unauthenticated", detail: "no session cookie" };
  const { status, json } = await publish(validBody);
  assert.equal(status, 401);
  assert.equal(json.detail, "no session cookie");
  assert.equal(json.postUrl, undefined);
});

test("a platform rejection answers 502 by default", async () => {
  nextPublish = { kind: "rejected", detail: "duplicate content" };
  const { status, json } = await publish(validBody);
  assert.equal(status, 502);
  assert.equal(json.detail, "duplicate content");
});

test("an unconfirmed attempt answers 409 and never looks like success", async () => {
  nextPublish = { kind: "rejected", detail: "submitted but unconfirmed", status: 409 };
  const { status, json } = await publish(validBody);
  assert.equal(status, 409);
  assert.equal(json.detail, "submitted but unconfirmed");
  assert.equal(json.postUrl, undefined);
});

test("an incomplete publish request is refused before anything is attempted", async () => {
  const before = calls.length;
  const { status, json } = await publish({ workspaceId: "ws-1", body: "hi" });
  assert.equal(status, 400);
  assert.match(json.detail, /idempotencyKey/);
  assert.equal(calls.length, before);
});

test("unparseable JSON is refused, not guessed at", async () => {
  const response = await fetch(`${bridge.url}/publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth },
    body: "{not json",
  });
  assert.equal(response.status, 400);
});

test("unknown routes 404 rather than answering vaguely", async () => {
  const response = await fetch(`${bridge.url}/nope`, { headers: auth });
  assert.equal(response.status, 404);
});

test("outcome to status mapping", () => {
  assert.equal(statusForOutcome({ kind: "published" }), 200);
  assert.equal(statusForOutcome({ kind: "unauthenticated", detail: "" }), 401);
  assert.equal(statusForOutcome({ kind: "rejected", detail: "" }), 502);
  assert.equal(statusForOutcome({ kind: "rejected", detail: "", status: 501 }), 501);
});

test("session status is reported unauthenticated without inventing a handle", async () => {
  nextSession = { authenticated: false, detail: "not signed in" };
  const response = await fetch(`${bridge.url}/session/ws-1`, { headers: auth });
  const json = (await response.json()) as Record<string, unknown>;
  assert.equal(json.authenticated, false);
  assert.equal(json.accountHandle, undefined);
});

// ---------------------------------------------------------------------------
// Live sign-in
// ---------------------------------------------------------------------------

test("a sign-in request reaches the publisher and reports only what it did", async () => {
  nextSignIn = {
    opened: true,
    alreadySignedIn: false,
    detail: "Sign in to X in this workspace's tab.",
  };

  const response = await fetch(`${bridge.url}/signin/ws-1`, {
    method: "POST",
    headers: auth,
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), nextSignIn);
  assert.ok(signInCalls.some((call) => call.workspaceId === "ws-1"));
});

test("a sign-in can name the network, for a workspace holding more than one account", async () => {
  const response = await fetch(`${bridge.url}/signin/ws-1`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ platform: "linkedin" }),
  });

  assert.equal(response.status, 200);
  const last = signInCalls.at(-1);
  assert.equal(last?.workspaceId, "ws-1");
  assert.equal(last?.platform, "linkedin");
});

test("an unreadable sign-in body is refused rather than defaulted", async () => {
  // Falling back to the workspace's own network here would open the wrong
  // login page and look like the app ignored what was asked for.
  const before = signInCalls.length;

  const response = await fetch(`${bridge.url}/signin/ws-1`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: "{not json",
  });

  assert.equal(response.status, 400);
  assert.equal(signInCalls.length, before, "the publisher must not be consulted");
});

test("a session can be read for one network of a workspace", async () => {
  nextSession = { authenticated: true, accountHandle: "@acme", detail: "signed in" };
  const response = await fetch(`${bridge.url}/session/ws-1?platform=mastodon`, {
    headers: auth,
  });

  assert.equal(response.status, 200);
  assert.equal(sessionCalls.at(-1)?.platform, "mastodon");
});

test("an already-signed-in workspace is told so rather than handed a tab", async () => {
  nextSignIn = {
    opened: false,
    alreadySignedIn: true,
    detail: "This workspace is already signed in to X.",
  };

  const response = await fetch(`${bridge.url}/signin/ws-2`, {
    method: "POST",
    headers: auth,
  });

  const payload = (await response.json()) as SignInInvitation;
  assert.equal(payload.opened, false);
  assert.equal(payload.alreadySignedIn, true);
});

test("opening a sign-in needs the capability token like everything else", async () => {
  // Opening a tab in the operator's browser is a real side effect, so it is
  // behind the same gate as publishing rather than being treated as harmless.
  const before = signInCalls.length;

  const response = await fetch(`${bridge.url}/signin/ws-1`, { method: "POST" });

  assert.equal(response.status, 401);
  assert.equal(signInCalls.length, before, "the publisher must not be consulted at all");
});
