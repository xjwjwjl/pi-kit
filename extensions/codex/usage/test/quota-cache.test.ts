import assert from "node:assert/strict";
import test from "node:test";
import {
	RETRY_MAX_ATTEMPTS,
	createCacheEntry,
	hasAttemptedInRefreshWindow,
	isFreshCacheEntry,
	isRetryDue,
} from "../src/quota-cache.ts";

const usage = {
	allowed: true,
	rate_limit: {
		primary_window: { used_percent: 24, limit_window_seconds: 18_000 },
	},
};

const success = { status: "success" as const, usage };
const failure = { status: "error" as const, usage: null, error: "network failure" };

test("failed attempts keep the last success time and become stale", () => {
	const previous = { result: success, observedAt: 1_000, lastSuccessAt: 1_000, lastAttemptAt: 1_000, stale: false, retryCount: 0 };
	const entry = createCacheEntry(previous, failure, 2_000);
	assert.equal(entry.lastSuccessAt, 1_000);
	assert.equal(entry.observedAt, 2_000);
	assert.equal(entry.lastAttemptAt, 2_000);
	assert.equal(entry.stale, true);
	assert.equal(entry.result.status, "error");
	assert.equal(isFreshCacheEntry(entry, 1_000), false);
	assert.equal(hasAttemptedInRefreshWindow(entry, 1_000), true);
	assert.equal(hasAttemptedInRefreshWindow(entry, 2_001), false);
});

test("successful attempts advance timestamps and are fresh", () => {
	const entry = createCacheEntry(undefined, success, 2_000);
	assert.equal(entry.lastSuccessAt, 2_000);
	assert.equal(entry.observedAt, 2_000);
	assert.equal(entry.lastAttemptAt, 2_000);
	assert.equal(entry.stale, false);
	assert.equal(isFreshCacheEntry(entry, 2_000), true);
});

test("failed attempts schedule exponential backoff", () => {
	const previous = { result: success, observedAt: 1_000, lastSuccessAt: 1_000, lastAttemptAt: 1_000, stale: false, retryCount: 0 };
	const entry = createCacheEntry(previous, failure, 2_000);
	assert.equal(entry.retryCount, 1);
	assert.equal(entry.nextRetryAt, 7_000);
	assert.equal(isRetryDue(entry, 6_999), false);
	assert.equal(isRetryDue(entry, 7_000), true);
});

test("retries back off exponentially within the same window", () => {
	const previous = { result: failure, observedAt: 2_000, lastAttemptAt: 2_000, stale: true, retryCount: 1, nextRetryAt: 7_000 };
	const entry = createCacheEntry(previous, failure, 7_000);
	assert.equal(entry.retryCount, 2);
	assert.equal(entry.nextRetryAt, 17_000);
	assert.equal(isRetryDue(entry, 16_999), false);
	assert.equal(isRetryDue(entry, 17_000), true);
});

test("retries stop after the maximum attempt count", () => {
	let previous = undefined as Parameters<typeof createCacheEntry>[0];
	for (let i = 1; i <= RETRY_MAX_ATTEMPTS; i += 1) {
		previous = createCacheEntry(previous, failure, 1_000 + i);
	}
	assert.equal(previous?.retryCount, RETRY_MAX_ATTEMPTS);
	assert.equal(previous?.nextRetryAt, undefined);
	assert.equal(isRetryDue(previous, 100_000), false);
});

test("a new refresh window resets the retry streak", () => {
	const previous = { result: failure, observedAt: 2_000, lastAttemptAt: 2_000, stale: true, retryCount: 3, nextRetryAt: 22_000 };
	const entry = createCacheEntry(previous, failure, 300_000);
	assert.equal(entry.retryCount, 1);
	assert.equal(entry.nextRetryAt, 305_000);
});

test("a successful command clears the backoff state", () => {
	const previous = { result: failure, observedAt: 2_000, lastAttemptAt: 2_000, stale: true, retryCount: 2, nextRetryAt: 12_000 };
	const entry = createCacheEntry(previous, success, 12_000);
	assert.equal(entry.stale, false);
	assert.equal(entry.retryCount, 0);
	assert.equal(entry.nextRetryAt, undefined);
	assert.equal(isRetryDue(entry, 1_000_000), false);
});
