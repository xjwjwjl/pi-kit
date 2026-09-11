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

test("summarizeRead reports truncation for requested ranges", () => {
	const result = {
		content: [{ type: "text", text: "a\nb\nc\n\n[100 more lines in file. Use offset=4 to continue.]" }],
		details: { truncation: { truncated: true, outputLines: 3, totalLines: 103 } },
	};

	assert.equal(summarizeRead(result), "3/103L");
});

test("summarizeRead keeps truncation metadata when no explicit range was requested", () => {
	const result = {
		content: [{ type: "text", text: "a\nb\nc" }],
		details: { truncation: { truncated: true, outputLines: 50, totalLines: 100 } },
	};

	assert.equal(summarizeRead(result), "50/100L");
});

test("summarizeRead falls back to a bare marker when the ratio is unknown", () => {
	assert.equal(
		summarizeRead({ content: [{ type: "text", text: "a" }], details: { truncation: { truncated: true, outputLines: 0, totalLines: 1 } } }),
		"truncated",
	);
	assert.equal(
		summarizeRead({ content: [{ type: "text", text: "a" }], details: { truncation: { truncated: true, outputLines: 20, totalLines: 20 } } }),
		"truncated",
	);
});

test("summarizeRead reports image results", () => {
	assert.equal(summarizeRead({ content: [{ type: "image", mimeType: "image/png" }] }), "image/png");
	assert.equal(summarizeRead({ content: [{ type: "image" }, { type: "image" }] }), "2 images");
});

test("summarizeRead surfaces a user limit that stopped before EOF", () => {
	const result = {
		content: [{ type: "text", text: "a\nb\n\n[4900 more lines in file. Use offset=101 to continue.]" }],
	};

	assert.equal(summarizeRead(result), "4900L more");
});

test("summarizeRead suppresses continuation notices without a remaining count", () => {
	const result = {
		content: [{ type: "text", text: "a\nb\n\n[something custom. Use offset=8 to continue.]" }],
	};

	assert.equal(summarizeRead(result), undefined);
});

test("summarizeRead reports core truncation when a requested limit exceeds the output cap", () => {
	const result = {
		content: [{ type: "text", text: "line 1\nline 2" }],
		details: { truncation: { truncated: true, outputLines: 2000, totalLines: 5000 } },
	};

	assert.equal(summarizeRead(result), "2000/5000L");
});

test("summarizeRead suppresses ordinary text line counts", () => {
	assert.equal(summarizeRead({ content: [{ type: "text", text: "a\nb" }] }), undefined);
});

test("summarizeRead reports first-line truncation for explicit ranges", () => {
	const result = {
		content: [{ type: "text", text: "[Line 10 is 60 KB, exceeds 50 KB limit.]" }],
		details: { truncation: { truncated: true, outputLines: 0, totalLines: 1, firstLineExceedsLimit: true } },
	};

	assert.equal(summarizeRead(result), "truncated");
});
