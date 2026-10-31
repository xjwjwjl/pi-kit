import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { test } from "node:test";
import { ForegroundExecutor } from "../src/executor.ts";
import { cancelledOutcome, failedOutcome, type RunOutcome } from "../src/outcome.ts";
import type { RunOnceOptions } from "../src/runner.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}

function options(prompt: string, signal?: AbortSignal): RunOnceOptions {
	return { cwd: ".", modelRegistry: {} as RunOnceOptions["modelRegistry"], prompt, signal };
}

function finished(responseText = "done"): RunOutcome {
	return { status: "finished", responseText, usage: { tokens: 12, cost: 0.25 }, toolUses: 2 };
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test("progress publishes queued/starting safely and reentrant queued cancellation cannot create work", async () => {
	const caller = new AbortController();
	const phases: string[] = [];
	let starts = 0;
	const executor = new ForegroundExecutor({ run: async () => { starts++; return finished(); } });
	const result = await executor.execute({ ...options("cancelled", caller.signal), onProgress: (event) => {
		if (event.type === "phase") { phases.push(event.phase); caller.abort(); }
	} });
	assert.equal(result.status, "aborted");
	assert.deepEqual(phases, ["queued"]);
	assert.equal(starts, 0);
	assert.equal((await executor.execute({ ...options("next"), onProgress: () => { throw new Error("UI failed"); } })).status, "finished");
	assert.equal(starts, 1);
	await executor.dispose();
});

test("cancellation inside the starting observation still prevents runner creation", async () => {
	const caller = new AbortController();
	let starts = 0;
	const executor = new ForegroundExecutor({ run: async () => { starts++; return finished(); } });
	const result = await executor.execute({ ...options("cancelled", caller.signal), onProgress: (event) => {
		if (event.type === "phase" && event.phase === "starting") caller.abort();
	} });
	assert.equal(result.status, "aborted");
	assert.equal(starts, 0);
	await executor.dispose();
});

test("bounded concurrency starts in FIFO order and preserves queued and running results", async () => {
	const gates = Array.from({ length: 5 }, () => deferred<RunOutcome>());
	const starts: string[] = [];
	const caller = new AbortController();
	const executor = new ForegroundExecutor({
		maxConcurrent: 2,
		run: async (input) => {
			starts.push(input.prompt);
			assert.notEqual(input.signal, caller.signal);
			assert.equal(input.cwd, ".");
			assert.equal(input.maxTurns, 4);
			return gates[Number(input.prompt)].promise;
		},
	});
	const outcomes: RunOutcome[] = [
		{ ...finished("rich"), transcriptPath: "a.jsonl", cleanupWarning: "warning",
			modelUsage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3,
				cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 } } },
		failedOutcome("provider"),
		{ ...cancelledOutcome(), reason: "turn_limit", responseText: "partial" },
		{ ...cancelledOutcome(), responseText: "cancelled partial" },
		finished("last"),
	];
	const calls = gates.map((_, i) => executor.execute({ ...options(String(i), caller.signal), maxTurns: 4 }));
	let queuedSettled = false;
	void calls[2].then(() => { queuedSettled = true; });
	await flush();
	assert.deepEqual(starts, ["0", "1"]);
	assert.equal(executor.runningCount, 2);
	assert.equal(executor.queuedCount, 3);
	assert.equal(queuedSettled, false);

	gates[1].resolve(outcomes[1]);
	assert.equal(await calls[1], outcomes[1]);
	await flush();
	assert.deepEqual(starts, ["0", "1", "2"]);
	gates[0].resolve(outcomes[0]);
	assert.equal(await calls[0], outcomes[0]);
	await flush();
	assert.deepEqual(starts, ["0", "1", "2", "3"]);
	gates[2].resolve(outcomes[2]);
	assert.equal(await calls[2], outcomes[2]);
	await flush();
	assert.deepEqual(starts, ["0", "1", "2", "3", "4"]);
	gates[3].resolve(outcomes[3]);
	gates[4].resolve(outcomes[4]);
	const results = await Promise.all(calls);
	results.forEach((result, i) => assert.equal(result, outcomes[i], "outcome identity is preserved"));
	assert.equal(executor.runningCount, 0);
	assert.equal(executor.queuedCount, 0);
	assert.equal(getEventListeners(caller.signal, "abort").length, 0);
	await executor.dispose();
});

