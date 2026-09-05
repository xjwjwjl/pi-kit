import assert from "node:assert/strict";
import test from "node:test";
import piTaskRouterExtension, { ROUTER_STATE_ENTRY } from "../index.ts";
import { STRICT_FLASH_FIRST_TURN_SYSTEM_PROMPT } from "../src/router-core.ts";

type Handler = (event: any, ctx: any) => unknown | Promise<unknown>;
type Command = { handler: (args: string, ctx: any) => Promise<void> };

function createHarness(
	initialEntries: unknown[] = [],
	model = { provider: "deepseek", id: "deepseek-v4-pro" },
	initialTools = ["read", "bash", "edit", "write"],
) {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, Command>();
	const entries = [...initialEntries];
	const notifications: Array<{ message: string; kind: string }> = [];
	const statuses = new Map<string, string | undefined>();
	let activeTools = [...initialTools];

	const pi = {
		on(name: string, handler: Handler) {
			const registered = handlers.get(name) ?? [];
			registered.push(handler);
			handlers.set(name, registered);
		},
		registerCommand(name: string, command: Command) {
			commands.set(name, command);
		},
		appendEntry(customType: string, data: unknown) {
			entries.push({ type: "custom", customType, data });
		},
		getActiveTools() {
			return [...activeTools];
		},
		setActiveTools(nextTools: string[]) {
			activeTools = [...nextTools];
		},
	};

	const ctx = {
		model,
		sessionManager: {
			getBranch: () => entries,
		},
		ui: {
			theme: {
				fg: (_color: string, text: string) => text,
			},
			setStatus: (key: string, value: string | undefined) => statuses.set(key, value),
			notify: (message: string, kind = "info") => notifications.push({ message, kind }),
		},
	};

	piTaskRouterExtension(pi as never);

	return {
		ctx,
		entries,
		notifications,
		statuses,
		getActiveTools() {
			return [...activeTools];
		},
		setModel(nextModel: { provider: string; id: string }) {
			ctx.model = nextModel;
		},
		async emit(name: string, event: Record<string, unknown> = {}) {
			const results: unknown[] = [];
			for (const handler of handlers.get(name) ?? []) {
				results.push(await handler(event, ctx));
			}
			return results;
		},
		async command(name: string, args = "") {
			const command = commands.get(name);
			assert.ok(command, `missing command ${name}`);
			await command.handler(args, ctx);
		},
	};
}

function prompt(text: string) {
	return { prompt: text, systemPrompt: "BASE SYSTEM" };
}

function textFromResult(result: unknown): string | undefined {
	if (!result || typeof result !== "object" || !("systemPrompt" in result)) return undefined;
	const value = (result as { systemPrompt?: unknown }).systemPrompt;
	return typeof value === "string" ? value : undefined;
}

test("locks the first Pro automatic route for the active branch", async () => {
	const harness = createHarness();
	await harness.emit("session_start");

	const first = await harness.emit("before_agent_start", prompt("修复登录报错并排查原因"));
	assert.match(textFromResult(first[0])!, /Task route: inspect/);
	assert.equal(harness.entries.length, 1);
	assert.deepEqual(harness.entries[0], {
		type: "custom",
		customType: ROUTER_STATE_ENTRY,
		data: { version: 2, autoMode: "inspect" },
	});
	assert.deepEqual(harness.getActiveTools(), ["read", "bash", "edit", "write"]);

	const later = await harness.emit("before_agent_start", prompt("创建一个新的管理后台"));
	assert.match(textFromResult(later[0])!, /Task route: inspect/);
	assert.equal(harness.entries.length, 1, "a later prompt must not recalculate the session route");
	assert.equal(harness.statuses.get("pi-task-router"), "router: inspect (auto)");
});

test("manual override persists, then auto restores the first automatic route", async () => {
	const harness = createHarness();
	await harness.emit("before_agent_start", prompt("修复缓存错误"));
	await harness.command("router", "act");

	const forced = await harness.emit("before_agent_start", prompt("继续修复缓存错误"));
	assert.match(textFromResult(forced[0])!, /Task route: act/);
	assert.deepEqual(harness.entries.at(-1), {
		type: "custom",
		customType: ROUTER_STATE_ENTRY,
		data: { version: 2, autoMode: "inspect", overrideMode: "act" },
	});

	await harness.command("router", "auto");
	const restored = await harness.emit("before_agent_start", prompt("创建一个新工具"));
	assert.match(textFromResult(restored[0])!, /Task route: inspect/);
	assert.deepEqual(harness.entries.at(-1), {
		type: "custom",
		customType: ROUTER_STATE_ENTRY,
		data: { version: 2, autoMode: "inspect" },
	});
});

test("does not inject or auto-persist for non-DeepSeek models", async () => {
	const harness = createHarness([], { provider: "sx", id: "gpt-5.6-terra" });
	await harness.emit("session_start");

	const result = await harness.emit("before_agent_start", prompt("修复一个 bug"));
	assert.equal(result[0], undefined);
	assert.equal(harness.entries.length, 0);
	assert.equal(harness.statuses.get("pi-task-router"), "router: inactive");
});

