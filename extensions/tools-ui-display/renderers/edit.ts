import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { createEditToolDefinition } from "@earendil-works/pi-coding-agent";
import { DiffPreviewBlock } from "../components/diff-preview-block.js";
import { DEFAULT_EDIT_DISPLAY_OPTIONS, type EditDisplayOptions } from "../settings/options.js";
import { editDiffStatText, editPathText, invalidText, metadataText, numericText, toolNameText } from "../style.js";
import { emptyComponent, shortPath, textBlocks } from "../tui-utils.js";
import { type CompactSummaryRowState, ensureCompactToolRow, getCompactCallText, setCompactRow, settleCompactSummaryRow, settleCompactRow } from "./compact-text.js";
import { compactEditError, editSummaryText, shouldInlineEditDiff, type EditArgs } from "./edit-helpers.js";
import { getExpandedResultRenderer } from "./render-expanded-result.js";
import { resolveToolRenderShell, type ToolRenderShellSource } from "./render-shell.js";
import { resolveToolPath } from "./tool-args.js";

type EditPreview = {
	diff?: string;
	firstChangedLine?: number;
	error?: string;
};

type BuiltInEditState = {
	callComponent?: {
		preview?: EditPreview;
		previewArgsKey?: string;
		previewPending?: boolean;
		settledError?: boolean;
	};
};

type CompactEditState = CompactSummaryRowState & {
	builtInEditState?: BuiltInEditState;
};

type EditDisplayOptionsSource = EditDisplayOptions | (() => EditDisplayOptions | undefined) | undefined;

function resolveEditDisplayOptions(source: EditDisplayOptionsSource): Required<EditDisplayOptions> {
	const value = typeof source === "function" ? source() : source;
	const inlineDiffMaxLines =
		typeof value?.inlineDiffMaxLines === "number" && Number.isFinite(value.inlineDiffMaxLines)
			? Math.max(0, Math.floor(value.inlineDiffMaxLines))
			: DEFAULT_EDIT_DISPLAY_OPTIONS.inlineDiffMaxLines;
	return { inlineDiffMaxLines };
}

function editTargetText(args: EditArgs, theme: Theme): string {
	return editPathText(shortPath(resolveToolPath(args)), theme);
}

function formatEditSummaryPart(part: string, theme: Theme): string {
	return /^\+\d+\s+-\d+$/.test(part) ? editDiffStatText(part, theme) ?? part : numericText(part, theme);
}

function formatEditSummary(summary: string | undefined, theme: Theme): string {
	if (!summary) return "";
	return metadataText(summary.split(" · ").map((part) => formatEditSummaryPart(part, theme)), theme);
}

function editPrefix(theme: Theme): string {
	return `${toolNameText("edit", theme)} `;
}

function builtInEditState(state: CompactEditState): BuiltInEditState {
	state.builtInEditState ??= {};
	return state.builtInEditState;
}

function renderBuiltInEditCall(original: ReturnType<typeof createEditToolDefinition>, args: any, theme: Theme, context: any, state: CompactEditState) {
	return original.renderCall?.(args, theme, {
		...context,
		state: builtInEditState(state),
		lastComponent: builtInEditState(state).callComponent,
	});
}

function previewFromState(state: CompactEditState): EditPreview | undefined {
	return state.builtInEditState?.callComponent?.preview;
}

function previewIsPending(state: CompactEditState): boolean {
	return Boolean(state.builtInEditState?.callComponent?.previewPending);
}

function pendingSummary(state: CompactEditState): string | undefined {
	return previewIsPending(state) ? "previewing" : undefined;
}

function finalDiff(result: any, state: CompactEditState): string | undefined {
	return typeof result?.details?.diff === "string" ? result.details.diff : previewFromState(state)?.diff;
}

export function registerCompactEdit(
	pi: ExtensionAPI,
	cwd: string,
	editOptionsSource?: EditDisplayOptionsSource,
	renderShellSource?: ToolRenderShellSource,
) {
	const original = createEditToolDefinition(cwd);

	pi.registerTool({
		...original,
		get renderShell() {
			return resolveToolRenderShell(renderShellSource);
		},
		execute(toolCallId, params, signal, onUpdate, ctx) {
			return original.execute(toolCallId, params, signal, onUpdate, ctx);
		},
		renderCall(args, theme, context) {
			const state = context.state as CompactEditState;
			if (context.expanded && original.renderCall) {
				return renderBuiltInEditCall(original, args, theme, context, state) ?? emptyComponent();
			}

			// Let the built-in renderer compute and cache the async diff preview, but keep
			// collapsed rendering compact and under this extension's control.
			renderBuiltInEditCall(original, args, theme, context, state);

			const row = ensureCompactToolRow(state, context.lastComponent);
			const target = editTargetText(args as EditArgs, theme);
			const preview = previewFromState(state);
			const previewSummary = preview?.diff ? editSummaryText(preview.diff) : pendingSummary(state);
			const error = preview?.error ? compactEditError(preview.error) : undefined;
			const suffix = error ? metadataText([invalidText(error, theme)], theme) : formatEditSummary(state.compactSummary ?? previewSummary, theme);
			return setCompactRow(row, editPrefix(theme), target, suffix);
		},
		renderResult(result, options, theme, context) {
			const state = context.state as CompactEditState;
			const args = context.args as EditArgs;
			const target = editTargetText(args, theme);
			const callText = getCompactCallText(state);
			const renderExpanded = getExpandedResultRenderer(original as any, result, options, theme, {
				...context,
				state: builtInEditState(state),
				lastComponent: undefined,
			} as any);

			if (context.isError) {
				const rawError = textBlocks(result);
				const error = compactEditError(rawError);
				settleCompactRow(state, callText, "failed", editPrefix(theme), target, metadataText([invalidText(error, theme)], theme));
				if (renderExpanded) return renderExpanded();
				return emptyComponent();
			}

			const diff = finalDiff(result, state);
			const summary = editSummaryText(diff);
			settleCompactSummaryRow(state, callText, "success", summary, editPrefix(theme), target, formatEditSummary(summary, theme));

			if (renderExpanded) return renderExpanded();
			if (shouldInlineEditDiff(diff, resolveEditDisplayOptions(editOptionsSource).inlineDiffMaxLines)) return new DiffPreviewBlock(diff ?? "", theme);
			return emptyComponent();
		},
	});
}
