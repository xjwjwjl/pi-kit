import assert from "node:assert/strict";
import test from "node:test";
import { putCache, readCache } from "../src/cache.ts";

test("cache returns a value before expiry", () => {
  const entry = putCache("value", 100, 50);
  assert.equal(readCache(entry, 149), "value");
});

test("cache expires at the deadline", () => {
  const entry = putCache("value", 100, 50);
  assert.equal(readCache(entry, 150), undefined);
});
