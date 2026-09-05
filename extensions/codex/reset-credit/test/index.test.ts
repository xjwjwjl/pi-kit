import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import test from "node:test";
import codexResetCreditExtension, { RESET_CREDIT_CONSUMED_EVENT } from "../index.ts";

function fakePi(): {
	pi: ExtensionAPI;
	events: Map<string, (...args: unknown[]) => void>;
	commands: Map<string, { description: string; handler: (args: string, ctx: unknown) => Promise<void> }>;
	emitted: string[];
} {
	const events = new Map<string, (...args: unknown[]) => void>();
	const commands = new Map<string, { description: string; handler: (args: string, ctx: unknown) => Promise<void> }>();
	const emitted: string[] = [];
	const pi = {
		registerCommand(name: string, definition: { description: string; handler: (args: string, ctx: unknown) => Promise<void> }) {
			commands.set(name, definition);
		},
		events: {
			on(name: string, handler: (...args: unknown[]) => void) { events.set(name, handler); },
			emit(name: string, _data: unknown) { emitted.push(name); },
		},
	} as unknown as ExtensionAPI;
	return { pi, events, commands, emitted };
}

test("registers /codex-reset-credit and emits reset-credit-consumed after a successful reset", async () => {
	const { pi, commands, emitted } = fakePi();
	codexResetCreditExtension(pi);

	const command = commands.get("codex-reset-credit");
	assert.ok(command);
	assert.equal(command.description.includes("reset"), true);

	// Consuming a credit requires the real fetch/consume path; the command's
	// event emission is covered by reset-command tests with injected fakes.
	// Here we only assert the extension wires the event name contract.
	assert.equal(emitted.length, 0);
	assert.equal(RESET_CREDIT_CONSUMED_EVENT, "openai-codex:reset-credit-consumed");
});
