import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { createChildSession, GRACE_TURNS, runOnce, type RunOnceOptions } from "../src/runner.ts";
import type { ProgressEvent } from "../src/progress.ts";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const options = (signal?: AbortSignal): RunOnceOptions => ({
	cwd: process.cwd(), modelRegistry: {} as RunOnceOptions["modelRegistry"], prompt: "task", signal,
});

function fixture(hooks: {
	prompt?: (emit: (event: unknown) => void) => void | Promise<void>;
	abort?: () => void | Promise<void>;
	shutdown?: () => void | Promise<void>;
	dispose?: () => void;
	getEntries?: () => unknown[];
	getSessionFile?: () => string | undefined;
	steer?: (message: string) => void;
} = {}) {
	const trace: string[] = [];
	const listeners = new Set<(event: unknown) => void>();
	const emit = (event: unknown) => { for (const listener of [...listeners]) listener(event); };
	const session = {
		messages: [],
		sessionManager: {
			getSessionFile: hooks.getSessionFile ?? (() => "transcript.jsonl"),
			...(hooks.getEntries ? { getEntries: hooks.getEntries } : {}),
		},
		subscribe: (listener: (event: unknown) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
		prompt: async () => { trace.push("prompt"); await hooks.prompt?.(emit); },
		abort: async () => { trace.push("abort"); await hooks.abort?.(); },
		steer: async (message: string) => { trace.push("steer"); hooks.steer?.(message); },
		extensionRunner: { emit: async () => { trace.push("shutdown"); await hooks.shutdown?.(); } },
		dispose: () => { trace.push("dispose"); hooks.dispose?.(); },
	} as unknown as AgentSession;
	return { session, trace, emit, listeners };
}

function message(text: string, extra: Record<string, unknown> = {}) {
	return { type: "message_end", message: {
		role: "assistant", stopReason: "stop", content: [{ type: "text", text }],
		usage: { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, totalTokens: 14,
			cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 } }, ...extra,
	} };
}

test("progress observes top-level tool lifecycles and the existing accounting without leaking payloads", async () => {
	const events: ProgressEvent[] = [];
	const f = fixture({ prompt: (emit) => {
		emit(message("", { content: [{ type: "toolCall", id: "one", name: "read" }, { type: "toolCall", id: "two", name: "bash" }] }));
		emit({ type: "tool_execution_start", toolCallId: "one", toolName: "read", args: { path: "src/a.ts", secret: "SECRET_ARGS" } });
		emit({ type: "tool_execution_start", toolCallId: "two", toolName: "bash", args: { command: "npm test --token SECRET_COMMAND" } });
		emit({ type: "tool_execution_start", toolCallId: "two/0", parentToolCallId: "two", toolName: "write", args: { path: "SECRET_NESTED" } });
		emit({ type: "tool_execution_update", toolCallId: "two", toolName: "bash", partialResult: "SECRET_OUTPUT" });
		emit({ type: "tool_execution_end", toolCallId: "two/0", parentToolCallId: "two", toolName: "write", isError: false });
		emit({ type: "tool_execution_end", toolCallId: "two", toolName: "bash", isError: true, durationMs: 1500 });
		emit({ type: "tool_execution_end", toolCallId: "one", toolName: "read", isError: false });
		emit(message("answer"));
	} });
	const result = await runOnce({ ...options(), onProgress: (event) => events.push(event) }, { createSession: async () => f.session });
	assert.equal(result.toolUses, 2);
	assert.deepEqual(events.filter((event) => event.type === "phase").map((event) => event.phase), ["starting", "running", "cleanup"]);
	assert.deepEqual(events.filter((event) => event.type === "tool-start").map((event) => event.name), ["read", "bash"]);
	assert.ok(events.some((event) => event.type === "tool-count" && event.count === 2));
	assert.doesNotMatch(JSON.stringify(events), /SECRET/);
	assert.ok(events.some((event) => event.type === "tool-start" && event.name === "bash" && event.target === "npm test"));
	assert.equal(f.listeners.size, 0);
});

