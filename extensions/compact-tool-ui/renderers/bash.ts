import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition, formatSize, keyHint } from "@earendil-works/pi-coding-agent";
import { ExpandedDetailRail, type ExpandedDetailSection } from "../components/expanded-detail-rail.js";
import { ExpandedToolHeader } from "../components/expanded-tool-header.js";
import { LineNumberedCodeBlock } from "../components/line-numbered-code-block.js";
import { ShellCommandBlock } from "../components/shell-command-block.js";
import { CompactToolRow, type CompactToolRowSuffixCandidate } from "../components/compact-tool-row.js";
import { OutputPreviewBlock } from "../components/output-preview-block.js";
import { ToolDetailFooter } from "../components/tool-detail-footer.js";
import { commandText } from "../format/bash-command.js";
import { summarizeBashCommand, type BashCommandDisplay } from "../format/bash-command-summary.js";
import { DEFAULT_BASH_DISPLAY_OPTIONS, type BashDisplayOptions, type BashTailPreview } from "../settings/options.js";
import { type ToolUiStatus, mutedMetadataText, toolNameText } from "../style.js";
import { countLines, emptyComponent, formatVisibleDuration, linkPath, stripAnsi, textBlocks } from "../tui-utils.js";
import { hasMeaningfulOutput, outputLineCount, previewTail, splitBashStatus, summarizeBashStream, summarizeFailedBashOutput, summarizeSuccessfulBashOutput, tail } from "./bash-helpers.js";
import { settleCompactState, type CompactSummaryState } from "./compact-text.js";
import { type BuiltInRendererSlots } from "./render-expanded-result.js";
import { resolveToolRenderShell, type ToolRenderShellSource } from "./render-shell.js";
import { resolveBashCommand, resolveBashTimeout, type BashArgs } from "./tool-args.js";

type BuiltInBashState = {
	startedAt?: number;
	endedAt?: number;
	interval?: NodeJS.Timeout;
};

type BashRefreshTimerEntry = {
	interval: NodeJS.Timeout;
	invalidate: () => void;
};

/** Maximum tail lines kept for a streaming expanded bash output. */
const STREAMING_OUTPUT_TAIL_LINES = 28;

type CompactBashState = CompactSummaryState<CompactToolRow> & BuiltInRendererSlots<BuiltInBashState> & {
	expandedCallHeader?: ExpandedToolHeader;
	compactStartedAt?: number;
	compactEndedAt?: number;
	compactInterval?: NodeJS.Timeout;
	/** Legacy mirror fields kept for persisted/older renderer state. */
	startedAt?: number;
	endedAt?: number;
};

export { DEFAULT_BASH_DISPLAY_OPTIONS, type BashDisplayOptions } from "../settings/options.js";

export type BashDisplayOptionsSource = BashDisplayOptions | (() => BashDisplayOptions);

function resolveBashDisplayOptions(source: BashDisplayOptionsSource | undefined): Required<BashDisplayOptions> {
	const value = typeof source === "function" ? source() : source;
	return { ...DEFAULT_BASH_DISPLAY_OPTIONS, ...value };
}

type BashPreviewPhase = "running" | "success" | "failed";

/** `failed` is the "quiet on success, verbose when something breaks" mode. */
function tailPreviewEnabled(mode: BashTailPreview, phase: BashPreviewPhase): boolean {
	if (mode === "off") return false;
	if (mode === "all") return true;
	return mode === phase;
}

function bashCommand(args: BashArgs): string {
	return resolveBashCommand(args);
}

function bashCommandDisplay(args: BashArgs): BashCommandDisplay {
	return summarizeBashCommand(bashCommand(args));
}

