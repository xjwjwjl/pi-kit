import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import remoteOpsExtension from "../index.ts";

test("registers remote_exec tool and user commands", () => {
	const tools: Array<{ name: string }> = [];
	const commands: string[] = [];
	const handlers: string[] = [];
	const fakePi = {
		on(event: string) {
			handlers.push(event);
		},
		registerTool(tool: { name: string }) {
			tools.push(tool);
		},
		registerCommand(name: string) {
			commands.push(name);
		},
		appendEntry() {},
	} as unknown as ExtensionAPI;

	remoteOpsExtension(fakePi);

	assert.deepEqual(tools.map((tool) => tool.name), ["remote_exec"]);
	assert.deepEqual(commands, ["remote-init", "remote-status", "remote-doctor"]);
	assert.ok(handlers.includes("project_trust"));
	assert.ok(handlers.includes("session_start"));
});
