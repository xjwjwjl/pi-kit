import assert from "node:assert/strict";
import test from "node:test";
import { parseTtlMs } from "../src/index.ts";

test("parseTtlMs accepts valid values", () => {
  assert.equal(parseTtlMs("2500"), 2500);
  assert.equal(parseTtlMs("60000"), 60000);
});

test("parseTtlMs rejects values above the cap", () => {
  assert.throws(() => parseTtlMs("60001"), /CACHE_TTL_MS/);
});

test("parseTtlMs rejects negative values", () => {
  assert.throws(() => parseTtlMs("-1"), /CACHE_TTL_MS/);
});
