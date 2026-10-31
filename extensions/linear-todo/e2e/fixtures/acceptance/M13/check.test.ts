import assert from "node:assert/strict";
import test from "node:test";
import { readCacheOr } from "../src/index.ts";

test("readCacheOr returns the cached value before expiry", () => {
  assert.equal(readCacheOr({ value: "v", expiresAt: 150 }, 100, "fallback"), "v");
});

test("readCacheOr returns the fallback after expiry", () => {
  assert.equal(readCacheOr({ value: "v", expiresAt: 150 }, 150, "fallback"), "fallback");
});
