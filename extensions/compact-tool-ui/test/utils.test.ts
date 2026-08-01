import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import { countLines, shortPath, stripAnsi } from "../core-utils.js";

test("countLines keeps explicit trailing blank lines", () => {
	assert.equal(countLines("a\n\n"), 2);
	assert.equal(countLines("\n\n"), 2);
});

test("countLines does not invent an extra line for a final newline", () => {
	assert.equal(countLines("a\n"), 1);
	assert.equal(countLines("a\r\n\r\n"), 2);
});

test("countLines handles empty and single-line input", () => {
	assert.equal(countLines(""), 0);
	assert.equal(countLines("a"), 1);
});

test("stripAnsi removes OSC, CSI, and unsafe control sequences", () => {
	const input = "safe\x1b]52;c;c2VjcmV0\x07 title\x1b[31m red\x1b[0m\x00\x1bPignored\x1b\\ done";
	assert.equal(stripAnsi(input), "safe title red done");
});

test("shortPath only abbreviates the home directory on a path boundary", () => {
	const home = os.homedir();
	assert.equal(shortPath(`${home}/project`), "~/project");
	assert.equal(shortPath(`${home}2/project`), `${home}2/project`);
	assert.equal(shortPath(`bad\npath\x1b]0;title\x07`), "bad path");
});
