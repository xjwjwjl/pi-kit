import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/**
 * Token Pulse file map
 *
 * 1. Domain types and constants
 * 2. Token estimation
 * 3. Metric calculations
 * 4. Formatting helpers
 * 5. Widget line rendering
 * 6. Runtime state factory
 * 7. pi event wiring
 */

// ── 1. Domain types and constants ─────────────────────────────────────

type EstimateKind = "auto" | "prose" | "structured" | "code";

type EstimateProfile = {
	asciiWordish: number;
	asciiPunct: number;
	cjk: number;
	otherNonAscii: number;
};

const ESTIMATE_PROFILES: Record<Exclude<EstimateKind, "auto">, EstimateProfile> = {
	prose: {
		asciiWordish: 1 / 4.1,
		asciiPunct: 1 / 2.2,
		cjk: 0.95,
		otherNonAscii: 0.7,
	},
	structured: {
		asciiWordish: 1 / 3.0,
		asciiPunct: 1 / 1.55,
		cjk: 1.0,
		otherNonAscii: 0.85,
	},
	code: {
		asciiWordish: 1 / 3.25,
		asciiPunct: 1 / 1.8,
		cjk: 0.95,
		otherNonAscii: 0.8,
	},
};

// Precompiled regexes — avoid per-call recompilation in hot paths
const STRUCTURAL_CHARS_RE = /[{}\[\]":,]/g;
const CODE_KEYWORDS_RE = /\b(const|let|var|function|class|return|if|else|for|while|import|export|from|def|SELECT|FROM|WHERE|curl|npm|pnpm|yarn|pip)\b/g;
const CODE_SYNTAX_RE = /[;()<>={}\[\]`/\\]/g;

type PulseState = {
	turnIndex: number | null;
	turnStartedAt: number | null;
	turnEndedAt: number | null;
	wallStartedAt: number | null;
	wallEndedAt: number | null;
	streaming: boolean;
	inToolPhase: boolean;
	visibleText: string;
	thinkingText: string;
	toolCallText: string;
	requestStartedAt: number | null;
	messageStartedAt: number | null;
	messageEndedAt: number | null;
	waitFrozenMs: number | null;
	streamFirstOutputAt: number | null;
	streamLastOutputAt: number | null;
	activeToolCallIds: Set<string>;
	lastOutputTokens: number | null;
};

type PulseSnapshot = PulseState & {
	displayOutTps: number | null;
	displayFirstOutputWaitMs: number | null;
};

type OutMetricDisplay = {
	tps: number;
	waitMs: number | null;
};

type RequestAverageMetrics = {
	avgFirstOutputWaitMs: number | null;
	avgOutTps: number | null;
};

type TurnTokenDisplay = {
	inputTokens: number;
	outputTokens: number;
	outputPending: boolean;
	cacheReadTotal: number;
	costTotal: number;
};

// Runtime/display constants

const TPS_SMOOTHING_ALPHA = 0.4;
const SLOW_FIRST_OUTPUT_WAIT_MS = 10_000;
const WIDGET_KEY = "token-pulse";
const REFRESH_MS = 120;

// ── 2. Time and token estimation ──────────────────────────────────────

function nowMs(): number {
	return Date.now();
}

function estimateWithProfile(text: string, profile: EstimateProfile): number {
	let asciiWordish = 0;
	let asciiPunct = 0;
	let cjk = 0;
	let otherNonAscii = 0;

	for (const char of text) {
		const code = char.charCodeAt(0);
		if (code <= 0x7f) {
			// charCode range instead of regex — hot path, called per character
			if (code <= 0x20 || (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) || code === 0x5f) {
				asciiWordish += 1;
			} else {
				asciiPunct += 1;
			}
			continue;
		}
		if (isWideChar(code)) {
			cjk += 1;
		} else {
			otherNonAscii += 1;
		}
	}

	return asciiWordish * profile.asciiWordish + asciiPunct * profile.asciiPunct + cjk * profile.cjk + otherNonAscii * profile.otherNonAscii;
}

function isProbablyStructured(text: string): boolean {
	const trimmed = text.trim();
	if (!trimmed) return false;
	if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
		return true;
	}
	const structuralChars = (trimmed.match(STRUCTURAL_CHARS_RE) ?? []).length;
	const structuralRatio = structuralChars / trimmed.length;
	return structuralChars >= 4 && structuralRatio >= 0.12 && (trimmed.includes(":") || trimmed.includes("="));
}

function isProbablyCode(text: string): boolean {
	const trimmed = text.trim();
	if (!trimmed) return false;
	if (trimmed.startsWith("```")) return true;
	const keywordHits = (trimmed.match(CODE_KEYWORDS_RE) ?? []).length;
	const syntaxChars = (trimmed.match(CODE_SYNTAX_RE) ?? []).length;
	const syntaxRatio = syntaxChars / trimmed.length;
	return keywordHits > 0 || (syntaxChars >= 4 && syntaxRatio >= 0.08);
}

function estimateSegmentTokens(text: string, kind: Exclude<EstimateKind, "auto">): number {
	return estimateWithProfile(text, ESTIMATE_PROFILES[kind]);
}

function estimateAutoTokens(text: string): number {
	let total = 0;
	let cursor = 0;
	const fenceRegex = /```[\s\S]*?```/g;
	for (const match of text.matchAll(fenceRegex)) {
		const index = match.index ?? 0;
		if (index > cursor) {
			total += estimateAutoTokensWithoutFences(text.slice(cursor, index));
		}
		total += estimateSegmentTokens(match[0], "code");
		cursor = index + match[0].length;
	}
	if (cursor < text.length) {
		total += estimateAutoTokensWithoutFences(text.slice(cursor));
	}
	return total;
}

function estimateAutoTokensWithoutFences(text: string): number {
	let total = 0;
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		if (isProbablyStructured(trimmed)) {
			total += estimateSegmentTokens(line, "structured");
		} else if (isProbablyCode(trimmed)) {
			total += estimateSegmentTokens(line, "code");
		} else {
			total += estimateSegmentTokens(line, "prose");
		}
	}
	return total;
}

