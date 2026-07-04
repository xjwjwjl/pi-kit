import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { createReadToolDefinition } from "@earendil-works/pi-coding-agent";
import { CompactHintBlock } from "../components/compact-hint-block.js";
import { invalidText, metadataText, paramText, readMetadataText, readPathText, toolNameText } from "../style.js";
import { emptyComponent, shortPath, textBlocks } from "../tui-utils.js";
import { compactFileToolError, compactFileToolHint } from "./compact-error.js";
import { type CompactSummaryRowState, ensureCompactToolRow, getCompactCallText, setCompactRow, settleCompactSummaryRow, settleCompactRow } from "./compact-text.js";
import { summarizeRead } from "./read-helpers.js";
import { getExpandedResultRenderer, renderExpandedCall, type BuiltInRendererSlots } from "./render-expanded-result.js";
import { resolveToolRenderShell, type ToolRenderShellSource } from "./render-shell.js";
import { resolveReadRange, resolveToolPath, type ReadArgs } from "./tool-args.js";

function readRangeText(start: number, end: number | undefined, theme: Theme): string {
	const separator = paramText("separator", ":", theme);
	const startText = paramText("number", String(start), theme);
	if (end === undefined) return `${separator}${startText}`;
	return `${separator}${startText}${paramText("separator", "-", theme)}${paramText("number", String(end), theme)}`;
}

function lineRangeText(args: ReadArgs, theme: Theme): string {
	const range = resolveReadRange(args);
	if (!range) return "";
	return readRangeText(range.start, range.end, theme);
}

type CompactReadState = CompactSummaryRowState & BuiltInRendererSlots;

function readTargetText(args: ReadArgs, theme: Theme): string {
	return `${readPathText(shortPath(resolveToolPath(args)), theme)}${lineRangeText(args, theme)}`;
}

function readPrefix(theme: Theme): string {
	return `${toolNameText("read", theme)} `;
}

export function registerCompactRead(pi: ExtensionAPI, cwd: string, renderShellSource?: ToolRenderShellSource) {
	const original = createReadToolDefinition(cwd);

	pi.registerTool({
		...original,
		get renderShell() {
			return resolveToolRenderShell(renderShellSource);
		},
		execute(toolCallId, params, signal, onUpdate, ctx) {
			return original.execute(toolCallId, params, signal, onUpdate, ctx);
		},
		renderCall(args, theme, context) {
			const state = context.state as CompactReadState;
			const expandedCall = renderExpandedCall(original, args, theme, context, state);
			if (expandedCall) return expandedCall;

			const row = ensureCompactToolRow(state, context.lastComponent === state.builtInCallComponent ? undefined : context.lastComponent);
			const target = readTargetText(args as ReadArgs, theme);
			const summary = state.compactSummary ? readMetadataText(state.compactSummary, theme) : "";
			return setCompactRow(row, readPrefix(theme), target, summary);
		},
		renderResult(result, options, theme, context) {
			const state = context.state as CompactReadState;
			const callText = getCompactCallText(state);
			const args = context.args as ReadArgs;
			const target = readTargetText(args, theme);
			const renderExpanded = getExpandedResultRenderer(original, result, options, theme, context, state);

			if (context.isError) {
				const rawError = textBlocks(result);
				const error = compactFileToolError(rawError);
				const hint = compactFileToolHint(rawError);
				settleCompactRow(state, callText, "failed", readPrefix(theme), target, metadataText([invalidText(error, theme)], theme));
				if (renderExpanded) return renderExpanded();
				return hint ? new CompactHintBlock(hint, theme) : emptyComponent();
			}

			const summary = summarizeRead(result, args);
			settleCompactSummaryRow(state, callText, "success", summary, readPrefix(theme), target, readMetadataText(summary, theme));
			return renderExpanded?.() ?? emptyComponent();
		},
	});
}
