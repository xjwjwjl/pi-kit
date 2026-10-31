import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import workingStatusExtension, { formatDuration } from "../index.ts";

type Handler = (event: any, ctx: any) => void | Promise<void>;

type Usage = {
	input: number;
	output: number;
	cacheRead: number;
	cost: { total: number };
};

function usage(input: number, output: number, cacheRead = 0, cost = 0): Usage {
	return { input, output, cacheRead, cost: { total: cost } };
}

function createHarness() {
	const handlers = new Map<string, Handler>();
	const notifications: string[] = [];
	const workingMessages: Array<string | undefined> = [];
	const widgetCalls: unknown[][] = [];
	const pi = {
		on(name: string, handler: Handler) {
			handlers.set(name, handler);
		},
	};
	const ctx = {
		hasUI: true,
		ui: {
			theme: {
				fg: (_color: string, value: string) => value,
				bold: (value: string) => value,
			},
			setWorkingMessage: (message?: string) => workingMessages.push(message),
			setWidget: (...args: unknown[]) => widgetCalls.push(args),
			notify: (message: string) => notifications.push(message),
		},
	};

	workingStatusExtension(pi as never);

	return {
		notifications,
		workingMessages,
		widgetCalls,
		emit: async (name: string, event: any = {}) => {
			const handler = handlers.get(name);
			assert.ok(handler, `missing handler: ${name}`);
			await handler(event, ctx);
		},
	};
}

function createTimedHarness(t: TestContext) {
	t.mock.timers.enable({ apis: ["Date", "setInterval", "setTimeout"], now: 10_000 });
	t.mock.method(performance, "now", () => Date.now());
	const harness = createHarness();
	t.after(() => harness.emit("session_shutdown"));
	return { ...harness, tick: (ms: number) => t.mock.timers.tick(ms) };
}

async function beginRequest(harness: ReturnType<typeof createHarness>): Promise<void> {
	await harness.emit("session_start");
	await harness.emit("agent_start");
	await harness.emit("turn_start", { turnIndex: 0 });
	await harness.emit("before_provider_request");
}

async function emitStreamDelta(
	harness: ReturnType<typeof createHarness>,
	delta: string,
	type: "text_delta" | "thinking_delta" = "text_delta",
): Promise<void> {
	await harness.emit("message_update", {
		message: { role: "assistant" },
		assistantMessageEvent: { type, delta },
	});
}

async function finishRequest(harness: ReturnType<typeof createHarness>): Promise<string> {
	await harness.emit("message_end", {
		message: { role: "assistant", stopReason: "stop", usage: usage(10, 100) },
	});
	await harness.emit("turn_end");
	await harness.emit("agent_end");
	await harness.emit("agent_settled");
	return harness.notifications.at(-1) ?? "";
}

for (const type of ["text_delta", "thinking_delta"] as const) {
	test(`keeps summary TPS when whitespace arrives separately in ${type}`, async (t) => {
		const harness = createTimedHarness(t);
		const whitespace = [" ", "\n", "\r\n", "\t"];

		for (const separateWhitespace of [false, true]) {
			await beginRequest(harness);
			await harness.emit("after_provider_response", { status: 200, headers: {} });
			for (let index = 0; index < whitespace.length; index += 1) {
				if (index > 0) harness.tick(250);
				await emitStreamDelta(harness, `abcdefghij${separateWhitespace ? "" : whitespace[index]}`, type);
				harness.tick(250);
				if (separateWhitespace) await emitStreamDelta(harness, whitespace[index]!, type);
			}

			assert.match(harness.workingMessages.at(-1) ?? "", /~4\.88 tok\/s/);
			assert.match(await finishRequest(harness), /~4\.88 tok\/s/);
		}
	});
}

