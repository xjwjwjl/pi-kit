import { test } from "node:test";
import assert from "node:assert/strict";
import { childExcludeTools, childExcludedTools } from "../src/child-policy.ts";

const ENV = "PI_SUBAGENT_EXCLUDED_TOOLS";
const BASE = ["agent", "agent_send", "agent_result", "ask_user"];

/** Run with a temporary env value and put the previous one back, even on failure. */
function withEnv(value: string | undefined, run: () => void): void {
	const previous = process.env[ENV];
	if (value === undefined) delete process.env[ENV];
	else process.env[ENV] = value;
	try {
		run();
	} finally {
		if (previous === undefined) delete process.env[ENV];
		else process.env[ENV] = previous;
	}
}

test("the default exclusions keep ask_user and the subagent tools", () => {
	withEnv(undefined, () => {
		assert.deepEqual(childExcludedTools(), BASE);
		assert.deepEqual(childExcludeTools(), BASE);
	});
});

test("PI_SUBAGENT_EXCLUDED_TOOLS adds trimmed, deduplicated names", () => {
	withEnv(" ask_renamed , ,ask_renamed, ui_confirm ", () => {
		assert.deepEqual(childExcludedTools(), [...BASE, "ask_renamed", "ui_confirm"]);
	});
});

test("a configured name that is already excluded does not appear twice", () => {
	withEnv("ask_user,agent", () => {
		assert.deepEqual(childExcludedTools(), BASE);
	});
});

test("an empty or blank env var leaves the defaults unchanged", () => {
	withEnv(" , ", () => {
		assert.deepEqual(childExcludedTools(), BASE);
	});
});

test("configured names are appended after a definition's own exclusions", () => {
	withEnv("ui_confirm", () => {
		assert.deepEqual(childExcludeTools(["bash"]), [...BASE, "ui_confirm", "bash"]);
	});
});
