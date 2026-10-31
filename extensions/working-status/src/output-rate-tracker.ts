export type OutputRateStatus = "measuring" | "burst";

export type OutputRateSnapshot = {
	/** Confidence-checked rate for the current measurement window. */
	rate: number | null;
	/** Low-confidence rate available as soon as a second delta arrives. */
	provisionalRate: number | null;
	/** Last stable rate, kept for a muted display after a burst or a pause. */
	retainedRate: number | null;
	status: OutputRateStatus | null;
	stale: boolean;
	totalTokens: number;
};

export type StreamedOutputFlow = {
	/** Locally observed text/thinking tokens measured after each segment baseline. */
	tokens: number;
	/** Intervals covered by those tokens; tool-call activity and long stalls break a segment. */
	durationMs: number;
};

type RateSample = {
	id: number;
	at: number;
	cumulativeTokens: number;
	deltaTokens: number;
};

type StreamedOutputCheckpoint = StreamedOutputFlow & { sampleId: number };

type StreamedOutputSegment = StreamedOutputFlow & {
	checkpoints: StreamedOutputCheckpoint[];
};

type BurstRange = {
	firstSampleId: number;
	lastSampleId: number;
};

export type OutputRateTrackerOptions = {
	now?: () => number;
	windowMs?: number;
	minimumWindowMs?: number;
	gapMs?: number;
	minimumDeltas?: number;
	minimumTokens?: number;
	burstShare?: number;
	provisionalMinimumWindowMs?: number;
	provisionalMinimumTokens?: number;
};

const DEFAULT_WINDOW_MS = 1_200;
const DEFAULT_MINIMUM_WINDOW_MS = 400;
const DEFAULT_GAP_MS = 2_000;
const DEFAULT_MINIMUM_DELTAS = 2;
const DEFAULT_MINIMUM_TOKENS = 4;
const DEFAULT_BURST_SHARE = 0.85;
const DEFAULT_PROVISIONAL_MINIMUM_WINDOW_MS = 250;
const DEFAULT_PROVISIONAL_MINIMUM_TOKENS = 2;

function monotonicNowMs(): number {
	return globalThis.performance?.now?.() ?? Date.now();
}

/**
 * Measures locally estimated output throughput without relying on provider usage.
 *
 * The first delta after a request or a long gap is a baseline only. Two rates are
 * derived from the deltas that follow:
 *
 * - a provisional rate, available almost immediately but easily skewed by
 *   network-buffered chunks;
 * - a stable rate, measured over a bounded window that requires enough elapsed
 *   time, samples, and token mass, and that rejects single-chunk bursts.
 *
 * Provider usage stays out of rate calculations entirely; callers use it only
 * for aggregate usage totals. The tracker also accumulates the flow time during
 * which output was actively arriving, paired with locally observed deltas for
 * the end-of-run summary.
 */
export class OutputRateTracker {
	private readonly now: () => number;
	private readonly windowMs: number;
	private readonly minimumWindowMs: number;
	private readonly gapMs: number;
	private readonly minimumDeltas: number;
	private readonly minimumTokens: number;
	private readonly burstShare: number;
	private readonly provisionalMinimumWindowMs: number;
	private readonly provisionalMinimumTokens: number;

	private samples: RateSample[] = [];
	private sampleSequence = 0;
	private lastSampleAt: number | null = null;
	// Flow accounting, independent of the bounded rate window: it survives
	// pruning and rebasing so the end-of-run measurement covers the whole
	// request. The first event of a segment only sets a baseline; stalls longer
	// than `gapMs` are dead time and are not credited.
	private lastActivityAt: number | null = null;
	private streamFlowMs = 0;
	// Separate from generic provider-stream activity: this is the numerator and
	// denominator used by the end summary, so tool-call JSON cannot dilute it.
	// A burst rolls the candidate back to a stable prefix, which stays reversible
	// until all known bad samples have left the measured window.
	private lastStreamedOutputAt: number | null = null;
	private currentStreamedOutputSegment: StreamedOutputSegment | null = null;
	private quarantinedThroughSampleId: number | null = null;
	private streamedOutputFlowMs = 0;
	private streamedOutputFlowTokens = 0;
	private currentRate: number | null = null;
	private provisionalRate: number | null = null;
	private currentStatus: OutputRateStatus | null = null;
	private lastStableRate: number | null = null;
	private totalOutputTokens = 0;

	constructor(options: OutputRateTrackerOptions = {}) {
		this.now = options.now ?? monotonicNowMs;
		this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
		this.minimumWindowMs = options.minimumWindowMs ?? DEFAULT_MINIMUM_WINDOW_MS;
		this.gapMs = options.gapMs ?? DEFAULT_GAP_MS;
		this.minimumDeltas = options.minimumDeltas ?? DEFAULT_MINIMUM_DELTAS;
		this.minimumTokens = options.minimumTokens ?? DEFAULT_MINIMUM_TOKENS;
		this.burstShare = options.burstShare ?? DEFAULT_BURST_SHARE;
		this.provisionalMinimumWindowMs = options.provisionalMinimumWindowMs ?? DEFAULT_PROVISIONAL_MINIMUM_WINDOW_MS;
		this.provisionalMinimumTokens = options.provisionalMinimumTokens ?? DEFAULT_PROVISIONAL_MINIMUM_TOKENS;
	}