test("does not invent TPS for whitespace-only output", async (t) => {
	const harness = createTimedHarness(t);
	await beginRequest(harness);
	await harness.emit("after_provider_response", { status: 200, headers: {} });
	for (const delta of [" ", "\n", "\t", "\r\n"]) {
		await emitStreamDelta(harness, delta);
		harness.tick(250);
	}

	assert.doesNotMatch(harness.workingMessages.at(-1) ?? "", /tok\/s/);
	assert.doesNotMatch(await finishRequest(harness), /tok\/s/);
});

test("keeps live and summary TPS aligned across a tool boundary", async (t) => {
	const harness = createTimedHarness(t);
	await beginRequest(harness);
	await harness.emit("after_provider_response", { status: 200, headers: {} });
	const delta = "x".repeat(41); // Approximately 10 tokens per delta.
	await emitStreamDelta(harness, delta);
	for (let index = 0; index < 2; index += 1) {
		harness.tick(250);
		await emitStreamDelta(harness, delta);
	}
	harness.tick(100);
	assert.match(harness.workingMessages.at(-1) ?? "", /~40 tok\/s/);

	for (const type of ["toolcall_start", "toolcall_delta", "toolcall_end"]) {
		harness.tick(250);
		await harness.emit("message_update", {
			message: { role: "assistant" },
			assistantMessageEvent: { type, delta: type === "toolcall_delta" ? "{}" : undefined },
		});
		harness.tick(100);
		assert.match(harness.workingMessages.at(-1) ?? "", /~40 tok\/s/);
	}

	harness.tick(250);
	await emitStreamDelta(harness, delta);
	for (let index = 0; index < 2; index += 1) {
		harness.tick(250);
		await emitStreamDelta(harness, delta);
	}

	harness.tick(100);
	assert.match(harness.workingMessages.at(-1) ?? "", /~40 tok\/s/);
	assert.match(await finishRequest(harness), /~40 tok\/s/);
});

test("keeps valid summary TPS before and after a buffered burst", async (t) => {
	const harness = createTimedHarness(t);
	await beginRequest(harness);
	const delta = "x".repeat(41);
	await emitStreamDelta(harness, delta);
	for (let index = 0; index < 2; index += 1) {
		harness.tick(250);
		await emitStreamDelta(harness, delta);
	}
	harness.tick(250);
	await emitStreamDelta(harness, "x".repeat(4_100));
	for (let index = 0; index < 6; index += 1) {
		harness.tick(250);
		await emitStreamDelta(harness, delta);
	}

	harness.tick(100);
	assert.match(harness.workingMessages.at(-1) ?? "", /~40 tok\/s/);
	const summary = await finishRequest(harness);
	assert.match(summary, /~40 tok\/s/);
	assert.match(summary, /↓100/); // Provider usage remains independent of the rate filter.
});

test("coalesces burst renders while still showing the final count", async (t) => {
	const harness = createTimedHarness(t);
	await beginRequest(harness);
	await harness.emit("after_provider_response", { status: 200, headers: {} });

	// A fast burst must not render once per delta. The leading render is immediate
	// and the remainder collapse into a single trailing render.
	const rendersBeforeBurst = harness.workingMessages.length;
	for (let index = 0; index < 40; index += 1) await emitStreamDelta(harness, "chunk ");
	const leadingRenders = harness.workingMessages.length - rendersBeforeBurst;
	assert.ok(leadingRenders <= 1, `expected at most one leading render, got ${leadingRenders}`);

	harness.tick(100);
	const burstRenders = harness.workingMessages.length - rendersBeforeBurst;
	assert.ok(burstRenders <= 2, `expected a leading and at most one trailing render, got ${burstRenders}`);
	// The trailing render must carry the complete burst, not a stale count.
	// 40 trimmed "chunk" deltas estimate to 40 * 5/4.1 = 49 tokens.
	assert.match(harness.workingMessages.at(-1) ?? "", /↓~49/);

	// A lifecycle render supersedes a pending trailing render instead of duplicating it.
	await emitStreamDelta(harness, "chunk ");
	const beforeSettle = harness.workingMessages.length;
	await harness.emit("message_end", {
		message: { role: "assistant", stopReason: "stop", usage: usage(10, 100) },
	});
	// The lifecycle render shows the finalized values...
	assert.match(harness.workingMessages.at(-1) ?? "", /↓100 ↑10/);
	// ...and cancels the pending trailing render: at most the lifecycle render and
	// one interval render may land, never a third duplicate from the old timer.
	harness.tick(100);
	const added = harness.workingMessages.length - beforeSettle;
	assert.ok(added >= 1 && added <= 2, `expected 1-2 renders after settle, got ${added}`);
});

