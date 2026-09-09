import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  MAX_STORED,
  POOL_TTL_MS,
  describeRestored,
  clearPool,
  poolKey,
  readPool,
  writePool,
  type StorageLike,
} from "./composer-pool.ts";
import type { Candidate, SuggestionLike } from "./candidates.ts";

function memory(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  const store: StorageLike & { map: Map<string, string> } = {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
  return store;
}

/** Storage that refuses everything, as it does when quota is full or disabled. */
function hostile(): StorageLike {
  return {
    getItem() {
      throw new Error("SecurityError: storage is disabled");
    },
    setItem() {
      throw new Error("QuotaExceededError");
    },
    removeItem() {
      throw new Error("SecurityError: storage is disabled");
    },
  };
}

let seq = 0;
function candidate(
  over: Partial<Candidate<SuggestionLike>> = {},
): Candidate<SuggestionLike> {
  seq += 1;
  return {
    id: `sug-${seq}`,
    ordinal: seq,
    generationId: "gen-1",
    text: `option ${seq}`,
    rationale: "because",
    characterCount: 10,
    ...over,
  };
}

const NOW = 1_760_000_000_000;
const CTX = { workspaceId: "ws-1", platform: "x" };

describe("options come back after a reload", () => {
  test("what was written is what is read", () => {
    const storage = memory();
    const pool = [candidate(), candidate()];

    writePool({ storage, ...CTX, candidates: pool, nextOrdinal: 9, now: NOW });
    const outcome = readPool({ storage, ...CTX, now: NOW + 1_000 });

    assert.equal(outcome.restored, true);
    if (!outcome.restored) return;
    assert.deepEqual(
      outcome.candidates.map((c) => c.text),
      pool.map((c) => c.text),
    );
    assert.equal(outcome.nextOrdinal, 9, "numbering must not restart");
  });

  test("ordinals and generation survive the round trip", () => {
    // Both matter downstream: the ordinal is the visible "Option N", and the
    // generation is what lets drafts kept from restored cards still group as
    // variants of one idea. Dropping either would look like working software.
    const storage = memory();
    const pool = [
      candidate({ ordinal: 4, generationId: "gen-7" }),
      candidate({ ordinal: 5, generationId: "gen-7" }),
    ];

    writePool({ storage, ...CTX, candidates: pool, nextOrdinal: 6, now: NOW });
    const outcome = readPool({ storage, ...CTX, now: NOW });

    assert.equal(outcome.restored, true);
    if (!outcome.restored) return;
    assert.deepEqual(
      outcome.candidates.map((c) => [c.ordinal, c.generationId]),
      [
        [4, "gen-7"],
        [5, "gen-7"],
      ],
    );
  });

  test("nothing stored reads as empty, not as an error", () => {
    const outcome = readPool({ storage: memory(), ...CTX, now: NOW });
    assert.equal(outcome.restored, false);
    if (outcome.restored) return;
    assert.equal(outcome.reason, "empty");
  });
});

describe("a sign-off is never restored", () => {
  test("the stored shape has no field that could carry one", () => {
    // The load-bearing test. `saveAsDraft` refuses until the operator ticks
    // "I have read this"; restoring that tick would let a card reach the
    // review queue on a sign-off given in a session that ended in a crash.
    // The only defence that cannot rot is there being nowhere to put it.
    const storage = memory();
    writePool({
      storage,
      ...CTX,
      candidates: [candidate()],
      nextOrdinal: 2,
      now: NOW,
    });

    const raw = storage.map.get(poolKey(CTX.workspaceId, CTX.platform)) ?? "";
    assert.doesNotMatch(raw, /reviewed/i);
    assert.doesNotMatch(raw, /approved/i);

    const stored = JSON.parse(raw);
    for (const entry of stored.candidates) {
      assert.deepEqual(
        Object.keys(entry).sort(),
        [
          "characterCount",
          "generationId",
          "id",
          "ordinal",
          "rationale",
          "text",
        ],
        "a new field here must be a deliberate decision, not a spread",
      );
    }
  });

  test("the operator is told the ticks are gone", () => {
    assert.match(describeRestored(1), /review tick is not restored/);
    assert.match(describeRestored(3), /review ticks are not restored/);
    assert.match(describeRestored(3), /^3 options/);
  });
});

describe("storage is treated as untrusted", () => {
  test("unparseable junk is dropped, and the key with it", () => {
    const key = poolKey(CTX.workspaceId, CTX.platform);
    const storage = memory({ [key]: "{not json" });

    const outcome = readPool({ storage, ...CTX, now: NOW });

    assert.equal(outcome.restored, false);
    if (outcome.restored) return;
    assert.equal(outcome.reason, "unreadable");
    assert.equal(
      storage.map.has(key),
      false,
      "a bad value must not be re-examined on every mount",
    );
  });

  test("an older stored version is dropped rather than migrated", () => {
    const key = poolKey(CTX.workspaceId, CTX.platform);
    const storage = memory({
      [key]: JSON.stringify({
        version: 0,
        ...CTX,
        savedAt: NOW,
        nextOrdinal: 2,
        candidates: [],
      }),
    });

    const outcome = readPool({ storage, ...CTX, now: NOW });
    assert.equal(outcome.restored, false);
    if (outcome.restored) return;
    assert.equal(outcome.reason, "wrong-shape");
  });

  test("a value that disagrees with its own key is not trusted", () => {
    // Written by something else, or by an older keying scheme. Half-right is
    // not right: options written for Instagram are not options for X.
    const key = poolKey(CTX.workspaceId, CTX.platform);
    const storage = memory({
      [key]: JSON.stringify({
        version: 1,
        workspaceId: "ws-1",
        platform: "instagram",
        savedAt: NOW,
        nextOrdinal: 2,
        candidates: [{ ...candidate() }],
      }),
    });

    const outcome = readPool({ storage, ...CTX, now: NOW });
    assert.equal(outcome.restored, false);
    if (outcome.restored) return;
    assert.equal(outcome.reason, "other-context");
  });

  test("candidates missing their text are discarded", () => {
    const key = poolKey(CTX.workspaceId, CTX.platform);
    const storage = memory({
      [key]: JSON.stringify({
        version: 1,
        ...CTX,
        savedAt: NOW,
        nextOrdinal: 3,
        candidates: [candidate(), { id: "sug-x", ordinal: 2 }],
      }),
    });

    const outcome = readPool({ storage, ...CTX, now: NOW });
    assert.equal(outcome.restored, true);
    if (!outcome.restored) return;
    assert.equal(outcome.candidates.length, 1);
  });

  test("a pool older than the window is not handed back", () => {
    // Yesterday's completions presented as current are worse than none: they
    // were written against a brief the operator no longer has in mind.
    const storage = memory();
    writePool({
      storage,
      ...CTX,
      candidates: [candidate()],
      nextOrdinal: 2,
      now: NOW,
    });

    const outcome = readPool({ storage, ...CTX, now: NOW + POOL_TTL_MS });
    assert.equal(outcome.restored, false);
    if (outcome.restored) return;
    assert.equal(outcome.reason, "stale");
  });

  test("just inside the window is still restored", () => {
    const storage = memory();
    writePool({
      storage,
      ...CTX,
      candidates: [candidate()],
      nextOrdinal: 2,
      now: NOW,
    });

    const outcome = readPool({ storage, ...CTX, now: NOW + POOL_TTL_MS - 1 });
    assert.equal(outcome.restored, true);
  });
});

describe("the composer keeps working when storage does not", () => {
  test("a write that throws is reported, not raised", () => {
    const wrote = writePool({
      storage: hostile(),
      ...CTX,
      candidates: [candidate()],
      nextOrdinal: 2,
      now: NOW,
    });
    assert.equal(wrote, false);
  });

  test("a read that throws is unreadable, not a crash", () => {
    const outcome = readPool({ storage: hostile(), ...CTX, now: NOW });
    assert.equal(outcome.restored, false);
    if (outcome.restored) return;
    assert.equal(outcome.reason, "unreadable");
  });

  test("clearing against dead storage is reported, not raised", () => {
    assert.equal(clearPool(hostile(), CTX.workspaceId, CTX.platform), false);
  });
});

describe("the pool is bounded", () => {
  test("an emptied pool clears the key instead of storing nothing", () => {
    // This is "delete on interaction" at the end of the loop: judge the last
    // card and there is nothing left to come back to.
    const storage = memory();
    writePool({
      storage,
      ...CTX,
      candidates: [candidate()],
      nextOrdinal: 2,
      now: NOW,
    });
    writePool({ storage, ...CTX, candidates: [], nextOrdinal: 2, now: NOW });

    assert.equal(storage.map.has(poolKey(CTX.workspaceId, CTX.platform)), false);
  });

  test("judging a card removes it from storage on the next write", () => {
    const storage = memory();
    const a = candidate();
    const b = candidate();

    writePool({ storage, ...CTX, candidates: [a, b], nextOrdinal: 3, now: NOW });
    writePool({ storage, ...CTX, candidates: [b], nextOrdinal: 3, now: NOW });

    const outcome = readPool({ storage, ...CTX, now: NOW });
    assert.equal(outcome.restored, true);
    if (!outcome.restored) return;
    assert.deepEqual(
      outcome.candidates.map((c) => c.id),
      [b.id],
    );
  });

  test("a long session cannot grow without bound, and keeps the newest", () => {
    const storage = memory();
    const many = Array.from({ length: MAX_STORED + 5 }, () => candidate());

    writePool({
      storage,
      ...CTX,
      candidates: many,
      nextOrdinal: many.length + 1,
      now: NOW,
    });
    const outcome = readPool({ storage, ...CTX, now: NOW });

    assert.equal(outcome.restored, true);
    if (!outcome.restored) return;
    assert.equal(outcome.candidates.length, MAX_STORED);
    assert.equal(
      outcome.candidates.at(-1)?.id,
      many.at(-1)?.id,
      "the newest options are the ones being worked on",
    );
  });

  test("each workspace and platform keeps its own pool", () => {
    const storage = memory();
    writePool({
      storage,
      workspaceId: "ws-1",
      platform: "x",
      candidates: [candidate({ text: "for x" })],
      nextOrdinal: 2,
      now: NOW,
    });
    writePool({
      storage,
      workspaceId: "ws-1",
      platform: "instagram",
      candidates: [candidate({ text: "for instagram" })],
      nextOrdinal: 2,
      now: NOW,
    });

    const x = readPool({
      storage,
      workspaceId: "ws-1",
      platform: "x",
      now: NOW,
    });
    assert.equal(x.restored, true);
    if (!x.restored) return;
    assert.equal(x.candidates[0].text, "for x");
  });
});
