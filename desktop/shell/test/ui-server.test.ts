import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import {
  readCookie,
  resolveStaticPath,
  SHELL_COOKIE_NAME,
  startWorkspaceUiServer,
  type UiServerHandle,
} from "../src/ui-server";

const root = mkdtempSync(path.join(tmpdir(), "marquee-shell-ui-"));
writeFileSync(path.join(root, "index.html"), "<!doctype html><title>workspace</title>");
writeFileSync(path.join(root, "app.js"), "export const ok = true;");

const TOKEN = "secret-token";
const API_TOKEN = "api-access-token";
let api: http.Server;
let ui: UiServerHandle;
let apiHits: string[] = [];
let apiTokensSeen: (string | undefined)[] = [];

before(async () => {
  api = http.createServer((request, response) => {
    apiHits.push(`${request.method} ${request.url}`);
    apiTokensSeen.push(request.headers["x-marquee-api-token"] as string | undefined);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ url: request.url }));
  });
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
  const port = (api.address() as { port: number }).port;

  ui = await startWorkspaceUiServer({
    rootDir: root,
    apiBaseUrl: `http://127.0.0.1:${port}`,
    token: TOKEN,
    apiAccessToken: API_TOKEN,
  });
});

after(async () => {
  await ui.close();
  await new Promise<void>((resolve) => api.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
});

const withToken = { cookie: `${SHELL_COOKIE_NAME}=${TOKEN}` };

test("a request without the shell cookie is refused", async () => {
  const response = await fetch(`${ui.origin}/`);
  assert.equal(response.status, 403);
});

test("a request with the wrong token is refused", async () => {
  const response = await fetch(`${ui.origin}/`, {
    headers: { cookie: `${SHELL_COOKIE_NAME}=guess` },
  });
  assert.equal(response.status, 403);
});

test("the privileged view gets the workspace UI", async () => {
  const response = await fetch(`${ui.origin}/`, { headers: withToken });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /workspace/);
});

test("client-side routes fall back to index.html", async () => {
  const response = await fetch(`${ui.origin}/workspaces/ws-a/queue`, { headers: withToken });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /<!doctype html>/i);
});

test("relative /api calls reach the API server unchanged", async () => {
  apiHits = [];
  const response = await fetch(`${ui.origin}/api/browser/state`, { headers: withToken });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { url: "/api/browser/state" });
  assert.deepEqual(apiHits, ["GET /api/browser/state"]);
});

test("POST bodies are forwarded", async () => {
  apiHits = [];
  const response = await fetch(`${ui.origin}/api/publish`, {
    method: "POST",
    headers: { ...withToken, "content-type": "application/json" },
    body: JSON.stringify({ draftId: "d1" }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(apiHits, ["POST /api/publish"]);
});

test("a path cannot escape the UI directory", () => {
  assert.equal(resolveStaticPath(root, "/../../etc/passwd"), path.join(root, "etc/passwd"));
  assert.equal(resolveStaticPath(root, "/app.js"), path.join(root, "app.js"));
});

test("cookie parsing ignores lookalike names", () => {
  assert.equal(readCookie("other=1; marquee_shell_token=abc", SHELL_COOKIE_NAME), "abc");
  assert.equal(readCookie("not_marquee_shell_token=abc", SHELL_COOKIE_NAME), null);
  assert.equal(readCookie(undefined, SHELL_COOKIE_NAME), null);
});

test("the proxy is the only thing that can present the API token", async () => {
  apiTokensSeen = [];

  await fetch(`${ui.origin}/api/browser/state`, { headers: withToken });
  assert.equal(apiTokensSeen.at(-1), API_TOKEN, "the proxy must add the API token");

  // A caller that already knows the UI cookie still cannot choose the API
  // token: an inbound copy is dropped and replaced with the real one.
  await fetch(`${ui.origin}/api/browser/state`, {
    headers: { ...withToken, "x-marquee-api-token": "forged" },
  });
  assert.equal(apiTokensSeen.at(-1), API_TOKEN);
});

test("an unauthenticated caller never reaches the API at all", async () => {
  const before = apiHits.length;
  const response = await fetch(`${ui.origin}/api/publish`, { method: "POST" });
  assert.equal(response.status, 403);
  assert.equal(apiHits.length, before);
});