test("progress failures cannot fail a run and reentrant cancellation does not start a prompt", async () => {
	const f = fixture({ prompt: (emit) => emit(message("answer")) });
	const result = await runOnce({ ...options(), onProgress: () => { throw new Error("broken UI"); } }, { createSession: async () => f.session });
	assert.equal(result.status, "finished");
	assert.equal(result.responseText, "answer");
	const caller = new AbortController();
	const g = fixture();
	const cancelled = await runOnce({ ...options(caller.signal), onProgress: (event) => {
		if (event.type === "phase" && event.phase === "running") caller.abort();
	} }, { createSession: async () => g.session });
	assert.equal(cancelled.status, "aborted");
	assert.ok(!g.trace.includes("prompt"));
	assert.equal(g.listeners.size, 0);
});

test("aborted and late session events never publish new tool activity", async () => {
	const caller = new AbortController();
	const gate = deferred();
	const events: ProgressEvent[] = [];
	const f = fixture({ prompt: async (emit) => {
		emit(message("partial"));
		emit({ type: "tool_execution_start", toolCallId: "one", toolName: "bash", args: {} });
		await gate.promise;
	} });
	const pending = runOnce({ ...options(caller.signal), onProgress: (event) => events.push(event) }, { createSession: async () => f.session, cancellationTimeoutMs: 0 });
	await tick();
	caller.abort();
	const count = events.length;
	f.emit({ type: "tool_execution_start", toolCallId: "late", toolName: "write", args: { path: "late.ts" } });
	f.emit({ type: "tool_execution_end", toolCallId: "one", toolName: "bash", isError: false });
	assert.equal(events.length, count);
	const result = await pending;
	assert.equal(result.status, "aborted");
	assert.equal(result.responseText, "partial");
	assert.ok(result.cleanupWarning);
	assert.equal(f.listeners.size, 0);
	const finalCount = events.length;
	gate.resolve();
	f.emit(message("late answer"));
	await tick();
	assert.equal(events.length, finalCount);
});

test("late initialization only releases the session and cannot create UI activity", async () => {
	const caller = new AbortController();
	let create!: (session: AgentSession) => void;
	const events: ProgressEvent[] = [];
	const f = fixture();
	const pending = runOnce({ ...options(caller.signal), onProgress: (event) => events.push(event) }, {
		createSession: () => new Promise((resolve) => { create = resolve; }), cancellationTimeoutMs: 0,
	});
	caller.abort();
	await pending;
	assert.deepEqual(events, [{ type: "phase", phase: "starting" }]);
	create(f.session);
	await tick();
	assert.deepEqual(f.trace, ["shutdown", "dispose"]);
	assert.deepEqual(events, [{ type: "phase", phase: "starting" }]);
});

test("runOnce returns plain result data and closes the session before returning", async () => {
	const emitted = message("answer");
	const f = fixture({ prompt: (emit) => emit(emitted), dispose: () => { emitted.message.usage.totalTokens = 999; } });
	const result = await runOnce(options(), { createSession: async () => f.session });
	assert.equal(result.status, "finished");
	assert.equal(result.responseText, "answer");
	assert.deepEqual(result.usage, { tokens: 14, cost: 1 });
	assert.equal(result.modelUsage?.totalTokens, 14);
	assert.equal(result.transcriptPath, "transcript.jsonl");
	assert.equal("session" in result, false);
	assert.deepEqual(f.trace, ["prompt", "shutdown", "dispose"]);
	assert.equal(f.listeners.size, 0);
});

test("a failure while collecting final output preserves the report and spend", async () => {
	const f = fixture({
		prompt: (emit) => emit(message("partial answer")),
		getEntries: () => { throw new Error("entries unavailable"); },
		getSessionFile: () => { throw new Error("transcript unavailable"); },
	});
	const result = await runOnce(options(), { createSession: async () => f.session });
	assert.equal(result.status, "finished");
	assert.equal(result.responseText, "partial answer");
	assert.equal(result.usage.tokens, 14);
	assert.equal(result.modelUsage?.totalTokens, 14, "falls back to the last observed usage");
	assert.equal(result.transcriptPath, undefined);
	assert.match(result.cleanupWarning ?? "", /final model usage/);
	assert.match(result.cleanupWarning ?? "", /transcript path/);
	assert.deepEqual(f.trace, ["prompt", "shutdown", "dispose"]);
});

