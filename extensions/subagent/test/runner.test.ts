import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
	GRACE_TURNS,
	childExcludeTools,
	collectResponseText,
	extractText,
	accountRun,
	observeRun,
	runOnce,
	turnLimitAction,
} from "../src/runner.ts";

/** A session stub exposing only what the runner touches. */
function fakeSession(
	messages: unknown[] = [],
	options: {
		onPrompt?: (context: { emit: (event: unknown) => void; session: AgentSession; prompt: string }) => void | Promise<void>;
		steer?: (text: string) => Promise<unknown>;
		abort?: () => Promise<unknown>;
	} = {},
): {
	session: AgentSession;
	emit: (event: unknown) => void;
	steered: string[];
	aborts: () => number;
} {
	const listeners: Array<(event: unknown) => void> = [];
	const steered: string[] = [];
	let aborts = 0;

	const emit = (event: unknown): void => {
		for (const listener of [...listeners]) listener(event);
	};

	const session = {
		messages,
		sessionManager: { getSessionFile: () => undefined },
		dispose: () => {},
		subscribe: (handler: (event: unknown) => void) => {
			listeners.push(handler);
			return () => {
				const index = listeners.indexOf(handler);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		// Both are async on the real session, so a throwing input handler or abort
		// hook rejects them. Recording before delegating keeps the existing tests'
		// synchronous assertions working.
		steer: async (text: string) => {
			steered.push(text);
			await options.steer?.(text);
		},
		abort: async () => {
			aborts += 1;
			await options.abort?.();
		},
		prompt: async (prompt: string) => {
			await options.onPrompt?.({ emit, session: session as unknown as AgentSession, prompt });
		},
	};

	return {
		session: session as unknown as AgentSession,
		emit,
		steered,
		aborts: () => aborts,
	};
}

function assistant(text: string, extra: Record<string, unknown> = {}): unknown {
	return { role: "assistant", content: [{ type: "text", text }], stopReason: "stop", ...extra };
}

/** Replay only this invocation's events; preexisting session messages are not replayed. */
function replay(messages: readonly unknown[], startIndex = 0) {
	const fake = fakeSession([...messages.slice(0, startIndex)]);
	const account = accountRun(fake.session);
	for (const message of messages.slice(startIndex)) fake.emit({ type: "message_end", message });
	account.unsubscribe();
	return { text: account.text, failure: account.failure, usage: account.usage, toolUses: account.toolUses };
}

function runFake(session: AgentSession, prompt: string) {
	return runOnce({ cwd: process.cwd(), modelRegistry: {} as never, prompt }, { createSession: async () => session });
}

test("extractText handles strings, text blocks and non-text blocks", () => {
	assert.equal(extractText("plain"), "plain");
	assert.equal(
		extractText([
			{ type: "text", text: "one" },
			{ type: "tool_use", name: "read" },
			{ type: "text", text: "two" },
		]),
		"one\ntwo",
	);
	assert.equal(extractText(undefined), "");
	assert.equal(extractText([{ type: "tool_use" }]), "");
});

test("turnLimitAction does nothing without a limit", () => {
	assert.equal(turnLimitAction(50, false, undefined), "none");
	assert.equal(turnLimitAction(1, false, undefined), "none");
});

test("turnLimitAction asks the agent to wrap up at the limit", () => {
	assert.equal(turnLimitAction(3, false, 5), "none");
	assert.equal(turnLimitAction(5, false, 5), "wrap-up");
});

test("turnLimitAction aborts only after the grace turns are spent", () => {
	assert.equal(turnLimitAction(5 + GRACE_TURNS - 1, true, 5), "none");
	assert.equal(turnLimitAction(5 + GRACE_TURNS, true, 5), "abort");
});

test("turnLimitAction never asks twice for the same run", () => {
	assert.equal(turnLimitAction(6, true, 5), "none", "already steered, still inside grace");
	assert.equal(turnLimitAction(9, true, 5), "none");
});

test("observeRun steers at the limit and aborts after grace", () => {
	const { session, emit, steered, aborts } = fakeSession();
	const run = observeRun(session, { maxTurns: 2 });

	emit({ type: "turn_end" });
	assert.equal(run.steered, false);
	emit({ type: "turn_end" });
	assert.equal(run.steered, true, "steered at the limit");
	assert.equal(steered.length, 1);
	assert.match(steered[0], /turn limit/);
	assert.match(steered[0], /Stop further investigation and tool calls/);
	assert.match(steered[0], /incomplete or unverified work/);
	assert.match(steered[0], /Do not claim full completion unless the acceptance criteria were met/);
	assert.equal(run.aborted, false, "not aborted yet — grace is still running");

	for (let i = 0; i < GRACE_TURNS - 1; i++) emit({ type: "turn_end" });
	assert.equal(aborts(), 0);
	emit({ type: "turn_end" });
	assert.equal(run.aborted, true);
	assert.equal(aborts(), 1);
	assert.equal(run.turns(), 2 + GRACE_TURNS);
});

test("observeRun counts turns and ignores the events it does not need", () => {
	const { session, emit } = fakeSession();
	const run = observeRun(session);
	assert.equal(run.turns(), 0);

	emit({ type: "turn_end" });
	emit({ type: "tool_execution_start", toolName: "read" });
	emit({ type: "message_end", message: { role: "assistant" } });
	emit({ type: "turn_end" });

	assert.equal(run.turns(), 2, "only turn_end advances the count");
});

test("observeRun swallows rejected steer and abort calls", async () => {
	// Both are async and can reject when an input handler or abort hook throws.
	// Nothing can act on that rejection, and under Node 24 an unhandled one can
	// terminate Pi, so the listener must not leave it floating.
	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown): void => {
		unhandled.push(reason);
	};
	process.on("unhandledRejection", onUnhandled);
	try {
		const { session, emit, steered, aborts } = fakeSession([], {
			steer: async () => {
				throw new Error("input handler exploded");
			},
			abort: async () => {
				throw new Error("abort hook exploded");
			},
		});
		const run = observeRun(session, { maxTurns: 1 });

		emit({ type: "turn_end" });
		assert.equal(run.steered, true, "the turn limit still steers");
		assert.equal(steered.length, 1, "the steer was still attempted");

		for (let i = 0; i < GRACE_TURNS; i++) emit({ type: "turn_end" });
		assert.equal(run.aborted, true, "the grace window still ends in an abort");
		assert.equal(aborts(), 1, "the abort was still attempted");

		// Let both rejections settle; without the catch they would surface here.
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(unhandled, [], "a rejected steer or abort must not escape");
	} finally {
		process.off("unhandledRejection", onUnhandled);
	}
});

test("collectResponseText accumulates deltas and resets only for a new assistant message", () => {
	const { session, emit } = fakeSession();
	const collector = collectResponseText(session);

	emit({ type: "message_start", message: { role: "assistant" } });
	emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hel" } });
	emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "lo" } });
	assert.equal(collector.getText(), "hello");

	// A user or tool-result message must not wipe collected assistant text.
	emit({ type: "message_start", message: { role: "user" } });
	assert.equal(collector.getText(), "hello");

	emit({ type: "message_start", message: { role: "assistant" } });
	assert.equal(collector.getText(), "", "a new assistant message starts a new answer");

	collector.unsubscribe();
	emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "ignored" } });
	assert.equal(collector.getText(), "");
});

