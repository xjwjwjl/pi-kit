import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { IndentedWrappedText, type IndentedWrappedTextSuffixCandidate } from "../components/indented-wrapped-text.js";
import { OutputPreviewBlock } from "../components/output-preview-block.js";
import { commandText } from "../format/bash-command.js";
import { summarizeBashCommand, type BashCommandDisplay } from "../format/bash-command-summary.js";
import { DEFAULT_BASH_DISPLAY_OPTIONS, type BashDisplayOptions } from "../settings/options.js";
import { type ToolUiStatus, mutedMetadataText, toolNameText } from "../style.js";
import { emptyComponent, formatDuration, textBlocks } from "../tui-utils.js";
import { hasMeaningfulOutput, previewTail, splitBashStatus, summarizeBashStream, summarizeFailedBashOutput, summarizeSuccessfulBashOutput, tail } from "./bash-helpers.js";
import { settleCompactState, type CompactSummaryState } from "./compact-text.js";
import { getExpandedResultRenderer, renderExpandedCall, type BuiltInRendererSlots } from "./render-expanded-result.js";
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

type CompactBashState = CompactSummaryState<IndentedWrappedText> & BuiltInRendererSlots<BuiltInBashState> & {
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

function ensureBashCallText(state: CompactBashState, component: unknown): IndentedWrappedText {
	const text = component instanceof IndentedWrappedText ? component : state.compactCallText ?? new IndentedWrappedText();
	state.compactCallText = text;
	return text;
}

function getBashCallText(state: CompactBashState): IndentedWrappedText | undefined {
	return state.compactCallText;
}

type BashMetadata = {
	full: string;
	candidates: IndentedWrappedTextSuffixCandidate[];
};

function setBashText(component: IndentedWrappedText, command: BashCommandDisplay, metadata: BashMetadata, theme: Theme) {
	component.setParts(`${toolNameText("bash", theme)} `, commandText(command.text, theme), metadata.full, metadata.candidates);
	return component;
}

function compactBashStatus(state: CompactBashState): ToolUiStatus {
	return state.compactStatus ?? "pending";
}

function compactBashMetadata(
	state: CompactBashState,
	status: ToolUiStatus,
	command: BashCommandDisplay,
	timeout: string | undefined,
	duration: string | undefined,
	executionStarted: boolean,
	theme: Theme,
	displayOptions: Required<BashDisplayOptions>,
): BashMetadata {
	const summary = status === "success" && !displayOptions.successfulOutputSummary ? undefined : state.compactSummary;
	const runningSummary = executionStarted ? summary ?? "running" : summary;
	const resultSummary = status === "running" || status === "pending" ? runningSummary : summary;
	const full = mutedMetadataText([command.metadata, timeout, resultSummary, duration], theme);
	const timeoutResultAndDuration = mutedMetadataText([timeout, resultSummary, duration], theme);
	const resultAndDuration = mutedMetadataText([resultSummary, duration], theme);
	const resultOnly = mutedMetadataText([resultSummary], theme);
	const durationOnly = mutedMetadataText([duration], theme);
	const timeoutOnly = mutedMetadataText([timeout], theme);
	const commandOnly = mutedMetadataText([command.metadata], theme);
	const fallback = resultAndDuration || resultOnly || durationOnly || timeoutOnly || commandOnly || full;
	const candidates: IndentedWrappedTextSuffixCandidate[] = [
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

function reuseBashRefreshInterval(
	toolCallId: string,
	invalidate: () => void,
	refreshTimerByToolCallId: Map<string, BashRefreshTimerEntry>,
): NodeJS.Timeout | undefined {
	const existing = refreshTimerByToolCallId.get(toolCallId);
	if (!existing) return undefined;
	existing.invalidate = invalidate;
	return existing.interval;
}

function ensureBashRefreshInterval(
	toolCallId: string,
	invalidate: () => void,
	refreshTimerByToolCallId: Map<string, BashRefreshTimerEntry>,
): NodeJS.Timeout {
	const existing = refreshTimerByToolCallId.get(toolCallId);
	if (existing) {
		existing.invalidate = invalidate;
		return existing.interval;
	}

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

	const interval = allowCreate
		? ensureBashRefreshInterval(toolCallId, invalidate, refreshTimerByToolCallId)
		: reuseBashRefreshInterval(toolCallId, invalidate, refreshTimerByToolCallId);
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

export function registerCompactBash(pi: ExtensionAPI, cwd: string, displayOptionsSource: BashDisplayOptionsSource = {}, renderShellSource?: ToolRenderShellSource) {
	const original = createBashToolDefinition(cwd);
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
				!context.expanded,
			);
			const expandedCall = renderExpandedCall(original, args, theme, context, state);
			if (expandedCall) return expandedCall;

			const text = ensureBashCallText(state, context.lastComponent);
			const status = compactBashStatus(state);
			const end = status === "success" || status === "failed" ? state.compactEndedAt ?? Date.now() : Date.now();
			const duration = startedAt === undefined ? undefined : formatDuration(end - startedAt);
			const displayOptions = resolveBashDisplayOptions(displayOptionsSource);
			const bashArgs = args as BashArgs;
			const command = bashCommandDisplay(bashArgs);
			const timeout = resolveBashTimeout(bashArgs);
			return setBashText(text, command, compactBashMetadata(state, status, command, timeout, duration, context.executionStarted, theme, displayOptions), theme);
		},
		renderResult(result, options, theme, context) {
			const state = context.state as CompactBashState;
			const startedAt = adoptBashStart(state, context.toolCallId, startedAtByToolCallId);
			syncBuiltInBashStart(state, startedAt);
			const isActive = options.isPartial && !context.isError;
			if (!isActive) settleCompactBashLifecycle(state, context.toolCallId, options.isPartial, context.isError, startedAtByToolCallId);
			syncBashRefreshLifecycle(state, context.toolCallId, context.invalidate, isActive, refreshTimerByToolCallId, isActive);

			const end = (options.isPartial && !context.isError ? Date.now() : state.compactEndedAt) ?? Date.now();
			const duration = startedAt === undefined ? undefined : formatDuration(end - startedAt);
			const raw = textBlocks(result);
			const { status, output } = splitBashStatus(raw, context.isError);
			const bashArgs = context.args as BashArgs;
			const rawCommand = bashCommand(bashArgs);
			const command = summarizeBashCommand(rawCommand);
			const timeout = resolveBashTimeout(bashArgs);
			const callText = getBashCallText(state);
			const renderExpanded = getExpandedResultRenderer(original, result, options, theme, context, state);
			const displayOptions = resolveBashDisplayOptions(displayOptionsSource);

			if (options.isPartial && !context.isError) {
				const hasOutput = hasMeaningfulOutput(output);
				const compactStatus: ToolUiStatus = hasOutput ? "running" : "pending";
				const streamSummary = summarizeBashStream(output);
				settleCompactState(state, compactStatus, streamSummary);
				callText && setBashText(callText, command, compactBashMetadata(state, compactStatus, command, timeout, duration, true, theme, displayOptions), theme);
				if (renderExpanded) return renderExpanded();
				if (displayOptions.runningTailPreview) {
					const preview = previewTail(output, displayOptions.previewLines);
					if (preview) return renderOutputPreview(preview, theme);
				}
				return emptyComponent();
			}

			if (context.isError) {
				const failureSummary = summarizeFailedBashOutput(status, output || raw, rawCommand);
				settleCompactState(state, "failed", failureSummary);
				callText && setBashText(callText, command, compactBashMetadata(state, "failed", command, timeout, duration, context.executionStarted, theme, displayOptions), theme);
				if (renderExpanded) return renderExpanded();
				const preview = tail(output || raw);
				if (!preview) return emptyComponent();
				return renderOutputPreview(preview, theme);
			}

			const outputSummary = summarizeSuccessfulBashOutput(output, rawCommand);
			settleCompactState(state, "success", outputSummary);
			callText && setBashText(callText, command, compactBashMetadata(state, "success", command, timeout, duration, context.executionStarted, theme, displayOptions), theme);
			if (renderExpanded) return renderExpanded();
			if (displayOptions.successfulTailPreview) {
				const preview = previewTail(output, displayOptions.previewLines);
				if (preview) return renderOutputPreview(preview, theme);
			}
			return emptyComponent();
		},
	});
}