function estimateTokensFromTextRaw(text: string, kind: EstimateKind = "auto"): number {
	const trimmed = text.trim();
	if (!trimmed) return 0;
	return kind === "auto" ? estimateAutoTokens(trimmed) : estimateSegmentTokens(trimmed, kind);
}

// ── 3. Metric calculations ───────────────────────────────────────────

function requestStartedAt(state: PulseState): number | null {
	return state.requestStartedAt ?? state.messageStartedAt;
}

function outTokens(state: PulseState): number {
	if (typeof state.lastOutputTokens === "number" && state.lastOutputTokens >= 0) {
		return state.lastOutputTokens;
	}
	return estimateTokensFromTextRaw(state.visibleText, "auto") + estimateTokensFromTextRaw(state.thinkingText, "prose") + estimateTokensFromTextRaw(state.toolCallText, "structured");
}

function generationDurationMs(state: PulseState): number | null {
	if (state.streamFirstOutputAt == null) return null;
	// Freeze at last output when streaming stops; prevents false TPS decay
	const endedAt = state.messageEndedAt ?? (state.streaming ? nowMs() : (state.streamLastOutputAt ?? nowMs()));
	return Math.max(0, endedAt - state.streamFirstOutputAt);
}

function firstOutputWaitMs(state: PulseState): number | null {
	const startedAt = requestStartedAt(state);
	if (startedAt == null) return null;
	if (state.streamFirstOutputAt == null) {
		if (state.messageEndedAt != null) return null;
		return Math.max(0, nowMs() - startedAt);
	}
	return state.waitFrozenMs;
}

