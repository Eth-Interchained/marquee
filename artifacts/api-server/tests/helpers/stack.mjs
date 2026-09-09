import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const serverRoot = fileURLToPath(new URL("../..", import.meta.url));

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/**
 * A stand-in for the desktop shell.
 *
 * Records every publish it is asked to make, and can be told to reject, or to
 * hold the request open — which is how a send is kept in flight long enough for
 * a person to try to change their mind mid-post.
 */
function startFakeShell(port, token) {
  const received = [];
  const state = { mode: "ok", holdMs: 0 };

  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      // The real shell refuses anything that does not carry its capability
      // token, so an unpaired server must not be able to post here either.
      if (req.headers["x-marquee-shell-token"] !== token) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ detail: "Not paired with this shell." }));
        return;
      }

      if (!req.url.startsWith("/publish")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ authenticated: true }));
        return;
      }

      received.push(JSON.parse(raw || "{}"));
      const respond = () => {
        if (state.mode === "reject") {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ detail: "The platform said no." }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ postUrl: `https://x.test/p/${received.length}` }),
        );
      };
      if (state.holdMs > 0) setTimeout(respond, state.holdMs);
      else respond();
    });
  });

  return {
    server,
    received,
    reject: () => (state.mode = "reject"),
    accept: () => (state.mode = "ok"),
    hold: (ms) => (state.holdMs = ms),
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Boots the built API server against a fake shell and a throwaway data dir. */
export async function startStack({ intervalMs = 500, bridge = true } = {}) {
  const bridgePort = await freePort();
  const apiPort = await freePort();
  const dataDir = mkdtempSync(join(tmpdir(), "marquee-test-"));

  const shellToken = `test-shell-token-${bridgePort}`;
  const shell = startFakeShell(bridgePort, shellToken);
  await new Promise((resolve) =>
    shell.server.listen(bridgePort, "127.0.0.1", resolve),
  );

  const server = spawn("node", ["./dist/index.mjs"], {
    cwd: serverRoot,
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(apiPort),
      NEDB_DATA_DIR: dataDir,
      MARQUEE_SESSION_BRIDGE_URL: bridge ? `http://127.0.0.1:${bridgePort}` : "",
      // The shell pairs the two halves; without the token the bridge counts as
      // unattached, exactly as it does on the web surface.
      MARQUEE_SESSION_BRIDGE_TOKEN: bridge ? shellToken : "",
      MARQUEE_SCHEDULER_INTERVAL_MS: String(intervalMs),
    },
    stdio: ["ignore", "ignore", "ignore"],
  });

  const base = `http://127.0.0.1:${apiPort}/api`;
  let up = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) {
        up = true;
        break;
      }
    } catch {}
    await sleep(125);
  }
  if (!up) throw new Error("api server did not start");

  return {
    base,
    shell,

    async putState(drafts) {
      const response = await fetch(`${base}/browser/state`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          version: 1,
          activeWorkspaceId: "ws-1",
          workspaces: [],
          uaProfiles: [],
          accounts: [],
          activity: [],
          settings: {},
          usage: {},
          updatedAt: new Date().toISOString(),
          drafts,
        }),
      });
      if (!response.ok) throw new Error(`state write failed: ${response.status}`);
      return response.json();
    },

    async publish(body) {
      const response = await fetch(`${base}/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    },

    async dispatches() {
      const response = await fetch(`${base}/schedule/dispatches`);
      return (await response.json()).dispatches;
    },

    async schedulerStatus() {
      return (await fetch(`${base}/schedule/status`)).json();
    },

    /** Waits until the shell has been asked to publish `count` times. */
    async waitForShell(count, timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (shell.received.length >= count) return true;
        await sleep(25);
      }
      return false;
    },

    /** Waits for the scheduler to have had a fair chance to act. */
    async settle(ms = intervalMs * 4) {
      await sleep(ms);
    },

    async stop() {
      server.kill("SIGTERM");
      await new Promise((resolve) => shell.server.close(resolve));
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

const APPROVED_AT = new Date(Date.now() - 600_000).toISOString();

export const approvedAt = APPROVED_AT;
export const past = (msAgo = 120_000) =>
  new Date(Date.now() - msAgo).toISOString();
export const future = () => new Date(Date.now() + 86_400_000).toISOString();

export function draft(id, overrides = {}) {
  return {
    id,
    workspaceId: "ws-1",
    platform: "x",
    body: `body of ${id}`,
    status: "scheduled",
    scheduledFor: past(),
    approvedBy: "Ada",
    approvedAt: APPROVED_AT,
    postUrl: null,
    lastError: null,
    createdAt: APPROVED_AT,
    updatedAt: APPROVED_AT,
    ...overrides,
  };
}

export function unapproved(id, overrides = {}) {
  return draft(id, {
    status: "draft",
    scheduledFor: null,
    approvedBy: null,
    approvedAt: null,
    ...overrides,
  });
}