test("event text walks back from the start index", () => {
	const session = fakeSession([assistant("first"), { role: "user", content: "x" }, assistant("second")]).session;
	assert.equal(replay(session.messages).text, "second");
	assert.equal(replay(session.messages, 2).text, "second");
	assert.equal(replay(session.messages, 3).text, "", "nothing produced in this invocation");
});

test("event text skips an empty final answer", () => {
	const session = fakeSession([assistant("real"), assistant("   ")]).session;
	assert.equal(replay(session.messages).text, "real");
});

test("event failure reports a provider error the run resolved normally", () => {
	const session = fakeSession([assistant("", { stopReason: "error", errorMessage: "rate limited" })]).session;
	assert.equal(replay(session.messages).failure, "rate limited");
});

test("event failure reports a silent max-token death", () => {
	const session = fakeSession([assistant("", { stopReason: "length" })]).session;
	assert.match(replay(session.messages).failure ?? "", /output token limit/);
});

test("event failure accepts a truncated answer that did produce text", () => {
	const session = fakeSession([assistant("partial but useful", { stopReason: "length" })]).session;
	assert.equal(replay(session.messages).failure, undefined);
});

test("event failure is undefined for a clean stop", () => {
	assert.equal(replay([assistant("done")]).failure, undefined);
	assert.equal(replay([]).failure, undefined);
});

test("event failure never inherits a prior turn's failure from startup history", () => {
	// No assistant event was emitted during this invocation; startup history is ignored.
	const messages = [assistant("", { stopReason: "error", errorMessage: "old failure" })];
	const session = fakeSession(messages).session;
	assert.equal(replay(session.messages, 1).failure, undefined, "nothing was produced, so nothing failed");
	assert.equal(replay(session.messages, 0).failure, "old failure", "without the boundary the old failure resurfaces");
});

test("event text never returns a prior turn's answer from startup history", () => {
	const messages = [assistant("previous answer")];
	const session = fakeSession(messages).session;
	assert.equal(replay(session.messages, 1).text, "", "this invocation produced nothing");
	assert.equal(replay(session.messages, 0).text, "previous answer");
});

test("a child loses the subagent tools whatever its definition asks for", () => {
	// A definition can add exclusions, never remove one. `excludeTools` also
	// outranks an allowlist, so naming a subagent tool in `tools` cannot restore it.
	assert.deepEqual(childExcludeTools(), ["agent", "agent_send", "agent_result", "ask_user"]);
	assert.deepEqual(childExcludeTools(["bash"]), ["agent", "agent_send", "agent_result", "ask_user", "bash"]);
	assert.deepEqual(childExcludeTools(["agent"]), ["agent", "agent_send", "agent_result", "ask_user", "agent"]);
});

