import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { createWriteToolDefinition, formatSize } from "@earendil-works/pi-coding-agent";
import { CompactHintBlock } from "../components/compact-hint-block.js";
import { invalidText, metadataText, numericText, toolNameText, writePathText } from "../style.js";
import { countLines, emptyComponent, plural, shortPath, textBlocks } from "../tui-utils.js";
import { compactFileToolError, compactFileToolHint } from "./compact-error.js";
import { type CompactSummaryRowState, ensureCompactToolRow, getCompactCallText, setCompactRow, settleCompactSummaryRow, settleCompactRow } from "./compact-text.js";
import { getExpandedResultRenderer, renderExpandedCall, type BuiltInRendererSlots } from "./render-expanded-result.js";
import { resolveToolRenderShell, type ToolRenderShellSource } from "./render-shell.js";
import { resolveToolPath, type WriteArgs } from "./tool-args.js";

type WriteSummary = {
	lines: number;
	bytes: number;
};

function summarizeWrite(args: WriteArgs): WriteSummary | undefined {
	if (typeof args.content !== "string") return undefined;
	return { lines: countLines(args.content), bytes: Buffer.byteLength(args.content, "utf8") };
}

function writeSummaryText(summary: WriteSummary): string {
	return `${plural(summary.lines, "line")} · ${formatSize(summary.bytes)}`;
}

function formatWriteSummary(summary: string, theme: Theme): string {
	return metadataText([numericText(summary, theme)], theme);
}

type CompactWriteState = CompactSummaryRowState & BuiltInRendererSlots;

function writePrefix(theme: Theme): string {
	return `${toolNameText("write", theme)} `;
}

function writeTargetText(path: string, theme: Theme): string {
	return writePathText(path, theme);
}

function pendingWriteSummary(args: WriteArgs, state: CompactWriteState): string | undefined {
	if (state.compactSummary) return state.compactSummary;
	const summary = summarizeWrite(args);
	return summary ? writeSummaryText(summary) : undefined;
}

export function registerCompactWrite(pi: ExtensionAPI, cwd: string, renderShellSource?: ToolRenderShellSource) {
	const original = createWriteToolDefinition(cwd);

	pi.registerTool({
		...original,
		get renderShell() {
			return resolveToolRenderShell(renderShellSource);
		},
		execute(toolCallId, params, signal, onUpdate, ctx) {
			return original.execute(toolCallId, params, signal, onUpdate, ctx);
		},
		renderCall(args, theme, context) {
			const state = context.state as CompactWriteState;
			const expandedCall = renderExpandedCall(original, args, theme, context, state);
			if (expandedCall) return expandedCall;

			const row = ensureCompactToolRow(state, context.lastComponent === state.builtInCallComponent ? undefined : context.lastComponent);
			const writeArgs = args as WriteArgs;
			const path = shortPath(resolveToolPath(writeArgs));
			const summary = pendingWriteSummary(writeArgs, state);
			return setCompactRow(row, writePrefix(theme), writeTargetText(path, theme), summary ? formatWriteSummary(summary, theme) : "");
		},
		renderResult(result, options, theme, context) {
			const state = context.state as CompactWriteState;
			const callText = getCompactCallText(state);
			const path = shortPath(resolveToolPath(context.args as WriteArgs));
			const renderExpanded = getExpandedResultRenderer(original, result, options, theme, context, state);

			if (context.isError) {
				const rawError = textBlocks(result);
				const error = compactFileToolError(rawError);
				const hint = compactFileToolHint(rawError);
				settleCompactRow(state, callText, "failed", writePrefix(theme), writeTargetText(path, theme), metadataText([invalidText(error, theme)], theme));
				if (renderExpanded) return renderExpanded();
				return hint ? new CompactHintBlock(hint, theme) : emptyComponent();
			}

			const summary = summarizeWrite(context.args as WriteArgs);
			const compactSummary = summary ? writeSummaryText(summary) : "invalid content";
			settleCompactSummaryRow(state, callText, "success", compactSummary, writePrefix(theme), writeTargetText(path, theme), formatWriteSummary(compactSummary, theme));
			return renderExpanded?.() ?? emptyComponent();
		},
	});
}
