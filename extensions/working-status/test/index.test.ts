import assert from "node:assert/strict";
import test from "node:test";
import workingStatusExtension from "../index.ts";

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

test("times the first-output wait from the provider response, not the request hook", async () => {
	const harness = createHarness();

	await harness.emit("session_start");
	await harness.emit("agent_start");
	await harness.emit("turn_start", { turnIndex: 0 });
	await harness.emit("before_provider_request");
	// A slow WebSocket attempt or retry backoff happens before the provider answers.
	await new Promise((resolve) => setTimeout(resolve, 400));
	await harness.emit("after_provider_response", { status: 200, headers: {} });
	await harness.emit("message_update", {
		message: { role: "assistant" },
		assistantMessageEvent: { type: "text_delta", delta: "hello" },
	});
	await harness.emit("message_end", {
		message: { role: "assistant", stopReason: "stop", usage: usage(10, 7) },
	});
	await harness.emit("turn_end");
	await harness.emit("agent_end");
	await harness.emit("agent_settled");

	const line = harness.notifications[0] ?? "";
	const wait = parseFirstOutputWaitMs(line);
	assert.ok(wait != null, `expected an average first-output wait in: ${line}`);
	assert.ok(wait < 300, `wait must exclude the pre-response delay: ${line}`);
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

test("ignores failed provider attempts when timing the first output", async () => {
	const harness = createHarness();

	await harness.emit("session_start");
	await harness.emit("agent_start");
	await harness.emit("turn_start", { turnIndex: 0 });
	await harness.emit("before_provider_request");
	// A retryable failure arrives fast, then the provider backs off and retries.
	await harness.emit("after_provider_response", { status: 429, headers: {} });
	await new Promise((resolve) => setTimeout(resolve, 400));
	await harness.emit("after_provider_response", { status: 200, headers: {} });
	await harness.emit("message_update", {
		message: { role: "assistant" },
		assistantMessageEvent: { type: "text_delta", delta: "hello" },
	});
	await harness.emit("message_end", {
		message: { role: "assistant", stopReason: "stop", usage: usage(10, 7) },
	});
	await harness.emit("turn_end");
	await harness.emit("agent_end");
	await harness.emit("agent_settled");

	const line = harness.notifications[0] ?? "";
	const wait = parseFirstOutputWaitMs(line);
	assert.ok(wait != null, `expected an average first-output wait in: ${line}`);
	assert.ok(wait < 300, `wait must start at the successful response, not the 429: ${line}`);
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
