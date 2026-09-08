/**
 * The runtime leg of the UI server: `/runtime/*` HTTP is proxied with the
 * runtime token added and the prefix stripped; `/runtime/ws/*` upgrades are
 * spliced through with the token moved into the query string; and every one
 * of those is still behind the shell cookie. The page must never be able to
 * present its own token, and the runtime must never see the shell cookie.
 */

import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import {
  rewriteRuntimeUrl,
  SHELL_COOKIE_NAME,
  startWorkspaceUiServer,
  type UiServerHandle,
} from "../src/ui-server";

const root = mkdtempSync(path.join(tmpdir(), "ua-shell-ui-rt-"));
writeFileSync(path.join(root, "index.html"), "<!doctype html><title>workspace</title>");

const TOKEN = "shell-cookie-token";
const RUNTIME_TOKEN = "runtime-capability-token";
let runtime: http.Server;
let ui: UiServerHandle;
let noRuntimeUi: UiServerHandle;
const seen: Array<{ url: string; token?: string; cookie?: string }> = [];
const upgrades: Array<{ url: string; cookie?: string; token?: string }> = [];

before(async () => {
  runtime = http.createServer((request, response) => {
    seen.push({
      url: request.url ?? "",
      token: request.headers["x-ua-runtime-token"] as string | undefined,
      cookie: request.headers.cookie,
    });
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ url: request.url }));
  });
  // A minimal upgrade responder: records the handshake, answers 101, echoes bytes.
  runtime.on("upgrade", (request, socket) => {
    upgrades.push({
      url: request.url ?? "",
      cookie: request.headers.cookie,
      token: request.headers["x-ua-runtime-token"] as string | undefined,
    });
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    socket.on("data", (chunk: Buffer) => socket.write(Buffer.concat([Buffer.from("echo:"), chunk])));
  });
  await new Promise<void>((resolve) => runtime.listen(0, "127.0.0.1", resolve));
  const port = (runtime.address() as { port: number }).port;

  ui = await startWorkspaceUiServer({
    rootDir: root,
    apiBaseUrl: "http://127.0.0.1:9", // never hit by these tests
    token: TOKEN,
    apiAccessToken: "api",
    runtime: { baseUrl: `http://127.0.0.1:${port}`, token: RUNTIME_TOKEN },
  });
  noRuntimeUi = await startWorkspaceUiServer({
    rootDir: root,
    apiBaseUrl: "http://127.0.0.1:9",
    token: TOKEN,
    apiAccessToken: "api",
    runtime: null,
  });
});

after(async () => {
  await ui.close();
  await noRuntimeUi.close();
  await new Promise<void>((resolve) => runtime.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
});

const cookie = `${SHELL_COOKIE_NAME}=${TOKEN}`;

test("rewriteRuntimeUrl strips the prefix, adds the token to ws paths only, and drops an inbound token", () => {
  assert.equal(rewriteRuntimeUrl("/runtime/health", "T"), "/health");
  assert.equal(rewriteRuntimeUrl("/runtime", "T"), "/");
  assert.equal(rewriteRuntimeUrl("/runtime/ws/pty?program=shell", "T"), "/ws/pty?program=shell&token=T");
  assert.equal(rewriteRuntimeUrl("/runtime/ws/pty?token=forged&cols=80", "T"), "/ws/pty?cols=80&token=T");
  assert.equal(rewriteRuntimeUrl("/runtime/run_code?token=forged", "T"), "/run_code");
  assert.equal(rewriteRuntimeUrl("/api/health", "T"), null);
  assert.equal(rewriteRuntimeUrl("/runtimes/x", "T"), null);
});

test("HTTP: the runtime is reached with the token added, prefix stripped, and no shell cookie", async () => {
  const response = await fetch(`${ui.origin}/runtime/health`, { headers: { cookie } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { url: "/health" });
  const last = seen.at(-1);
  assert.equal(last?.url, "/health");
  assert.equal(last?.token, RUNTIME_TOKEN);
  assert.equal(last?.cookie, undefined);
});

test("HTTP: a caller cannot smuggle its own runtime token header", async () => {
  await fetch(`${ui.origin}/runtime/run_code`, {
    method: "POST",
    headers: { cookie, "X-UA-Runtime-Token": "forged", "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(seen.at(-1)?.token, RUNTIME_TOKEN);
});

test("HTTP: without the shell cookie the runtime is never contacted", async () => {
  const before = seen.length;
  const response = await fetch(`${ui.origin}/runtime/health`);
  assert.equal(response.status, 403);
  assert.equal(seen.length, before);
});

test("HTTP: with no runtime configured the answer is a named 503, not a hang", async () => {
  const response = await fetch(`${noRuntimeUi.origin}/runtime/health`, { headers: { cookie } });
  assert.equal(response.status, 503);
  const body = (await response.json()) as { error: string };
  assert.equal(body.error, "runtime_unavailable");
});

function rawUpgrade(origin: string, requestPath: string, headers: string[]): Promise<{ status: string; socket: net.Socket }> {
  const url = new URL(origin);
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(url.port), url.hostname, () => {
      socket.write(
        [
          `GET ${requestPath} HTTP/1.1`,
          `Host: ${url.host}`,
          "Connection: Upgrade",
          "Upgrade: websocket",
          "Sec-WebSocket-Version: 13",
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
          ...headers,
          "",
          "",
        ].join("\r\n"),
      );
    });
    socket.once("data", (chunk: Buffer) => {
      const status = chunk.toString("utf8").split("\r\n")[0] ?? "";
      resolve({ status, socket });
    });
    socket.once("error", reject);
  });
}

test("WS: an upgrade under /runtime/ws is spliced through with the token in the query and the cookie dropped", async () => {
  const { status, socket } = await rawUpgrade(ui.origin, "/runtime/ws/pty?program=shell&token=forged", [`Cookie: ${cookie}`]);
  assert.equal(status, "HTTP/1.1 101 Switching Protocols");
  const last = upgrades.at(-1);
  assert.equal(last?.url, "/ws/pty?program=shell&token=" + RUNTIME_TOKEN);
  assert.equal(last?.cookie, undefined);
  assert.equal(last?.token, undefined);
  // Bytes flow both ways after the handshake.
  const echoed = await new Promise<string>((resolve) => {
    socket.once("data", (chunk: Buffer) => resolve(chunk.toString("utf8")));
    socket.write("ping");
  });
  assert.equal(echoed, "echo:ping");
  socket.destroy();
});

test("WS: without the shell cookie the upgrade is refused before the runtime is contacted", async () => {
  const before = upgrades.length;
  const { status, socket } = await rawUpgrade(ui.origin, "/runtime/ws/pty", []);
  assert.match(status, /^HTTP\/1\.1 403/);
  assert.equal(upgrades.length, before);
  socket.destroy();
});

test("WS: a non-runtime upgrade path is a 404, and a missing runtime is a 503", async () => {
  const a = await rawUpgrade(ui.origin, "/api/ws", [`Cookie: ${cookie}`]);
  assert.match(a.status, /^HTTP\/1\.1 404/);
  a.socket.destroy();
  const b = await rawUpgrade(noRuntimeUi.origin, "/runtime/ws/pty", [`Cookie: ${cookie}`]);
  assert.match(b.status, /^HTTP\/1\.1 503/);
  b.socket.destroy();
});
