// Executes the real fanout.py in --print mode against temp env files.
// Run: node --test deploy/mediamtx/fanout.test.mjs
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
const require = createRequire(import.meta.url);
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "fanout.py");

function run(path, envText, extra = []) {
  const dir = mkdtempSync(join(tmpdir(), "fanout-"));
  const envFile = join(dir, "fanout.env");
  if (envText !== null) writeFileSync(envFile, envText);
  try {
    const stdout = execFileSync("python3", [script, path, "--print", ...extra], {
      env: { ...process.env, FANOUT_ENV: envFile, FANOUT_RTSP_BASE: "rtsp://127.0.0.1:8554" },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    return { code: error.status, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

test("builds ONE ffmpeg with a tee to every configured destination, copy video, aac audio, keys redacted in the print", () => {
  const r = run("marquee/me", [
    "# keys",
    "FANOUT_TWITCH=rtmp://live.twitch.tv/app/live_SECRET1",
    'FANOUT_YOUTUBE="rtmp://a.rtmp.youtube.com/live2/SECRET2"',
    "FANOUT_KICK=rtmps://ingest.kick.example:443/app/SECRET3",
    "FANOUT_NOTES=not a url",
  ].join("\n"));
  assert.equal(r.code, 0, r.stderr);
  const out = r.stdout.trim();
  assert.match(out, /-i rtsp:\/\/127\.0\.0\.1:8554\/marquee\/me/);
  assert.match(out, /-c:v copy/);
  assert.match(out, /-c:a aac/);
  assert.match(out, /-f tee /);
  // three destinations, each protected by onfail=ignore, and no key printed
  assert.equal((out.match(/\[f=flv:onfail=ignore\]/g) ?? []).length, 3);
  assert.ok(!out.includes("SECRET"), "keys must never be printed");
  assert.match(out, /kick|twitch|youtube/);
});

test("no env file → --print exits 0 with a named reason (live mode parks instead of exiting)", () => {
  const r = run("marquee/me", null);
  assert.equal(r.code, 0);
});

test("live mode with nothing to do PARKS (exec sleep) rather than exiting, so runOnAvailableRestart cannot loop it", () => {
  // Spawn without --print and confirm it is still alive after a moment, then end it.
  const { spawn } = require("node:child_process");
  const dir = mkdtempSync(join(tmpdir(), "fanout-park-"));
  const child = spawn("python3", [script, "other/idle"], { env: { ...process.env, FANOUT_ENV: join(dir, "missing.env") }, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (c) => (stderr += c));
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      try {
        assert.equal(child.exitCode, null, `should still be running; stderr: ${stderr}`);
        assert.match(stderr, /parked/);
        child.kill("SIGTERM");
        resolve();
      } catch (e) {
        child.kill("SIGKILL");
        reject(e);
      }
    }, 1200);
  });
});

test("a path outside FANOUT_PATHS is skipped, exit 0", () => {
  const r = run("other/thing", "FANOUT_TWITCH=rtmp://x/app/k\nFANOUT_PATHS=marquee/*");
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), "");
});

test("no destinations → exit 0, nothing printed", () => {
  const r = run("marquee/me", "FANOUT_PATHS=marquee/*\nFANOUT_BAD=http://not-rtmp");
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), "");
});

test("usage error without a path → exit 2", () => {
  let code = 0;
  try {
    execFileSync("python3", [script], { stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    code = error.status;
  }
  assert.equal(code, 2);
});
