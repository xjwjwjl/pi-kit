import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { ShellCommandBlock } from "../components/shell-command-block.js";
import { adaptBashCommand, MAX_FORMAT_COMMAND_BYTES, MAX_FORMAT_COMMAND_TOKENS } from "../format/unbash-adapter.js";
import { layoutBashCommand } from "../format/bash-command-layout.js";

const theme = {
	fg(_token: string, text: string) {
		return text;
	},
	bold(text: string) {
		return text;
	},
} as any;

function nodeKinds(command: string): string[] {
	const layout = adaptBashCommand(command);
	assert.ok(layout);
	return layout.statements.map(({ node }) => node.kind);
}

test("adapts top-level statements, logical chains, and pipelines", () => {
	const layout = adaptBashCommand("echo a && pwd || printf x; cat input |& grep foo | sort");
	assert.ok(layout);
	assert.equal(layout.statementCount, 2);
	assert.equal(layout.formatted, true);
	assert.deepEqual(nodeKinds("echo a && pwd || printf x"), ["and-or"]);
	assert.deepEqual(nodeKinds("cat input |& grep foo | sort"), ["pipeline"]);

	const rendered = layoutBashCommand(layout);
	assert.deepEqual(
		rendered.lines.map((line) => ({ indent: line.indent, operator: line.trailingOperator })),
		[
			{ indent: 0, operator: "&&" },
			{ indent: 1, operator: "||" },
			{ indent: 1, operator: ";" },
			{ indent: 0, operator: "|&" },
			{ indent: 1, operator: "|" },
			{ indent: 1, operator: undefined },
		],
	);
});

test("keeps token text and redirection targets intact", () => {
	const layout = adaptBashCommand("FOO=1 npm test >out.txt 2>&1");
	assert.ok(layout);
	const node = layout.statements[0]?.node;
	assert.equal(node?.kind, "simple");
	if (node?.kind !== "simple") return;
	assert.deepEqual(
		node.tokens.map((token) => [token.role, token.text]),
		[
			["assignment", "FOO=1"],
			["command", "npm"],
			["argument", "test"],
			["redirection", ">out.txt"],
			["redirection", "2>&1"],
		],
	);
});

test("treats quoted operators, escaped find terminators, and command substitutions as atomic", () => {
	assert.ok(adaptBashCommand("echo 'a; b | c'"));
	assert.ok(adaptBashCommand("find . -exec echo {} \\;"));
	assert.ok(adaptBashCommand("echo $(pwd)"));
});

test("falls back for unsafe or incomplete shell syntax", () => {
	for (const command of [
		"echo a # comment",
		"echo `pwd`",
		"echo \"`pwd`\"",
		"eval echo hi",
		"echo ${value:-fallback}",
		"if true; then echo yes; fi",
		"echo 'unterminated",
	]) {
		assert.equal(adaptBashCommand(command), undefined, command);
	}
	assert.equal(adaptBashCommand("echo hi", false), undefined);
});

test("renders operators and token-boundary continuations without overflow", () => {
	const command = "echo a && pwd || printf x";
	const model = adaptBashCommand(command);
	assert.ok(model);
	const block = new ShellCommandBlock(layoutBashCommand(model), theme);
	assert.equal(block.render(80).join("\n"), "echo a &&\n  pwd ||\n  printf x");

	const long = adaptBashCommand("find . -maxdepth 1 -type f -name 'expanded-*.ts' -o -name 'line-numbered-code-block.ts' -o -name 'tool-detail-footer.ts' -print");
	assert.ok(long);
	const longBlock = new ShellCommandBlock(layoutBashCommand(long), theme);
	for (const width of [48, 64, 80, 120]) {
		const lines = longBlock.render(width);
		assert.ok(lines.every((line) => visibleWidth(line) <= width), `command overflow at ${width}`);
	}
	assert.match(longBlock.render(48).join("\n"), /\\$/m);

	const url = `https://${"a".repeat(120)}.example.test/path`;
	const urlModel = adaptBashCommand(`echo ${url}`);
	assert.ok(urlModel);
	const urlLines = new ShellCommandBlock(layoutBashCommand(urlModel), theme).render(48);
	assert.ok(urlLines.every((line) => visibleWidth(line) <= 48));
	const urlText = urlLines.join("").replace(/[ \\\n]/g, "");
	assert.ok(urlText.includes(url), "long atom should be wrapped without losing characters");
});

test("falls back before formatting oversized commands", () => {
	assert.equal(adaptBashCommand(`echo ${"x".repeat(MAX_FORMAT_COMMAND_BYTES)}`), undefined);
	const manyTokens = `echo ${Array.from({ length: MAX_FORMAT_COMMAND_TOKENS }, () => "x").join(" ")}`;
	assert.equal(adaptBashCommand(manyTokens), undefined);
});

test("preserves heredoc source as raw physical lines", () => {
	const command = "cat <<'EOF'\nhello | ; # body text\nEOF";
	const layout = adaptBashCommand(command);
	assert.ok(layout);
	assert.equal(layout.formatted, false);
	assert.equal(layout.statements[0]?.node.kind, "raw");
	assert.equal(layout.statements[0]?.node.source, command);
});
