import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { PairingFileError, writePairingFileAt } from "../src/pairing-file";

const dir = mkdtempSync(path.join(tmpdir(), "ua-pairing-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const payload = { url: "http://127.0.0.1:1234", token: "capability", pid: 42 };

test("a fresh pairing file is owner-only and holds the pairing", () => {
  const file = path.join(dir, "fresh.json");
  writePairingFileAt(file, payload);

  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), payload);
});

test("an existing file is never reused, however permissive it is", () => {
  // The dangerous case: someone leaves a world-readable file at the path and
  // the shell writes a live publishing capability into it.
  const file = path.join(dir, "planted.json");
  writeFileSync(file, "{}\n");
  chmodSync(file, 0o666);

  assert.throws(() => writePairingFileAt(file, payload), PairingFileError);
  assert.equal(readFileSync(file, "utf8"), "{}\n", "the planted file must be left untouched");
});

test("a symlink at the path is refused rather than followed", () => {
  const target = path.join(dir, "target.json");
  writeFileSync(target, "original\n");
  const link = path.join(dir, "link.json");
  symlinkSync(target, link);

  assert.throws(() => writePairingFileAt(link, payload), PairingFileError);
  assert.equal(readFileSync(target, "utf8"), "original\n", "the token must not reach the target");
});

test("a dangling symlink is refused too", () => {
  const link = path.join(dir, "dangling.json");
  symlinkSync(path.join(dir, "nowhere.json"), link);

  assert.throws(() => writePairingFileAt(link, payload), PairingFileError);
});

test("an unwritable directory fails loudly instead of silently skipping", () => {
  const file = path.join(dir, "missing-dir", "pairing.json");
  assert.throws(() => writePairingFileAt(file, payload), PairingFileError);
});
