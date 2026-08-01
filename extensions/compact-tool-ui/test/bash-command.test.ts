import assert from "node:assert/strict";
import test from "node:test";
import { commandText } from "../format/bash-command.js";

const theme = {
	fg(token: string, text: string) {
		return text ? `<${token}>${text}</${token}>` : "";
	},
	bold(text: string) {
		return text;
	},
} as any;

test("commandText highlights the command name but not its arguments", () => {
	assert.equal(commandText("git status", theme), "<syntaxFunction>git</syntaxFunction><muted> status</muted>");
});

test("commandText skips leading environment assignments", () => {
	assert.equal(
		commandText("FOO=1 BAR=2 npm test", theme),
		"<muted>FOO=1 BAR=2 </muted><syntaxFunction>npm</syntaxFunction><muted> test</muted>",
	);
});

test("commandText finds commands after shell separators", () => {
	assert.equal(
		commandText("echo hi && pwd", theme),
		"<syntaxFunction>echo</syntaxFunction><muted> hi && </muted><syntaxFunction>pwd</syntaxFunction>",
	);
});

test("commandText ignores heredoc bodies when scanning later commands", () => {
	const output = commandText("cat <<EOF\nhello\nEOF\npwd", theme);
	assert.match(output, /<syntaxFunction>cat<\/syntaxFunction>/);
	assert.match(output, /<syntaxFunction>pwd<\/syntaxFunction>/);
	assert.doesNotMatch(output, /<syntaxFunction>hello<\/syntaxFunction>/);
});
