import assert from "node:assert/strict";
import test from "node:test";
import { OutputRateTracker, type OutputRateSnapshot } from "../src/output-rate-tracker.ts";

function createTracker() {
	return new OutputRateTracker({ now: () => 0 });
}

function recordSamples(tracker: OutputRateTracker, samples: Array<[number, number]>): void {
	for (const [at, tokens] of samples) {
		tracker.record(tokens, at);
	}
}

function expected(overrides: Partial<OutputRateSnapshot>): OutputRateSnapshot {
	return {
		rate: null,
		provisionalRate: null,
		retainedRate: null,
		status: null,
		stale: false,
		totalTokens: 0,
		...overrides,
	};
}

test("offers a provisional rate before the stable window is confident", () => {
	const tracker = createTracker();

	recordSamples(tracker, [
		[0, 100],
		[300, 10],
	]);

	// One post-baseline sample is enough for a directional number only.
	assert.deepEqual(
		tracker.snapshot(300),
		expected({
			provisionalRate: (10 * 1000) / 300,
			status: "measuring",
			totalTokens: 110,
		}),
	);

	tracker.record(20, 600);
	assert.deepEqual(
		tracker.snapshot(600),
		expected({
			rate: 50,
			provisionalRate: 50,
			retainedRate: 50,
			totalTokens: 130,
		}),
	);
});

test("does not turn a large initial buffered chunk into a huge rate", () => {
	const tracker = createTracker();

	recordSamples(tracker, [
		[0, 10_000],
		[250, 1],
		[500, 1],
		[750, 1],
		[1000, 1],
	]);

	const snapshot = tracker.snapshot(1000);
	assert.equal(snapshot.status, null);
	assert.equal(snapshot.rate, 4);
});

test("excludes segment baselines and tool-call activity from summary flow", () => {
	const tracker = createTracker();

	recordSamples(tracker, [
		[0, 10_000],
		[250, 1],
		[500, 1],
		[750, 1],
		[1000, 1],
	]);
	assert.deepEqual(tracker.streamedOutputFlow(), { tokens: 4, durationMs: 1_000 });

	tracker.reset();
	tracker.record(10, 0);
	tracker.record(10, 500);
	tracker.recordActivity(750);
	tracker.recordActivity(1_000);
	tracker.record(10, 1_250);
	tracker.record(10, 1_500);
	assert.deepEqual(tracker.streamedOutputFlow(), { tokens: 20, durationMs: 750 });
});

test("suppresses a later single-chunk burst instead of publishing its rate", () => {
	const tracker = createTracker();

	recordSamples(tracker, [
		[0, 1],
		[250, 1],
		[500, 100],
		[750, 1],
	]);

	// Both the stable and the provisional value stay hidden: the provisional one
	// comes from the same dominant chunk the burst check rejects.
	assert.deepEqual(
		tracker.snapshot(750),
		expected({
			status: "burst",
			totalTokens: 103,
		}),
	);
});

test("excludes burst-contaminated flow from the final summary", () => {
	const tracker = createTracker();

	recordSamples(tracker, [
		[0, 1],
		[250, 1],
		[500, 10_000],
		[750, 1],
	]);

	// The live window rejects this burst; the aggregate flow must not reintroduce
	// the same invalid chunk into the final average TPS.
	assert.deepEqual(tracker.snapshot(750), expected({ status: "burst", totalTokens: 10_003 }));
	assert.deepEqual(tracker.streamedOutputFlow(), { tokens: 0, durationMs: 0 });
});

test("requires enough elapsed time and deltas before showing a rate", () => {
	const tracker = createTracker();

	recordSamples(tracker, [
		[0, 1],
		[50, 1],
		[100, 1],
		[150, 1],
	]);

	// Too short even for a provisional value, and far short of a stable one.
	assert.deepEqual(
		tracker.snapshot(150),
		expected({
			status: "measuring",
			totalTokens: 4,
		}),
	);
});

test("does not report a stale low rate after a long pause", () => {
	const tracker = createTracker();

	recordSamples(tracker, [
		[0, 1],
		[250, 1],
		[500, 1],
		[750, 1],
		[1000, 1],
	]);
	assert.equal(tracker.snapshot(1000).rate, 4);

	assert.deepEqual(
		tracker.snapshot(3_500),
		expected({
			// The stream paused, but the last confident rate stays available for a
			// muted display.
			retainedRate: 4,
			status: "measuring",
			stale: true,
			totalTokens: 5,
		}),
	);

	tracker.record(1, 3_500);
	assert.deepEqual(
		tracker.snapshot(3_500),
		expected({
			status: "measuring",
			totalTokens: 6,
		}),
	);
});

