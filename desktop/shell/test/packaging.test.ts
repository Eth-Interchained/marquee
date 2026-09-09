/**
 * Does the packaging config put things where the code looks for them?
 *
 * Three separate pieces have to agree about one path, and none of them can see
 * the others:
 *
 *   1. `desktop/py-runtime/build.py` names the PyInstaller output `jenny`
 *      (`--onedir --name jenny`);
 *   2. electron-builder's `extraResources` copies that directory to
 *      `resources/python/jenny`;
 *   3. the VENDORED, un-editable `findPythonExe` looks first at
 *      `<resources>/python/jenny/jenny[.exe]`.
 *
 * If any one drifts, a packaged build starts, fails to find its interpreter,
 * and the operator loses the Terminal with an error about a path they never
 * typed. The recursive-scan fallback would probably paper over it, which is
 * exactly why a test should not let it get that far.
 *
 * `config.ts` has the same problem for the bundled UI and the API server, and
 * the rename pass already broke one of those (it wrote `artifacts/marquee`),
 * so those are asserted here too.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { resolveConfig } from "../src/config";

const here = path.dirname(fileURLToPath(import.meta.url));
const shellDir = path.resolve(here, "..");
const repoRoot = path.resolve(shellDir, "..", "..");

type ExtraResource = { from: string; to: string };
const pkg = JSON.parse(readFileSync(path.join(shellDir, "package.json"), "utf8")) as {
  build: { extraResources: ExtraResource[]; asar: boolean; extraMetadata?: unknown };
  scripts: Record<string, string>;
};

function resourceFor(to: string): ExtraResource {
  const found = pkg.build.extraResources.find((r) => r.to === to);
  assert.ok(found, `extraResources must place something at "${to}"`);
  return found;
}

test("the Python bundle lands exactly where the vendored findPythonExe looks first", () => {
  const resource = resourceFor("python/jenny");
  // The vendored code builds: path.join(resourcesPath, 'python', 'jenny', 'jenny' + ext)
  // so `to` must be "python/jenny" and the file inside must be named `jenny`.
  assert.equal(resource.to, "python/jenny");
  assert.equal(resource.from, "../py-runtime/dist/jenny", "must copy PyInstaller's --onedir output directory");

  // And the vendored candidate list must still be the shape we are matching.
  const vendored = readFileSync(path.join(shellDir, "vendor", "jenny", "orchestrator", "process-manager.js"), "utf8");
  assert.match(
    vendored,
    /path\.join\(pythonDir,\s*'jenny',\s*`jenny\$\{ext\}`\)/,
    "vendored findPythonExe changed its primary candidate — the extraResources mapping must follow it",
  );
  assert.match(vendored, /const pythonDir = path\.join\(resourcesPath, 'python'\)/, "vendored code still expects resources/python");
});

test("build.py names the executable `jenny`, which is what makes that path true", () => {
  const build = readFileSync(path.join(repoRoot, "desktop", "py-runtime", "build.py"), "utf8");
  assert.match(build, /"--name",\s*"jenny"/, "renaming the PyInstaller output breaks the primary candidate path");
  assert.match(build, /"--onedir"/, "onefile would unpack to a temp dir and change the PTY's cwd");
  // The uvicorn hidden-imports are the part PyInstaller cannot discover itself.
  for (const mod of ["uvicorn.protocols.http.auto", "uvicorn.protocols.websockets.auto", "uvicorn.lifespan.on", "uvicorn.loops.auto"]) {
    assert.ok(build.includes(mod), `build.py must keep the hidden-import ${mod}`);
  }
});

test("the UI and API server are packaged where config.ts resolves them", () => {
  const resourcesPath = "/tmp/marquee-resources";
  const packaged = resolveConfig({
    appPath: path.join("/opt", "marquee", "resources", "app.asar"),
    userDataDir: "/tmp/marquee-user",
    resourcesPath,
    packaged: true,
  });

  assert.equal(packaged.workspaceUi.kind, "bundled");
  if (packaged.workspaceUi.kind === "bundled") {
    const expected = path.join(resourcesPath, resourceFor("workspace-ui").to);
    assert.equal(packaged.workspaceUi.dir, expected, "packaged UI dir must match extraResources `to`");
  }

  assert.equal(packaged.apiServer.kind, "spawn");
  if (packaged.apiServer.kind === "spawn") {
    // config.ts resolves resources/api-server/index.mjs; extraResources ships
    // the built directory to api-server/.
    assert.equal(packaged.apiServer.entry, path.join(resourcesPath, "api-server", "index.mjs"));
    assert.equal(resourceFor("api-server").to, "api-server");
  }
});

test("the dev paths point at the renamed directories, not the pre-fork ones", () => {
  const dev = resolveConfig({
    appPath: path.join(repoRoot, "desktop", "shell"),
    userDataDir: "/tmp/marquee-user",
    resourcesPath: "/unused",
    packaged: false,
  });
  assert.equal(dev.workspaceUi.kind, "bundled");
  if (dev.workspaceUi.kind === "bundled") {
    // The rename pass wrote `artifacts/marquee` here and the shell refused to
    // start; nothing but a path assertion or a real boot catches that.
    assert.equal(dev.workspaceUi.dir, path.join(repoRoot, "artifacts", "studio", "dist", "public"));
  }
  if (dev.apiServer.kind === "spawn") {
    assert.equal(dev.apiServer.entry, path.join(repoRoot, "artifacts", "api-server", "dist", "index.mjs"));
  }
});

test("packaging runs the bundle step before electron-builder, and verifies it", () => {
  // `--check` is what proves the bundle actually serves; a package script that
  // skipped it could ship a bundle that builds and cannot run.
  assert.match(pkg.scripts["bundle:python"] ?? "", /build\.py --check/);
  assert.match(pkg.scripts.package ?? "", /bundle:python/);
  assert.match(pkg.scripts.package ?? "", /electron-builder/);
});
