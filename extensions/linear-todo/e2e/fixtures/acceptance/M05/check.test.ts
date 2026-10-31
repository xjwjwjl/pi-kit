import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { isExpired } from "../src/index.ts";

test("README documents the cache expiration semantics", async () => {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  assert.match(readme, /expir/i);
});

test("isExpired flips at the exact deadline", () => {
  assert.equal(isExpired({ value: "v", expiresAt: 150 }, 149), false);
  assert.equal(isExpired({ value: "v", expiresAt: 150 }, 150), true);
});
