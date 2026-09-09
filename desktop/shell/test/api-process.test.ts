/**
 * Reclaiming an API server left behind by a shell that died badly.
 *
 * The data directory allows exactly one opener, so an orphaned child makes the
 * *next* launch fail. Reclaiming it means sending a signal to a pid read off
 * disk — which is only safe while the pid still belongs to the process that
 * was recorded, so that is what these tests are about.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { reclaimOrphanedApiServer } from "../src/api-process";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid: number, ms: number): Promise<boolean> {
  for (let waited = 0; waited < ms; waited += 50) {
    if (!alive(pid)) return true;
    await sleep(50);
  }
  return !alive(pid);
}

/** A stand-in for the API server: a node process that stays up on its own. */
function startIdleChild(dir: string): { child: ChildProcess; entry: string } {
  const entry = path.join(dir, "idle-api-server.mjs");
  writeFileSync(entry, "setInterval(() => {}, 1000);\n");
  const child = spawn(process.execPath, [entry], { stdio: "ignore" });
  return { child, entry };
}

test("an API server from a previous run is stopped and forgotten", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "marquee-shell-reclaim-"));
  const { child, entry } = startIdleChild(dir);
  const pid = child.pid;
  assert.ok(pid, "the stand-in child must have a pid");

  const pidFile = path.join(dir, "api-server.pid");
  writeFileSync(pidFile, JSON.stringify({ pid, entry, startedAt: new Date().toISOString() }));

  await reclaimOrphanedApiServer(pidFile);

  assert.equal(await waitForExit(pid, 5_000), true, "the orphan must be gone");
  assert.equal(existsSync(pidFile), false, "the note must not outlive the process");
});

test("a pid that now belongs to something else is left alone", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "marquee-shell-reclaim-"));
  const { child, entry } = startIdleChild(dir);
  const pid = child.pid;
  assert.ok(pid);

  // Same pid, different entry: exactly what pid reuse looks like from here.
  // Killing on the pid alone would end a stranger's process.
  const pidFile = path.join(dir, "api-server.pid");
  writeFileSync(
    pidFile,
    JSON.stringify({
      pid,
      entry: path.join(dir, "a-different-server.mjs"),
      startedAt: new Date().toISOString(),
    }),
  );

  await reclaimOrphanedApiServer(pidFile);
  await sleep(200);

  assert.equal(alive(pid as number), true, "an unrecognised process must survive");
  assert.equal(existsSync(pidFile), false, "the stale note is still discarded");

  child.kill("SIGKILL");
});

test("this process is never a candidate, whatever the file says", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "marquee-shell-reclaim-"));
  const pidFile = path.join(dir, "api-server.pid");
  writeFileSync(
    pidFile,
    JSON.stringify({ pid: process.pid, entry: process.argv[1] ?? "test", startedAt: "" }),
  );

  await reclaimOrphanedApiServer(pidFile);

  assert.equal(existsSync(pidFile), false);
});

test("a missing or unreadable note is not an error", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "marquee-shell-reclaim-"));

  await reclaimOrphanedApiServer(path.join(dir, "nothing-here.pid"));

  const junk = path.join(dir, "junk.pid");
  writeFileSync(junk, "not json at all");
  await reclaimOrphanedApiServer(junk);
  assert.equal(existsSync(junk), false);

  // A pid that cannot be signalled safely is refused before any signal.
  const bad = path.join(dir, "bad.pid");
  writeFileSync(bad, JSON.stringify({ pid: 1, entry: "/bin/launchd" }));
  await reclaimOrphanedApiServer(bad);
  assert.equal(existsSync(bad), false);
});
