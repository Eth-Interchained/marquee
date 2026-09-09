/**
 * The Python runtime, supervised by the VERBATIM Jenny orchestrator.
 *
 * The unit parts run everywhere. The live part spawns the real runtime through
 * the real vendored orchestrator and talks to it — it needs the runtime's venv
 * (desktop/py-runtime/.venv) and is reported as skipped, with the reason, when
 * that is absent. A skip that says why is not a silent pass.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

import { freeLoopbackPort } from "../src/net";
import {
  resolveDevPython,
  RUNTIME_TOKEN_ENV,
  startPythonRuntime,
  withRuntimeToken,
} from "../src/python-runtime";

const backendDir = path.resolve(__dirname, "..", "..", "py-runtime");
const venvPython = resolveDevPython(backendDir);
const haveVenv = venvPython.includes(".venv") && existsSync(venvPython);

test("withRuntimeToken exposes the token only inside the callback", () => {
  delete process.env[RUNTIME_TOKEN_ENV];
  let seen: string | undefined;
  const out = withRuntimeToken("abc", () => {
    seen = process.env[RUNTIME_TOKEN_ENV];
    return 42;
  });
  assert.equal(out, 42);
  assert.equal(seen, "abc");
  assert.equal(process.env[RUNTIME_TOKEN_ENV], undefined);
});

test("withRuntimeToken restores a pre-existing value and cleans up on throw", () => {
  process.env[RUNTIME_TOKEN_ENV] = "outer";
  assert.throws(() =>
    withRuntimeToken("inner", () => {
      assert.equal(process.env[RUNTIME_TOKEN_ENV], "inner");
      throw new Error("boom");
    }),
  );
  assert.equal(process.env[RUNTIME_TOKEN_ENV], "outer");
  delete process.env[RUNTIME_TOKEN_ENV];
});

test("resolveDevPython prefers the runtime venv and otherwise names the platform interpreter", () => {
  const fallback = resolveDevPython("/definitely/not/a/dir");
  assert.equal(fallback, process.platform === "win32" ? "python" : "python3");
});

test("an empty token is refused before anything is spawned", async () => {
  await assert.rejects(
    startPythonRuntime({ port: 1, token: "", backendDir, workspaceDir: backendDir, packaged: false }),
    /capability token is required/,
  );
});

test(
  "LIVE: Jenny spawns the runtime, /health goes green, the token gates /run_code, and stop() ends it",
  { skip: haveVenv ? false : `no venv at ${backendDir}/.venv — create it per desktop/py-runtime/README.md` },
  async () => {
    const port = await freeLoopbackPort();
    const token = "test-token-" + port;
    const handle = await startPythonRuntime({ port, token, backendDir, workspaceDir: backendDir, packaged: false });
    try {
      assert.equal(handle.port, port);
      assert.equal(handle.status().python, "running");
      assert.equal(handle.status().health.status, "healthy");

      const health = (await (await fetch(`${handle.baseUrl}/health`)).json()) as { gated: boolean; runtime: string };
      assert.equal(health.runtime, "ua-py-runtime");
      assert.equal(health.gated, true, "the child must have received the token through the env window");

      const denied = await fetch(`${handle.baseUrl}/run_code`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ language: "python", code: "print(1)" }),
      });
      assert.equal(denied.status, 401);

      const allowed = await fetch(`${handle.baseUrl}/run_code`, {
        method: "POST",
        headers: { "content-type": "application/json", "X-Marquee-Runtime-Token": token },
        body: JSON.stringify({ language: "python", code: "print(6*7)" }),
      });
      assert.equal(allowed.status, 200);
      const result = (await allowed.json()) as { stdout: string; exit_code: number };
      assert.equal(result.stdout.trim(), "42");
      assert.equal(result.exit_code, 0);

      // The token must not linger on the parent after spawn.
      assert.equal(process.env[RUNTIME_TOKEN_ENV], undefined);
    } finally {
      await handle.stop();
    }
    // Give Jenny's SIGTERM a moment, then the port must be free again.
    await new Promise((resolve) => setTimeout(resolve, 800));
    await assert.rejects(fetch(`${handle.baseUrl}/health`, { signal: AbortSignal.timeout(1000) }));
  },
);