test("formats run durations from milliseconds through hours", () => {
	assert.equal(formatDuration(0), "0ms");
	assert.equal(formatDuration(999), "999ms");
	assert.equal(formatDuration(1_200), "1.2s");
	assert.equal(formatDuration(59_400), "59.4s");
	assert.equal(formatDuration(60_000), "1m");
	assert.equal(formatDuration(200_000), "3m20s");
	assert.equal(formatDuration(3_599_000), "59m59s");
	assert.equal(formatDuration(3_600_000), "1h");
	assert.equal(formatDuration(4_500_000), "1h15m");
	assert.equal(formatDuration(90_030_000), "25h");
});

test("renders live metrics through Pi's working status instead of an editor widget", async () => {
	const harness = createHarness();

	await harness.emit("session_start");
	await harness.emit("agent_start");
	await harness.emit("turn_start", { turnIndex: 0 });
	await harness.emit("before_provider_request");
	await harness.emit("message_update", {
		message: { role: "assistant" },
		assistantMessageEvent: { type: "text_delta", delta: "streaming response" },
	});

	assert.equal(harness.widgetCalls.length, 0);
	assert.ok(harness.workingMessages.some((message) => message?.startsWith("Working | ") && message.includes("↓")));

	await harness.emit("agent_settled");
	// The final metrics stay visible briefly before the working area clears.
	assert.ok(harness.workingMessages.at(-1)?.includes("↓"));
});

test("keeps token and cost metrics in one group", async () => {
	const harness = createHarness();

	await harness.emit("session_start");
	await harness.emit("agent_start");
	await harness.emit("turn_start", { turnIndex: 0 });
	await harness.emit("before_provider_request");
	await harness.emit("message_end", {
		message: {
			role: "assistant",
			stopReason: "stop",
			usage: usage(100, 20, 30, 0.1),
		},
	});

	const message = harness.workingMessages.at(-1) ?? "";
	assert.equal((message.match(/\|/g) ?? []).length, 2);
	assert.match(message, /↓20 ↑100 CH23% \$0\.1000/);
});

async function emitSuccessfulTurn(
	harness: ReturnType<typeof createHarness>,
	turnIndex: number,
	turnUsage: Usage,
): Promise<void> {
	await harness.emit("turn_start", { turnIndex });
	await harness.emit("before_provider_request");
	await harness.emit("message_end", {
		message: { role: "assistant", stopReason: "stop", usage: turnUsage },
	});
	await harness.emit("turn_end");
	await harness.emit("agent_end");
}

test("preserves usage across automatic error retries and resets after settlement", async () => {
	const harness = createHarness();

	await harness.emit("session_start");
	await harness.emit("agent_start");
	await emitSuccessfulTurn(harness, 0, usage(100, 20, 3, 0.1));

	// Pi starts a new agent attempt for an automatic retry. The previous totals
	// must remain visible instead of being reset by this agent_start.
	await harness.emit("agent_start");
	await harness.emit("turn_start", { turnIndex: 1 });
	await harness.emit("before_provider_request");
	await harness.emit("message_end", {
		message: {
			role: "assistant",
			stopReason: "error",
			errorMessage: "Connection error.",
			usage: usage(0, 0),
		},
	});
	await harness.emit("turn_end");
	await harness.emit("agent_end");

	await harness.emit("agent_start");
	await emitSuccessfulTurn(harness, 2, usage(50, 10, 2, 0.2));
	await harness.emit("agent_settled");

	assert.equal(harness.notifications.length, 1);
	assert.match(harness.notifications[0]!, /↑150/);
	assert.match(harness.notifications[0]!, /↓30/);
	assert.match(harness.notifications[0]!, /CH5/);
	assert.match(harness.notifications[0]!, /\$0\.300/);

	// The next user prompt is a new run and must not inherit the old totals.
	await harness.emit("agent_start");
	await emitSuccessfulTurn(harness, 0, usage(5, 2));
	await harness.emit("agent_settled");

	assert.equal(harness.notifications.length, 2);
	assert.match(harness.notifications[1]!, /↑5/);
	assert.match(harness.notifications[1]!, /↓2/);
	assert.doesNotMatch(harness.notifications[1]!, /↑155/);
});