test("a collection failure keeps a failed run failed with its error, text, spend, and tools", async () => {
	const f = fixture({
		prompt: (emit) => {
			emit({ type: "message_end", message: { role: "assistant", stopReason: "toolUse",
				content: [{ type: "toolCall", id: "one", name: "read" }] } });
			emit(message("partial answer"));
			throw new Error("prompt failed");
		},
		getEntries: () => { throw new Error("entries unavailable"); },
		getSessionFile: () => { throw new Error("transcript unavailable"); },
	});
	const result = await runOnce(options(), { createSession: async () => f.session });
	assert.equal(result.status, "failed");
	if (result.status === "failed") assert.equal(result.error, "prompt failed");
	assert.equal(result.responseText, "partial answer");
	assert.equal(result.usage.tokens, 14);
	assert.equal(result.modelUsage?.totalTokens, 14);
	assert.equal(result.toolUses, 1);
	assert.equal(result.transcriptPath, undefined);
	assert.match(result.cleanupWarning ?? "", /final model usage/);
	assert.match(result.cleanupWarning ?? "", /transcript path/);
});

test("a collection failure keeps an aborted run aborted with its partial report", async () => {
	const done = deferred();
	const controller = new AbortController();
	const f = fixture({
		prompt: async (emit) => { emit(message("partial")); await done.promise; },
		abort: () => done.resolve(),
		getEntries: () => { throw new Error("entries unavailable"); },
		getSessionFile: () => { throw new Error("transcript unavailable"); },
	});
	const running = runOnce(options(controller.signal), { createSession: async () => f.session });
	await tick();
	controller.abort();
	const result = await running;
	assert.equal(result.status, "aborted");
	if (result.status === "aborted") assert.equal(result.reason, "cancelled");
	assert.equal(result.responseText, "partial");
	assert.equal(result.usage.tokens, 14);
	assert.equal(result.modelUsage?.totalTokens, 14);
	assert.equal(result.transcriptPath, undefined);
	assert.match(result.cleanupWarning ?? "", /final model usage/);
});

test("an unreadable transcript alone keeps the canonical usage and warns only about the path", async () => {
	const f = fixture({ prompt: (emit) => emit(message("answer")),
		getSessionFile: () => { throw new Error("transcript unavailable"); } });
	const result = await runOnce(options(), { createSession: async () => f.session });
	assert.equal(result.status, "finished");
	assert.equal(result.responseText, "answer");
	assert.equal(result.transcriptPath, undefined);
	assert.match(result.cleanupWarning ?? "", /transcript path/);
	assert.doesNotMatch(result.cleanupWarning ?? "", /final model usage/);
});

test("an unreadable final usage alone keeps the transcript and warns only about usage", async () => {
	const f = fixture({ prompt: (emit) => emit(message("answer")),
		getEntries: () => { throw new Error("entries unavailable"); } });
	const result = await runOnce(options(), { createSession: async () => f.session });
	assert.equal(result.status, "finished");
	assert.equal(result.transcriptPath, "transcript.jsonl");
	assert.equal(result.modelUsage?.totalTokens, 14);
	assert.match(result.cleanupWarning ?? "", /final model usage/);
	assert.doesNotMatch(result.cleanupWarning ?? "", /transcript path/);
});

test("a session without a transcript file is normal and stays warning-free", async () => {
	for (const getSessionFile of [() => undefined, () => ""]) {
		const f = fixture({ prompt: (emit) => emit(message("answer")), getSessionFile });
		const result = await runOnce(options(), { createSession: async () => f.session });
		assert.equal(result.status, "finished");
		assert.equal(result.responseText, "answer");
		assert.equal("transcriptPath" in result, false, "an empty path must not look like a file");
		assert.equal(result.cleanupWarning, undefined);
	}
});

