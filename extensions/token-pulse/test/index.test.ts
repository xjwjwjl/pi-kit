import assert from "node:assert/strict";
import test from "node:test";
import tokenPulseExtension from "../index.ts";

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
			setWidget: () => undefined,
			notify: (message: string) => notifications.push(message),
		},
	};

	tokenPulseExtension(pi as never);

	return {
		notifications,
		emit: async (name: string, event: any = {}) => {
			const handler = handlers.get(name);
			assert.ok(handler, `missing handler: ${name}`);
			await handler(event, ctx);
		},
	};
}

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
	assert.match(harness.notifications[0]!, /R5/);
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
	assert.match(harness.notifications[0]!, /R1/);
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
