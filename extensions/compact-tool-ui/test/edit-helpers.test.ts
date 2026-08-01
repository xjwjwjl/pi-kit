import assert from "node:assert/strict";
import test from "node:test";
import { compactEditError, editDiffStatText, editSummaryText, shouldInlineEditDiff, summarizeEditDiff } from "../renderers/edit-helpers.js";

test("summarizeEditDiff reports additions, removals, and line count", () => {
	const diff = " 1 context\n-2 old\n+2 new\n+3 added";
	assert.deepEqual(summarizeEditDiff(diff), { added: 2, removed: 1, lines: 4 });
	assert.equal(editDiffStatText(summarizeEditDiff(diff)), "+2 -1");
});

test("editSummaryText reports diff stat", () => {
	assert.equal(editSummaryText("-1 old\n+1 new"), "+1 -1");
});

test("shouldInlineEditDiff only allows small diffs", () => {
	assert.equal(shouldInlineEditDiff("-1 old\n+1 new"), true);
	assert.equal(shouldInlineEditDiff(Array.from({ length: 65 }, (_, i) => ` ${i} line`).join("\n")), false);
	assert.equal(shouldInlineEditDiff(Array.from({ length: 65 }, (_, i) => ` ${i} line`).join("\n"), 0), true);
});

test("compactEditError shortens common edit errors", () => {
	assert.equal(
		compactEditError("Could not find edits[2] in src/app.ts. The oldText must match exactly including all whitespace and newlines."),
		"edits[2] oldText not found",
	);
	assert.equal(compactEditError("Found 3 occurrences of the text in src/app.ts. The text must be unique."), "oldText not unique");
	assert.equal(compactEditError("edits[0] and edits[1] overlap in src/app.ts. Merge them into one edit."), "edits[0] and edits[1] overlap");
	assert.equal(compactEditError("No changes made to src/app.ts."), "no changes made");
});