test("a resolved provider failure is not reported as success", async () => {
	const f = fixture({ prompt: (emit) => emit(message("partial", { stopReason: "error", errorMessage: "provider down" })) });
	const result = await runOnce(options(), { createSession: async () => f.session });
	assert.equal(result.status, "failed");
	if (result.status === "failed") assert.equal(result.error, "provider down");
	assert.equal(result.responseText, "partial");
	assert.equal(f.trace.at(-1), "dispose");
});

test("an SDK aborted assistant message is detected even without a caller signal", async () => {
	const f = fixture({ prompt: (emit) => emit(message("partial", { stopReason: "aborted" })) });
	const result = await runOnce(options(), { createSession: async () => f.session });
	assert.equal(result.status, "aborted");
	if (result.status === "aborted") assert.equal(result.reason, "sdk_abort");
	assert.equal(result.responseText, "partial");
	assert.equal(result.usage.tokens, 14);
	assert.equal(f.trace.at(-1), "dispose");
});

test("a thrown prompt preserves partial output and spend and still closes", async () => {
	const f = fixture({ prompt: (emit) => { emit(message("partial")); throw new Error("prompt failed"); } });
	const result = await runOnce(options(), { createSession: async () => f.session });
	assert.equal(result.status, "failed");
	if (result.status === "failed") assert.equal(result.error, "prompt failed");
	assert.equal(result.responseText, "partial");
	assert.equal(result.usage.tokens, 14);
	assert.deepEqual(f.trace, ["prompt", "shutdown", "dispose"]);
	assert.equal(f.listeners.size, 0);
});

test("throwing undefined is still a failure, not a clean empty answer", async () => {
	const f = fixture({ prompt: () => { throw undefined; } });
	const result = await runOnce(options(), { createSession: async () => f.session });
	assert.equal(result.status, "failed");
});

test("a silent output-token limit is a failure, but text at that limit remains available", async () => {
	for (const text of ["", "partial answer"]) {
		const f = fixture({ prompt: (emit) => emit(message(text, { stopReason: "length" })) });
		const result = await runOnce(options(), { createSession: async () => f.session });
		assert.equal(result.status, text ? "finished" : "failed");
		assert.equal(result.responseText, text);
		assert.equal(f.trace.at(-1), "dispose");
	}
});

test("an empty successful run remains an empty successful result", async () => {
	const f = fixture();
	const result = await runOnce(options(), { createSession: async () => f.session });
	assert.equal(result.status, "finished");
	assert.equal(result.responseText, "");
	assert.deepEqual(result.usage, { tokens: 0, cost: 0 });
});

test("a pre-cancelled call never initializes an SDK session", async () => {
	const controller = new AbortController();
	controller.abort();
	let creations = 0;
	const result = await runOnce(options(controller.signal), { createSession: async () => { creations++; throw new Error("unexpected"); } });
	assert.equal(creations, 0);
	assert.equal(result.status, "aborted");
});

test("cancellation during initialization closes a returned session without prompting", async () => {
	const ready = deferred();
	const controller = new AbortController();
	const f = fixture();
	const running = runOnce(options(controller.signal), { createSession: async () => { await ready.promise; return f.session; } });
	controller.abort();
	ready.resolve();
	const result = await running;
	assert.equal(result.status, "aborted");
	assert.deepEqual(f.trace, ["shutdown", "dispose"]);
});

test("cancellation reaches a running session and retains its partial answer", async () => {
	const done = deferred();
	const controller = new AbortController();
	const f = fixture({ prompt: async (emit) => { emit(message("partial")); await done.promise; }, abort: () => done.resolve() });
	const running = runOnce(options(controller.signal), { createSession: async () => f.session });
	await tick();
	controller.abort();
	const result = await running;
	assert.equal(result.status, "aborted");
	if (result.status === "aborted") assert.equal(result.reason, "cancelled");
	assert.equal(result.responseText, "partial");
	assert.deepEqual(f.trace, ["prompt", "abort", "shutdown", "dispose"]);
	assert.equal(f.listeners.size, 0);
});

