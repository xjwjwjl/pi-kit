import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import codexUsageExtension from "../index.ts";

function fakePi(): {
	pi: ExtensionAPI;
	commands: Map<string, { description: string; handler: (args: string, ctx: unknown) => Promise<void> }>;
	events: Map<string, (...args: unknown[]) => void>;
} {
	const commands = new Map<string, { description: string; handler: (args: string, ctx: unknown) => Promise<void> }>();
	const events = new Map<string, (...args: unknown[]) => void>();
	const pi = {
		registerCommand(name: string, definition: { description: string; handler: (args: string, ctx: unknown) => Promise<void> }) {
			commands.set(name, definition);
		},
		events: {
			on(name: string, handler: (...args: unknown[]) => void) { events.set(name, handler); },
			emit() {},
		},
		on() {},
	} as unknown as ExtensionAPI;
	return { pi, commands, events };
}

test("one extension registers both usage and reset-credit commands", () => {
	// QuotaController creates its cache directory in the constructor; keep the
	// registration test out of the real agent directory.
	const agentDir = mkdtempSync(join(tmpdir(), "codex-usage-registration-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		const { pi, commands, events } = fakePi();
		codexUsageExtension(pi);

		const usage = commands.get("codex-usage");
		const reset = commands.get("codex-reset-credit");
		assert.ok(usage);
		assert.ok(reset);
		assert.equal(reset.description.includes("reset"), true);

		// The merged extension refreshes the status bar directly; the former
		// cross-package reset-credit-consumed event is no longer needed.
		assert.equal(events.has("openai-codex:reset-credit-consumed"), false);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	}
});
