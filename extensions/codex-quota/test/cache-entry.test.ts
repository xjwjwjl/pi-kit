import assert from "node:assert/strict";
import test from "node:test";
import {
  RETRY_MAX_ATTEMPTS,
  createCacheEntry,
  hasAttemptedInRefreshWindow,
  isFreshCacheEntry,
  isRetryDue,
} from "../index.ts";

const usage = {
  rate_limit: {
    primary_window: { used_percent: 24, limit_window_seconds: 18_000 },
  },
};

test("failed attempts keep the last success time and become stale", () => {
  const previous = {
    result: { usage },
    lastSuccessAt: 1_000,
    lastAttemptAt: 1_000,
    stale: false,
  };

  const entry = createCacheEntry(previous, { usage: null, error: true }, 2_000);

  assert.equal(entry.lastSuccessAt, 1_000);
  assert.equal(entry.lastAttemptAt, 2_000);
  assert.equal(entry.stale, true);
  assert.equal(entry.result.error, true);
  assert.deepEqual(entry.result.usage, usage);
  assert.equal(isFreshCacheEntry(entry, 1_000), false);
  assert.equal(hasAttemptedInRefreshWindow(entry, 1_000), true);
  assert.equal(hasAttemptedInRefreshWindow(entry, 2_001), false);
});

test("successful attempts advance both timestamps and are fresh", () => {
  const entry = createCacheEntry(undefined, { usage }, 2_000);

  assert.equal(entry.lastSuccessAt, 2_000);
  assert.equal(entry.lastAttemptAt, 2_000);
  assert.equal(entry.stale, false);
  assert.equal(isFreshCacheEntry(entry, 2_000), true);
});

test("failed attempts schedule an exponential backoff retry", () => {
  const previous = {
    result: { usage },
    lastSuccessAt: 1_000,
    lastAttemptAt: 1_000,
    stale: false,
  };
  const now = 2_000;

  const entry = createCacheEntry(previous, { usage: null, error: true }, now);

  assert.equal(entry.stale, true);
  assert.equal(entry.retryCount, 1);
  assert.equal(entry.nextRetryAt, now + 5_000);
  assert.equal(isRetryDue(entry, now + 4_999), false);
  assert.equal(isRetryDue(entry, now + 5_000), true);
});

test("retries back off exponentially within the same window", () => {
  const previous = {
    result: { usage: null, error: true },
    lastSuccessAt: 1_000,
    lastAttemptAt: 2_000,
    stale: true,
    retryCount: 1,
    nextRetryAt: 7_000,
  };

  const entry = createCacheEntry(previous, { usage: null, error: true }, 7_000);

  assert.equal(entry.retryCount, 2);
  assert.equal(entry.nextRetryAt, 7_000 + 10_000);
  assert.equal(isRetryDue(entry, 7_000 + 9_999), false);
  assert.equal(isRetryDue(entry, 7_000 + 10_000), true);
});

test("retries stop after the maximum attempt count", () => {
  let previous: Parameters<typeof createCacheEntry>[0] = {
    result: { usage },
    lastSuccessAt: 1_000,
    lastAttemptAt: 1_000,
    stale: false,
  };
  for (let i = 1; i <= RETRY_MAX_ATTEMPTS; i += 1) {
    previous = createCacheEntry(previous, { usage: null, error: true }, 1_000 + i);
  }

  assert.equal(previous?.retryCount, RETRY_MAX_ATTEMPTS);
  assert.equal(previous?.nextRetryAt, undefined);
  assert.equal(isRetryDue(previous, 1_000 + RETRY_MAX_ATTEMPTS + 100_000), false);
});

test("a new refresh window resets the retry streak", () => {
  const previous = {
    result: { usage: null, error: true },
    lastSuccessAt: 1_000,
    lastAttemptAt: 2_000,
    stale: true,
    retryCount: 3,
    nextRetryAt: 2_000 + 20_000,
  };
  const now = 300_000; // 落在后续的刷新窗口

  const entry = createCacheEntry(previous, { usage: null, error: true }, now);

  assert.equal(entry.retryCount, 1);
  assert.equal(entry.nextRetryAt, now + 5_000);
});

test("a successful retry clears the backoff state", () => {
  const previous = {
    result: { usage: null, error: true },
    lastSuccessAt: 1_000,
    lastAttemptAt: 2_000,
    stale: true,
    retryCount: 2,
    nextRetryAt: 12_000,
  };

  const entry = createCacheEntry(previous, { usage }, 12_000);

  assert.equal(entry.stale, false);
  assert.equal(entry.retryCount, 0);
  assert.equal(entry.nextRetryAt, undefined);
  assert.equal(isRetryDue(entry, 12_000 + 1_000_000), false);
  assert.equal(isFreshCacheEntry(entry, 12_000), true);
});