test("ignored cancellation is bounded and explicitly warns about late in-process work", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const done = deferred();
	const controller = new AbortController();
	const f = fixture({ prompt: async (emit) => { emit(message("partial")); await done.promise; throw new Error("late rejection"); } });
	const running = runOnce(options(controller.signal), { createSession: async () => f.session, cancellationTimeoutMs: 10 });
	await tick();
	controller.abort();
	t.mock.timers.tick(10);
	const result = await running;
	assert.equal(result.status, "aborted");
	assert.match(result.cleanupWarning ?? "", /may still be unwinding/);
	assert.equal(f.trace.at(-1), "dispose");
	assert.equal(f.listeners.size, 0);
	done.resolve();
	await tick();
	assert.equal(result.responseText, "partial", "late work cannot rewrite a returned snapshot");
});

test("a session created after the cancellation deadline is still shut down exactly once", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const ready = deferred();
	const controller = new AbortController();
	const f = fixture();
	const running = runOnce(options(controller.signal), {
		createSession: async () => { await ready.promise; return f.session; }, cancellationTimeoutMs: 10,
	});
	controller.abort();
	t.mock.timers.tick(10);
	const result = await running;
	assert.equal(result.status, "aborted");
	assert.match(result.cleanupWarning ?? "", /initialization/);
	assert.deepEqual(f.trace, []);
	ready.resolve();
	await tick();
	assert.deepEqual(f.trace, ["shutdown", "dispose"]);
});

test("cancellation during extension shutdown wins over the already completed prompt", async () => {
	const entered = deferred();
	const release = deferred();
	const controller = new AbortController();
	const f = fixture({ prompt: (emit) => emit(message("answer")),
		shutdown: async () => { entered.resolve(); await release.promise; } });
	const pending = runOnce(options(controller.signal), { createSession: async () => f.session });
	await entered.promise;
	controller.abort();
	release.resolve();
	const result = await pending;
	assert.equal(result.status, "aborted");
	if (result.status === "aborted") assert.equal(result.reason, "cancelled");
	assert.equal(result.responseText, "answer");
	assert.equal(result.usage.tokens, 14);
	assert.equal(f.trace.at(-1), "dispose");
});

test("turn-limit cancellation is distinguished from caller cancellation", async () => {
	const done = deferred();
	const wrapUp: string[] = [];
	const f = fixture({ steer: (message) => wrapUp.push(message), prompt: async (emit) => {
		emit(message("partial"));
		for (let index = 0; index < 1 + GRACE_TURNS; index++) emit({ type: "turn_end" });
		await done.promise;
	}, abort: () => done.resolve() });
	const result = await runOnce({ ...options(), maxTurns: 1 }, { createSession: async () => f.session });
	assert.equal(result.status, "aborted");
	if (result.status === "aborted") {
		assert.equal(result.reason, "turn_limit");
		assert.equal(result.limit, 1);
	}
	assert.deepEqual(f.trace, ["prompt", "steer", "abort", "shutdown", "dispose"]);
	assert.match(wrapUp[0], /Begin your final report with a single line containing exactly one of: Completed, Partial, or Blocked/);
	assert.match(wrapUp[0], /Partial means work progressed but remains incomplete or unverified/);
	assert.match(wrapUp[0], /environment\/tool failure prevents further progress/);
	assert.match(wrapUp[0], /checks actually run/);
});

test("startup failures return data rather than reject a sibling tool batch", async () => {
	const result = await runOnce(options(), { createSession: async () => { throw new Error("startup failed"); } });
	assert.equal(result.status, "failed");
	if (result.status === "failed") assert.equal(result.error, "startup failed");
});

test("extension shutdown failures do not erase a completed answer", async () => {
	const f = fixture({ prompt: (emit) => emit(message("answer")), shutdown: () => { throw new Error("shutdown failed"); } });
	const result = await runOnce(options(), { createSession: async () => f.session });
	assert.equal(result.status, "finished");
	assert.equal(result.responseText, "answer");
	assert.match(result.cleanupWarning ?? "", /shutdown failed/);
	assert.equal(f.trace.at(-1), "dispose");
});