test("default concurrency is ten, and completed calls release every permit", async () => {
	const gate = deferred<RunOutcome>();
	let starts = 0;
	const executor = new ForegroundExecutor({ run: () => { starts++; return gate.promise; } });
	const calls = Array.from({ length: 11 }, (_, i) => executor.execute(options(String(i))));
	await flush();
	assert.equal(starts, 10);
	assert.equal(executor.runningCount, 10);
	assert.equal(executor.queuedCount, 1);
	gate.resolve(finished());
	await Promise.all(calls);
	assert.equal(starts, 11);
	assert.equal(executor.runningCount, 0);
	assert.equal(executor.queuedCount, 0);
	await executor.dispose();
});

test("pre-cancelled calls do not start or consume a permit", async () => {
	let starts = 0;
	const caller = new AbortController();
	caller.abort();
	const executor = new ForegroundExecutor({ run: async () => { starts++; return finished(); } });
	assert.deepEqual(await executor.execute(options("skip", caller.signal)), cancelledOutcome());
	assert.equal(starts, 0);
	assert.equal(executor.runningCount, 0);
	assert.equal(executor.queuedCount, 0);
	assert.equal(getEventListeners(caller.signal, "abort").length, 0);
	await executor.dispose();
});

test("queued cancellation settles immediately without starting or consuming a permit", async () => {
	const gate = deferred<RunOutcome>();
	const starts: string[] = [];
	const executor = new ForegroundExecutor({ maxConcurrent: 1, run: (input) => {
		starts.push(input.prompt);
		return input.prompt === "first" ? gate.promise : Promise.resolve(finished(input.prompt));
	} });
	const first = executor.execute(options("first"));
	const caller = new AbortController();
	const cancelled = executor.execute(options("skip", caller.signal));
	const last = executor.execute(options("last"));
	await flush();
	caller.abort();
	assert.deepEqual(await cancelled, cancelledOutcome());
	assert.equal(executor.runningCount, 1);
	assert.equal(executor.queuedCount, 1);
	assert.deepEqual(starts, ["first"]);
	assert.equal(getEventListeners(caller.signal, "abort").length, 0);
	gate.resolve(finished());
	await Promise.all([first, last]);
	assert.deepEqual(starts, ["first", "last"]);
	assert.equal(executor.runningCount, 0);
	await executor.dispose();
});

test("cancellation between permit grant and run invocation never starts the call", async () => {
	const gate = deferred<RunOutcome>();
	const starts: string[] = [];
	const executor = new ForegroundExecutor({ maxConcurrent: 1, run: (input) => {
		starts.push(input.prompt);
		return input.prompt === "first" ? gate.promise : Promise.resolve(finished());
	} });
	const first = executor.execute(options("first"));
	const caller = new AbortController();
	const next = executor.execute(options("skip", caller.signal));
	const last = executor.execute(options("last"));
	await flush();
	gate.resolve(finished());
	// first's continuation runs after drain grants the next permit, before its run microtask.
	await first;
	assert.equal(executor.queuedCount, 1);
	assert.equal(executor.runningCount, 1);
	caller.abort();
	assert.deepEqual(await next, cancelledOutcome());
	await last;
	assert.deepEqual(starts, ["first", "last"]);
	assert.equal(executor.runningCount, 0);
	assert.equal(executor.queuedCount, 0);
	assert.equal(getEventListeners(caller.signal, "abort").length, 0);
	await executor.dispose();
});

test("immediate cancellation after execute also wins before the first run", async () => {
	let starts = 0;
	const caller = new AbortController();
	const executor = new ForegroundExecutor({ run: async () => { starts++; return finished(); } });
	const call = executor.execute(options("skip", caller.signal));
	caller.abort();
	assert.deepEqual(await call, cancelledOutcome());
	assert.equal(starts, 0);
	assert.equal(executor.runningCount, 0);
	await executor.dispose();
});

