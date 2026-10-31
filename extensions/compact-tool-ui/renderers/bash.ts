import type { ExtensionAPI, Theme, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { formatSize, keyHint } from "@earendil-works/pi-coding-agent";
import { ExpandedDetailRail, type ExpandedDetailSection } from "../components/expanded-detail-rail.js";
import { ExpandedToolHeader } from "../components/expanded-tool-header.js";
import { LineNumberedCodeBlock } from "../components/line-numbered-code-block.js";
import { ShellCommandBlock } from "../components/shell-command-block.js";
import { CompactToolRow, type CompactToolRowSuffixCandidate } from "../components/compact-tool-row.js";
import { ToolDetailFooter } from "../components/tool-detail-footer.js";
import { commandText } from "../format/bash-command.js";
import { summarizeBashCommand, type BashCommandDisplay } from "../format/bash-command-summary.js";
import { type ToolUiStatus, mutedMetadataText, toolNameText } from "../style.js";
import { countLines, emptyComponent, formatVisibleDuration, linkPath, stripAnsi, textBlocks } from "../tui-utils.js";
import { hasMeaningfulOutput, outputLineCount, splitBashStatus, summarizeBashStream, summarizeFailedBashOutput, summarizeSuccessfulBashOutput, tail } from "./bash-helpers.js";
import { settleCompactState, type CompactSummaryState } from "./compact-text.js";
import { registerCompactToolRenderer, type ToolRenderShellSource } from "./render-shell.js";
import { resolveBashCommand, resolveBashTimeout, type BashArgs } from "./tool-args.js";

type BashRefreshTimerEntry = {
	startedAt: number;
	interval: NodeJS.Timeout;
	invalidate: () => void;
};

/** Maximum tail lines kept for a streaming expanded bash output. */
const STREAMING_OUTPUT_TAIL_LINES = 28;

type ExpandedBashContentCache = {
	theme: Theme;
	colors: Theme["colors"];
	commandSource: string;
	command: ShellCommandBlock;
	output?: { source: string; isPartial: boolean; component: LineNumberedCodeBlock };
	view?: {
		command: ShellCommandBlock;
		output?: LineNumberedCodeBlock;
		metadata?: string;
		footer: string;
		component: ExpandedDetailRail;
	};
};

type CompactBashState = CompactSummaryState<CompactToolRow> & {
	expandedCallHeader?: ExpandedToolHeader;
	expandedContentCache?: ExpandedBashContentCache;
	compactStartedAt?: number;
	compactEndedAt?: number;
	compactDurationMs?: number;
};

function bashCommand(args: BashArgs): string {
	return resolveBashCommand(args);
}

function bashCommandDisplay(args: BashArgs): BashCommandDisplay {
	return summarizeBashCommand(bashCommand(args));
}

function ensureBashCallText(state: CompactBashState, component: unknown): CompactToolRow {
	const text = component instanceof CompactToolRow ? component : state.compactCallText ?? new CompactToolRow();
	state.compactCallText = text;
	return text;
}

function getBashCallText(state: CompactBashState): CompactToolRow | undefined {
	return state.compactCallText;
}

type BashMetadata = {
	full: string;
	candidates: CompactToolRowSuffixCandidate[];
};

type BashHeaderComponent = CompactToolRow | ExpandedToolHeader;

function setBashText(component: BashHeaderComponent, command: BashCommandDisplay, metadata: BashMetadata, theme: Theme) {
	component.setParts(`${toolNameText("bash", theme)} `, commandText(command.text, theme), metadata.full, metadata.candidates);
	return component;
}

function compactBashStatus(state: CompactBashState): ToolUiStatus {
	return state.compactStatus ?? "pending";
}

/** The built-in bash tool trims long output, so a collapsed row must not hide that it did. */
function bashOutputTruncated(result: any): boolean {
	return result?.details?.truncation?.truncated === true;
}

function withTruncationMarker(summary: string | undefined): string {
	return summary ? `${summary} · truncated` : "truncated";
}

function compactBashMetadata(
	state: CompactBashState,
	status: ToolUiStatus,
	command: BashCommandDisplay,
	timeout: string | undefined,
	duration: string | undefined,
	executionStarted: boolean,
	theme: Theme,
): BashMetadata {
	const active = status === "running" || status === "pending";
	// The configured timeout only matters while the command can still be cut off; once settled it
	// is noise, and `timeout`/`aborted` outcomes already surface through the result summary.
	const activeTimeout = active ? timeout : undefined;
	const summary = state.compactSummary;
	const runningSummary = executionStarted ? summary ?? "running" : summary;
	const resultSummary = active ? runningSummary : summary;
	const full = mutedMetadataText([command.metadata, activeTimeout, resultSummary, duration], theme);
	const timeoutResultAndDuration = mutedMetadataText([activeTimeout, resultSummary, duration], theme);
	const resultAndDuration = mutedMetadataText([resultSummary, duration], theme);
	const resultOnly = mutedMetadataText([resultSummary], theme);
	const durationOnly = mutedMetadataText([duration], theme);
	const timeoutOnly = mutedMetadataText([activeTimeout], theme);
	const commandOnly = mutedMetadataText([command.metadata], theme);
	const fallback = resultAndDuration || resultOnly || durationOnly || timeoutOnly || commandOnly || full;
	const candidates: CompactToolRowSuffixCandidate[] = [
		full,
		timeoutResultAndDuration,
		{ text: resultAndDuration, fallback: resultAndDuration === fallback },
		{ text: resultOnly, fallback: resultOnly === fallback },
		{ text: durationOnly, fallback: durationOnly === fallback },
		{ text: timeoutOnly, fallback: timeoutOnly === fallback },
		{ text: commandOnly, fallback: commandOnly === fallback },
	];
	return { full, candidates };
}

type BashRenderContext = Parameters<NonNullable<ToolRenderers["renderCall"]>>[2];

function bashDuration(
	state: CompactBashState,
	context: BashRenderContext,
	refreshTimerByToolCallId: Map<string, BashRefreshTimerEntry>,
	isPartial = context.isPartial,
): string | undefined {
	const { toolCallId, invalidate } = context;
	const existing = refreshTimerByToolCallId.get(toolCallId);
	// A remounted row adopts the observed live start, never the time it was replayed.
	state.compactStartedAt ??= existing?.startedAt;
	const settled = !isPartial || context.isError;
	if (settled) {
		if (typeof context.durationMs === "number" && Number.isFinite(context.durationMs) && context.durationMs >= 0) {
			state.compactDurationMs = context.durationMs;
		} else if (state.compactStartedAt !== undefined) {
			state.compactEndedAt ??= Date.now();
			state.compactDurationMs ??= Math.max(0, state.compactEndedAt - state.compactStartedAt);
		}
		if (existing) {
			clearInterval(existing.interval);
			refreshTimerByToolCallId.delete(toolCallId);
		}
	} else if (context.executionStarted && state.compactDurationMs === undefined && state.compactEndedAt === undefined) {
		state.compactStartedAt ??= Date.now();
		if (existing) {
			existing.invalidate = invalidate;
		} else {
			const interval = setInterval(() => refreshTimerByToolCallId.get(toolCallId)?.invalidate(), 1000);
			interval.unref?.();
			refreshTimerByToolCallId.set(toolCallId, { startedAt: state.compactStartedAt, interval, invalidate });
		}
	}
	const durationMs = state.compactDurationMs ?? (state.compactStartedAt === undefined ? undefined : Math.max(0, Date.now() - state.compactStartedAt));
	return durationMs === undefined ? undefined : formatVisibleDuration(durationMs);
}

function expandedBashCall(
	state: CompactBashState,
	command: BashCommandDisplay,
	metadata: BashMetadata,
	theme: Theme,
): ExpandedToolHeader {
	const header = state.expandedCallHeader ?? new ExpandedToolHeader();
	state.expandedCallHeader = header;
	setBashText(header, command, metadata, theme);
	return header;
}

function bashTruncationFooter(truncation: any): string {
	const outputLines = truncation?.outputLines;
	const totalLines = truncation?.totalLines;
	const parts: string[] = [];
	if (typeof outputLines === "number" && Number.isFinite(outputLines) && typeof totalLines === "number" && Number.isFinite(totalLines) && totalLines > 0) {
		parts.push(`${outputLines}/${totalLines} lines`);
	} else if (typeof outputLines === "number" && Number.isFinite(outputLines)) {
		parts.push(`${outputLines} lines shown`);
	}
	if (truncation?.truncatedBy === "bytes" && typeof truncation?.maxBytes === "number" && Number.isFinite(truncation.maxBytes)) {
		parts.push(`${formatSize(truncation.maxBytes)} cap`);
	}
	return parts.length > 0 ? `truncated · ${parts.join(" · ")}` : "truncated";
}

function expandedBashResult(
	state: CompactBashState,
	rawCommand: string,
	output: string,
	result: any,
	isPartial: boolean,
	theme: Theme,
	cwd: string,
): ExpandedDetailRail {
	const details = result?.details;
	const displayOutput = isPartial ? tail(output, STREAMING_OUTPUT_TAIL_LINES) : output;
	const footerParts: string[] = [];
	// The output section title carries `streaming` whenever it renders; keep the footer marker
	// only for the no-output case so the state is never lost or duplicated.
	if (isPartial && !displayOutput) footerParts.push("streaming");
	if (details?.truncation?.truncated) footerParts.push(bashTruncationFooter(details.truncation));
	if (details?.fullOutputPath) {
		const pathText = linkPath(theme.fg("mdLink", details.fullOutputPath), details.fullOutputPath, cwd);
		footerParts.push(`full output: ${pathText}`);
	}
	footerParts.push(keyHint("app.tools.expand", "collapse"));
	const footerText = footerParts.join(" · ");
	const commandSource = stripAnsi(rawCommand);
	let cached = state.expandedContentCache;
	if (!cached || cached.theme !== theme || cached.colors !== theme.colors) {
		cached = state.expandedContentCache = {
			theme, colors: theme.colors, commandSource, command: new ShellCommandBlock(commandSource, theme),
		};
	} else if (cached.commandSource !== commandSource) {
		cached.commandSource = commandSource;
		cached.command = new ShellCommandBlock(commandSource, theme);
	}

	let metadata: string | undefined;
	if (displayOutput) {
		const shownLines = countLines(displayOutput);
		metadata = isPartial ? streamingOutputMetadata(shownLines, outputLineCount(output)) : `${shownLines} lines`;
		if (cached.output?.source !== displayOutput || cached.output.isPartial !== isPartial) {
			cached.output = {
				source: displayOutput, isPartial,
				component: new LineNumberedCodeBlock(displayOutput, theme, {
					showLineNumbers: false, maxVisualLines: isPartial ? STREAMING_OUTPUT_TAIL_LINES : undefined,
				}),
			};
		}
	} else {
		cached.output = undefined;
	}
	const outputComponent = cached.output?.component;
	const view = cached.view;
	// Elapsed ticks invalidate the host row too. Reuse immutable content, not stale header metadata.
	if (view?.command === cached.command && view.output === outputComponent && view.metadata === metadata && view.footer === footerText) {
		return view.component;
	}
	const footer = new ToolDetailFooter();
	footer.setText(footerText);
	const sections: ExpandedDetailSection[] = [{ label: "command", content: cached.command }];
	if (outputComponent) sections.push({ label: "output", metadata, content: outputComponent });
	const component = new ExpandedDetailRail(theme, sections, footer);
	cached.view = { command: cached.command, output: outputComponent, metadata, footer: footerText, component };
	return component;
}

function streamingOutputMetadata(shownLines: number, totalLines: number): string {
	const label = shownLines < totalLines ? `tail ${shownLines}/${totalLines} lines` : `${shownLines} lines`;
	return `${label} · streaming`;
}

export function registerCompactBash(pi: ExtensionAPI, cwd: string, renderShellSource?: ToolRenderShellSource) {
	const refreshTimerByToolCallId = new Map<string, BashRefreshTimerEntry>();
	pi.on("session_shutdown", async () => {
		for (const entry of refreshTimerByToolCallId.values()) clearInterval(entry.interval);
		refreshTimerByToolCallId.clear();
	});

	registerCompactToolRenderer(pi, "bash", () => ({
		renderCall(args, theme, context) {
			const state = context.state as CompactBashState;
			const duration = bashDuration(state, context, refreshTimerByToolCallId);
			const bashArgs = args as BashArgs;
			const command = bashCommandDisplay(bashArgs);
			const timeout = resolveBashTimeout(bashArgs);
			const status = compactBashStatus(state);
			const metadata = compactBashMetadata(state, status, command, timeout, duration, context.executionStarted, theme);
			if (context.expanded) return expandedBashCall(state, command, metadata, theme);

			const text = ensureBashCallText(state, context.lastComponent);
			return setBashText(text, command, metadata, theme);
		},
		renderResult(result, options, theme, context) {
			const state = context.state as CompactBashState;
			const duration = bashDuration(state, context, refreshTimerByToolCallId, options.isPartial);
			const raw = textBlocks(result);
			const { status, output: settledOutput } = splitBashStatus(raw, context.isError);
			// An error can arrive with a final partial update; classify it without deleting stream text.
			const output = options.isPartial ? stripAnsi(raw).trimEnd() : settledOutput;
			const bashArgs = context.args as BashArgs;
			const rawCommand = bashCommand(bashArgs);
			const command = summarizeBashCommand(rawCommand);
			const timeout = resolveBashTimeout(bashArgs);
			const callText = getBashCallText(state);

			if (options.isPartial && !context.isError) {
				const hasOutput = hasMeaningfulOutput(output);
				const compactStatus: ToolUiStatus = hasOutput ? "running" : "pending";
				const streamSummary = summarizeBashStream(output);
				settleCompactState(state, compactStatus, streamSummary);
				const metadata = compactBashMetadata(state, compactStatus, command, timeout, duration, true, theme);
				callText && setBashText(callText, command, metadata, theme);
				if (context.expanded) expandedBashCall(state, command, metadata, theme);
				if (context.expanded) return expandedBashResult(state, rawCommand, output, result, true, theme, context.cwd ?? cwd);
				return emptyComponent();
			}

			if (context.isError) {
				const failureSummary = summarizeFailedBashOutput(status, output || raw, rawCommand);
				settleCompactState(state, "failed", failureSummary);
				const metadata = compactBashMetadata(state, "failed", command, timeout, duration, context.executionStarted, theme);
				callText && setBashText(callText, command, metadata, theme);
				if (context.expanded) expandedBashCall(state, command, metadata, theme);
				if (context.expanded) return expandedBashResult(state, rawCommand, output || raw, result, false, theme, context.cwd ?? cwd);
				// Keep collapsed height stable; diagnostics remain available through expansion.
				return emptyComponent();
			}

			const outputSummary = summarizeSuccessfulBashOutput(output, rawCommand);
			const truncatedSummary = bashOutputTruncated(result) ? withTruncationMarker(outputSummary) : outputSummary;
			settleCompactState(state, "success", truncatedSummary);
			const metadata = compactBashMetadata(state, "success", command, timeout, duration, context.executionStarted, theme);
			callText && setBashText(callText, command, metadata, theme);
			if (context.expanded) expandedBashCall(state, command, metadata, theme);
			if (context.expanded) return expandedBashResult(state, rawCommand, output, result, false, theme, context.cwd ?? cwd);
			return emptyComponent();
		},
	}), renderShellSource);
}