test("treats terminated as a failed request without losing prior usage", async () => {
	const harness = createHarness();

	await harness.emit("session_start");
	await harness.emit("agent_start");
	await emitSuccessfulTurn(harness, 0, usage(40, 8, 1, 0.05));

	await harness.emit("agent_start");
	await harness.emit("turn_start", { turnIndex: 1 });
	await harness.emit("before_provider_request");
	await harness.emit("message_end", {
		message: {
			role: "assistant",
			stopReason: "error",
			errorMessage: "terminated",
			usage: usage(0, 0),
		},
	});
	await harness.emit("turn_end");
	await harness.emit("agent_end");
	await harness.emit("agent_settled");

	assert.equal(harness.notifications.length, 1);
	assert.match(harness.notifications[0]!, /↑40/);
	assert.match(harness.notifications[0]!, /↓8/);
	assert.match(harness.notifications[0]!, /CH1/);
	assert.doesNotMatch(harness.notifications[0]!, /avg first/);
});

test("prefers reported output when a failed response has partial usage", async () => {
	const harness = createHarness();

	await harness.emit("session_start");
	await harness.emit("agent_start");
	await harness.emit("turn_start", { turnIndex: 0 });
	await harness.emit("before_provider_request");
	await harness.emit("message_update", {
		message: { role: "assistant" },
		assistantMessageEvent: { type: "text_delta", delta: "partial response with provider usage" },
	});
	await harness.emit("message_end", {
		message: {
			role: "assistant",
			stopReason: "error",
			errorMessage: "429 rate limit exceeded",
			usage: usage(20, 17),
		},
	});
	await harness.emit("turn_end");
	await harness.emit("agent_end");
	await harness.emit("agent_settled");

	assert.equal(harness.notifications.length, 1);
	assert.match(harness.notifications[0]!, /↑20/);
	assert.match(harness.notifications[0]!, /↓17/);
	assert.doesNotMatch(harness.notifications[0]!, /avg first/);
});

test("falls back to locally estimated output when a successful response reports zero usage", async () => {
	const harness = createHarness();

	await harness.emit("session_start");
	await harness.emit("agent_start");
	await harness.emit("turn_start", { turnIndex: 0 });
	await harness.emit("before_provider_request");
	await harness.emit("message_update", {
		message: { role: "assistant" },
		assistantMessageEvent: { type: "text_delta", delta: "streamed response" },
	});
	await harness.emit("message_end", {
		message: {
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text: "streamed response" }],
			usage: usage(10, 0),
		},
	});
	await harness.emit("turn_end");
	await harness.emit("agent_end");
	await harness.emit("agent_settled");

	assert.equal(harness.notifications.length, 1);
	assert.match(harness.notifications[0]!, /↓[1-9]/);
});

