import assert from "node:assert/strict";
import test from "node:test";
import tokenMonitorExtension from "../index.ts";

test("extension registers the token-monitor command", () => {
	const commands = new Map<string, unknown>();
	tokenMonitorExtension({
		registerCommand(name: string, command: unknown) {
			commands.set(name, command);
		},
	} as never);
	assert.ok(commands.has("token-monitor"));
});
