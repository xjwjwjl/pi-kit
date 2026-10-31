import assert from "node:assert/strict";
import test from "node:test";
import { authorizationHeader } from "../src/auth.ts";

test("authorizationHeader builds a bearer header", () => {
  assert.equal(authorizationHeader(" token "), "Bearer token");
});

test("authorizationHeader rejects a missing token", () => {
  assert.throws(() => authorizationHeader(undefined), /AUTH_TOKEN/);
});
