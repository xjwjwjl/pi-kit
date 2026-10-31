import assert from "node:assert/strict";
import test from "node:test";
import { OutputRateTracker, type OutputRateSnapshot } from "../src/output-rate-tracker.ts";

function createTracker() {
	return new OutputRateTracker({ now: () => 0 });
}

function createTrackerWithBurst() {
	const tracker = createTracker();
	for (const at of [0, 250, 500]) tracker.record(10, at);
	tracker.record(1_000, 750);
	return tracker;
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

test("tool activity rebases live output while retaining the previous stable rate", () => {
	const tracker = createTracker();
	for (const at of [0, 250, 500]) tracker.record(10, at);
	assert.equal(tracker.snapshot(500).rate, 40);

	tracker.recordActivity(750);
	assert.deepEqual(tracker.snapshot(750), expected({ retainedRate: 40, totalTokens: 30 }));
	tracker.recordActivity(1_000);

	// Even a large post-tool chunk is just the new baseline, not a burst.
	tracker.record(1_000, 1_250);
	assert.deepEqual(
		tracker.snapshot(1_250),
		expected({ retainedRate: 40, status: "measuring", totalTokens: 1_030 }),
	);
	tracker.record(10, 1_500);
	assert.equal(tracker.snapshot(1_500).provisionalRate, 40);
	tracker.record(10, 1_750);
	assert.equal(tracker.snapshot(1_750).rate, 40);
	assert.deepEqual(tracker.streamedOutputFlow(), { tokens: 40, durationMs: 1_000 });
});

test("a long tool pause still clears the retained rate when output resumes", () => {
	const tracker = createTracker();
	for (const at of [0, 250, 500]) tracker.record(10, at);
	tracker.recordActivity(750);
	tracker.recordActivity(3_000);
	assert.equal(tracker.snapshot(3_000).retainedRate, 40);
	assert.equal(tracker.snapshot(3_000).stale, true);

	tracker.record(10, 3_500);
	assert.deepEqual(tracker.snapshot(3_500), expected({ status: "measuring", totalTokens: 40 }));
	assert.deepEqual(tracker.streamedOutputFlow(), { tokens: 20, durationMs: 500 });
});

test("tool activity clears an unconfirmed provisional rate", () => {
	const tracker = createTracker();
	tracker.record(10, 0);
	tracker.record(10, 300);
	assert.equal(tracker.snapshot(300).provisionalRate, (10 * 1000) / 300);

	tracker.recordActivity(350);
	assert.deepEqual(tracker.snapshot(350), expected({ totalTokens: 20 }));
	tracker.record(10, 400);
	assert.deepEqual(tracker.snapshot(400), expected({ status: "measuring", totalTokens: 30 }));
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

test("preserves a stable prefix and resumes summary after a local burst", () => {
	const tracker = createTrackerWithBurst();
	assert.deepEqual(tracker.streamedOutputFlow(), { tokens: 20, durationMs: 500 });

	for (let at = 1_000; at <= 2_000; at += 250) {
		tracker.record(10, at);
		assert.deepEqual(tracker.streamedOutputFlow(), { tokens: 20, durationMs: 500 });
	}
	assert.equal(tracker.snapshot(2_000).rate, 40);
	tracker.record(10, 2_250);
	assert.deepEqual(tracker.streamedOutputFlow(), { tokens: 30, durationMs: 750 });
});

test("rolls back late-detected bursts to a checkpoint before the offending sample", () => {
	const tracker = createTracker();
	recordSamples(tracker, [[0, 1], [250, 100], [500, 100], [750, 1_000], [1_000, 1], [1_250, 1]]);
	assert.notEqual(tracker.snapshot(1_250).rate, null);

	// Pruning the older samples first reveals that the 750ms chunk was a burst.
	tracker.record(1, 1_500);
	assert.equal(tracker.snapshot(1_500).status, "burst");
	assert.deepEqual(tracker.streamedOutputFlow(), { tokens: 200, durationMs: 500 });
});

test("does not resume summary when other chunks merely dilute a burst", () => {
	const tracker = createTrackerWithBurst();
	for (let at = 1_000; at <= 2_000; at += 250) {
		tracker.record(100, at);
		assert.deepEqual(tracker.streamedOutputFlow(), { tokens: 20, durationMs: 500 });
		if (at === 1_250) assert.notEqual(tracker.snapshot(at).rate, null);
	}

	// The bad chunk has left the measured increments; 2000ms is a new baseline.
	tracker.record(100, 2_250);
	assert.deepEqual(tracker.streamedOutputFlow(), { tokens: 120, durationMs: 750 });
});

test("extends summary quarantine when another burst arrives before recovery", () => {
	const tracker = createTrackerWithBurst();
	tracker.record(100, 1_000);
	tracker.record(100, 1_250);
	tracker.record(10_000, 1_500);
	for (let at = 1_750; at <= 2_750; at += 250) {
		tracker.record(100, at);
		assert.deepEqual(tracker.streamedOutputFlow(), { tokens: 20, durationMs: 500 });
	}

	tracker.record(100, 3_000);
	assert.deepEqual(tracker.streamedOutputFlow(), { tokens: 120, durationMs: 750 });
});

test("does not retain an unconfirmed prefix when the first stable window detects a burst", () => {
	const tracker = createTracker();
	recordSamples(tracker, [[0, 1], [100, 1_000], [200, 1], [400, 1]]);
	assert.equal(tracker.snapshot(400).status, "burst");
	assert.deepEqual(tracker.streamedOutputFlow(), { tokens: 0, durationMs: 0 });
});

test("ends burst quarantine at tool boundaries without double-counting the prefix", () => {
	const tracker = createTrackerWithBurst();
	tracker.recordActivity(800);
	tracker.recordActivity(900);
	tracker.record(10_000, 1_000);
	tracker.record(10, 1_250);
	assert.deepEqual(tracker.streamedOutputFlow(), { tokens: 30, durationMs: 750 });

	tracker.recordActivity(1_300);
	tracker.recordActivity(1_400);
	assert.deepEqual(tracker.streamedOutputFlow(), { tokens: 30, durationMs: 750 });
});

test("ends burst quarantine after a long gap but not at the exact gap boundary", () => {
	const tracker = createTrackerWithBurst();
	tracker.record(10_000, 3_000);
	tracker.record(10, 3_250);
	assert.deepEqual(tracker.streamedOutputFlow(), { tokens: 30, durationMs: 750 });

	const exactGap = createTrackerWithBurst();
	exactGap.record(10, 2_750); // Exactly 2000ms after the previous output.
	assert.equal(exactGap.snapshot(2_750).rate, null);
	assert.deepEqual(exactGap.streamedOutputFlow(), { tokens: 20, durationMs: 500 });
});

test("ends burst quarantine when the stream clock moves backwards", () => {
	const tracker = createTrackerWithBurst();
	tracker.record(10_000, 700);
	tracker.record(10, 950);
	assert.deepEqual(tracker.streamedOutputFlow(), { tokens: 30, durationMs: 750 });
});

test("retains a checkpoint anchor across many windows before a late burst", () => {
	const tracker = createTracker();
	for (let at = 0; at <= 10_000; at += 250) tracker.record(10, at);
	recordSamples(tracker, [
		[10_250, 100], [10_500, 100], [10_750, 1_000], [11_000, 1], [11_250, 1], [11_500, 1],
	]);
	assert.equal(tracker.snapshot(11_500).status, "burst");
	assert.deepEqual(tracker.streamedOutputFlow(), { tokens: 600, durationMs: 10_500 });
});

test("reset clears burst quarantine and its saved prefix", () => {
	const tracker = createTrackerWithBurst();
	tracker.reset();
	tracker.record(10_000, 3_000);
	tracker.record(10, 3_250);
	assert.deepEqual(tracker.streamedOutputFlow(), { tokens: 10, durationMs: 250 });
});

test("summary recovery is independent of repeated snapshot reads", () => {
	const observed = createTracker();
	const untouched = createTracker();
	const samples: Array<[number, number]> = [[0, 10], [250, 10], [500, 10], [750, 1_000]];
	for (let at = 1_000; at <= 2_500; at += 250) samples.push([at, 10]);
	for (const [at, tokens] of samples) {
		observed.record(tokens, at);
		untouched.record(tokens, at);
		for (let read = 0; read < 3; read += 1) {
			assert.deepEqual(observed.streamedOutputFlow(), untouched.streamedOutputFlow());
			assert.deepEqual(observed.snapshot(at), untouched.snapshot(at));
		}
	}
	observed.recordActivity(2_750);
	untouched.recordActivity(2_750);
	assert.deepEqual(observed.streamedOutputFlow(), { tokens: 40, durationMs: 1_000 });
	assert.deepEqual(observed.streamedOutputFlow(), untouched.streamedOutputFlow());
});

test("rolls back before every offending chunk at a lower custom burst threshold", () => {
	const tracker = new OutputRateTracker({ now: () => 0, burstShare: 0.4, minimumDeltas: 3 });
	recordSamples(tracker, [
		[0, 100], [250, 100], [500, 100], [750, 100], [1_000, 100], [1_250, 100],
		[1_500, 150], [1_750, 160], [2_000, 1], [2_250, 1],
	]);
	assert.notEqual(tracker.snapshot(2_250).rate, null);

	// Both the 150- and 160-token chunks exceed 40% after pruning.
	tracker.record(1, 2_500);
	assert.equal(tracker.snapshot(2_500).status, "burst");
	assert.deepEqual(tracker.streamedOutputFlow(), { tokens: 500, durationMs: 1_250 });
});

test("can roll back a quarantined prefix further when an older chunk is detected later", () => {
	const tracker = new OutputRateTracker({ now: () => 0, burstShare: 0.4, minimumDeltas: 3 });
	recordSamples(tracker, [
		[0, 100], [250, 100], [500, 100], [750, 100], [1_000, 100], [1_250, 100],
		[1_400, 100], [1_500, 190], [1_750, 200], [2_000, 1], [2_250, 1], [2_500, 1],
	]);
	assert.equal(tracker.snapshot(2_500).status, "burst");
	assert.deepEqual(tracker.streamedOutputFlow(), { tokens: 790, durationMs: 1_500 });

	// The older 190-token chunk crosses the same threshold only after more pruning.
	tracker.record(1, 2_650);
	assert.equal(tracker.snapshot(2_650).status, "burst");
	assert.deepEqual(tracker.streamedOutputFlow(), { tokens: 600, durationMs: 1_400 });
});

test("distinguishes a stable checkpoint and a later burst at the same timestamp", () => {
	const tracker = createTracker();
	for (const at of [0, 250, 500]) tracker.record(10, at);
	tracker.record(1_000, 500);
	assert.equal(tracker.snapshot(500).status, "burst");
	assert.deepEqual(tracker.streamedOutputFlow(), { tokens: 20, durationMs: 500 });
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
