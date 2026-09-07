import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  describeCommittedSiblings,
  draftsInRows,
  groupSiblings,
} from "./sibling-groups.ts";
import { orderForQueue } from "./queue-order.ts";
import type { Draft, DraftStatus, Platform } from "../types.ts";

let seq = 0;

function draft(
  status: DraftStatus,
  over: Partial<Draft> & { generationId?: string; ordinal?: number } = {},
): Draft {
  seq += 1;
  const stamp = `2026-09-0${Math.min(9, seq)}T10:00:00.000Z`;
  const { generationId, ordinal, ...rest } = over;
  return {
    id: `draft-${seq}`,
    workspaceId: "ws-x",
    platform: "x",
    body: `post ${seq}`,
    media: [],
    status,
    scheduledFor: null,
    approvedBy: null,
    approvedAt: null,
    postUrl: null,
    lastError: null,
    origin: generationId ? { generationId, ordinal: ordinal ?? seq } : null,
    createdAt: stamp,
    updatedAt: stamp,
    ...rest,
  } as Draft;
}

const shape = (rows: ReturnType<typeof groupSiblings>) =>
  rows.map((row) =>
    row.kind === "single"
      ? row.draft.id
      : `[${row.drafts.map((d) => d.id).join(",")}]`,
  );

describe("grouping variants of one generation", () => {
  test("two drafts kept from one generation render as one stack", () => {
    const a = draft("draft", { generationId: "gen-1" });
    const b = draft("draft", { generationId: "gen-1" });

    assert.deepEqual(shape(groupSiblings([a, b])), [`[${a.id},${b.id}]`]);
  });

  test("a hand-written post is never grouped", () => {
    // The Network page composes directly, so those drafts carry no origin at
    // all. They must not fall into some catch-all bucket with each other.
    const typed = draft("draft");
    const alsoTyped = draft("draft");

    assert.deepEqual(shape(groupSiblings([typed, alsoTyped])), [
      typed.id,
      alsoTyped.id,
    ]);
  });

  test("drafts from different generations are not siblings", () => {
    const a = draft("draft", { generationId: "gen-1" });
    const b = draft("draft", { generationId: "gen-2" });

    assert.deepEqual(shape(groupSiblings([a, b])), [a.id, b.id]);
  });

  test("one surviving variant is a card, not a stack of one", () => {
    // The operator deleted the others. A group header saying "1 variant of one
    // idea" is chrome describing nothing.
    const lonely = draft("draft", { generationId: "gen-1" });

    assert.deepEqual(shape(groupSiblings([lonely])), [lonely.id]);
  });

  test("nothing is dropped or duplicated", () => {
    const rows = groupSiblings([
      draft("draft", { generationId: "gen-1" }),
      draft("draft"),
      draft("draft", { generationId: "gen-1" }),
      draft("failed", { generationId: "gen-2" }),
    ]);

    const flat = draftsInRows(rows);
    assert.equal(flat.length, 4);
    assert.equal(new Set(flat.map((d) => d.id)).size, 4);
  });
});

describe("grouping does not fight the queue's order", () => {
  test("a group sits where its first member sat", () => {
    // `orderForQueue` puts failed first. The group must not jump the queue
    // just because it has more members.
    const broke = draft("failed");
    const first = draft("draft", {
      generationId: "gen-1",
      createdAt: "2026-09-02T10:00:00.000Z",
    });
    const second = draft("draft", {
      generationId: "gen-1",
      createdAt: "2026-09-03T10:00:00.000Z",
    });

    const rows = groupSiblings(orderForQueue([second, broke, first]));

    assert.deepEqual(shape(rows), [broke.id, `[${first.id},${second.id}]`]);
  });

  test("a posted variant is not folded in with one still awaiting review", () => {
    // This is the case where grouping would actively mislead: the operator
    // needs to see that one of these already went out, and burying it inside a
    // stack of pending work hides exactly that.
    const pending = draft("draft", { generationId: "gen-1" });
    const gone = draft("published", { generationId: "gen-1" });

    const rows = groupSiblings(orderForQueue([gone, pending]));

    assert.deepEqual(shape(rows), [pending.id, gone.id]);
  });

  test("one generation split across two statuses makes two rows", () => {
    const pendingA = draft("draft", { generationId: "gen-1" });
    const pendingB = draft("draft", { generationId: "gen-1" });
    const goneA = draft("published", { generationId: "gen-1" });
    const goneB = draft("published", { generationId: "gen-1" });

    const rows = groupSiblings(
      orderForQueue([goneA, pendingA, goneB, pendingB]),
    );

    assert.equal(rows.length, 2, "two ranks, two rows");
    assert.ok(
      rows.every((row) => row.kind === "group"),
      "each rank has two members, so each is a stack",
    );
    assert.equal(
      new Set(rows.map((row) => row.key)).size,
      2,
      "the rows must not collide on a key derived from the generation alone",
    );
  });
});

describe("the warning, which is the reason this exists", () => {
  test("silent while at most one variant is cleared to send", () => {
    const approved = draft("approved", {
      generationId: "gen-1",
      approvedAt: "2026-09-05T10:00:00.000Z",
    });
    const waiting = draft("draft", { generationId: "gen-1" });

    // Different ranks, so these do not even group — and neither is a warning.
    assert.equal(describeCommittedSiblings([approved, waiting]), null);
  });

  test("two approved variants on one network says to revoke all but one", () => {
    const a = draft("approved", {
      generationId: "gen-1",
      approvedAt: "2026-09-05T10:00:00.000Z",
    });
    const b = draft("approved", {
      generationId: "gen-1",
      approvedAt: "2026-09-05T11:00:00.000Z",
    });

    const rows = groupSiblings(orderForQueue([a, b]));
    const row = rows[0];

    assert.equal(row.kind, "group");
    if (row.kind !== "group") return;
    assert.equal(row.committed, 2);
    assert.match(row.warning ?? "", /same network/);
    assert.match(row.warning ?? "", /revoke all but one/);
  });

  test("variants cleared on different networks is stated, not scolded", () => {
    // Running one idea across networks is a normal thing to do deliberately,
    // so the wording reports it and does not tell the operator to undo it.
    const x = draft("approved", {
      generationId: "gen-1",
      platform: "x" as Platform,
      approvedAt: "2026-09-05T10:00:00.000Z",
    });
    const ig = draft("approved", {
      generationId: "gen-1",
      platform: "instagram" as Platform,
      approvedAt: "2026-09-05T11:00:00.000Z",
    });

    const warning = describeCommittedSiblings([x, ig]);
    assert.match(warning ?? "", /2 networks/);
    assert.doesNotMatch(warning ?? "", /revoke/);
  });

  test("an already-published pair still warns, because it already happened", () => {
    // Nothing can be undone here, but the record should say the same idea went
    // out twice rather than leaving it to be noticed on the account.
    const a = draft("published", { generationId: "gen-1" });
    const b = draft("published", { generationId: "gen-1" });

    assert.match(describeCommittedSiblings([a, b]) ?? "", /cleared to go out/);
  });

  test("an attested variant counts as gone", () => {
    // The operator said it posted. Treating it as still pending would invite
    // approving the sibling as a replacement for something already public.
    const attested = draft("attested", { generationId: "gen-1" });
    const published = draft("published", { generationId: "gen-1" });

    assert.equal(describeCommittedSiblings([attested, published]) !== null, true);
  });
});
