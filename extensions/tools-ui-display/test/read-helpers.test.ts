import assert from "node:assert/strict";
import test from "node:test";
import { readContinuationOffset, stripReadContinuationNotice, summarizeRead } from "../renderers/read-helpers.js";

test("readContinuationOffset extracts the next offset from continuation footers", () => {
	assert.equal(readContinuationOffset("line 1\nline 2\n\n[1 more lines in file. Use offset=3 to continue.]"), 3);
	assert.equal(readContinuationOffset("line 1\n\n[Showing lines 1-20 of 100. Use offset=21 to continue.]"), 21);
	assert.equal(readContinuationOffset("line 1"), undefined);
});

test("stripReadContinuationNotice removes continuation footers without matching exact wording", () => {
	assert.equal(
		stripReadContinuationNotice("line 1\nline 2\n\n[anything here as long as it says offset=3 to continue.]"),
		"line 1\nline 2",
	);
});

test("summarizeRead suppresses line counts for requested ranges", () => {
	const result = {
		content: [{ type: "text", text: "a\nb\nc\n\n[100 more lines in file. Use offset=4 to continue.]" }],
		details: { truncation: { truncated: true, outputLines: 3, totalLines: 103 } },
	};

	assert.equal(summarizeRead(result, { offset: 10, limit: 3 }), undefined);
});

test("summarizeRead keeps truncation metadata when no explicit range was requested", () => {
	const result = {
		content: [{ type: "text", text: "a\nb\nc" }],
		details: { truncation: { truncated: true, outputLines: 50, totalLines: 100 } },
	};

	assert.equal(summarizeRead(result), "truncated");
});

test("summarizeRead reports image results", () => {
	assert.equal(summarizeRead({ content: [{ type: "image", mimeType: "image/png" }] }), "image/png");
	assert.equal(summarizeRead({ content: [{ type: "image" }, { type: "image" }] }), "2 images");
});

test("summarizeRead ignores continuation counts for explicit ranges", () => {
	const result = {
		content: [{ type: "text", text: "a\nb\n\n[something custom. Use offset=8 to continue.]" }],
	};

	assert.equal(summarizeRead(result, { offset: 6, limit: 2 }), undefined);
});

test("summarizeRead suppresses ordinary text line counts", () => {
	assert.equal(summarizeRead({ content: [{ type: "text", text: "a\nb" }] }), undefined);
});

test("summarizeRead reports first-line truncation for explicit ranges", () => {
	const result = {
		content: [{ type: "text", text: "[Line 10 is 60 KB, exceeds 50 KB limit.]" }],
		details: { truncation: { truncated: true, outputLines: 0, totalLines: 1, firstLineExceedsLimit: true } },
	};

	assert.equal(summarizeRead(result, { offset: 10 }), "truncated");
});