test("uses final assistant content when a failed response has no streamed deltas", async () => {
	const harness = createHarness();

	await harness.emit("session_start");
	await harness.emit("agent_start");
	await harness.emit("turn_start", { turnIndex: 0 });
	await harness.emit("before_provider_request");
	await harness.emit("message_end", {
		message: {
			role: "assistant",
			stopReason: "error",
			errorMessage: "Request timed out.",
			content: [{ type: "text", text: "partial response returned before timeout" }],
			usage: usage(0, 0),
		},
	});
	await harness.emit("turn_end");
	await harness.emit("agent_end");
	await harness.emit("agent_settled");

	assert.equal(harness.notifications.length, 1);
	assert.match(harness.notifications[0]!, /↓[1-9]/);
	assert.doesNotMatch(harness.notifications[0]!, /avg first/);
});

test("keeps normal length completions in request averages", async () => {
	const harness = createHarness();

	await harness.emit("session_start");
	await harness.emit("agent_start");
	await harness.emit("turn_start", { turnIndex: 0 });
	await harness.emit("before_provider_request");
	await harness.emit("message_update", {
		message: { role: "assistant" },
		assistantMessageEvent: { type: "text_delta", delta: "truncated response" },
	});
	await new Promise((resolve) => setTimeout(resolve, 2));
	await harness.emit("message_end", {
		message: {
			role: "assistant",
			stopReason: "length",
			errorMessage: "provider diagnostic that is not a failed stop reason",
			usage: usage(10, 7),
		},
	});
	await harness.emit("turn_end");
	await harness.emit("agent_end");
	await harness.emit("agent_settled");

	assert.equal(harness.notifications.length, 1);
	assert.match(harness.notifications[0]!, /↑10/);
	assert.match(harness.notifications[0]!, /↓7/);
	assert.match(harness.notifications[0]!, /avg first/);
});

test("keeps estimating partial output when a provider error has zero usage", async () => {
	const harness = createHarness();

	await harness.emit("session_start");
	await harness.emit("agent_start");
	await harness.emit("turn_start", { turnIndex: 0 });
	await harness.emit("before_provider_request");
	await harness.emit("message_update", {
		message: { role: "assistant" },
		assistantMessageEvent: { type: "text_delta", delta: "partial response" },
	});
	await harness.emit("message_end", {
		message: {
			role: "assistant",
			stopReason: "error",
			errorMessage: "Connection error.",
			usage: usage(0, 0),
		},
	});
	await harness.emit("turn_end");
	await harness.emit("agent_end");
	await harness.emit("agent_settled");

	assert.equal(harness.notifications.length, 1);
	assert.match(harness.notifications[0]!, /↓[1-9]/);
});

test("keeps the TPS detail when the terminal cannot fit every metric", async () => {
	const originalColumns = process.stdout.columns;
	process.stdout.columns = 46;
	try {
		const harness = createHarness();

		await harness.emit("session_start");
		await harness.emit("agent_start");
		await harness.emit("turn_start", { turnIndex: 0 });
		await harness.emit("before_provider_request");
		await harness.emit("message_update", {
			message: { role: "assistant" },
			assistantMessageEvent: { type: "text_delta", delta: "streaming response" },
		});
		await new Promise((resolve) => setTimeout(resolve, 300));
		await harness.emit("message_update", {
			message: { role: "assistant" },
			assistantMessageEvent: { type: "text_delta", delta: " more text" },
		});
		// Delta renders are coalesced; wait for the trailing render.
		await new Promise((resolve) => setTimeout(resolve, 120));

		const message = harness.workingMessages.at(-1) ?? "";
		assert.match(message, /tok\/s/);
		assert.doesNotMatch(message, /first/);
	} finally {
		process.stdout.columns = originalColumns;
	}
});

function parseFirstOutputWaitMs(message: string): number | null {
	const match = message.match(/avg first (?:(\d+)ms|([\d.]+)s|(\d+)m(?:(\d+)s)?)/);
	if (!match) return null;
	if (match[1] != null) return Number(match[1]);
	if (match[2] != null) return Number(match[2]) * 1000;
	const minutes = Number(match[3]);
	const seconds = match[4] == null ? 0 : Number(match[4]);
	return (minutes * 60 + seconds) * 1000;
}

