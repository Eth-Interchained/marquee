import test from "node:test";
import assert from "node:assert/strict";

import { partitionFor, profileDirectoryName } from "../src/partition";

test("the same workspace always gets the same jar", () => {
  assert.equal(partitionFor("ws-1"), partitionFor("ws-1"));
  assert.match(partitionFor("ws-1"), /^persist:mq-ws-1-[0-9a-f]{16}$/);
});

test("ids that differ only in unsafe characters do not share a cookie jar", () => {
  // The whole point: "team/a" flattening onto "team-a" would sign both
  // workspaces into one account's session.
  const collidingPairs = [
    ["team/a", "team-a"],
    ["a b", "a-b"],
    ["ws:1", "ws-1"],
    ["ws#1", "ws@1"],
    ["ünicode", "-nicode"],
    ["", "-"],
  ];

  for (const [left, right] of collidingPairs) {
    assert.notEqual(
      partitionFor(left),
      partitionFor(right),
      `"${left}" and "${right}" must not share a partition`,
    );
  }
});

test("a very long id stays a usable directory name and is still unique", () => {
  const base = "w".repeat(300);
  const other = `${base}x`;
  const partition = partitionFor(base);

  assert.ok(profileDirectoryName(partition).length <= 80);
  assert.notEqual(partition, partitionFor(other));
});

test("partition keys are safe to use as directory names", () => {
  for (const id of ["ws/1", "../escape", "a\\b", "c:\\windows", "тест", "emoji-🙂"]) {
    const name = profileDirectoryName(partitionFor(id));
    assert.match(name, /^mq-[A-Za-z0-9_-]+$/);
    assert.ok(!name.includes(".."), `"${id}" produced a traversal-ish name`);
  }
});

test("the profile directory name drops only the persist prefix", () => {
  assert.equal(profileDirectoryName("persist:mq-x-0123456789abcdef"), "mq-x-0123456789abcdef");
});