test("restores active-branch state on session start and tree navigation", async () => {
	const inspectBranch = [
		{
			type: "custom",
			customType: ROUTER_STATE_ENTRY,
			data: { version: 2, autoMode: "inspect", flashFirstTurnCompleted: true },
		},
	];
	const harness = createHarness(inspectBranch);
	await harness.emit("session_start");
	let result = await harness.emit("before_agent_start", prompt("创建一个项目"));
	assert.match(textFromResult(result[0])!, /Task route: inspect/);

	harness.entries.splice(0, harness.entries.length, {
		type: "custom",
		customType: ROUTER_STATE_ENTRY,
		data: { version: 2, autoMode: "act", overrideMode: "neutral", flashFirstTurnCompleted: true },
	});
	await harness.emit("session_tree");
	result = await harness.emit("before_agent_start", prompt("修复一个 bug"));
	assert.equal(textFromResult(result[0]), undefined, "neutral must add no guidance");
	assert.equal(harness.statuses.get("pi-task-router"), "router: neutral (manual)");
});

test("applies the strict Flash profile once and restores tools after the first agent run", async () => {
	const harness = createHarness([], { provider: "deepseek", id: "deepseek-v4-flash" });
	await harness.emit("session_start");

	const first = await harness.emit("before_agent_start", prompt("修复登录报错并排查原因"));
	assert.equal(textFromResult(first[0]), STRICT_FLASH_FIRST_TURN_SYSTEM_PROMPT);
	assert.deepEqual(harness.getActiveTools(), ["bash", "edit"]);
	assert.deepEqual(harness.entries.at(-1), {
		type: "custom",
		customType: ROUTER_STATE_ENTRY,
		data: {
			version: 2,
			autoMode: "inspect",
			flashFirstTurnRestoreTools: ["read", "bash", "edit", "write"],
		},
	});

	await harness.emit("message_end", { message: { role: "assistant" } });
	assert.deepEqual(harness.getActiveTools(), ["bash", "edit"], "strict tools survive an assistant response without a tool call");
	await harness.emit("agent_end");
	assert.deepEqual(harness.getActiveTools(), ["read", "bash", "edit", "write"]);
	assert.deepEqual(harness.entries.at(-1), {
		type: "custom",
		customType: ROUTER_STATE_ENTRY,
		data: { version: 2, autoMode: "inspect", flashFirstTurnCompleted: true },
	});

	const later = await harness.emit("before_agent_start", prompt("继续修复登录问题"));
	assert.match(textFromResult(later[0])!, /Task route: inspect/);
	assert.deepEqual(harness.getActiveTools(), ["read", "bash", "edit", "write"]);
});

test("promotes original tools after the first restricted Flash tool-call decision", async () => {
	const harness = createHarness([], { provider: "deepseek", id: "deepseek-v4-flash" });
	await harness.emit("before_agent_start", prompt("修复登录报错"));
	assert.deepEqual(harness.getActiveTools(), ["bash", "edit"]);

	await harness.emit("message_end", {
		message: { role: "assistant", content: [{ type: "toolCall", name: "bash" }] },
	});
	assert.deepEqual(harness.getActiveTools(), ["read", "bash", "edit", "write"]);
	assert.deepEqual(harness.entries.at(-1), {
		type: "custom",
		customType: ROUTER_STATE_ENTRY,
		data: { version: 2, autoMode: "inspect", flashFirstTurnCompleted: true },
	});
});

test("keeps strict tools through retryable agent-end failures until settled", async () => {
	const harness = createHarness([], { provider: "deepseek", id: "deepseek-v4-flash" });
	await harness.emit("before_agent_start", prompt("修复登录报错"));
	await harness.emit("agent_end", { messages: [{ role: "assistant", stopReason: "error" }] });
	assert.deepEqual(harness.getActiveTools(), ["bash", "edit"]);

	await harness.emit("agent_settled");
	assert.deepEqual(harness.getActiveTools(), ["read", "bash", "edit", "write"]);
});

test("does not defer strict Flash mode when its required tool surface is absent", async () => {
	const harness = createHarness([], { provider: "deepseek", id: "deepseek-v4-flash" }, ["read", "bash", "write"]);
	const result = await harness.emit("before_agent_start", prompt("修复登录报错"));
	assert.match(textFromResult(result[0])!, /Task route: inspect/);
	assert.deepEqual(harness.getActiveTools(), ["read", "bash", "write"]);
	assert.deepEqual(harness.entries.at(-1), {
		type: "custom",
		customType: ROUTER_STATE_ENTRY,
		data: { version: 2, autoMode: "inspect", flashFirstTurnCompleted: true },
	});
});

test("restores an interrupted strict Flash tool surface on session start", async () => {
	const harness = createHarness([
		{
			type: "custom",
			customType: ROUTER_STATE_ENTRY,
			data: {
				version: 2,
				autoMode: "inspect",
				flashFirstTurnRestoreTools: ["read", "bash", "edit", "write"],
			},
		},
	], { provider: "deepseek", id: "deepseek-v4-flash" }, ["bash", "edit"]);

	await harness.emit("session_start");
	assert.deepEqual(harness.getActiveTools(), ["read", "bash", "edit", "write"]);
	assert.deepEqual(harness.entries.at(-1), {
		type: "custom",
		customType: ROUTER_STATE_ENTRY,
		data: { version: 2, autoMode: "inspect", flashFirstTurnCompleted: true },
	});
});

test("reports invalid router commands without mutating state", async () => {
	const harness = createHarness();
	await harness.command("router", "turbo");
	assert.deepEqual(harness.entries, []);
	assert.deepEqual(harness.notifications.at(-1), {
		message: 'Unknown router mode "turbo". Use /router [inspect|act|neutral|auto].',
		kind: "error",
	});
});
