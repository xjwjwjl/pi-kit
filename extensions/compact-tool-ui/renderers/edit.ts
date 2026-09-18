import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { createEditToolDefinition, keyHint } from "@earendil-works/pi-coding-agent";
import { DiffPreviewBlock } from "../components/diff-preview-block.js";
import { ExpandedDetailRail, type ExpandedDetailSection } from "../components/expanded-detail-rail.js";
import { ExpandedDiffBlock } from "../components/expanded-diff-block.js";
import { ExpandedToolHeader } from "../components/expanded-tool-header.js";
import { LineNumberedCodeBlock } from "../components/line-numbered-code-block.js";
import { ToolDetailFooter } from "../components/tool-detail-footer.js";
import { DEFAULT_EDIT_DISPLAY_OPTIONS, type EditDisplayOptions, normalizeInlineDiffMaxLines } from "../settings/options.js";
import { editDiffStatText, editPathText, invalidText, metadataText, numericText, toolNameText } from "../style.js";
import { countLines, emptyComponent, linkPath, shortPath, textBlocks } from "../tui-utils.js";
import { type CompactSummaryRowState, ensureCompactToolRow, getCompactCallText, setCompactRow, settleCompactSummaryRow, settleCompactRow } from "./compact-text.js";
import { compactEditError, countEditDiffHunks, editSummaryText, shouldInlineEditDiff, type EditArgs } from "./edit-helpers.js";
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
	expandedCallHeader?: ExpandedToolHeader;
	builtInEditState?: BuiltInEditState;
};

type EditDisplayOptionsSource = EditDisplayOptions | (() => EditDisplayOptions | undefined) | undefined;

function resolveEditDisplayOptions(source: EditDisplayOptionsSource): Required<EditDisplayOptions> {
	const value = typeof source === "function" ? source() : source;
	return { inlineDiffMaxLines: normalizeInlineDiffMaxLines(value?.inlineDiffMaxLines ?? DEFAULT_EDIT_DISPLAY_OPTIONS.inlineDiffMaxLines) };
}

function editTargetText(args: EditArgs, cwd: string, theme: Theme): string {
	const rawPath = resolveToolPath(args);
	const styled = editPathText(shortPath(rawPath), theme);
	return rawPath ? linkPath(styled, rawPath, cwd) : styled;
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

function expandedEditHeader(state: CompactEditState, target: string, summary: string | undefined, theme: Theme): ExpandedToolHeader {
	const header = state.expandedCallHeader ?? new ExpandedToolHeader();
	state.expandedCallHeader = header;
	header.setParts(editPrefix(theme), target, summary ? formatEditSummary(summary, theme) : "");
	return header;
}

function expandedEditResult(diff: string | undefined, rawError: string | undefined, theme: Theme, isError: boolean): ExpandedDetailRail {
	const footer = new ToolDetailFooter();
	footer.setText(keyHint("app.tools.expand", "collapse"));
	const sections: ExpandedDetailSection[] = [];
	if (isError) {
		if (rawError) sections.push({ label: "error", content: new LineNumberedCodeBlock(rawError, theme, { showLineNumbers: false }) });
	} else if (diff) {
		const hunks = countEditDiffHunks(diff);
		sections.push({ label: "diff", metadata: hunks > 0 ? `${hunks} hunks` : undefined, content: new ExpandedDiffBlock(diff, theme) });
	}
	return new ExpandedDetailRail(theme, sections, footer);
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
			// Let the built-in renderer compute and cache the async diff preview, but never
			// embed its Box/component tree in the expanded rail.
			renderBuiltInEditCall(original, args, theme, context, state);
			const target = editTargetText(args as EditArgs, cwd, theme);
			if (context.expanded) {
				const preview = previewFromState(state);
				const previewSummary = preview?.diff ? editSummaryText(preview.diff) : pendingSummary(state);
				const error = preview?.error ? compactEditError(preview.error) : undefined;
				return expandedEditHeader(state, target, error ? error : previewSummary ?? (!context.argsComplete ? "preparing" : undefined), theme);
			}

			const row = ensureCompactToolRow(state, context.lastComponent);
			const preview = previewFromState(state);
			const previewSummary = preview?.diff ? editSummaryText(preview.diff) : pendingSummary(state);
			const error = preview?.error ? compactEditError(preview.error) : undefined;
			const suffix = error ? metadataText([invalidText(error, theme)], theme) : formatEditSummary(state.compactSummary ?? previewSummary, theme);
			return setCompactRow(row, editPrefix(theme), target, suffix);
		},
		renderResult(result, options, theme, context) {
			const state = context.state as CompactEditState;
			const args = context.args as EditArgs;
			const target = editTargetText(args, cwd, theme);
			const callText = getCompactCallText(state);

			if (context.isError) {
				const rawError = textBlocks(result);
				const error = compactEditError(rawError);
				settleCompactRow(state, callText, "failed", editPrefix(theme), target, metadataText([invalidText(error, theme)], theme));
				if (context.expanded) {
					expandedEditHeader(state, target, error, theme);
					return expandedEditResult(undefined, rawError, theme, true);
				}
				return emptyComponent();
			}

			const diff = finalDiff(result, state);
			const summary = editSummaryText(diff);
			settleCompactSummaryRow(state, callText, "success", summary, editPrefix(theme), target, formatEditSummary(summary, theme));

			if (context.expanded) {
				expandedEditHeader(state, target, summary, theme);
				return expandedEditResult(diff, undefined, theme, false);
			}
			if (shouldInlineEditDiff(diff, resolveEditDisplayOptions(editOptionsSource).inlineDiffMaxLines)) return new DiffPreviewBlock(diff ?? "", theme);
			return emptyComponent();
		},
	});
}
