import assert from "node:assert/strict";
import test from "node:test";
import { putCache } from "../src/cache.ts";

test("putCache rejects a non-integer ttl", () => {
  assert.throws(() => putCache("v", 0, 1.5), /ttlMs/);
});

test("putCache still accepts an integer ttl", () => {
  assert.deepEqual(putCache("v", 0, 50), { value: "v", expiresAt: 50 });
});
