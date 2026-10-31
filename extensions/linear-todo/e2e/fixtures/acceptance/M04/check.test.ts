import assert from "node:assert/strict";
import test from "node:test";
import { authorizationHeader } from "../src/auth.ts";

test("tokens containing whitespace are rejected", () => {
  assert.throws(() => authorizationHeader("a b"), /AUTH_TOKEN/);
  assert.throws(() => authorizationHeader("a\tb"), /AUTH_TOKEN/);
});

test("surrounding whitespace is still trimmed", () => {
  assert.equal(authorizationHeader(" token "), "Bearer token");
});
