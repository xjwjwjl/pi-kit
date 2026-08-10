import assert from "node:assert/strict";
import test from "node:test";
import { parseVerifiedCommand } from "../src/policy/shell-parser.js";

test("parses one static command into verified argv", () => {
	const result = parseVerifiedCommand('journalctl --since "1 hour ago"');
	assert.deepEqual(result, {
		ok: true,
		command: {
			executable: "journalctl",
			executionPath: "journalctl",
			args: ["--since", "1 hour ago"],
		},
	});
});

test("allows quoted shell-looking literals but rejects expansion and glob syntax", () => {
	assert.equal(parseVerifiedCommand('echo "| *.log"').ok, true);
	assert.equal(parseVerifiedCommand('echo "$(id)"').ok, false);
	assert.equal(parseVerifiedCommand("echo *.log").ok, false);
	assert.equal(parseVerifiedCommand('echo "$HOME"').ok, false);
	assert.equal(parseVerifiedCommand("echo $(id)").ok, false);
	assert.equal(parseVerifiedCommand("echo $((1+1))").ok, false);
});

test("rejects every non-simple shell construct", () => {
	for (const command of [
		"a && b",
		"a || b",
		"a | b",
		"a; b",
		"a &",
		"echo hi;",
		"echo hi > out",
		"FOO=bar echo hi",
		"echo hi\nnext",
		"(echo hi)",
	]) {
		assert.equal(parseVerifiedCommand(command).ok, false, command);
	}
	assert.equal(parseVerifiedCommand("bash -c 'echo hi'").ok, true);
});

test("rejects relative and untrusted executable paths", () => {
	assert.equal(parseVerifiedCommand("./systemctl status nginx").ok, false);
	assert.equal(parseVerifiedCommand("/tmp/systemctl status nginx").ok, false);
	assert.equal(parseVerifiedCommand("unknown-tool --version").ok, false);
	assert.equal(parseVerifiedCommand("/usr/bin/systemctl status nginx").ok, true);
});

test("rejects ANSI-C quoting, process substitution, and extended glob", () => {
	assert.equal(parseVerifiedCommand("echo $'hello\\nworld'").ok, false);
	assert.equal(parseVerifiedCommand("echo $'\\t'").ok, false);
	assert.equal(parseVerifiedCommand("cat <(ls)").ok, false);
	assert.equal(parseVerifiedCommand("ls @(a|b)").ok, false);
});

test("handles nested quotes and backslash escapes in literals", () => {
	assert.equal(parseVerifiedCommand("echo \"a'b\"").ok, true);
	assert.equal(parseVerifiedCommand("echo 'a\"b'").ok, true);
	assert.equal(parseVerifiedCommand("echo foo\\\\bar").ok, true);
	assert.equal(parseVerifiedCommand("echo 'text with spaces'").ok, true);
});

test("rejects control characters and empty/missing command names", () => {
	assert.equal(parseVerifiedCommand("").ok, false);
	assert.equal(parseVerifiedCommand("   ").ok, false);
	assert.equal(parseVerifiedCommand("echo \\x01").ok, true);
});

test("rejects tilde and brace expansion in unquoted positions", () => {
	assert.equal(parseVerifiedCommand("echo ~").ok, false);
	assert.equal(parseVerifiedCommand("echo ~/path").ok, false);
	assert.equal(parseVerifiedCommand('echo "~/path"').ok, true);
	assert.equal(parseVerifiedCommand("echo {a,b}").ok, false);
	assert.equal(parseVerifiedCommand('echo "{a,b}"').ok, true);
});
