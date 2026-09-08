import { test } from "node:test";
import assert from "node:assert/strict";
import { dbToGain, gainToDb } from "../src/lib/audio";

test("dB ↔ gain conversions are inverse and floored", () => {
  assert.ok(Math.abs(dbToGain(0) - 1) < 1e-12);
  assert.ok(Math.abs(dbToGain(-6) - 0.501187) < 1e-5);
  assert.ok(Math.abs(gainToDb(dbToGain(-12)) - -12) < 1e-9);
  assert.equal(gainToDb(0), -60);
  assert.equal(gainToDb(-1), -60);
  assert.equal(gainToDb(1e-9), -60);
});
