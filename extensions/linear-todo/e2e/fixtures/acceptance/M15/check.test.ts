import assert from "node:assert/strict";
import test from "node:test";
import { describeCacheEntry } from "../src/index.ts";

test("describeCacheEntry reports an active entry", () => {
  assert.equal(describeCacheEntry({ value: 1, expiresAt: 150 }, 149), "active");
});

test("describeCacheEntry reports an expired entry", () => {
  assert.equal(describeCacheEntry({ value: 1, expiresAt: 150 }, 150), "expired");
});
