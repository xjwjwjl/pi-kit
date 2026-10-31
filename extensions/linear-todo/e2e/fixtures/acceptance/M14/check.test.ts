import assert from "node:assert/strict";
import test from "node:test";
import { assertCacheEntry } from "../src/index.ts";

test("assertCacheEntry accepts a well-formed entry", () => {
  assert.doesNotThrow(() => assertCacheEntry({ value: 1, expiresAt: 5 }));
});

test("assertCacheEntry rejects a malformed entry", () => {
  assert.throws(() => assertCacheEntry({ value: 1, expiresAt: "5" } as never), /CacheEntry/);
});
