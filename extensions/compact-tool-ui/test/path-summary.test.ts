import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import { MIDDLE_ELLIPSIS, truncateMiddle, truncatePathMiddle } from "../core-utils.js";
import { MAX_INLINE_PATH_CHARS, summarizePath } from "../format/path-summary.js";

test("truncateMiddle keeps both ends and inserts one ellipsis", () => {
	assert.equal(truncateMiddle("short", 10), "short");
	assert.equal(truncateMiddle("abcdefghijklmnopqrstuvwxyz", 10), `abcde${MIDDLE_ELLIPSIS}wxyz`);
});

test("truncatePathMiddle leaves short paths untouched", () => {
	assert.equal(truncatePathMiddle("src/index.ts", 64), "src/index.ts");
});

test("truncatePathMiddle snaps the cut to separators and keeps the file name", () => {
	const path = "packages/app/src/components/very/deep/nested/ComponentName.tsx";
	const result = truncatePathMiddle(path, 40);
	assert.equal(result, `packages/app/src${MIDDLE_ELLIPSIS}/ComponentName.tsx`);
	assert.ok(result.length <= 40);
	assert.ok(result.endsWith("/ComponentName.tsx"));
});

test("truncatePathMiddle treats Windows separators as boundaries", () => {
	const path = "C:\\Users\\admin\\projects\\deep\\nested\\file.tsx";
	const result = truncatePathMiddle(path, 32);
	assert.ok(result.length <= 32);
	assert.ok(result.endsWith("\\file.tsx"));
	assert.ok(result.includes(MIDDLE_ELLIPSIS));
});

test("truncatePathMiddle falls back to a balanced cut without separators", () => {
	const result = truncatePathMiddle("no-separators-but-really-long-identifier-name.tsx", 24);
	assert.ok(result.length <= 24);
	assert.ok(result.includes(MIDDLE_ELLIPSIS));
});

test("summarizePath shortens the home directory and middle-truncates long paths", () => {
	const home = os.homedir();
	assert.equal(summarizePath(`${home}/project/src/index.ts`), "~/project/src/index.ts");

	const long = `${home}/project/${"nested/".repeat(20)}ComponentName.tsx`;
	const result = summarizePath(long);
	assert.ok(result.length <= MAX_INLINE_PATH_CHARS);
	assert.ok(result.startsWith(`~${MIDDLE_ELLIPSIS}`) || result.includes(MIDDLE_ELLIPSIS));
	assert.ok(result.endsWith("ComponentName.tsx"));
});

test("summarizePath keeps the placeholder for missing paths", () => {
	assert.equal(summarizePath(undefined), "...");
	assert.equal(summarizePath(""), "...");
});