test("running cancellation forwards only to that call and normalizes its rejection", async () => {
	const gate = deferred<RunOutcome>();
	const caller = new AbortController();
	let internalSignal: AbortSignal | undefined;
	const executor = new ForegroundExecutor({ run: (input) => {
		if (input.prompt === "sibling") return gate.promise;
		internalSignal = input.signal;
		return new Promise((_, reject) => input.signal!.addEventListener("abort", () => reject(new Error("abort")), { once: true }));
	} });
	const call = executor.execute(options("cancel", caller.signal));
	const sibling = executor.execute(options("sibling"));
	await flush();
	assert.notEqual(internalSignal, caller.signal);
	caller.abort();
	assert.equal(internalSignal?.aborted, true);
	assert.deepEqual(await call, cancelledOutcome());
	assert.equal(executor.runningCount, 1);
	gate.resolve(finished());
	assert.equal((await sibling).status, "finished");
	assert.equal(executor.runningCount, 0);
	assert.equal(getEventListeners(caller.signal, "abort").length, 0);
	await executor.dispose();
});

test("caller cancellation wins over a late finished outcome without erasing its output", async () => {
	const gate = deferred<RunOutcome>();
	const caller = new AbortController();
	const executor = new ForegroundExecutor({ run: () => gate.promise });
	const pending = executor.execute(options("late", caller.signal));
	await flush();
	caller.abort();
	gate.resolve(finished("late answer"));
	const result = await pending;
	assert.equal(result.status, "aborted");
	if (result.status === "aborted") assert.equal(result.reason, "cancelled");
	assert.equal(result.responseText, "late answer");
	assert.equal(result.usage.tokens, 12);
	assert.equal(executor.runningCount, 0);
	await executor.dispose();
});

test("synchronous throws and asynchronous rejection do not block siblings or the queue", async () => {
	const gate = deferred<RunOutcome>();
	const starts: string[] = [];
	const executor = new ForegroundExecutor({ maxConcurrent: 2, run: (input) => {
		starts.push(input.prompt);
		if (input.prompt === "throws") throw new Error("sync failure");
		if (input.prompt === "rejects") return Promise.reject("async failure");
		return input.prompt === "sibling" ? gate.promise : Promise.resolve(finished("last"));
	} });
	const calls = ["throws", "sibling", "rejects", "last"].map((prompt) => executor.execute(options(prompt)));
	assert.deepEqual(await calls[0], failedOutcome(new Error("sync failure")));
	assert.deepEqual(await calls[2], failedOutcome("async failure"));
	assert.equal((await calls[3]).responseText, "last");
	assert.equal(executor.runningCount, 1);
	assert.deepEqual(starts, ["throws", "sibling", "rejects", "last"]);
	gate.resolve(finished());
	await Promise.all(calls);
	assert.equal(executor.runningCount, 0);
	assert.equal(executor.queuedCount, 0);
	await executor.dispose();
});

test("dispose is idempotent, aborts running and queued calls, and rejects new work", async () => {
	const gate = deferred<RunOutcome>();
	const caller = new AbortController();
	const signals: AbortSignal[] = [];
	const executor = new ForegroundExecutor({ maxConcurrent: 1, run: (input) => {
		signals.push(input.signal!);
		return gate.promise;
	} });
	const running = executor.execute(options("running", caller.signal));
	const queued = executor.execute(options("queued", caller.signal));
	await flush();
	let reentered: Promise<void> | undefined;
	signals[0].addEventListener("abort", () => { reentered = executor.dispose(); }, { once: true });
	const shutdown = executor.dispose();
	assert.equal(executor.dispose(), shutdown);
	assert.equal(reentered, shutdown);
	assert.equal(signals[0].aborted, true);
	assert.equal(caller.signal.aborted, false, "disposal must not abort the caller's controller");
	assert.deepEqual(await queued, cancelledOutcome());
	assert.equal(executor.queuedCount, 0);
	let disposed = false;
	void shutdown.then(() => { disposed = true; });
	await flush();
	assert.equal(disposed, false, "shutdown waits for the active run, not just its abort signal");
	const refused = await executor.execute(options("refused"));
	assert.equal(refused.status, "failed");
	assert.match(refused.status === "failed" ? refused.error : "", /disposed/i);
	gate.resolve(cancelledOutcome());
	assert.deepEqual(await running, cancelledOutcome());
	await shutdown;
	assert.equal(executor.runningCount, 0);
	assert.equal(signals.length, 1);
	assert.equal(getEventListeners(caller.signal, "abort").length, 0);
	assert.equal(executor.dispose(), shutdown);
});

