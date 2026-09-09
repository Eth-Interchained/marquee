/**
 * The shell talking to a *gated* API server, the way it does at runtime.
 *
 * The unit suites can all pass while the product is dead: the shell starts its
 * API server with MARQUEE_API_ACCESS_TOKEN, so every shell-internal caller must
 * carry that token. If the workspace directory does not, it reads nothing, the
 * publisher resolves no workspace, and every approved post fails before a
 * composer is ever opened. This exercises that whole path against the real
 * built API server, with a stub publisher standing in for Chromium.
 */

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { IdempotencyLedger } from "../src/idempotency";
import { freeLoopbackPort, waitForHttpOk } from "../src/net";
import {
  startSessionBridge,
  type PublishOutcome,
  type PublisherPort,
  type SessionBridgeHandle,
} from "../src/session-bridge-server";
import { WorkspaceDirectory } from "../src/workspace-directory";

const here = path.dirname(fileURLToPath(import.meta.url));
const apiEntry = path.resolve(here, "../../../artifacts/api-server/dist/index.mjs");

const BRIDGE_TOKEN = `bridge-${"0123456789abcdef".repeat(3)}`;
const API_TOKEN = `api-${"fedcba9876543210".repeat(3)}`;
const APPROVAL = { approvedBy: "operator@acme", approvedAt: "2026-01-01T00:00:00.000Z" };

