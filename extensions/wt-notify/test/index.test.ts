import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import wtNotifyExtension from "../index.ts";

type Handler = (event: any, ctx: any) => void | Promise<void>;

function createHarness() {
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, { description?: string; handler: (args: string, ctx: any) => Promise<void> }>();
	// Completion notices emitted through the injected `notify` sink.
	const toasts: Array<{ message: string }> = [];
	// Command feedback emitted via ctx.ui.notify.
	const uiNotifications: Array<{ message: string; type?: string }> = [];
	const pi = {
		on(name: string, handler: Handler) {
			handlers.set(name, handler);
		},
		registerCommand(name: string, command: { description?: string; handler: (args: string, ctx: any) => Promise<void> }) {
			commands.set(name, command);
		},
	};
	const ctx = {
		hasUI: true,
		ui: {
			notify: (message: string, type?: string) => uiNotifications.push({ message, type }),
		},
	};

	wtNotifyExtension(pi as never, {
		notify: (message: string) => toasts.push({ message }),
	});

	return {
		toasts,
		uiNotifications,
		emit: async (name: string, event: any = {}) => {
			const handler = handlers.get(name);
			assert.ok(handler, `missing handler: ${name}`);
			await handler(event, ctx);
		},
		runCommand: async (args: string) => {
			const command = commands.get("wt-notify");
			assert.ok(command, "missing wt-notify command");
			await command.handler(args, ctx);
		},
	};
}

function settledRun(stopReason = "stop"): any {
	return { messages: [{ role: "assistant", stopReason }] };
}

const realNow = Date.now;
let clock = 0;

function setClock(ms: number): void {
	clock = ms;
}

beforeEach(() => {
	clock = 1_000_000;
	Date.now = () => clock;
	process.env.WT_SESSION = "test-wt-session";
});

afterEach(() => {
	Date.now = realNow;
	delete process.env.WT_SESSION;
});

test("emits a completion notice when a long run settles in Windows Terminal", async () => {
	const harness = createHarness();

	await harness.emit("agent_start");
	setClock(clock + 12_000);
	await harness.emit("agent_end", settledRun());
	await harness.emit("agent_settled");

	assert.equal(harness.toasts.length, 1);
	assert.equal(harness.toasts[0]!.message, "🤖 任务完成 · 用时 12s · wt-notify");
});

test("filters runs shorter than the default 8s threshold", async () => {
	const harness = createHarness();

	await harness.emit("agent_start");
	setClock(clock + 5_000);
	await harness.emit("agent_end", settledRun());
	await harness.emit("agent_settled");

	assert.equal(harness.toasts.length, 0);
});

test("wt-notify 0 disables the minimum duration filter", async () => {
	const harness = createHarness();
	await harness.runCommand("0");

	await harness.emit("agent_start");
	setClock(clock + 1_000);
	await harness.emit("agent_end", settledRun());
	await harness.emit("agent_settled");

	assert.equal(harness.toasts.length, 1);
	assert.equal(harness.toasts[0]!.message, "🤖 任务完成 · 用时 1s · wt-notify");
	// The threshold change itself is acknowledged in the TUI, not as a toast.
	assert.equal(harness.uiNotifications[0]!.message, "wt-notify: minimum duration filter disabled");
	assert.equal(harness.uiNotifications[0]!.type, "info");
});

test("wt-notify <seconds> raises the threshold until reload", async () => {
	const harness = createHarness();
	await harness.runCommand("15");

	await harness.emit("agent_start");
	setClock(clock + 10_000);
	await harness.emit("agent_end", settledRun());
	await harness.emit("agent_settled");

	// [0] is the TUI confirmation of the threshold change; the 10s run is filtered.
	assert.equal(harness.toasts.length, 0);
	assert.equal(harness.uiNotifications.length, 1);
	assert.match(harness.uiNotifications[0]!.message, /15s/);
});

test("never notifies for user-aborted runs", async () => {
	const harness = createHarness();
	await harness.runCommand("0");
	harness.toasts.length = 0;

	await harness.emit("agent_start");
	setClock(clock + 60_000);
	await harness.emit("agent_end", settledRun("aborted"));
	await harness.emit("agent_settled");

	assert.equal(harness.toasts.length, 0);
});

test("keeps the wall clock across automatic retries and notifies once", async () => {
	const harness = createHarness();

	await harness.emit("agent_start");
	setClock(clock + 3_000);
	// First attempt errors; Pi starts a retry immediately.
	await harness.emit("agent_end", settledRun("error"));
	await harness.emit("agent_start");
	setClock(clock + 7_000);
	await harness.emit("agent_end", settledRun());
	await harness.emit("agent_settled");

	assert.equal(harness.toasts.length, 1);
	assert.equal(harness.toasts[0]!.message, "🤖 任务完成 · 用时 10s · wt-notify");
});

test("stays silent outside Windows Terminal", async () => {
	delete process.env.WT_SESSION;
	const harness = createHarness();

	await harness.emit("agent_start");
	setClock(clock + 20_000);
	await harness.emit("agent_end", settledRun());
	await harness.emit("agent_settled");

	assert.equal(harness.toasts.length, 0);
});

test("session_shutdown clears stale run state", async () => {
	const harness = createHarness();

	await harness.emit("agent_start");
	await harness.emit("session_shutdown");
	setClock(clock + 60_000);
	await harness.emit("agent_end", settledRun());
	await harness.emit("agent_settled");

	assert.equal(harness.toasts.length, 0);
});

test("agent_settled without a preceding agent_start is ignored", async () => {
	const harness = createHarness();

	await harness.emit("agent_settled");

	assert.equal(harness.toasts.length, 0);
});

test("wt-notify without arguments reports the current threshold", async () => {
	const harness = createHarness();
	await harness.runCommand("");

	assert.deepEqual(harness.uiNotifications, [
		{ message: "wt-notify: minimum duration is 8s (0 = filter off)", type: "info" },
	]);
});

test("wt-notify rejects invalid input without changing the threshold", async () => {
	const harness = createHarness();
	await harness.runCommand("abc");
	await harness.runCommand("-3");

	// Threshold unchanged: a 10s run still notifies.
	await harness.emit("agent_start");
	setClock(clock + 10_000);
	await harness.emit("agent_end", settledRun());
	await harness.emit("agent_settled");

	assert.equal(harness.uiNotifications.length, 2);
	assert.equal(harness.uiNotifications[0]!.type, "error");
	assert.equal(harness.uiNotifications[1]!.type, "error");
	assert.equal(harness.toasts.length, 1);
	assert.equal(harness.toasts[0]!.message, "🤖 任务完成 · 用时 10s · wt-notify");
});