test("dispose failures are reported without failing the completed run", async () => {
	const f = fixture({ prompt: (emit) => emit(message("answer")), dispose: () => { throw new Error("dispose failed"); } });
	const result = await runOnce(options(), { createSession: async () => f.session });
	assert.equal(result.status, "finished");
	assert.equal(result.responseText, "answer");
	assert.match(result.cleanupWarning ?? "", /dispose failed/);
	assert.equal(f.trace.at(-1), "dispose");
});

test("a final turn without text marks the fallback instead of presenting it as the report", async () => {
	const f = fixture({ prompt: (emit) => { emit(message("interim text")); emit(message("")); } });
	const result = await runOnce(options(), { createSession: async () => f.session });
	assert.equal(result.status, "finished");
	assert.match(result.responseText, /interim text/);
	assert.match(result.responseText, /no final text/);
});

test("one-shot ownership starts and shuts down real SDK extensions without a model call", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "pi-run-once-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const agentDir = join(root, "agent");
	mkdirSync(agentDir);
	const marker = join(root, "events.txt");
	const extension = join(root, "probe.ts");
	writeFileSync(extension, `import { appendFileSync } from "node:fs";
export default function (pi) {
  pi.on("session_start", () => { appendFileSync(${JSON.stringify(marker)}, "start\\n"); });
  pi.on("session_shutdown", () => { appendFileSync(${JSON.stringify(marker)}, "stop\\n"); });
}`);
	t.mock.method(globalThis, "fetch", async () => { throw new Error("network forbidden"); });
	const result = await runOnce({ ...options(), cwd: root, agentDir, extensionPaths: [extension], tools: [],
		model: { provider: "probe", id: "probe", name: "probe", api: "openai-completions", input: ["text"],
			contextWindow: 10_000, maxTokens: 1000, reasoning: false,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as never,
	}, { createSession: async (request) => {
		const session = await createChildSession(request);
		session.prompt = async () => {};
		return session;
	} });
	assert.equal(result.status, "finished");
	assert.equal(readFileSync(marker, "utf8"), "start\nstop\n");
});

test("cancellation while a real extension factory loads still has a shutdown owner", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "pi-load-cancel-"));
	const controller = new AbortController();
	const key = `__pi_cancel_${Math.random().toString(36).slice(2)}`;
	(globalThis as unknown as Record<string, unknown>)[key] = controller;
	t.after(() => { delete (globalThis as unknown as Record<string, unknown>)[key]; rmSync(root, { recursive: true, force: true }); });
	const agentDir = join(root, "agent");
	mkdirSync(agentDir);
	const marker = join(root, "events.txt");
	const extension = join(root, "probe.ts");
	writeFileSync(extension, `import { appendFileSync } from "node:fs";
export default async function (pi) {
  appendFileSync(${JSON.stringify(marker)}, "acquired\\n");
  pi.on("session_shutdown", () => { appendFileSync(${JSON.stringify(marker)}, "released\\n"); });
  globalThis[${JSON.stringify(key)}].abort();
  await Promise.resolve();
}`);
	t.mock.method(globalThis, "fetch", async () => { throw new Error("network forbidden"); });
	const result = await runOnce({ ...options(controller.signal), cwd: root, agentDir,
		extensionPaths: [extension], tools: [],
		model: { provider: "probe", id: "probe", name: "probe", api: "openai-completions", input: ["text"],
			contextWindow: 10_000, maxTokens: 1000, reasoning: false,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as never,
	});
	assert.equal(result.status, "aborted");
	assert.equal(readFileSync(marker, "utf8"), "acquired\nreleased\n");
});

