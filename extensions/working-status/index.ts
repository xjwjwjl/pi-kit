import type {
	BeforeProviderRequestEvent,
	ExtensionAPI,
	ExtensionContext,
	MessageEndEvent,
	MessageStartEvent,
	MessageUpdateEvent,
	Theme,
	ThemeColor,
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
	TurnStartEvent,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { OutputRateTracker } from "./src/output-rate-tracker.ts";

/**
 * Working Status file map
 *
 * 1. Domain types and constants
 * 2. Token estimation
 * 3. Metric calculations
 * 4. Formatting helpers
 * 5. Working status rendering
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
	wallStartedAt: number | null;
	wallEndedAt: number | null;
	streaming: boolean;
	inToolPhase: boolean;
	// Locally estimated output for the in-flight request. Each delta is estimated
	// as it arrives, so the pending count stays O(1) and no stream text is retained.
	visibleTokens: number;
	thinkingTokens: number;
	toolCallTokens: number;
	requestStartedAt: number | null;
	providerResponseAt: number | null;
	messageStartedAt: number | null;
	messageEndedAt: number | null;
	waitFrozenMs: number | null;
	streamFirstOutputAt: number | null;
	activeToolCallIds: Set<string>;
};

type PulseSnapshot = PulseState & {
	displayOutTps: number | null;
	displayOutTpsProvisional: number | null;
	displayOutTpsRetained: number | null;
	displayOutTpsStale: boolean;
	displayFirstOutputWaitMs: number | null;
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

const SLOW_FIRST_OUTPUT_WAIT_MS = 10_000;
const DEFAULT_WORKING_MESSAGE = "Working";
const REFRESH_MS = 250;
// Keep the final metrics visible briefly after the run settles before clearing.
const FINAL_DISPLAY_MS = 3_000;
// Below this the stream span is too short to derive a meaningful rate.
const MIN_STREAM_RATE_DURATION_MS = 250;
// The message renders inside the editor's top border: Pi hands the border
// `columns - 5`, the loader prefixes `spinner + space`, and the border renderer
// trims one leading padding column, leaving `columns - 8` for the message.
const WORKING_STATUS_WIDTH_OVERHEAD = 8;

// ── 2. Time and token estimation ──────────────────────────────────────

function nowMs(): number {
	return Date.now();
}

function estimateWithProfile(text: string, profile: EstimateProfile): number {
	let asciiWordish = 0;
	let asciiPunct = 0;
	let cjk = 0;
	let otherNonAscii = 0;

	// Iterate by code point: astral characters (CJK Ext B–H, emoji) arrive as a
	// surrogate pair and would otherwise be counted and classified twice.
	for (const char of text) {
		const code = char.codePointAt(0) ?? 0;
		if (code <= 0x7f) {
			// Code-point range instead of regex — hot path, called per character
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

/**
 * Wall-clock basis for output latency and stream throughput.
 *
 * Both bases exclude transport setup so the two provider transports stay
 * comparable: `after_provider_response` marks the successful response headers
 * (SSE), and `message_start` marks the stream being established (WebSocket,
 * which never emits an HTTP response). The request hook is the last resort; it
 * runs before connect attempts and retry backoff, so it would inflate `first`.
 */
function outputMeasurementStartedAt(state: PulseState): number | null {
	return state.providerResponseAt ?? state.messageStartedAt ?? requestStartedAt(state);
}

function firstOutputWaitMs(state: PulseState): number | null {
	const startedAt = outputMeasurementStartedAt(state);
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
	if (r < 1_000_000) return `${(r / 1000).toFixed(1)}k`;
	return `${(r / 1_000_000).toFixed(1)}M`;
}

function formatCost(value: number): string {
	if (!Number.isFinite(value) || value <= 0) return "$0";
	if (value < 1) return `$${value.toFixed(4)}`;
	if (value < 10) return `$${value.toFixed(3)}`;
	return `$${value.toFixed(2)}`;
}

function cacheReadPercent(cacheReadTotal: number, inputTokens: number): number | null {
	const total = inputTokens + cacheReadTotal;
	if (total <= 0) return null;
	return Math.round((cacheReadTotal / total) * 100);
}

type MetricKind = "input" | "output" | "cache" | "cost";

type MetricEntry = {
	kind: MetricKind;
	count: string;
	percent: number | null;
	pending: boolean;
};

/** Canonical metric segments — the single source of truth for what gets shown. */
function buildMetricEntries(
	inputTokens: number,
	outputTokens: number,
	outputPending: boolean,
	cacheReadTotal: number,
	costTotal: number,
): MetricEntry[] {
	const entries: MetricEntry[] = [];
	if (inputTokens > 0) {
		entries.push({ kind: "input", count: formatTokenCount(inputTokens), percent: null, pending: false });
	}
	if (outputTokens > 0 || outputPending) {
		entries.push({ kind: "output", count: formatTokenCount(outputTokens), percent: null, pending: outputPending });
	}
	if (cacheReadTotal > 0) {
		entries.push({ kind: "cache", count: formatTokenCount(cacheReadTotal), percent: cacheReadPercent(cacheReadTotal, inputTokens), pending: false });
	}
	if (costTotal > 0) {
		entries.push({ kind: "cost", count: formatCost(costTotal), percent: null, pending: false });
	}
	return entries;
}

/**
 * Ranges terminals render as two columns. Callers must pass a full code point:
 * astral characters lose their high bits when read as a UTF-16 code unit, which
 * silently disabled the supplementary ranges here.
 */
function isWideChar(codePoint: number): boolean {
	return (
		// BMP CJK (incl. radicals/kangxi) and compat ideographs
		(codePoint >= 0x3400 && codePoint <= 0x9FFF) ||
		(codePoint >= 0xF900 && codePoint <= 0xFAFF) ||
		// Wide pictographs/emoji
		(codePoint >= 0x1F300 && codePoint <= 0x1FAFF) ||
		// Supplementary CJK Ext B–H and compat supplement
		(codePoint >= 0x20000 && codePoint <= 0x323AF)
	);
}

function isSlowFirstOutputWait(waitMs: number | null): boolean {
	return waitMs != null && waitMs >= SLOW_FIRST_OUTPUT_WAIT_MS;
}

const ANSI_ESCAPE_RE = /\x1B\[[0-9;]*[A-Za-z]/g;

function visibleTextWidth(text: string): number {
	const plain = text.replace(ANSI_ESCAPE_RE, "");
	let width = 0;
	for (const char of plain) {
		width += isWideChar(char.codePointAt(0) ?? 0) ? 2 : 1;
	}
	return width;
}

function metricParts(snapshot: PulseSnapshot, theme: Theme) {
	const fg = (color: ThemeColor, value: string) => (theme?.fg ? theme.fg(color, value) : value);
	const bold = (value: string) => (theme?.bold ? theme.bold(value) : value);
	const dim = (value: string) => fg("dim", value);
	const muted = (value: string) => fg("muted", value);
	const accent = (value: string) => fg("accent", value);
	const warn = (value: string) => fg("warning", value);
	const firstIsSlow = isSlowFirstOutputWait(snapshot.displayFirstOutputWaitMs);
	const hasAnyTps =
		snapshot.displayOutTps != null || snapshot.displayOutTpsProvisional != null || snapshot.displayOutTpsRetained != null;
	// Once a rate is on screen it is the headline metric, so a normal wait is
	// de-emphasized below the muted default; only a slow wait keeps its color.
	const firstIsDemoted = !firstIsSlow && hasAnyTps;
	let firstPart: string | null = null;
	if (snapshot.displayFirstOutputWaitMs != null) {
		const duration = formatDuration(snapshot.displayFirstOutputWaitMs);
		if (firstIsSlow) firstPart = `${warn("first")} ${warn(duration)}`;
		else firstPart = `${dim("first")} ${firstIsDemoted ? dim(duration) : muted(duration)}`;
	}
	let tpsPart: string | null = null;
	if (snapshot.displayOutTps != null) {
		const formatted = `~${formatTps(snapshot.displayOutTps)}`;
		const value = snapshot.streaming && !snapshot.displayOutTpsStale ? accent(bold(formatted)) : muted(formatted);
		tpsPart = `${value} ${dim("tok/s")}`;
	} else if (snapshot.displayOutTpsProvisional != null) {
		// Provisional values track the earliest measurable window and can still be
		// skewed by buffered chunks, so they stay muted behind a distinct marker.
		const formatted = `≈${formatTps(snapshot.displayOutTpsProvisional)}`;
		tpsPart = `${muted(formatted)} ${dim("tok/s")}`;
	} else if (snapshot.displayOutTpsRetained != null) {
		// The last confident rate, kept visible after a burst or a pause.
		const formatted = `~${formatTps(snapshot.displayOutTpsRetained)}`;
		tpsPart = `${muted(formatted)} ${dim("tok/s")}`;
	}
	return { firstPart, tpsPart };
}

// ── 5. Working status rendering ───────────────────────────────────────

function renderWorkingMessage(snapshot: PulseSnapshot, theme: Theme, tokenDisplay: TurnTokenDisplay): string {
	const dim = (value: string) => (theme?.fg ? theme.fg("dim", value) : value);
	const muted = (value: string) => (theme?.fg ? theme.fg("muted", value) : value);
	const accent = (value: string) => (theme?.fg ? theme.fg("accent", value) : value);
	const text = (value: string) => (theme?.fg ? theme.fg("text", value) : value);
	const totalMs = requestTotalDurationMs(snapshot);
	if (totalMs == null) return "";

	const wallEndedAt = snapshot.wallEndedAt;
	const done = wallEndedAt != null && !snapshot.streaming && !snapshot.inToolPhase;
	// Keep the final metrics visible briefly after the run settles, then clear.
	if (done && nowMs() - wallEndedAt >= FINAL_DISPLAY_MS) return "";

	const timePart = `${dim("◷")} ${dim(formatDuration(totalMs))}`;
	// Priority order: output, input, cache, cost — output is the headline metric.
	const LIVE_PRIORITY: Record<MetricKind, number> = { output: 0, input: 1, cache: 2, cost: 3 };
	const entries = buildMetricEntries(
		tokenDisplay.inputTokens,
		tokenDisplay.outputTokens,
		tokenDisplay.outputPending,
		tokenDisplay.cacheReadTotal,
		tokenDisplay.costTotal,
	).sort((a, b) => LIVE_PRIORITY[a.kind] - LIVE_PRIORITY[b.kind]);
	const statParts: string[] = [];
	for (const entry of entries) {
		if (entry.kind === "input") {
			statParts.push(`${muted("↑")}${muted(entry.count)}`);
		} else if (entry.kind === "output") {
			const outputText = entry.pending && entry.count !== "0" ? `~${entry.count}` : entry.count;
			statParts.push(`${text("↓")}${text(outputText)}`);
		} else if (entry.kind === "cache") {
			statParts.push(`${muted("CH")}${muted(entry.percent == null ? entry.count : `${entry.percent}%`)}`);
		} else {
			statParts.push(accent(entry.count));
		}
	}

	const detailParts: string[] = [];
	const { firstPart, tpsPart } = metricParts(snapshot, theme);
	if (firstPart) detailParts.push(firstPart);
	if (tpsPart) detailParts.push(tpsPart);

	// Assemble within a width budget; token/cost stats stay as one group.
	const budget = Math.max(28, (process.stdout.columns ?? 80) - WORKING_STATUS_WIDTH_OVERHEAD);
	let line = ` ${dim("|")} ${timePart}`;
	const fits = (candidate: string) => visibleTextWidth(`${DEFAULT_WORKING_MESSAGE}${candidate}`) <= budget;

	if (statParts.length > 0) {
		const visibleStatParts = [...statParts];
		while (visibleStatParts.length > 1) {
			const candidate = `${line} ${dim("|")} ${visibleStatParts.join(" ")}`;
			if (fits(candidate)) break;
			visibleStatParts.pop();
		}
		line = `${line} ${dim("|")} ${visibleStatParts.join(" ")}`;
	}

	if (detailParts.length > 0) {
		const detail = detailParts.join(` ${dim("\u00b7")} `);
		const candidate = `${line} ${dim("|")} ${detail}`;
		if (fits(candidate)) {
			line = candidate;
		} else if (tpsPart) {
			// TPS outranks the first-output wait: on a narrow terminal keep the rate
			// and drop the wait metric instead of dropping both.
			const tpsOnly = `${line} ${dim("|")} ${tpsPart}`;
			if (fits(tpsOnly)) line = tpsOnly;
		}
	}
	return `${DEFAULT_WORKING_MESSAGE}${line}`;
}

// ── 6. Runtime state factory ─────────────────────────────────────────

function createState(): PulseState {
	return {
		turnIndex: null,
		wallStartedAt: null,
		wallEndedAt: null,
		streaming: false,
		inToolPhase: false,
		visibleTokens: 0,
		thinkingTokens: 0,
		toolCallTokens: 0,
		requestStartedAt: null,
		providerResponseAt: null,
		messageStartedAt: null,
		messageEndedAt: null,
		waitFrozenMs: null,
		streamFirstOutputAt: null,
		activeToolCallIds: new Set(),
	};
}

/** Drop the in-flight output estimate without touching the run totals. */
function resetStreamedTokens(state: PulseState): void {
	state.visibleTokens = 0;
	state.thinkingTokens = 0;
	state.toolCallTokens = 0;
}

function resetState(state: PulseState, turnIndex: number | null): void {
	state.turnIndex = turnIndex;
	state.streaming = false;
	state.inToolPhase = false;
	resetStreamedTokens(state);
	state.requestStartedAt = null;
	state.providerResponseAt = null;
	state.messageStartedAt = null;
	state.messageEndedAt = null;
	state.waitFrozenMs = null;
	state.streamFirstOutputAt = null;
	state.activeToolCallIds.clear();
}

// ── 7. pi event wiring ───────────────────────────────────────────────

function extractDelta(event: MessageUpdateEvent, type: "text_delta" | "thinking_delta" | "toolcall_delta"): string {
	const delta = event.assistantMessageEvent;
	// Both checks are required: `type` picks the requested delta kind, and the
	// `in` guard lets TypeScript narrow to the variants carrying `delta`.
	if (delta.type !== type || !("delta" in delta)) return "";
	return delta.delta;
}

/**
 * Narrow an agent message to an assistant message. Pi events carry the wider
 * `AgentMessage` union, which also includes user, tool-result, and custom
 * messages; only assistant messages have this role.
 */
function isAssistantMessage(message: { role: string }): message is AssistantMessage {
	return message.role === "assistant";
}

function isFailedAssistantMessage(message: AssistantMessage): boolean {
	// Pi's only successful assistant terminal states. Treat pending, missing,
	// or provider-specific stop reasons as failed so malformed responses cannot
	// contaminate request averages.
	return message.stopReason !== "stop" && message.stopReason !== "length" && message.stopReason !== "toolUse";
}

function nonNegativeFiniteNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function estimateAssistantMessageTokens(message: AssistantMessage): number {
	if (!Array.isArray(message.content)) return 0;

	let total = 0;
	for (const block of message.content) {
		if (block.type === "text") {
			total += estimateTokensFromTextRaw(block.text, "auto");
		} else if (block.type === "thinking") {
			total += estimateTokensFromTextRaw(block.thinking, "prose");
		} else if (block.type === "toolCall") {
			let argumentsText = "";
			try {
				argumentsText = typeof block.arguments === "string" ? block.arguments : JSON.stringify(block.arguments ?? "") ?? "";
			} catch {
				argumentsText = String(block.arguments ?? "");
			}
			total += estimateTokensFromTextRaw(`${block.name ?? ""}${argumentsText}`, "structured");
		}
	}
	return total;
}
/**
 * Pi calls the response hook for every provider attempt, including the retryable
 * failures it then backs off and retries. Only a successful response may start
 * the output latency clock.
 */
function isSuccessfulProviderResponse(status: number | undefined): boolean {
	return status != null && status >= 200 && status < 300;
}

function resolveFinalOutputTokens(
	failed: boolean,
	providerOutput: number | null,
	estimatedOutput: number,
): number | null {
	// Failed responses may report zero usage after producing partial output. The
	// same fallback is needed for successful compatible endpoints that omit usage
	// and leave the initialized output count at zero.
	if ((providerOutput == null || providerOutput === 0) && estimatedOutput > 0) {
		return estimatedOutput;
	}
	if (providerOutput != null) return providerOutput;
	return estimatedOutput > 0 ? estimatedOutput : null;
}

export default function workingStatusExtension(pi: ExtensionAPI) {
	// Mutable runtime state for the current session/request.
	const state = createState();
	let timer: ReturnType<typeof setInterval> | undefined;
	let lastCtx: ExtensionContext | undefined;
	let pendingTurnIndex: number | null = null;
	// Pi emits agent_start/agent_end for each retry attempt, while agent_settled
	// marks the end of the complete run. Keep totals alive across those attempts.
	let agentRunActive = false;

	// Live rate is estimated locally from text/thinking deltas only. Provider usage
	// feeds the end-of-run totals and the final average stream rate, but it never
	// drives the live TPS display.
	const outputRateTracker = new OutputRateTracker();
	// Agent-level usage totals — input/output from provider usage, output estimated during streaming until finalized
	let inputTokens = 0;
	let outputTokens = 0;
	let cacheReadTotal = 0;
	let runCostTotal = 0;
	let currentRequestOutputPending = false;

	// Locally estimated output for the in-flight request. Deltas are estimated once
	// as they arrive, so this is a sum instead of a full-stream re-estimate.
	const estimatedStreamedTokens = (): number => state.visibleTokens + state.thinkingTokens + state.toolCallTokens;

	const resetUsageTotals = () => {
		inputTokens = 0;
		outputTokens = 0;
		cacheReadTotal = 0;
		runCostTotal = 0;
		currentRequestOutputPending = false;
	};

	const getTurnTokenDisplay = (): TurnTokenDisplay => {
		const pendingOutputTokens = currentRequestOutputPending ? estimatedStreamedTokens() : 0;
		return {
			inputTokens,
			outputTokens: outputTokens + pendingOutputTokens,
			outputPending: currentRequestOutputPending,
			cacheReadTotal,
			costTotal: runCostTotal,
		};
	};

	const commitPendingEstimatedUsage = () => {
		if (!currentRequestOutputPending) return;
		const estimatedOutput = estimatedStreamedTokens();
		if (estimatedOutput > 0) {
			outputTokens += estimatedOutput;
		}
		currentRequestOutputPending = false;
	};

	let avgFirstOutputWaitTotalMs = 0;
	let avgFirstOutputWaitCount = 0;
	// End-of-run TPS uses the same local text/thinking stream estimate as the
	// live indicator. Provider usage remains the source for the ↓ total only.
	let avgStreamedOutputTokens = 0;
	let avgStreamDurationMs = 0;

	const resetRateMetrics = () => {
		outputRateTracker.reset();
	};

	const resetRequestAverages = () => {
		avgFirstOutputWaitTotalMs = 0;
		avgFirstOutputWaitCount = 0;
		avgStreamedOutputTokens = 0;
		avgStreamDurationMs = 0;
	};

	const getRequestAverages = (): RequestAverageMetrics => ({
		avgFirstOutputWaitMs: avgFirstOutputWaitCount > 0 ? avgFirstOutputWaitTotalMs / avgFirstOutputWaitCount : null,
		avgOutTps: avgStreamDurationMs > 0 ? (avgStreamedOutputTokens * 1000) / avgStreamDurationMs : null,
	});

	const recordCompletedModelTurnAverages = (streamedOutputTokens: number, streamFlowMs: number | null) => {
		if (state.waitFrozenMs != null) {
			avgFirstOutputWaitTotalMs += state.waitFrozenMs;
			avgFirstOutputWaitCount += 1;
		}

		// Keep the summary TPS comparable to the live value: text/thinking deltas
		// only. Provider usage can include hidden reasoning and tool arguments that
		// never appeared in the local stream, which inflated the former summary.
		if (streamedOutputTokens > 0 && streamFlowMs != null && streamFlowMs >= MIN_STREAM_RATE_DURATION_MS) {
			avgStreamedOutputTokens += streamedOutputTokens;
			avgStreamDurationMs += streamFlowMs;
		}
	};

	// Convert mutable event state into a render-ready snapshot. Reading the rate
	// never advances its measurement window; only output events record samples.
	const getSnapshot = (): PulseSnapshot => {
		// A retained value survives bursts and pauses, keeping the last confident
		// rate visible (muted) instead of letting it vanish mid-stream.
		const rate = outputRateTracker.snapshot();
		return {
			...state,
			displayOutTps: rate.rate,
			displayOutTpsProvisional: rate.provisionalRate,
			displayOutTpsRetained: rate.retainedRate,
			displayOutTpsStale: rate.stale,
			displayFirstOutputWaitMs: firstOutputWaitMs(state),
		};
	};

	// Working status lifecycle — unified metrics in Pi's built-in working area.
	const requestRender = (ctx = lastCtx) => {
		if (!ctx?.hasUI) return;
		lastCtx = ctx;
		const snapshot = getSnapshot();
		const message = renderWorkingMessage(snapshot, ctx.ui.theme, getTurnTokenDisplay());
		ctx.ui.setWorkingMessage(message || undefined);
	};

	const clearUI = (ctx = lastCtx) => {
		if (!ctx?.hasUI) return;
		ctx.ui.setWorkingMessage();
	};

	const stopTimer = () => {
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
	};

	let clearTimer: ReturnType<typeof setTimeout> | undefined;
	const stopClearTimer = () => {
		if (clearTimer) {
			clearTimeout(clearTimer);
			clearTimer = undefined;
		}
	};
	const scheduleClear = (ctx = lastCtx) => {
		stopClearTimer();
		if (!ctx?.hasUI) return;
		clearTimer = setTimeout(() => {
			clearTimer = undefined;
			clearUI(ctx);
		}, FINAL_DISPLAY_MS);
		clearTimer.unref?.();
	};

	const startTimer = (ctx: ExtensionContext | undefined) => {
		lastCtx = ctx ?? lastCtx;
		if (!timer) {
			timer = setInterval(() => requestRender(), REFRESH_MS);
			timer.unref?.();
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

	/** Freeze the first-output wait once, when output first appears. */
	const markStreamOutputStarted = () => {
		if (state.streamFirstOutputAt != null) return;
		const at = nowMs();
		state.streamFirstOutputAt = at;
		const startedAt = outputMeasurementStartedAt(state);
		if (startedAt != null && state.waitFrozenMs == null) {
			state.waitFrozenMs = Math.max(0, at - startedAt);
		}
	};

	/**
	 * Estimate one streamed text/thinking delta and feed the rate tracker. The same
	 * per-delta estimate is what the pending ↓ count accumulates, so the reported
	 * rate and the displayed token count share one estimation basis.
	 */
	const recordStreamOutput = (delta: string, kind: "auto" | "prose"): number => {
		markStreamOutputStarted();
		const estimatedTokens = estimateTokensFromTextRaw(delta, kind);
		if (estimatedTokens > 0) {
			outputRateTracker.record(estimatedTokens);
			return estimatedTokens;
		}
		outputRateTracker.recordActivity();
		return 0;
	};

	/**
	 * Tool-call JSON stays out of the live rate because it commonly arrives in one
	 * buffered burst, but its time still counts toward the flow window.
	 */
	const recordToolCallActivity = () => {
		markStreamOutputStarted();
		outputRateTracker.recordActivity();
	};

	const finishModelGeneration = () => {
		if (state.messageEndedAt == null) {
			state.messageEndedAt = nowMs();
		}
		state.streaming = false;
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
		agentRunActive = false;
		resetState(state, null);
		state.wallStartedAt = null;
		state.wallEndedAt = null;
		resetRateMetrics();
		resetRequestAverages();
		resetUsageTotals();
		stopClearTimer();
		clearUI(ctx);
		requestRender(ctx);
	});

	pi.on("agent_start", (_event, ctx) => {
		const isNewAgentRun = !agentRunActive;
		agentRunActive = true;

		// Automatic retries create another agent_start, but they are still part of
		// the same user-visible run and must not erase its accumulated usage.
		if (isNewAgentRun) {
			if (state.wallStartedAt == null || state.wallEndedAt != null) {
				state.wallStartedAt = nowMs();
				state.wallEndedAt = null;
			}
			resetRateMetrics();
			resetRequestAverages();
			resetUsageTotals();
			stopClearTimer();
			clearUI(ctx);
		}
		requestRender(ctx);
	});

	pi.on("turn_start", (event: TurnStartEvent, ctx) => {
		pendingTurnIndex = event.turnIndex;
		resetForPendingTurn();
		resetRateMetrics();
		requestRender(ctx);
	});

	pi.on("before_provider_request", (_event: BeforeProviderRequestEvent, ctx) => {
		ensureTurnMeasurement();
		commitPendingEstimatedUsage();
		currentRequestOutputPending = true;
		state.requestStartedAt = nowMs();
		state.messageStartedAt = null;
		state.messageEndedAt = null;
		state.waitFrozenMs = null;
		state.streamFirstOutputAt = null;
		state.providerResponseAt = null;
		resetStreamedTokens(state);
		resetRateMetrics();
		startTimer(ctx);
		requestRender(ctx);
	});

	pi.on("after_provider_response", (event, ctx) => {
		// Only a successful response for an in-flight request counts. A late or
		// failed attempt must not re-base or pre-date the measurement.
		if (state.requestStartedAt == null) return;
		if (!isSuccessfulProviderResponse(event.status)) return;
		state.providerResponseAt = nowMs();
		requestRender(ctx);
	});

	pi.on("message_start", (event: MessageStartEvent, ctx) => {
		if (!isAssistantMessage(event.message)) return;
		ensureTurnMeasurement();
		if (state.requestStartedAt == null) {
			state.requestStartedAt = event.message.timestamp;
		}
		state.messageStartedAt = nowMs();
		state.messageEndedAt = null;
		requestRender(ctx);
	});

	pi.on("message_update", (event: MessageUpdateEvent, ctx) => {
		if (!isAssistantMessage(event.message)) return;

		const assistantEvent = event.assistantMessageEvent;
		const textDelta = extractDelta(event, "text_delta");
		const thinkingDelta = extractDelta(event, "thinking_delta");
		const toolCallDelta = extractDelta(event, "toolcall_delta");

		if (textDelta) {
			ensureTurnMeasurement();
			markStreaming();
			state.visibleTokens += recordStreamOutput(textDelta, "auto");
			startTimer(ctx);
			requestRender(ctx);
			return;
		}

		if (thinkingDelta) {
			ensureTurnMeasurement();
			markStreaming();
			state.thinkingTokens += recordStreamOutput(thinkingDelta, "prose");
			startTimer(ctx);
			requestRender(ctx);
			return;
		}

		if (assistantEvent.type === "toolcall_start" || assistantEvent.type === "toolcall_delta" || assistantEvent.type === "toolcall_end") {
			ensureTurnMeasurement();
			markStreaming();
			if (toolCallDelta) {
				state.toolCallTokens += estimateTokensFromTextRaw(toolCallDelta, "structured");
			}
			// Tool-call tokens are counted by the provider, so their streaming time
			// belongs to the flow window even though they add no visible text.
			recordToolCallActivity();
			startTimer(ctx);
			requestRender(ctx);
			return;
		}

		if (assistantEvent.type === "done") {
			finishModelGeneration();
			requestRender(ctx);
			return;
		}

		if (assistantEvent.type === "error") {
			finishModelGeneration();
			requestRender(ctx);
		}
	});

	pi.on("tool_execution_start", (event: ToolExecutionStartEvent, ctx) => {
		ensureTurnMeasurement();
		finishModelGeneration();
		beginToolExecution(event.toolCallId);
		startTimer(ctx);
		requestRender(ctx);
	});

	pi.on("tool_execution_end", (event: ToolExecutionEndEvent, ctx) => {
		if (state.turnIndex == null) return;
		endToolExecution(event.toolCallId);
		requestRender(ctx);
	});

	pi.on("message_end", (event: MessageEndEvent, ctx) => {
		if (!isAssistantMessage(event.message)) return;

		ensureTurnMeasurement();
		finishModelGeneration();

		const failed = isFailedAssistantMessage(event.message);
		const input = nonNegativeFiniteNumber(event.message.usage?.input);
		const providerOutput = nonNegativeFiniteNumber(event.message.usage?.output);
		const cacheRead = nonNegativeFiniteNumber(event.message.usage?.cacheRead);
		const cost = nonNegativeFiniteNumber(event.message.usage?.cost?.total);
		if (input != null && input > 0) {
			inputTokens += input;
		}
		const streamedOutput = currentRequestOutputPending ? estimatedStreamedTokens() : 0;
		const messageOutput = estimateAssistantMessageTokens(event.message);
		const estimatedOutput = Math.max(streamedOutput, messageOutput);
		const finalizedOutput = resolveFinalOutputTokens(failed, providerOutput, estimatedOutput);
		if (finalizedOutput != null) {
			outputTokens += finalizedOutput;
		}
		if (cacheRead != null && cacheRead > 0) {
			cacheReadTotal += cacheRead;
		}
		if (cost != null && cost > 0) {
			runCostTotal += cost;
		}
		currentRequestOutputPending = false;
		if (!failed) {
			const flow = outputRateTracker.streamedOutputFlow();
			recordCompletedModelTurnAverages(flow.tokens, flow.durationMs > 0 ? flow.durationMs : null);
		}

		requestRender(ctx);
	});

	pi.on("turn_end", (_event, ctx) => {
		commitPendingEstimatedUsage();
		finishModelGeneration();
		endToolExecution();
		state.streaming = false;
		state.inToolPhase = false;
		stopTimer();
		requestRender(ctx);
	});

	pi.on("agent_end", (_event, ctx) => {
		// agent_end closes one attempt. A retry may immediately emit another
		// agent_start, so do not close the wall-clock run or show its summary here.
		commitPendingEstimatedUsage();
		finishModelGeneration();
		endToolExecution();
		state.streaming = false;
		state.inToolPhase = false;
		stopTimer();
		requestRender(ctx);
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (!agentRunActive) return;

		commitPendingEstimatedUsage();
		state.wallEndedAt = nowMs();
		finishModelGeneration();
		endToolExecution();
		state.streaming = false;
		state.inToolPhase = false;
		stopTimer();

		// The settled run is the first point where the totals are final, so this is
		// where the complete summary belongs.
		const totalMs = state.wallStartedAt != null ? state.wallEndedAt - state.wallStartedAt : 0;
		const averages = getRequestAverages();
		const timePart = `◷ ${formatDuration(totalMs)}`;
		const statParts: string[] = [];
		for (const entry of buildMetricEntries(inputTokens, outputTokens, false, cacheReadTotal, runCostTotal)) {
			if (entry.kind === "input") statParts.push(`↑${entry.count}`);
			else if (entry.kind === "output") statParts.push(`↓${entry.count}`);
			else if (entry.kind === "cache") statParts.push(`CH${entry.count}${entry.percent == null ? "" : `·${entry.percent}%`}`);
			else statParts.push(entry.count);
		}
		const avgParts: string[] = [];
		if (averages.avgFirstOutputWaitMs != null) avgParts.push(`avg first ${formatDuration(averages.avgFirstOutputWaitMs)}`);
		// Streamed text/thinking throughput over the time that output flowed. The
		// `~` marker signals that token counts are locally estimated.
		if (averages.avgOutTps != null) avgParts.push(`~${formatTps(averages.avgOutTps)} tok/s`);
		let message = timePart;
		if (statParts.length > 0) message += ` | ${statParts.join(" ")}`;
		if (avgParts.length > 0) message += ` | ${avgParts.join(" · ")}`;

		agentRunActive = false;
		if (ctx.hasUI) ctx.ui.notify(message, "info");
		requestRender(ctx);
		scheduleClear(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		pendingTurnIndex = null;
		agentRunActive = false;
		stopTimer();
		stopClearTimer();
		commitPendingEstimatedUsage();
		resetState(state, null);
		state.wallStartedAt = null;
		state.wallEndedAt = null;
		resetRateMetrics();
		resetRequestAverages();
		resetUsageTotals();
		clearUI(ctx);
	});
}