function requestTotalDurationMs(state: PulseState): number | null {
	if (state.wallStartedAt == null) return null;
	const endedAt = state.wallEndedAt ?? nowMs();
	return Math.max(0, endedAt - state.wallStartedAt);
}

// ── 4. Formatting and width helpers ──────────────────────────────────

function formatDuration(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	const totalSeconds = Math.round(ms / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (seconds === 0) return `${minutes}m`;
	return `${minutes}m${seconds}s`;
}

function formatTps(value: number | null): string {
	if (value == null || !Number.isFinite(value)) return "--";
	if (value >= 10) return value.toFixed(0);
	if (value >= 5) return value.toFixed(1);
	return value.toFixed(2);
}

function formatTokenCount(n: number): string {
	const r = Math.round(n);
	if (r <= 0) return "0";
	if (r < 1000) return String(r);
	return `${(r / 1000).toFixed(1)}k`;
}

function formatCost(value: number): string {
	if (!Number.isFinite(value) || value <= 0) return "$0";
	if (value < 1) return `$${value.toFixed(4)}`;
	if (value < 10) return `$${value.toFixed(3)}`;
	return `$${value.toFixed(2)}`;
}

function smoothTps(previous: number | null, next: number): number {
	if (previous == null || !Number.isFinite(previous)) return next;
	return previous + (next - previous) * TPS_SMOOTHING_ALPHA;
}

function isWideChar(code: number): boolean {
	return (code >= 0x3400 && code <= 0x9FFF) || (code >= 0xF900 && code <= 0xFAFF);
}

function isSlowFirstOutputWait(waitMs: number | null): boolean {
	return waitMs != null && waitMs >= SLOW_FIRST_OUTPUT_WAIT_MS;
}

function metricParts(snapshot: PulseSnapshot, theme: any) {
	const fg = (color: string, value: string) => (theme?.fg ? theme.fg(color, value) : value);
	const bold = (value: string) => (theme?.bold ? theme.bold(value) : value);
	const dim = (value: string) => fg("dim", value);
	const muted = (value: string) => fg("muted", value);
	const accent = (value: string) => fg("accent", value);
	const warn = (value: string) => fg("warning", value);
	const firstIsSlow = isSlowFirstOutputWait(snapshot.displayFirstOutputWaitMs);
	const firstIsStale = !firstIsSlow && snapshot.displayOutTps != null;
	const firstPart =
		snapshot.displayFirstOutputWaitMs == null
			? null
			: `${firstIsSlow ? warn("first") : dim("first")} ${firstIsSlow ? warn(formatDuration(snapshot.displayFirstOutputWaitMs)) : firstIsStale ? dim(formatDuration(snapshot.displayFirstOutputWaitMs)) : muted(formatDuration(snapshot.displayFirstOutputWaitMs))}`;
	const tpsPart =
		snapshot.displayOutTps == null
			? null
			: `${snapshot.streaming ? accent(bold(formatTps(snapshot.displayOutTps))) : muted(formatTps(snapshot.displayOutTps))} ${dim("tok/s")}`;
	return { firstPart, tpsPart };
}

// ── 5. Widget line rendering ─────────────────────────────────────────

function renderWidgetLine(snapshot: PulseSnapshot, theme: any, tokenDisplay: TurnTokenDisplay): string {
	const dim = (s: string) => (theme?.fg ? theme.fg("dim", s) : s);
	const totalMs = requestTotalDurationMs(snapshot);
	if (totalMs == null) return "";

	const isDone = snapshot.wallEndedAt != null && !snapshot.streaming && !snapshot.inToolPhase;
	// ponytail: when done, clear widget — notify banner shows the summary
	if (isDone) return "";

	const timePart = `${dim("⏱")} ${dim(formatDuration(totalMs))}`;
	const statParts: string[] = [];
	if (tokenDisplay.inputTokens > 0) {
		statParts.push(`${dim("↑")}${dim(formatTokenCount(tokenDisplay.inputTokens))}`);
	}
	const outTokens = tokenDisplay.outputTokens;
	if (outTokens > 0 || tokenDisplay.outputPending) {
		statParts.push(`${dim("↓")}${dim(formatTokenCount(outTokens))}`);
	}
	if (tokenDisplay.cacheReadTotal > 0) {
		statParts.push(`${dim("R")}${dim(formatTokenCount(tokenDisplay.cacheReadTotal))}`);
	}
	if (tokenDisplay.costTotal > 0) {
		statParts.push(dim(formatCost(tokenDisplay.costTotal)));
	}

	const detailParts: string[] = [];
	const { firstPart, tpsPart } = metricParts(snapshot, theme);
	if (firstPart) detailParts.push(firstPart);
	if (tpsPart) detailParts.push(tpsPart);

	let line = timePart;
	if (statParts.length > 0) line += ` ${dim("|")} ${statParts.join(" ")}`;
	if (detailParts.length > 0) line += ` ${dim("|")} ${detailParts.join(` ${dim("\u00b7")} `)}`;
	return line;
}

// ── 6. Runtime state factory ─────────────────────────────────────────

function createState(): PulseState {
	return {
		turnIndex: null,
		turnStartedAt: null,
		turnEndedAt: null,
		wallStartedAt: null,
		wallEndedAt: null,
		streaming: false,
		inToolPhase: false,
		visibleText: "",
		thinkingText: "",
		toolCallText: "",
		requestStartedAt: null,
		messageStartedAt: null,
		messageEndedAt: null,
		waitFrozenMs: null,
		streamFirstOutputAt: null,
		streamLastOutputAt: null,
		activeToolCallIds: new Set(),
		lastOutputTokens: null,
	};
}

function resetState(state: PulseState, turnIndex: number | null): void {
	state.turnIndex = turnIndex;
	state.turnStartedAt = turnIndex == null ? null : nowMs();
	state.turnEndedAt = null;
	state.streaming = false;
	state.inToolPhase = false;
	state.visibleText = "";
	state.thinkingText = "";
	state.toolCallText = "";
	state.requestStartedAt = null;
	state.messageStartedAt = null;
	state.messageEndedAt = null;
	state.waitFrozenMs = null;
	state.streamFirstOutputAt = null;
	state.streamLastOutputAt = null;
	state.activeToolCallIds.clear();
	state.lastOutputTokens = null;
}

// ── 7. pi event wiring ───────────────────────────────────────────────

function extractDelta(event: any, type: "text_delta" | "thinking_delta" | "toolcall_delta"): string {
	const delta = event?.assistantMessageEvent;
	if (!delta || delta.type !== type) return "";
	return typeof delta.delta === "string" ? delta.delta : "";
}

function isAssistantMessage(event: any): boolean {
	return event?.message?.role === "assistant";
}

export default function tokenPulseExtension(pi: ExtensionAPI) {
	// Mutable runtime state for the current session/request.
	const state = createState();
	let timer: ReturnType<typeof setInterval> | undefined;
	let lastCtx: ExtensionContext | undefined;
	let pendingTurnIndex: number | null = null;

	// Sticky display state keeps the last meaningful Output TPS visible
	// through tool phases and completed turns.
	let stickyOutMetric: OutMetricDisplay | null = null;
	let smoothedOutTps: number | null = null;
	let lastDisplayOutTps: number | null = null;
	let lastDeltaTokens = 0;
	let lastDeltaTimeMs = 0;
	// Agent-level usage totals — input/output from provider usage, output estimated during streaming until finalized
	let inputTokens = 0;
	let outputTokens = 0;
	let cacheReadTotal = 0;
	let runCostTotal = 0;
	let currentRequestOutputPending = false;
	// Token estimation cache — skip re-estimation when text hasn't changed
	let cachedTokens = 0;
	let cachedVisibleLen = -1;
	let cachedThinkingLen = -1;
	let cachedToolCallLen = -1;

	const outTokensCached = (s: PulseState): number => {
		if (typeof s.lastOutputTokens === "number" && s.lastOutputTokens >= 0) {
			return s.lastOutputTokens;
		}
		const vLen = s.visibleText.length;
		const tLen = s.thinkingText.length;
		const cLen = s.toolCallText.length;
		if (vLen !== cachedVisibleLen || tLen !== cachedThinkingLen || cLen !== cachedToolCallLen) {
			cachedTokens = estimateTokensFromTextRaw(s.visibleText, "auto")
				+ estimateTokensFromTextRaw(s.thinkingText, "prose")
				+ estimateTokensFromTextRaw(s.toolCallText, "structured");
			cachedVisibleLen = vLen;
			cachedThinkingLen = tLen;
			cachedToolCallLen = cLen;
		}
		return cachedTokens;
	};

	const resetUsageTotals = () => {
		inputTokens = 0;
		outputTokens = 0;
		cacheReadTotal = 0;
		runCostTotal = 0;
		currentRequestOutputPending = false;
	};

	const getTurnTokenDisplay = (): TurnTokenDisplay => {
		const pendingOutputTokens = currentRequestOutputPending ? outTokensCached(state) : 0;
		return {
			inputTokens,
			outputTokens: outputTokens + pendingOutputTokens,
			outputPending: currentRequestOutputPending,
			cacheReadTotal,
			costTotal: runCostTotal,
		};
	};

	const commitPendingEstimatedUsage = () => {
		if (currentRequestOutputPending) {
			const estimatedOutput = outTokensCached(state);
			if (estimatedOutput > 0) {
				outputTokens += estimatedOutput;
			}
			currentRequestOutputPending = false;
		}
	};

	let avgFirstOutputWaitTotalMs = 0;
	let avgFirstOutputWaitCount = 0;
	let avgOutputTokens = 0;
	let avgGenerationDurationMs = 0;

	const resetStickyMetrics = (resetLastDisplay = false) => {
		stickyOutMetric = null;
		smoothedOutTps = null;
		lastDeltaTokens = 0;
		lastDeltaTimeMs = 0;
		cachedVisibleLen = -1;
		cachedThinkingLen = -1;
		cachedToolCallLen = -1;
		if (resetLastDisplay) lastDisplayOutTps = null;
	};

	const resetRequestAverages = () => {
		avgFirstOutputWaitTotalMs = 0;
		avgFirstOutputWaitCount = 0;
		avgOutputTokens = 0;
		avgGenerationDurationMs = 0;
	};

	const getRequestAverages = (): RequestAverageMetrics => ({
		avgFirstOutputWaitMs: avgFirstOutputWaitCount > 0 ? avgFirstOutputWaitTotalMs / avgFirstOutputWaitCount : null,
		avgOutTps: avgGenerationDurationMs > 0 ? (avgOutputTokens * 1000) / avgGenerationDurationMs : null,
	});

	const recordCompletedModelTurnAverages = () => {
		if (state.waitFrozenMs != null) {
			avgFirstOutputWaitTotalMs += state.waitFrozenMs;
			avgFirstOutputWaitCount += 1;
		}

		const genMs = generationDurationMs(state);
		const tokens = outTokens(state);
		if (genMs != null && genMs > 0 && tokens > 0) {
			avgOutputTokens += tokens;
			avgGenerationDurationMs += genMs;
		}
	};

	// Convert mutable event state into a render-ready snapshot.
	const getSnapshot = (): PulseSnapshot => {
		const tokens = outTokensCached(state);
		const time = nowMs();
		let nextOutTps: number | null = null;

		// Delta-based instantaneous TPS — only update reference on valid samples
		if (lastDeltaTimeMs === 0) {
			lastDeltaTokens = tokens;
			lastDeltaTimeMs = time;
		} else if (time > lastDeltaTimeMs) {
			const dTok = tokens - lastDeltaTokens;
			if (dTok > 0) {
				const dMs = time - lastDeltaTimeMs;
				if (dMs >= 200) {
					nextOutTps = (dTok * 1000) / dMs;
					lastDeltaTokens = tokens;
					lastDeltaTimeMs = time;
				}
			}
		}

		const nextWaitMs = firstOutputWaitMs(state);
		const outputActive = state.streaming || state.inToolPhase;

		if (nextOutTps != null) {
			smoothedOutTps = outputActive ? smoothTps(smoothedOutTps, nextOutTps) : nextOutTps;
			lastDisplayOutTps = smoothedOutTps;
			stickyOutMetric = {
				tps: smoothedOutTps,
				waitMs: nextWaitMs,
			};
		}

		if (stickyOutMetric != null && nextOutTps == null) {
			lastDisplayOutTps = stickyOutMetric.tps;
			return {
				...state,
				displayOutTps: stickyOutMetric.tps,
				displayFirstOutputWaitMs: nextWaitMs ?? stickyOutMetric.waitMs,
			};
		}

		return {
			...state,
			displayOutTps: smoothedOutTps ?? lastDisplayOutTps,
			displayFirstOutputWaitMs: nextWaitMs,
		};
	};

	// Widget line lifecycle — unified metrics above editor
	const requestRender = (ctx = lastCtx) => {
		if (!ctx?.hasUI) return;
		lastCtx = ctx;
		const snapshot = getSnapshot();
		const line = renderWidgetLine(snapshot, ctx.ui.theme, getTurnTokenDisplay());
		ctx.ui.setWidget(WIDGET_KEY, line ? [line] : undefined, { placement: "aboveEditor" });
	};

	const clearUI = (ctx = lastCtx) => {
		if (!ctx?.hasUI) return;
		ctx.ui.setWidget(WIDGET_KEY, undefined);
	};

	const stopTimer = () => {
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
	};

	const startTimer = (ctx: ExtensionContext | undefined) => {
		lastCtx = ctx ?? lastCtx;
		if (!timer) {
			timer = setInterval(() => requestRender(), REFRESH_MS);
		}
	};

	// Model turn and phase transitions.
	const resetForPendingTurn = () => {
		resetState(state, pendingTurnIndex);
	};

	const ensureTurnMeasurement = () => {
		if (pendingTurnIndex == null) return;
		if (state.turnIndex === pendingTurnIndex) return;
		resetForPendingTurn();
	};

	const markStreaming = () => {
		state.streaming = true;
		if (state.activeToolCallIds.size === 0) {
			state.inToolPhase = false;
		}
	};

	const recordStreamOutput = () => {
		const at = nowMs();
		if (state.streamFirstOutputAt == null) {
			state.streamFirstOutputAt = at;
			const startedAt = requestStartedAt(state);
			if (startedAt != null && state.waitFrozenMs == null) {
				state.waitFrozenMs = Math.max(0, at - startedAt);
			}
		}
		state.streamLastOutputAt = at;
	};

	const finishModelGeneration = () => {
		if (state.messageEndedAt == null) {
			state.messageEndedAt = nowMs();
		}
		state.streaming = false;
	};

	const finishTurn = () => {
		if (state.turnStartedAt != null && state.turnEndedAt == null) {
			state.turnEndedAt = nowMs();
		}
	};

	const beginToolExecution = (toolCallId: string | undefined) => {
		if (toolCallId) {
			state.activeToolCallIds.add(toolCallId);
		}
		state.streaming = false;
		state.inToolPhase = true;
	};

	const endToolExecution = (toolCallId?: string) => {
		if (toolCallId) {
			state.activeToolCallIds.delete(toolCallId);
		} else {
			state.activeToolCallIds.clear();
		}
		if (state.activeToolCallIds.size === 0) {
			state.inToolPhase = false;
		}
	};

	// pi event handlers.

	pi.on("session_start", (_event, ctx) => {
		pendingTurnIndex = null;
		resetState(state, null);
		state.wallStartedAt = null;
		state.wallEndedAt = null;
		resetStickyMetrics(true);
		resetRequestAverages();
		resetUsageTotals();
		clearUI(ctx);
		requestRender(ctx);
	});

	pi.on("agent_start", (_event, ctx) => {
		if (state.wallStartedAt == null || state.wallEndedAt != null) {
			state.wallStartedAt = nowMs();
			state.wallEndedAt = null;
		}
		resetStickyMetrics(true);
		resetRequestAverages();
		resetUsageTotals();
		clearUI(ctx);
		requestRender(ctx);
	});

	pi.on("turn_start", (event: any, ctx) => {
		pendingTurnIndex = typeof event?.turnIndex === "number" ? event.turnIndex : null;
		resetForPendingTurn();
		resetStickyMetrics();
		requestRender(ctx);
	});

	pi.on("before_provider_request", (event: any, ctx) => {
		ensureTurnMeasurement();
		commitPendingEstimatedUsage();
		currentRequestOutputPending = true;
		state.requestStartedAt = nowMs();
		state.messageStartedAt = null;
		state.messageEndedAt = null;
		state.waitFrozenMs = null;
		state.streamFirstOutputAt = null;
		state.streamLastOutputAt = null;
		state.visibleText = "";
		state.thinkingText = "";
		state.toolCallText = "";
		state.lastOutputTokens = null;
		lastDeltaTokens = 0;
		lastDeltaTimeMs = 0;
		cachedVisibleLen = -1;
		cachedThinkingLen = -1;
		cachedToolCallLen = -1;
		startTimer(ctx);
		requestRender(ctx);
	});

	pi.on("message_start", (event: any, ctx) => {
		if (!isAssistantMessage(event)) return;
		ensureTurnMeasurement();
		const timestamp = event?.message?.timestamp;
		if (state.requestStartedAt == null) {
			state.requestStartedAt = typeof timestamp === "number" ? timestamp : nowMs();
		}
		state.messageStartedAt = nowMs();
		state.messageEndedAt = null;
		requestRender(ctx);
	});

	pi.on("message_update", (event: any, ctx) => {
		if (!isAssistantMessage(event)) return;

		const assistantEvent = event?.assistantMessageEvent;
		const textDelta = extractDelta(event, "text_delta");
		const thinkingDelta = extractDelta(event, "thinking_delta");
		const toolCallDelta = extractDelta(event, "toolcall_delta");

		if (textDelta) {
			ensureTurnMeasurement();
			markStreaming();
			state.visibleText += textDelta;
			recordStreamOutput();
			startTimer(ctx);
			requestRender(ctx);
			return;
		}

		if (thinkingDelta) {
			ensureTurnMeasurement();
			markStreaming();
			state.thinkingText += thinkingDelta;
			recordStreamOutput();
			startTimer(ctx);
			requestRender(ctx);
			return;
		}

		if (assistantEvent?.type === "toolcall_start" || assistantEvent?.type === "toolcall_delta" || assistantEvent?.type === "toolcall_end") {
			ensureTurnMeasurement();
			markStreaming();
			if (toolCallDelta) {
				state.toolCallText += toolCallDelta;
			}
			recordStreamOutput();
			startTimer(ctx);
			requestRender(ctx);
			return;
		}

		if (assistantEvent?.type === "done") {
			finishModelGeneration();
			requestRender(ctx);
			return;
		}

		if (assistantEvent?.type === "error") {
			finishModelGeneration();
			requestRender(ctx);
		}
	});

	pi.on("tool_execution_start", (event: any, ctx) => {
		ensureTurnMeasurement();
		finishModelGeneration();
		beginToolExecution(typeof event?.toolCallId === "string" ? event.toolCallId : undefined);
		startTimer(ctx);
		requestRender(ctx);
	});

	pi.on("tool_execution_end", (event: any, ctx) => {
		if (state.turnIndex == null) return;
		endToolExecution(typeof event?.toolCallId === "string" ? event.toolCallId : undefined);
		requestRender(ctx);
	});

	pi.on("message_end", (event: any, ctx) => {
		if (!isAssistantMessage(event)) return;

		ensureTurnMeasurement();
		finishModelGeneration();

		const input = event?.message?.usage?.input;
		const output = event?.message?.usage?.output;
		const cacheRead = event?.message?.usage?.cacheRead;
		const cost = event?.message?.usage?.cost?.total;
		if (typeof input === "number" && Number.isFinite(input) && input > 0) {
			inputTokens += input;
		}
		if (typeof output === "number" && output >= 0) {
			state.lastOutputTokens = output;
			outputTokens += output;
			lastDeltaTokens = 0;
			lastDeltaTimeMs = 0;
			cachedVisibleLen = -1;
			cachedThinkingLen = -1;
			cachedToolCallLen = -1;
		} else if (currentRequestOutputPending) {
			const estimatedOutput = outTokensCached(state);
			if (estimatedOutput > 0) {
				outputTokens += estimatedOutput;
			}
		}
		if (typeof cacheRead === "number" && Number.isFinite(cacheRead) && cacheRead > 0) {
			cacheReadTotal += cacheRead;
		}
		if (typeof cost === "number" && Number.isFinite(cost) && cost > 0) {
			runCostTotal += cost;
		}
		currentRequestOutputPending = false;
		recordCompletedModelTurnAverages();

		requestRender(ctx);
	});

	pi.on("turn_end", (_event, ctx) => {
		commitPendingEstimatedUsage();
		finishModelGeneration();
		endToolExecution();
		finishTurn();
		state.streaming = false;
		state.inToolPhase = false;
		stopTimer();
		requestRender(ctx);
	});

	pi.on("agent_end", (_event, ctx) => {
		commitPendingEstimatedUsage();
		state.wallEndedAt = nowMs();
		finishModelGeneration();
		endToolExecution();
		finishTurn();
		state.streaming = false;
		stopTimer();

		// ponytail: persist run metrics as session entry (invisible to LLM)
		const totalMs = state.wallStartedAt != null ? state.wallEndedAt - state.wallStartedAt : 0;
		const averages = getRequestAverages();
		// ponytail: show run summary as persistent notification
		const timePart = `⏱ ${formatDuration(totalMs)}`;
		const statParts: string[] = [];
		if (inputTokens > 0) statParts.push(`↑${formatTokenCount(inputTokens)}`);
		if (outputTokens > 0) statParts.push(`↓${formatTokenCount(outputTokens)}`);
		if (cacheReadTotal > 0) statParts.push(`R${formatTokenCount(cacheReadTotal)}`);
		if (runCostTotal > 0) statParts.push(formatCost(runCostTotal));
		const avgParts: string[] = [];
		if (averages.avgFirstOutputWaitMs != null) avgParts.push(`avg first ${formatDuration(averages.avgFirstOutputWaitMs)}`);
		if (averages.avgOutTps != null) avgParts.push(`avg ${formatTps(averages.avgOutTps)} tok/s`);
		let message = timePart;
		if (statParts.length > 0) message += ` | ${statParts.join(" ")}`;
		if (avgParts.length > 0) message += ` | ${avgParts.join(" · ")}`;
		if (ctx.hasUI) ctx.ui.notify(message, "info");

		requestRender(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		pendingTurnIndex = null;
		stopTimer();
		commitPendingEstimatedUsage();
		resetState(state, null);
		state.wallStartedAt = null;
		state.wallEndedAt = null;
		resetStickyMetrics(true);
		resetRequestAverages();
		resetUsageTotals();
		clearUI(ctx);
	});
}