test("event usage counts only this invocation's assistant turns", () => {
	// Every turn re-sends the whole conversation, so the cumulative figure is the
	// one that answers "what did this agent cost", not the size of its context.
	const prior = { role: "assistant", usage: { totalTokens: 9_999, cost: { total: 9 } } };
	const first = { role: "assistant", usage: { totalTokens: 100, cost: { total: 0.01 } } };
	const second = { role: "assistant", usage: { totalTokens: 200, cost: { total: 0.02 } } };

	assert.deepEqual(replay([prior, first, second], 1).usage, { tokens: 300, cost: 0.03 });
	assert.deepEqual(replay([prior, first, second]).usage, { tokens: 10_299, cost: 9.03 });
});

test("event tool count counts tool calls, not turns", () => {
	// One assistant turn can call several tools, and a turn with none at all is common.
	// Counting turns would report a number that never matches what the agent did, and a
	// tool-ish part on a non-assistant message must not be counted either.
	const prior = { role: "assistant", content: [{ type: "toolCall" }] };
	const first = { role: "assistant", content: [{ type: "text" }, { type: "toolCall" }, { type: "toolCall" }] };
	const second = { role: "assistant", content: [{ type: "text" }] };
	const third = { role: "assistant", content: [{ type: "toolCall" }] };
	const user = { role: "user", content: [{ type: "toolCall" }] };
	const messages = [prior, first, second, third, user];

	assert.equal(replay(messages, 1).toolUses, 3, "only this invocation's calls");
	assert.equal(replay(messages).toolUses, 4, "and only the assistant's");
});

test("event usage ignores a toolResult's own usage", () => {
	// Its docstring is explicit that it is not part of main context accounting, so
	// counting it would inflate every run that used tools.
	const messages = [
		{ role: "assistant", usage: { totalTokens: 100, cost: { total: 0.01 } } },
		{ role: "toolResult", usage: { totalTokens: 5_000, cost: { total: 5 } } },
	];
	assert.deepEqual(replay(messages).usage, { tokens: 100, cost: 0.01 });
});

test("event usage reports zero rather than NaN when the provider said nothing", () => {
	assert.deepEqual(replay([assistant("done")]).usage, { tokens: 0, cost: 0 });
	assert.deepEqual(replay([]).usage, { tokens: 0, cost: 0 });
});

test("event usage survives a usage record without a cost breakdown", () => {
	const messages = [{ role: "assistant", usage: { totalTokens: 42 } }];
	assert.deepEqual(replay(messages).usage, { tokens: 42, cost: 0 });
});

test("a mid-run compaction cannot erase this run's usage, tool uses, failure or text", async () => {
	// Startup messages must not be counted, and compaction must not erase events
	// already observed during this one-shot invocation.
	const prior = assistant("previous answer", { usage: { totalTokens: 9_999, cost: { total: 9 } } });
	const fake = fakeSession([prior], {
		onPrompt: ({ emit, session }) => {
			// A user message carries usage too; the accountant must ignore it.
			emit({ type: "message_end", message: { role: "user", content: "keep going", usage: { totalTokens: 5_000 } } });
			emit({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "fresh answer" }, { type: "toolCall" }, { type: "toolCall" }],
					stopReason: "error",
					errorMessage: "provider exploded",
					usage: { totalTokens: 1_234, cost: { total: 0.05 } },
				},
			});
			// What `_refreshFinalizedContext()` does after compaction: the message
			// array becomes a projection that no longer contains this run's turns.
			// Anything sliced from a pre-prompt index is now empty.
			(session.messages as unknown[]).length = 0;
			emit({ type: "turn_end" });
		},
	});

	const result = await runFake(fake.session, "keep going");

	assert.deepEqual(result.usage, { tokens: 1_234, cost: 0.05 }, "only this run's assistant usage is counted");
	assert.equal(result.toolUses, 2, "tool calls are counted from the run's own messages");
	assert.equal(result.status, "failed");
	assert.equal(result.status === "failed" ? result.error : "", "provider exploded", "a resolved provider error is still a failure");
	assert.equal(result.responseText, "fresh answer", "the fallback text survives the shrink");
});

test("a silent length stop survives a mid-run compaction as a failure", async () => {
	const fake = fakeSession([], {
		onPrompt: ({ emit, session }) => {
			emit({
				type: "message_end",
				message: { role: "assistant", content: [], stopReason: "length", usage: { totalTokens: 42 } },
			});
			(session.messages as unknown[]).length = 0;
		},
	});

	const result = await runFake(fake.session, "go");

	assert.equal(result.status, "failed");
	assert.match(result.status === "failed" ? result.error : "", /output token limit/);
	assert.equal(result.responseText, "", "nothing was produced, and no prior text leaks in");
	assert.deepEqual(result.usage, { tokens: 42, cost: 0 });
});

test("the streaming collector still wins over the event accountant", async () => {
	const fake = fakeSession([], {
		onPrompt: ({ emit }) => {
			emit({ type: "message_start", message: { role: "assistant" } });
			emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "streamed" } });
			emit({
				type: "message_end",
				message: { role: "assistant", content: [{ type: "text", text: "finalized" }], stopReason: "stop" },
			});
		},
	});

	const result = await runFake(fake.session, "go");
	assert.equal(result.responseText, "streamed");
});
