import assert from "node:assert/strict";
import test from "node:test";
import { summarizeBashCommand } from "../format/bash-command-summary.js";

test("summarizeBashCommand keeps short single-line commands intact", () => {
	assert.deepEqual(summarizeBashCommand("git status"), { text: "git status", summarized: false });
});

test("summarizeBashCommand truncates long single-line commands", () => {
	const command = `echo ${"x".repeat(160)}`;
	const summary = summarizeBashCommand(command);
	assert.equal(summary.summarized, true);
	assert.match(summary.text, /…$/);
	assert.equal(summary.metadata, undefined);
	assert.ok(summary.text.length <= 64);
});

test("summarizeBashCommand uses semantic labels for rg commands", () => {
	assert.deepEqual(summarizeBashCommand("rg -n \"renderResult\" src -g'*.ts'"), {
		text: "rg /renderResult/ in src",
		summarized: true,
	});
	assert.deepEqual(summarizeBashCommand("rg -F \"foo.bar\" src"), {
		text: "rg foo.bar in src",
		summarized: true,
	});
	assert.deepEqual(summarizeBashCommand("rg --files src -g'*.ts'"), {
		text: "rg --files in src",
		summarized: true,
	});
});

test("summarizeBashCommand truncates long rg patterns before dropping the target path", () => {
	const summary = summarizeBashCommand(
		"rg \"settledTailPreview|settled tail|Bash settled|successfulTailPreview|success tail\" -n . --glob '!node_modules'",
	);
	assert.equal(summary.summarized, true);
	assert.equal(summary.text, "rg /settledTailPreview|settled tail|Bash …/ in .");
	assert.ok(summary.text.length <= 48);
});

test("summarizeBashCommand uses semantic labels for find commands", () => {
	assert.deepEqual(summarizeBashCommand("find . -name '*.ts' | sort"), {
		text: "find *.ts in .",
		summarized: true,
	});
	assert.deepEqual(summarizeBashCommand("find src -type d"), {
		text: "find dirs in src",
		summarized: true,
	});
});

test("summarizeBashCommand uses semantic labels for simple ls commands", () => {
	assert.deepEqual(summarizeBashCommand("ls -la renderers"), {
		text: "ls renderers",
		summarized: true,
	});
	assert.deepEqual(summarizeBashCommand("ls renderers && rg bash renderers"), {
		text: "ls renderers && rg bash renderers",
		summarized: false,
	});
});

test("summarizeBashCommand summarizes direct python heredocs", () => {
	const summary = summarizeBashCommand("python3 - <<'PY'\nprint('hi')\nPY");
	assert.equal(summary.text, "python3 heredoc");
	assert.equal(summary.summarized, true);
	assert.match(summary.metadata ?? "", /^3 lines · /);
});

test("summarizeBashCommand summarizes shell scripts containing python heredocs", () => {
	const summary = summarizeBashCommand("set -e\npython3 - <<'PY'\nprint('hi')\nPY");
	assert.equal(summary.text, "shell script with python heredoc");
	assert.match(summary.metadata ?? "", /^4 lines · /);
});

test("summarizeBashCommand summarizes cat heredocs with target paths", () => {
	const summary = summarizeBashCommand("cat > /tmp/foo.py <<'PY'\nprint('hi')\nPY");
	assert.equal(summary.text, "cat heredoc > /tmp/foo.py");
	assert.match(summary.metadata ?? "", /^3 lines · /);
});

test("summarizeBashCommand summarizes generic multiline shell scripts", () => {
	const summary = summarizeBashCommand("echo a\necho b");
	assert.equal(summary.text, "shell script");
	assert.match(summary.metadata ?? "", /^2 lines · /);
});
