import assert from "node:assert/strict";
import test from "node:test";
import globalSessionsExtension from "../index.ts";

test("extension registers the global sessions command", () => {
	const commands = new Map<string, unknown>();
	globalSessionsExtension({
		registerCommand(name: string, command: unknown) {
			commands.set(name, command);
		},
	} as never);

	assert.ok(commands.has("sessions"));
});