test("repeated reads do not advance or alter the measurement window", () => {
	const tracker = createTracker();

	recordSamples(tracker, [
		[0, 1],
		[250, 1],
		[500, 1],
		[750, 1],
		[1000, 1],
	]);

	const first = tracker.snapshot(1000);
	const second = tracker.snapshot(1000);
	assert.deepEqual(second, first);
});

test("retains the last stable rate across a long pause", () => {
	const tracker = createTracker();

	recordSamples(tracker, [
		[0, 1],
		[250, 1],
		[500, 1],
		[750, 1],
		[1000, 1],
	]);

	// Pauses mid-stream and during a later tool phase both keep the value.
	assert.deepEqual(
		tracker.snapshot(3_500),
		expected({
			retainedRate: 4,
			status: "measuring",
			stale: true,
			totalTokens: 5,
		}),
	);
});

test("keeps the retained rate visible while a later burst is suppressed", () => {
	const tracker = createTracker();

	recordSamples(tracker, [
		[0, 1],
		[250, 1],
		[500, 1],
		[750, 1],
		[1000, 1],
	]);
	assert.equal(tracker.snapshot(1000).rate, 4);

	tracker.record(1_000, 1250);
	const afterBurst = tracker.snapshot(1250);
	assert.equal(afterBurst.rate, null);
	assert.equal(afterBurst.provisionalRate, null);
	assert.equal(afterBurst.status, "burst");
	assert.equal(afterBurst.retainedRate, 4);
});

test("measures only the time output was actively arriving", () => {
	const tracker = createTracker();

	recordSamples(tracker, [
		[0, 10],
		[1_000, 10],
		[1_500, 10],
		[2_000, 10],
		[3_000, 10],
	]);

	// The first event only sets a baseline; the credited time is the sum of the
	// gaps between consecutive events.
	assert.equal(tracker.streamFlowDurationMs(), 3_000);
});

test("excludes stalls from the measured flow time", () => {
	const tracker = createTracker();

	recordSamples(tracker, [
		[0, 10],
		[1_000, 10],
	]);
	// A 4s stall starts a new segment: the stall itself is dead time and the
	// event that opens the segment only sets a new baseline.
	tracker.record(10, 5_000);
	tracker.record(10, 6_000);

	assert.equal(tracker.streamFlowDurationMs(), 2_000);

	tracker.reset();
	assert.equal(tracker.streamFlowDurationMs(), 0);
});

test("a mid-stream stall does not change the measured flow rhythm", () => {
	const steady = createTracker();
	for (const at of [0, 250, 500, 750, 1_000, 1_250]) steady.record(10, at);

	const stalled = createTracker();
	for (const at of [0, 250, 500]) stalled.record(10, at);
	for (const at of [10_500, 10_750, 11_000]) stalled.record(10, at);

	// Both streams delivered deltas at 250ms intervals; the 10s pause is the only
	// difference and must not appear in the flow time. The stalled stream measures
	// exactly one gap less because each post-stall segment starts a new baseline.
	assert.equal(steady.streamFlowDurationMs(), 1_250);
	assert.equal(stalled.streamFlowDurationMs(), 1_000);
});

test("credits activity that carries no locally estimated tokens", () => {
	const tracker = createTracker();

	tracker.record(10, 0);
	tracker.record(10, 500);
	// Tool-call streaming: the provider counts these tokens, so the time counts
	// toward the flow window even though the live rate ignores it.
	tracker.recordActivity(1_000);
	tracker.recordActivity(1_500);

	assert.equal(tracker.streamFlowDurationMs(), 1_500);
});

test("has no flow time before the second event arrives", () => {
	const tracker = createTracker();

	assert.equal(tracker.streamFlowDurationMs(), 0);

	tracker.record(10, 0);
	// A single event has no measurable span.
	assert.equal(tracker.streamFlowDurationMs(), 0);

	tracker.recordActivity(300);
	assert.equal(tracker.streamFlowDurationMs(), 300);
});
