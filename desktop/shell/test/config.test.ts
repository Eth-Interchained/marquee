import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { describeConfigProblem, resolveConfig, type ShellConfig } from "../src/config";

const dir = mkdtempSync(path.join(tmpdir(), "ua-config-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const uiDir = path.join(dir, "ui");
const apiEntry = path.join(dir, "api.mjs");
writeFileSync(apiEntry, "// built api server\n");
writeFileSync(path.join(dir, "index.html"), "");

function config(apiServer: ShellConfig["apiServer"]): ShellConfig {
  return {
    workspaceUi: { kind: "external", url: "http://127.0.0.1:5173/" },
    apiServer,
    bridgePort: 0,
    dataDir: path.join(dir, "ledger"),
    userDataDir: dir,
    pythonRuntime: { enabled: false, backendDir: path.join(dir, "py-runtime") },
  };
}

test("an external API server with no access token stops the shell from starting", () => {
  // The shell hands its publishing capability to whatever API it is pointed at.
  // An ungated one is reachable by anything on the network, so it is refused
  // outright rather than started with a warning.
  const problem = describeConfigProblem(
    config({ kind: "external", baseUrl: "http://10.0.0.5:3000", accessToken: null }),
  );

  assert.ok(problem, "an ungated external API must be a hard failure");
  assert.match(problem, /MARQUEE_API_ACCESS_TOKEN/);
});

test("an empty access token counts as no token", () => {
  const problem = describeConfigProblem(
    config({ kind: "external", baseUrl: "http://127.0.0.1:3000", accessToken: "" }),
  );

  assert.ok(problem);
});

test("a paired external API server is accepted", () => {
  assert.equal(
    describeConfigProblem(
      config({ kind: "external", baseUrl: "http://127.0.0.1:3000", accessToken: "paired" }),
    ),
    null,
  );
});

test("the spawned API server needs no pairing, and reports a missing build", () => {
  assert.equal(describeConfigProblem(config({ kind: "spawn", entry: apiEntry })), null);

  const missing = describeConfigProblem(
    config({ kind: "spawn", entry: path.join(dir, "not-built.mjs") }),
  );
  assert.match(String(missing), /API server build is missing/);
});

test("MARQUEE_API_ACCESS_TOKEN is read into external API config", () => {
  const previousUrl = process.env.MARQUEE_API_SERVER_URL;
  const previousToken = process.env.MARQUEE_API_ACCESS_TOKEN;
  process.env.MARQUEE_API_SERVER_URL = "http://127.0.0.1:3000";
  process.env.MARQUEE_API_ACCESS_TOKEN = "paired-token";

  try {
    const resolved = resolveConfig({
      appPath: dir,
      userDataDir: dir,
      resourcesPath: dir,
      packaged: false,
    });
    assert.deepEqual(resolved.apiServer, {
      kind: "external",
      baseUrl: "http://127.0.0.1:3000",
      accessToken: "paired-token",
    });
  } finally {
    if (previousUrl === undefined) delete process.env.MARQUEE_API_SERVER_URL;
    else process.env.MARQUEE_API_SERVER_URL = previousUrl;
    if (previousToken === undefined) delete process.env.MARQUEE_API_ACCESS_TOKEN;
    else process.env.MARQUEE_API_ACCESS_TOKEN = previousToken;
  }
});

// Kept so an accidental default of "bundled UI missing" does not go unnoticed.
test("a bundled UI directory that does not exist is reported", () => {
  const problem = describeConfigProblem({
    ...config({ kind: "spawn", entry: apiEntry }),
    workspaceUi: { kind: "bundled", dir: uiDir },
  });
  assert.match(String(problem), /workspace UI build is missing/);
});