describe(
  "shell against a gated API server",
  // Built from source in CI before this runs; skipped in a checkout that has
  // not built the API server yet rather than failing for an unrelated reason.
  { skip: existsSync(apiEntry) ? false : `Build the API server first: ${apiEntry} is missing` },
  () => {
    let dataDir: string;
    let bridge: SessionBridgeHandle;
    let api: ChildProcess;
    let apiBase: string;
    let published: string[] = [];

    before(async () => {
      dataDir = mkdtempSync(path.join(tmpdir(), "marquee-shell-integration-"));
      const ledger = new IdempotencyLedger(path.join(dataDir, "ledger.json"));

      const publisher: PublisherPort = {
        async sessionStatus(workspaceId) {
          return {
            authenticated: workspaceId === "ws-a",
            accountHandle: "@acme",
            detail: "Stub publisher standing in for Chromium.",
          };
        },
        async beginSignIn(workspaceId) {
          return {
            opened: true,
            alreadySignedIn: false,
            detail: `Stub publisher pretended to open a sign-in tab for ${workspaceId}.`,
          };
        },
        async signOut() {
          // Nothing in these suites exercises a sign-out; the port
          // requires it, and a fake that lies about succeeding would be
          // worse than one that plainly refuses.
          return { signedOut: false, detail: "not exercised by this test" };
        },
        async publish(input) {
          return ledger.run(input.idempotencyKey, input, async (): Promise<PublishOutcome> => {
            published.push(input.draftId);
            return {
              kind: "published",
              postUrl: `https://x.com/acme/status/${published.length}`,
              postId: String(published.length),
            };
          });
        },
      };

      bridge = await startSessionBridge({ publisher, token: BRIDGE_TOKEN });

      // Asking the OS beats guessing: a random port in a fixed range collides
      // with whatever else the machine is running, and the failure reads as a
      // broken API server rather than an occupied port.
      const port = await freeLoopbackPort();
      apiBase = `http://127.0.0.1:${port}`;
      api = spawn(process.execPath, [apiEntry], {
        env: {
          ...process.env,
          NODE_ENV: "production",
          PORT: String(port),
          HOST: "127.0.0.1",
          MARQUEE_SESSION_BRIDGE_URL: bridge.url,
          MARQUEE_SESSION_BRIDGE_TOKEN: BRIDGE_TOKEN,
          MARQUEE_API_ACCESS_TOKEN: API_TOKEN,
          NEDB_DATA_DIR: path.join(dataDir, "nedb"),
        },
        stdio: ["ignore", "ignore", "inherit"],
      });

      await waitForHttpOk(`${apiBase}/api/healthz`, 30_000, 200, { "X-Marquee-Api-Token": API_TOKEN });

      const seeded = await fetch(`${apiBase}/api/browser/state`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", "X-Marquee-Api-Token": API_TOKEN },
        body: JSON.stringify({
          version: 1,
          activeWorkspaceId: "ws-a",
          workspaces: [
            {
              id: "ws-a",
              name: "Acme Studio",
              platform: "x",
              accountHandle: "@acme",
              profileId: "profile-mac",
            },
          ],
          uaProfiles: [
            {
              id: "profile-mac",
              name: "Mac desktop",
              userAgent: "Mozilla/5.0 (Macintosh) Chrome/131.0.0.0 Safari/537.36",
              locale: "en-GB",
              timezone: "Europe/London",
              clientHints: true,
            },
          ],
          drafts: [
            {
              id: "draft-ok",
              workspaceId: "ws-a",
              platform: "x",
              body: "hello from the shell",
              status: "approved",
              scheduledFor: null,
              approvedBy: APPROVAL.approvedBy,
              approvedAt: APPROVAL.approvedAt,
              postUrl: null,
              lastError: null,
              createdAt: APPROVAL.approvedAt,
              updatedAt: APPROVAL.approvedAt,
            },
          ],
          accounts: [],
          activity: [],
          settings: {},
          usage: {},
          updatedAt: APPROVAL.approvedAt,
        }),
      });
      assert.equal(seeded.status, 200, "seeding the ledger should succeed");
    });

    after(async () => {
      api?.kill("SIGTERM");
      await bridge?.close();
      rmSync(dataDir, { recursive: true, force: true });
    });

    test("the directory reads the workspace list through the gate", async () => {
      const directory = new WorkspaceDirectory(
        () => apiBase,
        () => API_TOKEN,
      );
      const snapshot = await directory.refresh();

      assert.equal(directory.error, null);
      assert.equal(snapshot.activeWorkspaceId, "ws-a");
      const workspace = directory.lookup("ws-a");
      assert.ok(workspace, "the shell must be able to see its own workspaces");
      assert.equal(workspace.profile?.timezone, "Europe/London");
    });

    test("a directory without the token reads nothing, and says so", async () => {
      const directory = new WorkspaceDirectory(() => apiBase);
      const snapshot = await directory.refresh();

      assert.equal(snapshot.workspaces.length, 0);
      assert.match(String(directory.error), /401/);
    });

    test("an approved post reaches the publisher through the whole chain", async () => {
      published = [];
      const response = await fetch(`${apiBase}/api/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Marquee-Api-Token": API_TOKEN },
        body: JSON.stringify({
          workspaceId: "ws-a",
          draftId: "draft-ok",
          platform: "x",
          body: "hello from the shell",
          approval: APPROVAL,
        }),
      });
      const payload = (await response.json()) as { status?: string; postUrl?: string };

      assert.equal(response.status, 200, JSON.stringify(payload));
      assert.equal(payload.status, "published");
      assert.match(String(payload.postUrl), /^https:\/\/x\.com\/acme\/status\/\d+$/);
      assert.deepEqual(published, ["draft-ok"]);
    });

    test("a caller cannot bring its own idempotency key", async () => {
      // A post is identified by its draft and the approval it carries. If a
      // caller could name the key, two invented names for one post would each
      // look new, and each would post.
      published = [];
      const response = await fetch(`${apiBase}/api/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Marquee-Api-Token": API_TOKEN },
        body: JSON.stringify({
          workspaceId: "ws-a",
          draftId: "draft-ok",
          platform: "x",
          body: "hello from the shell",
          approval: APPROVAL,
          idempotencyKey: "draft-ok:1",
        }),
      });

      assert.equal(response.status, 400);
      assert.deepEqual(published, [], "nothing may be posted on a refused key");
    });

    test("an untokened local caller never reaches the publisher", async () => {
      published = [];
      const response = await fetch(`${apiBase}/api/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: "ws-a",
          draftId: "draft-ok",
          platform: "x",
          body: "hello from the shell",
          approval: APPROVAL,
          idempotencyKey: "draft-ok:2",
        }),
      });

      assert.equal(response.status, 401);
      assert.deepEqual(published, []);
    });
  },
);
