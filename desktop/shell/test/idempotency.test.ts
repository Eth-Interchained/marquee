import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { IdempotencyLedger, isTerminal, unconfirmedOutcome } from "../src/idempotency";
import type { PublishOutcome } from "../src/session-bridge-server";

const dir = mkdtempSync(path.join(tmpdir(), "marquee-shell-ledger-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const context = { draftId: "draft-1", platform: "x" };

function ledger(name: string): IdempotencyLedger {
  return new IdempotencyLedger(path.join(dir, `${name}.json`));
}

test("a published post is never attempted twice", async () => {
  const store = ledger("published");
  let attempts = 0;

  const attempt = async (): Promise<PublishOutcome> => {
    attempts += 1;
    return { kind: "published", postUrl: "https://x.com/a/status/1" };
  };

  const first = await store.run("key-1", context, attempt);
  const second = await store.run("key-1", context, attempt);

  assert.equal(attempts, 1);
  assert.deepEqual(first, second);
});

test("an unconfirmed attempt is terminal, because a retry could double-post", async () => {
  const store = ledger("unconfirmed");
  let attempts = 0;

  const outcome = await store.run("key-2", context, async () => {
    attempts += 1;
    return unconfirmedOutcome("submitted, no confirmation");
  });

  assert.equal(outcome.kind, "rejected");
  await store.run("key-2", context, async () => {
    attempts += 1;
    return { kind: "published" } as PublishOutcome;
  });

  assert.equal(attempts, 1);
});

test("a signed-out attempt is retried once the operator signs in", async () => {
  const store = ledger("unauthenticated");
  let attempts = 0;

  const first = await store.run("key-3", context, async () => {
    attempts += 1;
    return { kind: "unauthenticated", detail: "no session" } as PublishOutcome;
  });
  assert.equal(first.kind, "unauthenticated");

  const second = await store.run("key-3", context, async () => {
    attempts += 1;
    return { kind: "published", postId: "7" } as PublishOutcome;
  });

  assert.equal(attempts, 2);
  assert.equal(second.kind, "published");
});

test("a plain rejection can be retried after the draft is fixed", async () => {
  const store = ledger("rejected");
  assert.equal(isTerminal({ kind: "rejected", detail: "too long" }), false);
  assert.equal(isTerminal({ kind: "rejected", detail: "unconfirmed", status: 409 }), true);
  assert.equal(store.get("nothing"), null);
});

test("concurrent retries of one key share a single attempt", async () => {
  const store = ledger("concurrent");
  let attempts = 0;

  const attempt = async (): Promise<PublishOutcome> => {
    attempts += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { kind: "published", postId: "9" };
  };

  const results = await Promise.all([
    store.run("key-4", context, attempt),
    store.run("key-4", context, attempt),
    store.run("key-4", context, attempt),
  ]);

  assert.equal(attempts, 1);
  for (const result of results) assert.equal(result.kind, "published");
});

test("the ledger survives a restart", async () => {
  const file = path.join(dir, "restart.json");
  const first = new IdempotencyLedger(file);
  await first.run("key-5", context, async () => ({ kind: "published", postId: "11" }));

  const reopened = new IdempotencyLedger(file);
  let attempts = 0;
  const outcome = await reopened.run("key-5", context, async () => {
    attempts += 1;
    return { kind: "published", postId: "22" } as PublishOutcome;
  });

  assert.equal(attempts, 0);
  assert.equal(outcome.kind === "published" && outcome.postId, "11");
});
