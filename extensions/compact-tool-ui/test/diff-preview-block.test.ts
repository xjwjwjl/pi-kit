import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { DiffPreviewBlock } from "../components/diff-preview-block.js";

const theme = {
	fg(_token: string, text: string) {
		return text;
	},
	bold(text: string) {
		return text;
	},
} as any;

test("DiffPreviewBlock keeps long logical diff lines on one screen row", () => {
	const diff = [
		'-82 assert.equal(summarizeSuccessfulBashOutput("src/a.ts:1:hit\\nsrc/a.ts-2-context", "rg -n -C 2 hit src"), "3 search lines");',
		'+86 assert.equal(summarizeSuccessfulBashOutput("42\\n", "find . || wc -l"), "1 output line");',
	].join("\n");
	const lines = new DiffPreviewBlock(diff, theme).render(80);

	assert.equal(lines.length, 4, "one blank line, two logical diff lines, and the closing guide");
	for (const line of lines) {
		assert.ok(visibleWidth(line) <= 80);
		assert.ok(visibleWidth(line) <= 76, "leaves a right-edge guard to prevent terminal auto-wrap");
	}
	assert.match(lines[1] ?? "", /^  │ -82 /);
	assert.match(lines[1] ?? "", /…/);
	assert.match(lines[1] ?? "", /"3 search lines"\);$/);
	assert.match(lines[2] ?? "", /^  │ \+86 /);
	assert.match(lines[2] ?? "", /…/);
	assert.match(lines[2] ?? "", /"1 output line"\);$/);
});

test("DiffPreviewBlock normalizes tabs before measuring and rendering", () => {
	const diff = '+35 \tif (normalized.startsWith("~/") || (process.platform === "win32" && normalized.startsWith("~\\\\"))) {';
	const line = new DiffPreviewBlock(diff, theme).render(80)[1] ?? "";

	assert.doesNotMatch(line, /\t/);
	assert.match(line, /^  │ \+35    if /);
	assert.match(line, /…/);
	assert.ok(visibleWidth(line) <= 76);
});