test("counts first from the request through response setup and freezes on output", async (t) => {
	const harness = createTimedHarness(t);
	await beginRequest(harness);
	harness.tick(10_000);
	await harness.emit("after_provider_response", { status: 429, headers: {} });
	harness.tick(5_000);
	assert.match(harness.workingMessages.at(-1) ?? "", /first 15\.0s/);

	await harness.emit("after_provider_response", { status: 200, headers: {} });
	assert.match(harness.workingMessages.at(-1) ?? "", /first 15\.0s/);
	harness.tick(250);
	await harness.emit("message_start", { message: { role: "assistant", timestamp: Date.now() } });
	assert.match(harness.workingMessages.at(-1) ?? "", /first 15\.3s/);
	harness.tick(750);
	await emitStreamDelta(harness, "hello");
	harness.tick(2_000);
	assert.match(harness.workingMessages.at(-1) ?? "", /first 16\.0s/);
	assert.equal(parseFirstOutputWaitMs(await finishRequest(harness)), 16_000);
});

test("includes WebSocket connection and pre-event waiting in first", async (t) => {
	const harness = createTimedHarness(t);
	await beginRequest(harness);
	harness.tick(15_000);
	assert.match(harness.workingMessages.at(-1) ?? "", /first 15\.0s/);

	await harness.emit("message_start", { message: { role: "assistant", timestamp: Date.now() } });
	assert.match(harness.workingMessages.at(-1) ?? "", /first 15\.0s/);
	harness.tick(1_000);
	await emitStreamDelta(harness, "hello");
	assert.match(harness.workingMessages.at(-1) ?? "", /first 16\.0s/);
	assert.equal(parseFirstOutputWaitMs(await finishRequest(harness)), 16_000);
});

test("measures first from the request even without response or message-start hooks", async (t) => {
	const harness = createTimedHarness(t);
	await beginRequest(harness);
	assert.match(harness.workingMessages.at(-1) ?? "", /first 0ms/);
	harness.tick(15_000);
	assert.match(harness.workingMessages.at(-1) ?? "", /first 15\.0s/);

	await emitStreamDelta(harness, "hello");
	assert.match(harness.workingMessages.at(-1) ?? "", /first 15\.0s/);
	harness.tick(1_000);
	assert.equal(parseFirstOutputWaitMs(await finishRequest(harness)), 15_000);
});

test("omits first from completed requests with no streamed output", async (t) => {
	const harness = createTimedHarness(t);
	await beginRequest(harness);
	await harness.emit("after_provider_response", { status: 200, headers: {} });
	harness.tick(1_000);
	assert.match(harness.workingMessages.at(-1) ?? "", /first 1\.0s/);

	assert.doesNotMatch(await finishRequest(harness), /first/);
	assert.doesNotMatch(harness.workingMessages.at(-1) ?? "", /first/);
});

test("falls back to the assistant timestamp when the request hook is unavailable", async (t) => {
	const harness = createTimedHarness(t);
	await harness.emit("session_start");
	await harness.emit("agent_start");
	await harness.emit("turn_start", { turnIndex: 0 });
	const timestamp = Date.now();
	harness.tick(500);
	await harness.emit("message_start", { message: { role: "assistant", timestamp } });
	assert.match(harness.workingMessages.at(-1) ?? "", /first 500ms/);
	harness.tick(500);
	await emitStreamDelta(harness, "hello");
	assert.equal(parseFirstOutputWaitMs(await finishRequest(harness)), 1_000);
});