test("a real SDK before_agent_start abort is not a successful empty answer", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "pi-sdk-abort-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const agentDir = join(root, "agent");
	mkdirSync(agentDir);
	const extension = join(root, "probe.ts");
	writeFileSync(extension, `export default function (pi) {
  pi.on("before_agent_start", (_event, ctx) => { void ctx.abort(); });
}`);
	t.mock.method(globalThis, "fetch", async () => { throw new Error("network forbidden"); });
	let sdkSettledAborted = false;
	const result = await runOnce({ ...options(), cwd: root, agentDir, extensionPaths: [extension], tools: [],
		model: { provider: "probe", id: "probe", name: "probe", api: "openai-completions", input: ["text"],
			contextWindow: 10_000, maxTokens: 1000, reasoning: false,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as never,
	}, { createSession: async (request) => {
		const session = await createChildSession(request);
		// Supply synthetic auth only to pass SDK preflight; streaming remains the offline stub below.
		t.mock.method(session.modelRuntime, "checkAuth", async () => ({ type: "api_key" as const, source: "offline" }));
		t.mock.method(session.modelRuntime, "getAuth", async () => ({ auth: { apiKey: "offline-test-key" } }));
		session.subscribe((event) => {
			if (event.type === "agent_settled") sdkSettledAborted = event.aborted;
		});
		session.agent.streamFunction = () => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({ type: "error", reason: "aborted", error: {
					...message("").message, api: "openai-completions", provider: "probe", model: "probe",
					timestamp: Date.now(), stopReason: "aborted",
				} as AssistantMessage });
				stream.end();
			});
			return stream;
		};
		return session;
	} });
	assert.equal(sdkSettledAborted, true, `the public settled event detects SDK abort: ${JSON.stringify(result)}`);
	assert.equal(result.status, "aborted");
	if (result.status === "aborted") assert.equal(result.reason, "sdk_abort");
});

test("foreground cleanup keeps the process alive until an unresponsive shutdown reaches its bound", () => {
	const moduleUrl = new URL("../src/runner.ts", import.meta.url).href;
	const script = `import { disposeChildSession } from ${JSON.stringify(moduleUrl)};
const session = { extensionRunner: { emit: () => new Promise(() => {}) }, dispose() {} };
await disposeChildSession(session, 20);
console.log("disposed");`;
	const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script],
		{ encoding: "utf8", timeout: 15_000 });
	assert.equal(child.error, undefined);
	assert.equal(child.status, 0, child.stderr);
	assert.equal(child.stdout.trim(), "disposed");
});

test("canonical one-shot usage includes tools, compaction, and non-message inference without double counting", async () => {
	const assistant = message("answer").message;
	const f = fixture({ prompt: (emit) => {
		emit({ type: "message_end", message: assistant });
		emit({ type: "message_end", message: { role: "toolResult", usage: assistant.usage } });
	} });
	Object.assign(f.session.sessionManager, { getEntries: () => [
		{ type: "message", message: assistant },
		{ type: "message", message: { role: "toolResult", usage: assistant.usage } },
		{ type: "compaction", usage: assistant.usage },
		{ type: "usage", usage: assistant.usage },
	] });
	const result = await runOnce(options(), { createSession: async () => f.session });
	assert.deepEqual(result.usage, { tokens: 14, cost: 1 }, "the tool row retains its assistant-only totals");
	assert.equal(result.modelUsage?.totalTokens, 56, "canonical entries replace, not add to, event fallback");
	assert.equal(result.modelUsage?.cost.total, 4);
});

test("usage survives compaction and includes complete nested-model accounting", async () => {
	const f = fixture({ prompt: (emit) => {
		emit(message("first", { usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, totalTokens: 100,
			reasoning: 7, cacheWrite1h: 9, cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 } } }));
		emit({ type: "auto_compaction_end" });
		emit({ type: "message_end", message: { role: "toolResult", usage: { totalTokens: 999 } } });
		emit(message("final"));
	} });
	const result = await runOnce(options(), { createSession: async () => f.session });
	assert.equal(result.responseText, "final");
	assert.deepEqual(result.usage, { tokens: 114, cost: 11 });
	assert.deepEqual(result.modelUsage, { input: 12, output: 23, cacheRead: 34, cacheWrite: 45, totalTokens: 1113,
		reasoning: 7, cacheWrite1h: 9, cost: { input: 1.1, output: 2.2, cacheRead: 3.3, cacheWrite: 4.4, total: 11 } });
});