	reset(): void {
		this.samples = [];
		this.sampleSequence = 0;
		this.lastSampleAt = null;
		this.lastActivityAt = null;
		this.streamFlowMs = 0;
		this.lastStreamedOutputAt = null;
		this.currentStreamedOutputSegment = null;
		this.quarantinedThroughSampleId = null;
		this.streamedOutputFlowMs = 0;
		this.streamedOutputFlowTokens = 0;
		this.currentRate = null;
		this.provisionalRate = null;
		this.currentStatus = null;
		this.lastStableRate = null;
		this.totalOutputTokens = 0;
	}

	/**
	 * Record non-text output activity, such as streamed tool-call arguments.
	 * It breaks both text-only measurement windows, but keeps the last stable
	 * rate available for a muted display. Zero-token text is not tool activity.
	 */
	recordActivity(at = this.now()): void {
		if (!Number.isFinite(at)) return;
		this.noteActivity(at);
		// Tool-call JSON is deliberately outside the user-visible TPS numerator.
		// It must also end the corresponding output-only measurement segment.
		this.finishStreamedOutputSegment();
		this.lastStreamedOutputAt = null;
		this.samples = [];
		this.currentRate = null;
		this.provisionalRate = null;
		this.currentStatus = null;
		// Keep lastSampleAt so output after a long tool pause still triggers
		// the normal gap rebase, including clearing the retained rate.
	}

	/** Record one locally estimated output delta. */
	record(deltaTokens: number, at = this.now()): void {
		if (!Number.isFinite(deltaTokens) || deltaTokens <= 0 || !Number.isFinite(at)) return;

		this.noteActivity(at);
		this.noteStreamedOutput(deltaTokens, at);
		this.totalOutputTokens += deltaTokens;
		const sample: RateSample = { id: ++this.sampleSequence, at, cumulativeTokens: this.totalOutputTokens, deltaTokens };
		if (this.lastSampleAt != null) {
			const gapMs = at - this.lastSampleAt;
			if (gapMs < 0 || gapMs > this.gapMs) {
				// A long pause or a clock jump starts a new segment. The delta that
				// opens it becomes the new baseline.
				this.rebase(sample);
				return;
			}
		}

		if (this.samples.length === 0) {
			this.samples.push(sample);
			this.lastSampleAt = at;
			this.currentRate = null;
			this.provisionalRate = null;
			this.currentStatus = "measuring";
			return;
		}

		this.samples.push(sample);
		this.lastSampleAt = at;
		this.prune(at);
		const burst = this.recompute();
		this.updateSummaryFlow(sample, burst);
	}

	/**
	 * Read the current rates. The last stable rate is always reported as a
	 * retained value so a muted TPS can stay visible across bursts and gaps;
	 * `rebase()` clears it once new output arrives after a gap.
	 */
	snapshot(at = this.now()): OutputRateSnapshot {
		const stale = this.lastSampleAt == null || at - this.lastSampleAt > this.gapMs;
		if (stale) {
			return {
				rate: null,
				provisionalRate: null,
				retainedRate: this.lastStableRate,
				status: this.samples.length > 0 ? "measuring" : null,
				stale: true,
				totalTokens: this.totalOutputTokens,
			};
		}

		return {
			rate: this.currentRate,
			provisionalRate: this.provisionalRate,
			retainedRate: this.lastStableRate,
			status: this.currentStatus,
			stale: false,
			totalTokens: this.totalOutputTokens,
		};
	}

	/**
	 * Time during which output was actively arriving, with stalls longer than
	 * `gapMs` excluded. Callers pair this with the provider-counted output token
	 * tokens to get a user-observable throughput for the request.
	 */
	streamFlowDurationMs(): number {
		return this.streamFlowMs;
	}

	/**
	 * The text/thinking-only flow used by the end summary. Each segment's first
	 * delta is a baseline, matching the live TPS calculation and avoiding a
	 * buffered first chunk being treated as instantaneous throughput.
	 */
	streamedOutputFlow(): StreamedOutputFlow {
		let tokens = this.streamedOutputFlowTokens;
		let durationMs = this.streamedOutputFlowMs;
		const current = this.currentStreamedOutputSegment;
		if (current) {
			tokens += current.tokens;
			durationMs += current.durationMs;
		}
		return { tokens, durationMs };
	}

	private noteActivity(at: number): void {
		if (this.lastActivityAt != null) {
			const gapMs = at - this.lastActivityAt;
			if (gapMs >= 0 && gapMs <= this.gapMs) {
				this.streamFlowMs += gapMs;
			}
		}
		this.lastActivityAt = at;
	}

