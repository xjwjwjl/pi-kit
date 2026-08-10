import assert from "node:assert/strict";
import test from "node:test";
import {
	eventTokens,
	filterEvents,
	modelAggregates,
	providerAggregates,
	scopeAggregates,
	sortRequests,
	totalsForEvents,
	trendBuckets,
} from "../src/aggregate.ts";
import { formatCost } from "../src/format.ts";
import { customRange } from "../src/time-range.ts";
import type { TokenEvent } from "../src/types.ts";

function event(overrides: Partial<TokenEvent> = {}): TokenEvent {
	return {
		entryId: "entry",
		sessionId: "session",
		sessionFile: "/tmp/session.jsonl",
		sessionCreatedAt: 1,
		timestampMs: Date.parse("2026-07-22T10:00:00.000Z"),
		scope: "/workspace/api",
		provider: "openai",
		model: "gpt-test",
		inputTokens: 100,
		outputTokens: 20,
		cacheReadTokens: 10,
		cacheWriteTokens: 5,
		cost: 0.25,
		stopReason: "stop",
		...overrides,
	};
}

test("formats zero cost as a two-decimal dollar amount", () => {
	assert.equal(formatCost(0), "$0.00");
});

test("aggregates all four token buckets without adding cache twice", () => {
	const events = [event(), event({ entryId: "second", outputTokens: 40, provider: "anthropic", model: "sonnet", scope: "/workspace/web", cost: 0.5 })];
	const totals = totalsForEvents(events);
	assert.equal(eventTokens(events[0]!), 135);
	assert.deepEqual(totals, {
		tokens: 290,
		inputTokens: 200,
		outputTokens: 60,
		cacheReadTokens: 20,
		cacheWriteTokens: 10,
		cost: 0.75,
		requests: 2,
	});
});

test("groups provider, model, and scope rows and searches all dimensions", () => {
	const events = [
		event(),
		event({ entryId: "second", provider: "anthropic", model: "sonnet", scope: "/workspace/web" }),
	];
	assert.deepEqual(providerAggregates(events, "tokens").map((row) => row.provider), ["anthropic", "openai"]);
	assert.deepEqual(modelAggregates(events, "tokens").map((row) => row.key), ["anthropic/sonnet", "openai/gpt-test"]);
	assert.deepEqual(scopeAggregates(events, "tokens").map((row) => row.scope), ["/workspace/api", "/workspace/web"]);
	assert.equal(filterEvents(events, "sonnet web").length, 1);
	assert.equal(filterEvents(events, '"workspace/api"').length, 1);
});

test("request sorting supports time, tokens, and cost", () => {
	const events = [
		event({ entryId: "old", timestampMs: 1, cost: 0.9, outputTokens: 1 }),
		event({ entryId: "new", timestampMs: 2, cost: 0.1, outputTokens: 1000 }),
	];
	assert.deepEqual(sortRequests(events, "time").map((item) => item.entryId), ["new", "old"]);
	assert.deepEqual(sortRequests(events, "tokens").map((item) => item.entryId), ["new", "old"]);
	assert.deepEqual(sortRequests(events, "cost").map((item) => item.entryId), ["old", "new"]);
});

test("trend buckets preserve the requested range and aggregate costs", () => {
	const range = customRange(Date.parse("2026-07-22T10:00:00.000Z"), Date.parse("2026-07-22T13:00:00.000Z"));
	const events = [
		event({ timestampMs: Date.parse("2026-07-22T10:15:00.000Z"), cost: 0.2 }),
		event({ entryId: "next", timestampMs: Date.parse("2026-07-22T11:15:00.000Z"), cost: 0.3 }),
	];
	const buckets = trendBuckets(events, range);
	assert.equal(buckets.length, 3);
	assert.equal(buckets.reduce((sum, bucket) => sum + bucket.totals.cost, 0), 0.5);
});
