import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { authorizationHeader } from "../src/auth.ts";

test("authorizationHeader carries an explanatory comment", async () => {
  const source = await readFile(new URL("../src/auth.ts", import.meta.url), "utf8");
  assert.ok(
    source.split("\n").some((line) => line.trim().startsWith("//")),
    "expected an explanatory comment line in src/auth.ts",
  );
});

test("authorizationHeader behavior is unchanged", () => {
  assert.equal(authorizationHeader(" token "), "Bearer token");
  assert.throws(() => authorizationHeader(undefined), /AUTH_TOKEN/);
});
