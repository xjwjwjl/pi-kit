import assert from "node:assert/strict";
import test from "node:test";
import { isExpired } from "../src/index.ts";

test("isExpired is available after a restart", () => {
  assert.equal(isExpired({ value: "v", expiresAt: 150 }, 149), false);
  assert.equal(isExpired({ value: "v", expiresAt: 150 }, 150), true);
});
