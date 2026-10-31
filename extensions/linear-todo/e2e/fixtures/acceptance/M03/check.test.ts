import assert from "node:assert/strict";
import test from "node:test";
import { readCacheTtlMs } from "../src/index.ts";

test("readCacheTtlMs returns the configured value", () => {
  assert.equal(readCacheTtlMs({ CACHE_TTL_MS: "2500" }), 2500);
});

test("readCacheTtlMs falls back to the default", () => {
  assert.equal(readCacheTtlMs({}), 1000);
});

test("readCacheTtlMs rejects invalid values", () => {
  assert.throws(() => readCacheTtlMs({ CACHE_TTL_MS: "abc" }), /CACHE_TTL_MS/);
});
