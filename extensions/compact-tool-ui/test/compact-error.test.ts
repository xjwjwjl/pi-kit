import assert from "node:assert/strict";
import test from "node:test";
import { compactFileToolError } from "../renderers/compact-error.js";

test("compactFileToolError normalizes common file errors", () => {
	assert.equal(compactFileToolError("ENOENT: no such file or directory, open 'src/missing.ts'"), "path not found");
	assert.equal(compactFileToolError("Could not find file src/missing.ts"), "path not found");
	assert.equal(compactFileToolError("EACCES: permission denied, open 'src/secret.ts'"), "permission denied");
	assert.equal(compactFileToolError("Content must be a string"), "invalid content");
});

test("compactFileToolError falls back to the first concise line", () => {
	assert.equal(compactFileToolError("\n\x1b[31mUnexpected write failure\x1b[0m\nDetails"), "Unexpected write failure");
});