test("dispose aborts every active call and observes their rejections independently", async () => {
	const signals: AbortSignal[] = [];
	const executor = new ForegroundExecutor({ maxConcurrent: 2, run: (input) => {
		signals.push(input.signal!);
		return new Promise((_, reject) => {
			input.signal!.addEventListener("abort", () => reject(new Error("shutdown")), { once: true });
		});
	} });
	const calls = ["active one", "active two", "queued one", "queued two"]
		.map((prompt) => executor.execute(options(prompt)));
	await flush();
	assert.equal(signals.length, 2);
	await executor.dispose();
	assert.equal(signals.every((signal) => signal.aborted), true);
	assert.deepEqual(await Promise.all(calls), calls.map(() => cancelledOutcome()));
	assert.equal(signals.length, 2, "queued work never starts during shutdown");
	assert.equal(executor.runningCount, 0);
	assert.equal(executor.queuedCount, 0);
});

test("dispose before invocation cancels both granted and queued calls without starting run", async () => {
	let starts = 0;
	const executor = new ForegroundExecutor({ maxConcurrent: 1, run: async () => { starts++; return finished(); } });
	const first = executor.execute(options("first"));
	const second = executor.execute(options("second"));
	const shutdown = executor.dispose();
	assert.deepEqual(await Promise.all([first, second]), [cancelledOutcome(), cancelledOutcome()]);
	await shutdown;
	assert.equal(starts, 0);
	assert.equal(executor.runningCount, 0);
	assert.equal(executor.queuedCount, 0);
});

test("default shutdown has a 5000ms bound even when run ignores abort", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const gate = deferred<RunOutcome>();
	const caller = new AbortController();
	let signal: AbortSignal | undefined;
	const executor = new ForegroundExecutor({ run: (input) => { signal = input.signal; return gate.promise; } });
	const call = executor.execute(options("ignores abort", caller.signal));
	await flush();
	const shutdown = executor.dispose();
	let disposed = false;
	void shutdown.then(() => { disposed = true; });
	assert.equal(signal?.aborted, true);
	t.mock.timers.tick(4_999);
	await flush();
	assert.equal(disposed, false);
	t.mock.timers.tick(1);
	await shutdown;
	assert.equal(disposed, true);
	assert.equal(executor.runningCount, 1, "uncooperative work is not claimed to have stopped");
	// A late rejection is observed, releases its entry, and cannot reject dispose.
	gate.reject(new Error("late failure"));
	assert.deepEqual(await call, cancelledOutcome());
	assert.equal(executor.runningCount, 0);
	assert.equal(getEventListeners(caller.signal, "abort").length, 0);
	assert.equal(executor.dispose(), shutdown);
});

test("custom and zero shutdown deadlines are honored without forcing settlement of execute", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	for (const timeoutMs of [0, 25]) {
		const gate = deferred<RunOutcome>();
		const executor = new ForegroundExecutor({ shutdownTimeoutMs: timeoutMs, run: () => gate.promise });
		const call = executor.execute(options("uncooperative"));
		await flush();
		let callSettled = false;
		void call.then(() => { callSettled = true; });
		const shutdown = executor.dispose();
		t.mock.timers.tick(timeoutMs);
		await shutdown;
		assert.equal(callSettled, false);
		const result = { ...cancelledOutcome(), responseText: "partial", cleanupWarning: "still unwinding" };
		gate.resolve(result);
		assert.equal(await call, result);
		assert.equal(executor.runningCount, 0);
	}
});

test("empty disposal is repeatable and default runner is never invoked for pre-cancelled work", async () => {
	const executor = new ForegroundExecutor();
	const caller = new AbortController();
	caller.abort();
	assert.deepEqual(await executor.execute(options("skip", caller.signal)), cancelledOutcome());
	const shutdown = executor.dispose();
	assert.equal(executor.dispose(), shutdown);
	await shutdown;
	assert.equal((await executor.execute(options("refused"))).status, "failed");
	assert.equal(executor.runningCount, 0);
	assert.equal(executor.queuedCount, 0);
});

test("invalid executor limits fail early rather than strand queued work", () => {
	for (const maxConcurrent of [0, -1, 1.5, NaN, Infinity]) {
		assert.throws(() => new ForegroundExecutor({ maxConcurrent }), /maxConcurrent/);
	}
	for (const shutdownTimeoutMs of [-1, NaN, Infinity]) {
		assert.throws(() => new ForegroundExecutor({ shutdownTimeoutMs }), /shutdownTimeoutMs/);
	}
});
