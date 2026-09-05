import assert from "node:assert/strict";
import test from "node:test";
import { OutputRateTracker } from "../src/output-rate-tracker.ts";

function createTracker() {
	return new OutputRateTracker({ now: () => 0 });
}

function recordSamples(tracker: OutputRateTracker, samples: Array<[number, number]>): void {
	for (const [at, tokens] of samples) {
		tracker.record(tokens, at);
	}
}

test("waits for a confident window after the baseline delta", () => {
	const tracker = createTracker();

	recordSamples(tracker, [
		[0, 100],
		[200, 10],
		[400, 10],
	]);

	assert.deepEqual(tracker.snapshot(400), {
		rate: null,
		status: "measuring",
		stale: false,
		totalTokens: 120,
	});

	tracker.record(10, 600);
	assert.deepEqual(tracker.snapshot(600), {
		rate: 50,
		status: null,
		stale: false,
		totalTokens: 130,
	});
	assert.deepEqual(tracker.currentMeasurement(), {
		tokens: 30,
		durationMs: 600,
		rate: 50,
	});
});

test("does not turn a large initial buffered chunk into a huge rate", () => {
	const tracker = createTracker();

	recordSamples(tracker, [
		[0, 10_000],
		[250, 1],
		[500, 1],
		[750, 1],
	]);

	const snapshot = tracker.snapshot(750);
	assert.equal(snapshot.status, null);
	assert.equal(snapshot.rate, 4);
});

test("suppresses a later single-chunk burst instead of publishing its rate", () => {
	const tracker = createTracker();

	recordSamples(tracker, [
		[0, 1],
		[250, 1],
		[500, 100],
		[750, 1],
	]);

	assert.deepEqual(tracker.snapshot(750), {
		rate: null,
		status: "burst",
		stale: false,
		totalTokens: 103,
	});
});

test("requires enough elapsed time and deltas before showing a rate", () => {
	const tracker = createTracker();

	recordSamples(tracker, [
		[0, 1],
		[50, 1],
		[100, 1],
		[150, 1],
	]);

	assert.deepEqual(tracker.snapshot(150), {
		rate: null,
		status: "measuring",
		stale: false,
		totalTokens: 4,
	});
});

test("does not report a stale low rate after a long pause", () => {
	const tracker = createTracker();

	recordSamples(tracker, [
		[0, 1],
		[250, 1],
		[500, 1],
		[750, 1],
	]);
	assert.equal(tracker.snapshot(750).rate, 4);

	assert.deepEqual(tracker.snapshot(3_000), {
		rate: null,
		status: "measuring",
		stale: true,
		totalTokens: 4,
	});

	tracker.record(1, 3_000);
	assert.deepEqual(tracker.snapshot(3_000), {
		rate: null,
		status: "measuring",
		stale: false,
		totalTokens: 5,
	});
});

test("repeated reads do not advance or alter the measurement window", () => {
	const tracker = createTracker();

	recordSamples(tracker, [
		[0, 1],
		[250, 1],
		[500, 1],
		[750, 1],
	]);

	const first = tracker.snapshot(750);
	const second = tracker.snapshot(750);
	assert.deepEqual(second, first);
});

test("retains the last stable rate only for a stale non-streaming display", () => {
	const tracker = createTracker();

	recordSamples(tracker, [
		[0, 1],
		[250, 1],
		[500, 1],
		[750, 1],
	]);

	assert.deepEqual(tracker.snapshot(3_000, true), {
		rate: 4,
		status: null,
		stale: true,
		totalTokens: 4,
	});
});
