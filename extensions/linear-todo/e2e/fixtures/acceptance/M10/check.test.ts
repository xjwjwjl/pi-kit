import assert from "node:assert/strict";
import test from "node:test";
import { remainingTtlMs } from "../src/index.ts";

test("remainingTtlMs reports the remaining lifetime", () => {
  assert.equal(remainingTtlMs({ value: "v", expiresAt: 150 }, 100), 50);
});

test("remainingTtlMs clamps at zero after expiry", () => {
  assert.equal(remainingTtlMs({ value: "v", expiresAt: 150 }, 200), 0);
});