test("reports locally streamed output over the measured flow time", async () => {
	const harness = createHarness();

	await harness.emit("session_start");
	await harness.emit("agent_start");
	await harness.emit("turn_start", { turnIndex: 0 });
	await harness.emit("before_provider_request");
	await harness.emit("after_provider_response", { status: 200, headers: {} });
	// A long silent wait before the first token must not dilute the rate.
	await new Promise((resolve) => setTimeout(resolve, 2_000));
	// A buffered first chunk is a baseline, not instantaneous throughput.
	await harness.emit("message_update", {
		message: { role: "assistant" },
		assistantMessageEvent: { type: "text_delta", delta: "x".repeat(10_000) },
	});
	await emitStableRate(harness, 3);
	await harness.emit("message_end", {
		// Provider output may include hidden reasoning; it must not inflate the
		// user-facing TPS beyond the locally observed text/thinking stream.
		message: { role: "assistant", stopReason: "stop", usage: usage(10, 4_000) },
	});
	await harness.emit("turn_end");
	await harness.emit("agent_end");
	await harness.emit("agent_settled");

	const line = harness.notifications[0] ?? "";
	assert.match(line, /~[\d.]+ tok\/s(?!.*\|)/);
	// The baseline burst plus three 250ms deltas leave a 750ms flow window. The
	// 4k provider count remains visible in ↓, while TPS stays near the post-
	// baseline locally observed stream.
	const rate = Number(line.match(/~([\d.]+) tok\/s/)?.[1]);
	assert.match(line, /↓4\.0k/);
	assert.ok(rate > 0 && rate < 100, `provider-only output must not inflate TPS: ${line}`);
});

test("includes failed transport attempts and retry backoff within one request in first", async (t) => {
	const harness = createTimedHarness(t);
	await beginRequest(harness);
	harness.tick(100);
	await harness.emit("after_provider_response", { status: 429, headers: {} });
	harness.tick(400);
	await harness.emit("after_provider_response", { status: 503, headers: {} });
	harness.tick(500);
	await harness.emit("after_provider_response", { status: 200, headers: {} });
	harness.tick(100);
	await emitStreamDelta(harness, "hello");

	assert.equal(parseFirstOutputWaitMs(await finishRequest(harness)), 1_100);
});

test("freezes first on tool-only output and not on later argument deltas", async (t) => {
	const harness = createTimedHarness(t);
	await beginRequest(harness);
	harness.tick(3_500);
	await harness.emit("message_update", {
		message: { role: "assistant" },
		assistantMessageEvent: { type: "toolcall_start" },
	});
	harness.tick(1_000);
	await harness.emit("message_update", {
		message: { role: "assistant" },
		assistantMessageEvent: { type: "toolcall_delta", delta: "{}" },
	});
	assert.match(harness.workingMessages.at(-1) ?? "", /first 3\.5s/);
	assert.equal(parseFirstOutputWaitMs(await finishRequest(harness)), 3_500);
});

