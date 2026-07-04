import assert from "node:assert/strict";
import test from "node:test";
import {
	hasMeaningfulOutput,
	previewTail,
	splitBashStatus,
	summarizeBashStream,
	summarizeFailedBashOutput,
	summarizeSuccessfulBashOutput,
	tail,
} from "../renderers/bash-helpers.js";

test("splitBashStatus extracts exit codes and strips ansi", () => {
	assert.deepEqual(splitBashStatus("\u001b[31mboom\u001b[0m\nCommand exited with code 2\n", true), {
		status: "exit 2",
		output: "boom",
	});
});

test("splitBashStatus extracts timeout and abort statuses", () => {
	assert.deepEqual(splitBashStatus("still running\nCommand timed out after 1.5 seconds", true), {
		status: "timeout 1.5s",
		output: "still running",
	});
	assert.deepEqual(splitBashStatus("partial output\nCommand aborted", true), {
		status: "aborted",
		output: "partial output",
	});
});

test("splitBashStatus normalizes no-output success and generic errors", () => {
	assert.deepEqual(splitBashStatus("(no output)", false), { status: "ok", output: "" });
	assert.deepEqual(splitBashStatus("failure details", true), { status: "failed", output: "failure details" });
});

test("splitBashStatus degrades gracefully when the footer wording changes", () => {
	assert.deepEqual(splitBashStatus("failure details\nExited with code 7", true), {
		status: "exit 7",
		output: "failure details\nExited with code 7",
	});
});

test("summarizeFailedBashOutput classifies common failure types", () => {
	assert.equal(
		summarizeFailedBashOutput("exit 1", "FAIL src/app.test.ts\nTests: 1 failed, 3 passed\n", "pnpm test"),
		"test failed · exit 1",
	);
	assert.equal(
		summarizeFailedBashOutput("exit 2", "src/app.ts:42:13 - error TS2322: Type 'string' is not assignable to type 'number'.\n", "pnpm tsc --noEmit"),
		"tsc errors · exit 2",
	);
	assert.equal(summarizeFailedBashOutput("exit 127", "bash: foo: command not found\n", "foo"), "command not found · exit 127");
	assert.equal(summarizeFailedBashOutput("exit 1", "EACCES: permission denied, open '/tmp/out'\n", "node build.js"), "permission denied · exit 1");
	assert.equal(summarizeFailedBashOutput("timeout 1.5s", "still running", "sleep 10"), "timeout 1.5s");
});

test("hasMeaningfulOutput ignores blank output", () => {
	assert.equal(hasMeaningfulOutput(""), false);
	assert.equal(hasMeaningfulOutput("\n  \n"), false);
	assert.equal(hasMeaningfulOutput("ok\n"), true);
});

test("summarizeSuccessfulBashOutput reports output line counts", () => {
	assert.equal(summarizeSuccessfulBashOutput(""), undefined);
	assert.equal(summarizeSuccessfulBashOutput("ok\n"), "1 output line");
	assert.equal(summarizeSuccessfulBashOutput("a\nb\n"), "2 output lines");
});

test("summarizeSuccessfulBashOutput uses semantic summaries for search commands", () => {
	assert.equal(summarizeSuccessfulBashOutput("src/a.ts:1:alpha\nsrc/a.ts:2:beta\nsrc/b.ts:8:gamma\n", "rg -n alpha src"), "3 matches · 2 files");
	assert.equal(summarizeSuccessfulBashOutput("12:alpha\n18:beta\n", "rg -n alpha src/a.ts"), "2 matches");
	assert.equal(summarizeSuccessfulBashOutput("src/a.ts\nsrc/b.ts\n", "rg -l alpha src"), "2 files");
});

test("summarizeSuccessfulBashOutput uses semantic summaries for path and list commands", () => {
	assert.equal(summarizeSuccessfulBashOutput("src/a.ts\nsrc/b.ts\n", "find src -name '*.ts'"), "2 paths");
	assert.equal(summarizeSuccessfulBashOutput("total 16\ndrwxr-xr-x  .\n-rw-r--r--  a.ts\n", "ls -la"), "2 entries");
	assert.equal(summarizeSuccessfulBashOutput("src/a.ts\nsrc/b.ts\n", "rg --files src"), "2 paths");
});

test("summarizeSuccessfulBashOutput handles conservative rg/find/ls cases", () => {
	assert.equal(summarizeSuccessfulBashOutput("src/a.ts:1:hit\nsrc/a.ts-2-context\n--\nsrc/b.ts:3:hit\n", "rg -n -C 2 hit src"), "3 search lines");
	assert.equal(summarizeSuccessfulBashOutput(" 42\n", "find . -type f | wc -l"), "42 files");
	assert.equal(summarizeSuccessfulBashOutput("a\nb\nsrc/a.ts:1:hit\n", "ls src && rg -n hit src"), "3 output lines");
});

test("summarizeSuccessfulBashOutput reports empty semantic output", () => {
	assert.equal(summarizeSuccessfulBashOutput("", "rg missing src"), "no matches");
	assert.equal(summarizeSuccessfulBashOutput("\n  \n", "grep -R missing src"), "no matches");
	assert.equal(summarizeSuccessfulBashOutput("", "find src -name '*.missing'"), "no paths");
	assert.equal(summarizeSuccessfulBashOutput("", "rg --files missing-dir"), "no paths");
	assert.equal(summarizeSuccessfulBashOutput("", "ls empty-dir"), "empty");
});

test("tail keeps only the requested trailing lines", () => {
	assert.equal(tail("a\nb\nc\n", 2), "b\nc");
});

test("previewTail keeps only the requested trailing lines when output is meaningful", () => {
	assert.equal(previewTail("a\nb\nc\n", 2), "b\nc");
	assert.equal(previewTail("\n  \n", 2), "");
});

test("summarizeBashStream reports running output line counts", () => {
	assert.equal(summarizeBashStream(""), "running");
	assert.equal(summarizeBashStream("\n  \n"), "running");
	assert.equal(summarizeBashStream("a\nb\n"), "2 lines so far");
});
