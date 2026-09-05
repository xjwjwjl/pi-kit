export type OutputRateStatus = "measuring" | "burst";

export type OutputRateSnapshot = {
	rate: number | null;
	status: OutputRateStatus | null;
	stale: boolean;
	totalTokens: number;
};

export type OutputRateMeasurement = {
	tokens: number;
	durationMs: number;
	rate: number;
};

type RateSample = {
	at: number;
	cumulativeTokens: number;
	deltaTokens: number;
};

export type OutputRateTrackerOptions = {
	now?: () => number;
	windowMs?: number;
	minimumWindowMs?: number;
	gapMs?: number;
	minimumDeltas?: number;
	minimumTokens?: number;
	burstShare?: number;
};

const DEFAULT_WINDOW_MS = 1_200;
const DEFAULT_MINIMUM_WINDOW_MS = 600;
const DEFAULT_GAP_MS = 2_000;
const DEFAULT_MINIMUM_DELTAS = 3;
const DEFAULT_MINIMUM_TOKENS = 3;
const DEFAULT_BURST_SHARE = 0.75;

function monotonicNowMs(): number {
	return globalThis.performance?.now?.() ?? Date.now();
}

/**
 * Measures locally estimated output throughput without relying on provider usage.
 *
 * The first delta after a request or a long gap is a baseline only. Subsequent
 * deltas are measured over a bounded time window, which prevents both TTFT and
 * network-buffered chunks from being interpreted as generation speed.
 */
export class OutputRateTracker {
	private readonly now: () => number;
	private readonly windowMs: number;
	private readonly minimumWindowMs: number;
	private readonly gapMs: number;
	private readonly minimumDeltas: number;
	private readonly minimumTokens: number;
	private readonly burstShare: number;

	private samples: RateSample[] = [];
	private lastSampleAt: number | null = null;
	private currentRate: number | null = null;
	private currentStatus: OutputRateStatus | null = null;
	private lastStableRate: number | null = null;
	private lastStableMeasurement: OutputRateMeasurement | null = null;
	private totalOutputTokens = 0;

	constructor(options: OutputRateTrackerOptions = {}) {
		this.now = options.now ?? monotonicNowMs;
		this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
		this.minimumWindowMs = options.minimumWindowMs ?? DEFAULT_MINIMUM_WINDOW_MS;
		this.gapMs = options.gapMs ?? DEFAULT_GAP_MS;
		this.minimumDeltas = options.minimumDeltas ?? DEFAULT_MINIMUM_DELTAS;
		this.minimumTokens = options.minimumTokens ?? DEFAULT_MINIMUM_TOKENS;
		this.burstShare = options.burstShare ?? DEFAULT_BURST_SHARE;
	}

	reset(): void {
		this.samples = [];
		this.lastSampleAt = null;
		this.currentRate = null;
		this.currentStatus = null;
		this.lastStableRate = null;
		this.lastStableMeasurement = null;
		this.totalOutputTokens = 0;
	}

	/** Record one locally estimated output delta. */
	record(deltaTokens: number, at = this.now()): void {
		if (!Number.isFinite(deltaTokens) || deltaTokens <= 0 || !Number.isFinite(at)) return;

		if (this.lastSampleAt != null && (at < this.lastSampleAt || at - this.lastSampleAt > this.gapMs)) {
			this.rebase(at, deltaTokens);
			return;
		}

		this.totalOutputTokens += deltaTokens;
		if (this.samples.length === 0) {
			this.samples.push({ at, cumulativeTokens: this.totalOutputTokens, deltaTokens });
			this.lastSampleAt = at;
			this.currentRate = null;
			this.currentStatus = "measuring";
			return;
		}

		this.samples.push({ at, cumulativeTokens: this.totalOutputTokens, deltaTokens });
		this.lastSampleAt = at;
		this.prune(at);
		this.recompute();
	}

	/**
	 * Read the current rate. When `retainStale` is true, a completed generation
	 * may keep its last stable value for a muted tool-phase display.
	 */
	snapshot(at = this.now(), retainStale = false): OutputRateSnapshot {
		const stale = this.lastSampleAt == null || at - this.lastSampleAt > this.gapMs;
		if (stale) {
			return {
				rate: retainStale ? this.lastStableRate : null,
				status: retainStale ? null : this.samples.length > 0 ? "measuring" : null,
				stale: true,
				totalTokens: this.totalOutputTokens,
			};
		}

		return {
			rate: this.currentRate,
			status: this.currentStatus,
			stale: false,
			totalTokens: this.totalOutputTokens,
		};
	}

	/** Return the latest confidence-checked window for aggregate reporting. */
	currentMeasurement(): OutputRateMeasurement | null {
		return this.currentRate == null ? null : this.lastStableMeasurement;
	}

	private rebase(at: number, deltaTokens: number): void {
		this.totalOutputTokens += deltaTokens;
		this.samples = [{ at, cumulativeTokens: this.totalOutputTokens, deltaTokens }];
		this.lastSampleAt = at;
		this.currentRate = null;
		this.currentStatus = "measuring";
		this.lastStableRate = null;
		this.lastStableMeasurement = null;
	}

	private prune(at: number): void {
		const cutoff = at - this.windowMs;
		while (this.samples.length > 1 && this.samples[1]!.at < cutoff) {
			this.samples.shift();
		}
	}

	private recompute(): void {
		const start = this.samples[0];
		const end = this.samples[this.samples.length - 1];
		if (!start || !end || end === start) {
			this.currentRate = null;
			this.currentStatus = "measuring";
			return;
		}

		const elapsedMs = end.at - start.at;
		const measuredTokens = end.cumulativeTokens - start.cumulativeTokens;
		const measuredSamples = this.samples.slice(1);
		const maximumDeltaTokens = Math.max(...measuredSamples.map((sample) => sample.deltaTokens));

		if (elapsedMs < this.minimumWindowMs || measuredSamples.length < this.minimumDeltas || measuredTokens < this.minimumTokens) {
			this.currentRate = null;
			this.currentStatus = "measuring";
			return;
		}

		if (maximumDeltaTokens / measuredTokens >= this.burstShare) {
			this.currentRate = null;
			this.currentStatus = "burst";
			return;
		}

		this.currentRate = (measuredTokens * 1000) / elapsedMs;
		this.currentStatus = null;
		this.lastStableRate = this.currentRate;
		this.lastStableMeasurement = {
			tokens: measuredTokens,
			durationMs: elapsedMs,
			rate: this.currentRate,
		};
	}
}