test("skips the average stream rate when nothing streamed", async () => {
	const harness = createHarness();

	await harness.emit("session_start");
	await harness.emit("agent_start");
	await harness.emit("turn_start", { turnIndex: 0 });
	await harness.emit("before_provider_request");
	await harness.emit("after_provider_response", { status: 200, headers: {} });
	await harness.emit("message_end", {
		message: {
			role: "assistant",
			stopReason: "toolUse",
			content: [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.ts" } }],
			usage: usage(10, 7),
		},
	});
	await harness.emit("turn_end");
	await harness.emit("agent_end");
	await harness.emit("agent_settled");

	// No streamed activity means no flow window to divide by, so a rate would be
	// meaningless even though the provider reported output tokens.
	assert.doesNotMatch(harness.notifications[0]!, /tok\/s/);
});

/** Emit enough evenly spread deltas for the tracker to publish a stable rate. */
async function emitStableRate(harness: ReturnType<typeof createHarness>, deltas = 4): Promise<void> {
	for (let index = 0; index < deltas; index += 1) {
		await harness.emit("message_update", {
			message: { role: "assistant" },
			assistantMessageEvent: { type: "text_delta", delta: "streaming output " },
		});
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
}

test("keeps the retained rate instead of the burst-derived provisional value", async () => {
	const harness = createHarness();

	await harness.emit("session_start");
	await harness.emit("agent_start");
	await harness.emit("turn_start", { turnIndex: 0 });
	await harness.emit("before_provider_request");
	await emitStableRate(harness);
	assert.match(harness.workingMessages.at(-1) ?? "", /tok\/s/);

	// A single buffered chunk must not replace the confident rate with a
	// provisional number derived from that same burst.
	await harness.emit("message_update", {
		message: { role: "assistant" },
		assistantMessageEvent: { type: "text_delta", delta: "x".repeat(2_000) },
	});

	const message = harness.workingMessages.at(-1) ?? "";
	assert.match(message, /~[\d.]+ tok\/s/);
	assert.doesNotMatch(message, /≈/);
});

test("keeps the retained rate visible during a mid-stream pause", async () => {
	const harness = createHarness();

	await harness.emit("session_start");
	await harness.emit("agent_start");
	await harness.emit("turn_start", { turnIndex: 0 });
	await harness.emit("before_provider_request");
	await emitStableRate(harness);

	const before = harness.workingMessages.at(-1) ?? "";
	const beforeRate = before.match(/~([\d.]+) tok\/s/);
	assert.ok(beforeRate, `expected a stable TPS in: ${before}`);

	// The stream is still open, but no output arrives for longer than the gap.
	await new Promise((resolve) => setTimeout(resolve, 2_200));

	const after = harness.workingMessages.at(-1) ?? "";
	const afterRate = after.match(/~([\d.]+) tok\/s/);
	assert.ok(afterRate, `expected the retained TPS in: ${after}`);
	assert.equal(afterRate[1], beforeRate[1]);
});

test("resets the TPS measurement window when a new turn starts", async () => {
	const harness = createHarness();

	await harness.emit("session_start");
	await harness.emit("agent_start");
	await harness.emit("turn_start", { turnIndex: 0 });
	await harness.emit("before_provider_request");
	await emitStableRate(harness);
	assert.match(harness.workingMessages.at(-1) ?? "", /tok\/s/);

	await harness.emit("turn_end");
	await harness.emit("turn_start", { turnIndex: 1 });

	// A new turn is a new measurement window: the previous turn's rate must not
	// survive as a stale or retained value.
	assert.doesNotMatch(harness.workingMessages.at(-1) ?? "", /tok\/s/);
});

test("does not carry streamed output across provider attempts in one turn", async () => {
	const harness = createHarness();

	await harness.emit("session_start");
	await harness.emit("agent_start");
	await harness.emit("turn_start", { turnIndex: 0 });
	await harness.emit("before_provider_request");
	await harness.emit("message_update", {
		message: { role: "assistant" },
		assistantMessageEvent: { type: "text_delta", delta: "partial response from the failed attempt" },
	});
	await harness.emit("turn_end");
	const committed = parseDownTokens(harness.workingMessages.at(-1) ?? "");
	assert.ok(committed, "expected the partial stream to be committed as a total");

	// Pi retries inside the same turn, so nothing else clears the in-flight
	// estimate: the new request must not start on top of the previous attempt's
	// stream, or the committed output would be counted twice.
	await harness.emit("before_provider_request");
	assert.equal(parseDownTokens(harness.workingMessages.at(-1) ?? ""), committed);
});

function parseDownTokens(message: string): string | null {
	return message.match(/↓~?([\d.]+[kM]?)/)?.[1] ?? null;
}

test("clears the working status and stops refreshing on session shutdown", async () => {
	const harness = createHarness();

	await harness.emit("session_start");
	await harness.emit("agent_start");
	await harness.emit("turn_start", { turnIndex: 0 });
	await harness.emit("before_provider_request");
	await harness.emit("message_update", {
		message: { role: "assistant" },
		assistantMessageEvent: { type: "text_delta", delta: "streaming response" },
	});

	await harness.emit("session_shutdown");
	assert.equal(harness.workingMessages.at(-1), undefined);

	// The refresh interval must not outlive the session.
	const rendersAfterShutdown = harness.workingMessages.length;
	await new Promise((resolve) => setTimeout(resolve, 600));
	assert.equal(harness.workingMessages.length, rendersAfterShutdown);
});
