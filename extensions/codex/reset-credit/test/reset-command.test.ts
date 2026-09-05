import assert from "node:assert/strict";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import test from "node:test";
import { createCodexQuotaCommand } from "../src/reset-command.ts";
import type { CodexCredential, ResetCreditsResult } from "../src/types.ts";

const credential: CodexCredential = {
	access: "access-token",
	accountId: "account-id",
};

function fakeContext(options: {
	hasUI?: boolean;
	mode?: "tui" | "rpc" | "json" | "print";
	confirmed?: boolean;
	select?: (choices: string[]) => string | undefined;
} = {}) {
	const notifications: Array<{ message: string; type: string }> = [];
	const customCalls: Array<{
		factory: (
			tui: unknown,
			theme: unknown,
			keybindings: unknown,
			done: (value: unknown) => void,
		) => unknown;
		done: (value: unknown) => void;
	}> = [];
	const ctx = {
		hasUI: options.hasUI ?? true,
		mode: options.mode ?? "rpc",
		ui: {
			theme: {
				bold: (text: string) => text,
				fg: (_color: string, text: string) => text,
			},
			notify: (message: string, type: string) => notifications.push({ message, type }),
			confirm: async () => options.confirmed ?? true,
			select: async (_title: string, choices: string[]) => options.select?.(choices),
			custom: (factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (value: unknown) => void) => unknown) => {
				return new Promise<unknown>((resolve) => {
					let component: { dispose?: () => void } | undefined;
					try {
						component = factory(
							{ requestRender: () => {} },
							{ fg: (_c: string, t: string) => t, bold: (t: string) => t },
							{},
							(value: unknown) => resolve(value),
						) as { dispose?: () => void } | undefined;
					} catch (error) {
						resolve({ error });
						return;
					}
					if (component && "dispose" in component) {
						// BorderedLoader: its action runs automatically; it resolves itself.
						return;
					}
					// Picker: expose done for test-driven completion.
					customCalls.push({
						factory,
						done: (value) => resolve(value),
					});
				});
			},
		},
	};
	return { ctx: ctx as unknown as ExtensionCommandContext, notifications, customCalls };
}

function availableCredits(): ResetCreditsResult {
	return {
		status: "success",
		credits: {
			availableCount: 2,
			credits: [
				{ id: "credit-1", title: "First", expires_at: null },
				{ id: "credit-2", title: "Second", expires_at: null },
			],
		},
	};
}

function tick(ms = 0): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(fn: () => boolean, timeoutMs = 1000): Promise<void> {
	const start = Date.now();
	while (!fn()) {
		if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
		await tick(5);
	}
}

test("defaults to reset flow (opens picker and consumes when confirmed)", async () => {
	let consumed: unknown;
	let resets = 0;
	const { ctx, notifications, customCalls } = fakeContext({ mode: "tui" });
	const command = createCodexQuotaCommand({
		readCredential: () => credential,
		fetchCredits: async (_credential) => availableCredits(),
		consumeCredit: async (_credential, request) => {
			consumed = request;
			return { status: "success", outcome: "reset" };
		},
		uuid: () => "attempt-uuid",
		onReset: () => { resets++; },
		useLoaderUI: false,
	});

	const run = command("", ctx);
	// withLoader is disabled, so the fetch completes immediately; picker opens.
	await waitFor(() => customCalls.length >= 1);
	// Picker: choose credit-2.
	customCalls[0]!.done({ creditId: "credit-2" });
	await run;

	assert.deepEqual(consumed, { idempotencyKey: "attempt-uuid", creditId: "credit-2" });
	assert.equal(resets, 1);
	assert.match(notifications.at(-1)!.message, /consumed/);
	assert.equal(notifications.at(-1)!.type, "info");
});

test("reset asks for a credit, confirms, consumes it, and notifies the reset event", async () => {
	const { ctx, notifications } = fakeContext({ select: (choices) => choices[1] });
	let consumed: unknown;
	let resets = 0;
	const command = createCodexQuotaCommand({
		readCredential: () => credential,
		fetchCredits: async (_credential) => availableCredits(),
		consumeCredit: async (_credential, request) => {
			consumed = request;
			return { status: "success", outcome: "reset" };
		},
		uuid: () => "attempt-uuid",
		onReset: () => { resets++; },
	});

	await command("", ctx);

	assert.deepEqual(consumed, { idempotencyKey: "attempt-uuid", creditId: "credit-2" });
	assert.equal(resets, 1);
	assert.match(notifications.at(-1)!.message, /consumed/);
	assert.equal(notifications.at(-1)!.type, "info");
});

test("reset does not consume anything without interactive UI", async () => {
	const { ctx, notifications } = fakeContext({ hasUI: false, mode: "print" });
	let consumeCalls = 0;
	const command = createCodexQuotaCommand({
		readCredential: () => credential,
		fetchCredits: async (_credential) => availableCredits(),
		consumeCredit: async (_credential, _request) => {
			consumeCalls++;
			return { status: "success", outcome: "reset" };
		},
	});

	await command("", ctx);

	assert.equal(consumeCalls, 0);
	assert.match(notifications.at(-1)!.message, /interactive confirmation/);
	assert.equal(notifications.at(-1)!.type, "warning");
});



test("reset TUI picker cancellation does not consume", async () => {
	const { ctx, notifications, customCalls } = fakeContext({ mode: "tui" });
	let consumeCalls = 0;
	const command = createCodexQuotaCommand({
		readCredential: () => credential,
		fetchCredits: async (_credential) => availableCredits(),
		consumeCredit: async (_credential, _request) => {
			consumeCalls++;
			return { status: "success", outcome: "reset" };
		},
		useLoaderUI: false,
	});

	const run = command("", ctx);
	await waitFor(() => customCalls.length >= 1);
	// Picker cancellation.
	customCalls[0]!.done({ cancelled: true });
	await run;

	assert.equal(consumeCalls, 0);
	assert.match(notifications.at(-1)!.message, /cancelled/);
});

test("reset cancellation and non-reset outcomes do not notify the reset event", async () => {
	const cancelled = fakeContext({ confirmed: false });
	let resets = 0;
	const cancelCommand = createCodexQuotaCommand({
		readCredential: () => credential,
		fetchCredits: async (_credential) => availableCredits(),
		consumeCredit: async (_credential, _request) => ({ status: "success", outcome: "reset" }),
		onReset: () => { resets++; },
	});
	await cancelCommand("", cancelled.ctx);
	assert.equal(resets, 0);
	assert.match(cancelled.notifications.at(-1)!.message, /cancelled/);

	const noCredit = fakeContext({ select: (choices) => choices[0] });
	const noCreditCommand = createCodexQuotaCommand({
		readCredential: () => credential,
		fetchCredits: async (_credential) => availableCredits(),
		consumeCredit: async (_credential, _request) => ({ status: "success", outcome: "noCredit" }),
		onReset: () => { resets++; },
	});
	await noCreditCommand("", noCredit.ctx);
	assert.equal(resets, 0);
	assert.match(noCredit.notifications.at(-1)!.message, /No Codex reset credit/);
});