function adoptBashStart(state: CompactBashState, toolCallId: string, startedAtByToolCallId: Map<string, number>): number | undefined {
	if (state.compactStartedAt !== undefined) return state.compactStartedAt;
	const startedAt = startedAtByToolCallId.get(toolCallId);
	if (startedAt === undefined) return undefined;
	state.compactStartedAt = startedAt;
	state.compactEndedAt = undefined;
	// Keep the built-in bash renderer's duration state coherent when expanded later.
	state.startedAt ??= startedAt;
	state.endedAt = undefined;
	return startedAt;
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

function syncCompactBashInterval(state: CompactBashState, interval: NodeJS.Timeout) {
	if (state.compactInterval && state.compactInterval !== interval) clearInterval(state.compactInterval);
	state.compactInterval = interval;
}

function detachCompactBashInterval(state: CompactBashState) {
	state.compactInterval = undefined;
}

function syncBuiltInBashInterval(state: CompactBashState, interval: NodeJS.Timeout) {
	if (state.builtInRendererState?.interval && state.builtInRendererState.interval !== interval) {
		clearInterval(state.builtInRendererState.interval);
	}
	state.builtInRendererState ??= {};
	state.builtInRendererState.interval = interval;
}

function detachBuiltInBashInterval(state: CompactBashState) {
	if (state.builtInRendererState) state.builtInRendererState.interval = undefined;
}

function manageBashRefreshInterval(
	toolCallId: string,
	invalidate: () => void,
	refreshTimerByToolCallId: Map<string, BashRefreshTimerEntry>,
	allowCreate: boolean,
): NodeJS.Timeout | undefined {
	const existing = refreshTimerByToolCallId.get(toolCallId);
	if (existing) {
		existing.invalidate = invalidate;
		return existing.interval;
	}
	if (!allowCreate) return undefined;
	const interval = setInterval(() => refreshTimerByToolCallId.get(toolCallId)?.invalidate(), 1000);
	interval.unref?.();
	refreshTimerByToolCallId.set(toolCallId, { interval, invalidate });
	return interval;
}

function clearBashRefreshInterval(toolCallId: string, refreshTimerByToolCallId: Map<string, BashRefreshTimerEntry>) {
	const entry = refreshTimerByToolCallId.get(toolCallId);
	if (!entry) return;
	clearInterval(entry.interval);
	refreshTimerByToolCallId.delete(toolCallId);
}

function syncBashRefreshLifecycle(
	state: CompactBashState,
	toolCallId: string,
	invalidate: () => void,
	active: boolean,
	refreshTimerByToolCallId: Map<string, BashRefreshTimerEntry>,
	allowCreate: boolean,
) {
	if (!active) {
		clearBashRefreshInterval(toolCallId, refreshTimerByToolCallId);
		detachCompactBashInterval(state);
		detachBuiltInBashInterval(state);
		return;
	}

	const interval = manageBashRefreshInterval(toolCallId, invalidate, refreshTimerByToolCallId, allowCreate);
	if (!interval) return;
	syncCompactBashInterval(state, interval);
	syncBuiltInBashInterval(state, interval);
}

function syncBuiltInBashStart(state: CompactBashState, startedAt: number | undefined) {
	if (startedAt === undefined) return;
	state.builtInRendererState ??= {};
	state.builtInRendererState.startedAt ??= startedAt;
	if (state.compactStatus === "success" || state.compactStatus === "failed") {
		state.builtInRendererState.endedAt ??= state.compactEndedAt;
	} else {
		state.builtInRendererState.endedAt = undefined;
	}
}

function renderOutputPreview(preview: string, theme: Theme) {
	return new OutputPreviewBlock(preview, theme);
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
	rawCommand: string,
	output: string,
	result: any,
	isPartial: boolean,
	theme: Theme,
	cwd: string,
): ExpandedDetailRail {
	const details = result?.details;
	const displayOutput = isPartial ? tail(output, STREAMING_OUTPUT_TAIL_LINES) : output;
	const footer = new ToolDetailFooter();
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
	footer.setText(footerParts.join(" · "));

	const sections: ExpandedDetailSection[] = [
		// Keep the command exactly as supplied; ShellCommandBlock only applies ANSI-safe wrapping.
		{ label: "command", content: new ShellCommandBlock(stripAnsi(rawCommand), theme) },
	];
	if (displayOutput) {
		const shownLines = countLines(displayOutput);
		sections.push({
			label: "output",
			metadata: isPartial ? streamingOutputMetadata(shownLines, outputLineCount(output)) : `${shownLines} lines`,
			content: new LineNumberedCodeBlock(displayOutput, theme, { showLineNumbers: false, maxVisualLines: isPartial ? STREAMING_OUTPUT_TAIL_LINES : undefined }),
		});
	}
	return new ExpandedDetailRail(theme, sections, footer);
}

function streamingOutputMetadata(shownLines: number, totalLines: number): string {
	const label = shownLines < totalLines ? `tail ${shownLines}/${totalLines} lines` : `${shownLines} lines`;
	return `${label} · streaming`;
}

function settleCompactBashLifecycle(
	state: CompactBashState,
	toolCallId: string,
	isPartial: boolean,
	isError: boolean,
	startedAtByToolCallId: Map<string, number>,
) {
	if (!isPartial || isError) {
		state.compactEndedAt ??= Date.now();
		state.endedAt ??= state.compactEndedAt;
		if (state.builtInRendererState) state.builtInRendererState.endedAt ??= state.compactEndedAt;
		startedAtByToolCallId.delete(toolCallId);
	}
}

function isActiveBashExecution(state: CompactBashState, startedAt: number | undefined, executionStarted: boolean): boolean {
	if (startedAt === undefined) return false;
	if (state.compactEndedAt !== undefined || state.endedAt !== undefined || state.builtInRendererState?.endedAt !== undefined) return false;
	return executionStarted || compactBashStatus(state) === "running" || compactBashStatus(state) === "pending";
}

export function registerCompactBash(pi: ExtensionAPI, cwd: string, displayOptionsSource: BashDisplayOptionsSource = {}, renderShellSource?: ToolRenderShellSource, shellPath?: string) {
	const original = createBashToolDefinition(cwd, shellPath ? { shellPath } : undefined);
	const startedAtByToolCallId = new Map<string, number>();
	const refreshTimerByToolCallId = new Map<string, BashRefreshTimerEntry>();

	pi.registerTool({
		...original,
		get renderShell() {
			return resolveToolRenderShell(renderShellSource);
		},
		execute(toolCallId, params, signal, onUpdate, ctx) {
			startedAtByToolCallId.set(toolCallId, Date.now());
			return original.execute(toolCallId, params, signal, onUpdate, ctx);
		},
		renderCall(args, theme, context) {
			const state = context.state as CompactBashState;
			const startedAt = adoptBashStart(state, context.toolCallId, startedAtByToolCallId);
			syncBuiltInBashStart(state, startedAt);
			syncBashRefreshLifecycle(
				state,
				context.toolCallId,
				context.invalidate,
				isActiveBashExecution(state, startedAt, context.executionStarted),
				refreshTimerByToolCallId,
				true,
			);
			const bashArgs = args as BashArgs;
			const command = bashCommandDisplay(bashArgs);
			const timeout = resolveBashTimeout(bashArgs);
			const status = compactBashStatus(state);
			const end = status === "success" || status === "failed" ? state.compactEndedAt ?? Date.now() : Date.now();
			const duration = startedAt === undefined ? undefined : formatVisibleDuration(end - startedAt);
			const displayOptions = resolveBashDisplayOptions(displayOptionsSource);
			const metadata = compactBashMetadata(state, status, command, timeout, duration, context.executionStarted, theme);
			if (context.expanded) return expandedBashCall(state, command, metadata, theme);

			const text = ensureBashCallText(state, context.lastComponent);
			return setBashText(text, command, metadata, theme);
		},
		renderResult(result, options, theme, context) {
			const state = context.state as CompactBashState;
			const startedAt = adoptBashStart(state, context.toolCallId, startedAtByToolCallId);
			syncBuiltInBashStart(state, startedAt);
			const isActive = options.isPartial && !context.isError;
			if (!isActive) settleCompactBashLifecycle(state, context.toolCallId, options.isPartial, context.isError, startedAtByToolCallId);
			syncBashRefreshLifecycle(state, context.toolCallId, context.invalidate, isActive, refreshTimerByToolCallId, isActive);

			const end = (options.isPartial && !context.isError ? Date.now() : state.compactEndedAt) ?? Date.now();
			const duration = startedAt === undefined ? undefined : formatVisibleDuration(end - startedAt);
			const raw = textBlocks(result);
			const { status, output } = splitBashStatus(raw, context.isError);
			const bashArgs = context.args as BashArgs;
			const rawCommand = bashCommand(bashArgs);
			const command = summarizeBashCommand(rawCommand);
			const timeout = resolveBashTimeout(bashArgs);
			const callText = getBashCallText(state);
			const displayOptions = resolveBashDisplayOptions(displayOptionsSource);

			if (options.isPartial && !context.isError) {
				const hasOutput = hasMeaningfulOutput(output);
				const compactStatus: ToolUiStatus = hasOutput ? "running" : "pending";
				const streamSummary = summarizeBashStream(output);
				settleCompactState(state, compactStatus, streamSummary);
				const metadata = compactBashMetadata(state, compactStatus, command, timeout, duration, true, theme);
				callText && setBashText(callText, command, metadata, theme);
				if (context.expanded) expandedBashCall(state, command, metadata, theme);
				if (context.expanded) return expandedBashResult(rawCommand, output, result, true, theme, context.cwd);
				if (tailPreviewEnabled(displayOptions.tailPreview, "running")) {
					const preview = previewTail(output, displayOptions.previewLines);
					if (preview) return renderOutputPreview(preview, theme);
				}
				return emptyComponent();
			}

			if (context.isError) {
				const failureSummary = summarizeFailedBashOutput(status, output || raw, rawCommand);
				settleCompactState(state, "failed", failureSummary);
				const metadata = compactBashMetadata(state, "failed", command, timeout, duration, context.executionStarted, theme);
				callText && setBashText(callText, command, metadata, theme);
				if (context.expanded) expandedBashCall(state, command, metadata, theme);
				if (context.expanded) return expandedBashResult(rawCommand, output || raw, result, false, theme, context.cwd);
				// Failures collapse to the one-line row like every other outcome; the full error
				// stays available through expand so a failing command cannot hold the transcript open.
				if (tailPreviewEnabled(displayOptions.tailPreview, "failed")) {
					const preview = previewTail(output || raw, displayOptions.previewLines);
					if (preview) return renderOutputPreview(preview, theme);
				}
				return emptyComponent();
			}

			const outputSummary = summarizeSuccessfulBashOutput(output, rawCommand);
			const truncatedSummary = bashOutputTruncated(result) ? withTruncationMarker(outputSummary) : outputSummary;
			settleCompactState(state, "success", truncatedSummary);
			const metadata = compactBashMetadata(state, "success", command, timeout, duration, context.executionStarted, theme);
			callText && setBashText(callText, command, metadata, theme);
			if (context.expanded) expandedBashCall(state, command, metadata, theme);
			if (context.expanded) return expandedBashResult(rawCommand, output, result, false, theme, context.cwd);
			if (tailPreviewEnabled(displayOptions.tailPreview, "success")) {
				const preview = previewTail(output, displayOptions.previewLines);
				if (preview) return renderOutputPreview(preview, theme);
			}
			return emptyComponent();
		},
	});
}