	private noteStreamedOutput(deltaTokens: number, at: number): void {
		if (this.lastStreamedOutputAt == null) {
			this.startStreamedOutputSegment();
		} else {
			const gapMs = at - this.lastStreamedOutputAt;
			if (gapMs < 0 || gapMs > this.gapMs) {
				this.startStreamedOutputSegment();
			} else if (this.currentStreamedOutputSegment && this.quarantinedThroughSampleId == null) {
				this.currentStreamedOutputSegment.durationMs += gapMs;
				this.currentStreamedOutputSegment.tokens += deltaTokens;
			}
		}
		this.lastStreamedOutputAt = at;
	}

	private updateSummaryFlow(sample: RateSample, burst: BurstRange | null): void {
		const segment = this.currentStreamedOutputSegment;
		if (!segment) return;
		if (burst) {
			// A chunk can become dominant only after older samples are pruned.
			// Roll back before the actual offender, not just the latest checkpoint.
			while (segment.checkpoints.length > 0 && segment.checkpoints.at(-1)!.sampleId >= burst.firstSampleId) {
				segment.checkpoints.pop();
			}
			const checkpoint = segment.checkpoints.at(-1);
			segment.tokens = checkpoint?.tokens ?? 0;
			segment.durationMs = checkpoint?.durationMs ?? 0;
			// Keep this prefix reversible: a lower custom threshold can identify
			// an even earlier offender on a later window.
			this.quarantinedThroughSampleId = Math.max(this.quarantinedThroughSampleId ?? 0, burst.lastSampleId);
			return;
		}
		if (this.currentRate == null) return;

		const baseline = this.samples[0]!;
		if (this.quarantinedThroughSampleId != null) {
			// Dilution alone is not recovery. The known bad chunks must be out of
			// the measured increments, and this event is only the new baseline.
			if (baseline.id < this.quarantinedThroughSampleId) return;
			this.startStreamedOutputSegment();
		}
		const current = this.currentStreamedOutputSegment!;
		current.checkpoints.push({ sampleId: sample.id, tokens: current.tokens, durationMs: current.durationMs });
		// Retain the last checkpoint at/before the live baseline, plus newer ones.
		// Anything that can still become a burst lies strictly after that anchor.
		while (current.checkpoints.length > 1 && current.checkpoints[1]!.sampleId <= baseline.id) {
			current.checkpoints.shift();
		}
	}

	private startStreamedOutputSegment(): void {
		this.finishStreamedOutputSegment();
		this.currentStreamedOutputSegment = { tokens: 0, durationMs: 0, checkpoints: [] };
	}

	private finishStreamedOutputSegment(): void {
		const segment = this.currentStreamedOutputSegment;
		if (segment) {
			this.streamedOutputFlowMs += segment.durationMs;
			this.streamedOutputFlowTokens += segment.tokens;
		}
		this.currentStreamedOutputSegment = null;
		this.quarantinedThroughSampleId = null;
	}

	private rebase(sample: RateSample): void {
		this.samples = [sample];
		this.lastSampleAt = sample.at;
		this.currentRate = null;
		this.provisionalRate = null;
		this.currentStatus = "measuring";
		this.lastStableRate = null;
	}

	private prune(at: number): void {
		const cutoff = at - this.windowMs;
		while (this.samples.length > 1 && this.samples[1]!.at < cutoff) {
			this.samples.shift();
		}
	}

	private recompute(): BurstRange | null {
		const start = this.samples[0];
		const end = this.samples[this.samples.length - 1];
		if (!start || !end || end === start) {
			this.currentRate = null;
			this.provisionalRate = null;
			this.currentStatus = "measuring";
			return null;
		}

		const elapsedMs = end.at - start.at;
		const measuredTokens = end.cumulativeTokens - start.cumulativeTokens;
		const measuredSampleCount = this.samples.length - 1;

		// A second delta is enough for a directional number, so short streams still
		// show something; the marker and styling keep it clearly low-confidence.
		this.provisionalRate =
			elapsedMs >= this.provisionalMinimumWindowMs && measuredSampleCount >= 1 && measuredTokens >= this.provisionalMinimumTokens
				? (measuredTokens * 1000) / elapsedMs
				: null;

		if (elapsedMs < this.minimumWindowMs || measuredSampleCount < this.minimumDeltas || measuredTokens < this.minimumTokens) {
			this.currentRate = null;
			this.currentStatus = "measuring";
			return null;
		}

		// Scan in place without allocating arrays. A lower custom threshold can
		// identify several offenders: rollback needs the first, recovery the last.
		let firstSampleId: number | null = null;
		let lastSampleId = 0;
		for (let index = 1; index < this.samples.length; index += 1) {
			const sample = this.samples[index]!;
			if (sample.deltaTokens / measuredTokens >= this.burstShare) {
				firstSampleId ??= sample.id;
				lastSampleId = sample.id;
			}
		}
		if (firstSampleId != null) {
			this.currentRate = null;
			// The provisional number is derived from the same dominant chunk, so it
			// would surface exactly the buffered burst this check suppresses.
			this.provisionalRate = null;
			this.currentStatus = "burst";
			return { firstSampleId, lastSampleId };
		}

		this.currentRate = (measuredTokens * 1000) / elapsedMs;
		this.currentStatus = null;
		this.lastStableRate = this.currentRate;
		return null;
	}
}
