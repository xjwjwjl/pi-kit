import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { createWriteToolDefinition, formatSize, getLanguageFromPath, highlightCode, keyHint } from "@earendil-works/pi-coding-agent";
import { CompactHintBlock } from "../components/compact-hint-block.js";
import { ExpandedDetailRail, type ExpandedDetailSection } from "../components/expanded-detail-rail.js";
import { ExpandedToolHeader } from "../components/expanded-tool-header.js";
import { LineNumberedCodeBlock } from "../components/line-numbered-code-block.js";
import { ToolDetailFooter } from "../components/tool-detail-footer.js";
import { invalidText, metadataText, numericText, toolNameText, writePathText } from "../style.js";
import { countLines, emptyComponent, formatLineCount, linkPath, shortPath, stripAnsi, textBlocks, trimTrailingEmptyLines } from "../tui-utils.js";
import { compactFileToolError, compactFileToolHint } from "./compact-error.js";
import { type CompactSummaryRowState, ensureCompactToolRow, getCompactCallText, setCompactRow, settleCompactSummaryRow, settleCompactRow } from "./compact-text.js";
import { type BuiltInRendererSlots } from "./render-expanded-result.js";
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
	return `${formatLineCount(summary.lines)} · ${formatSize(summary.bytes)}`;
}

function formatWriteSummary(summary: string, theme: Theme): string {
	return metadataText([numericText(summary, theme)], theme);
}

type WriteHighlightCache = {
	rawPath?: string;
	rawContent: string;
	language: string;
	theme: Theme;
	lines: string[];
};

type CompactWriteState = CompactSummaryRowState & BuiltInRendererSlots & {
	expandedCallHeader?: ExpandedToolHeader;
	expandedHighlightCache?: WriteHighlightCache;
};

function writePrefix(theme: Theme): string {
	return `${toolNameText("write", theme)} `;
}

function writeTargetText(displayPath: string, rawPath: string | undefined, cwd: string, theme: Theme): string {
	const styled = writePathText(displayPath, theme);
	return rawPath ? linkPath(styled, rawPath, cwd) : styled;
}

function pendingWriteSummary(args: WriteArgs, state: CompactWriteState): string | undefined {
	if (state.compactSummary) return state.compactSummary;
	const summary = summarizeWrite(args);
	return summary ? writeSummaryText(summary) : undefined;
}

function normalizeWriteContent(content: string): string {
	return content.replace(/\r\n?/g, "\n").replace(/\t/g, "   ");
}

function expandedWriteContent(state: CompactWriteState, args: WriteArgs, theme: Theme, argsComplete: boolean): { lines: string[]; language?: string } | undefined {
	if (typeof args.content !== "string") return undefined;
	const rawPath = resolveToolPath(args);
	const language = rawPath ? getLanguageFromPath(rawPath) : undefined;
	const normalized = normalizeWriteContent(args.content);
	if (!language || !argsComplete) return { lines: trimTrailingEmptyLines(normalized.split("\n")), language };

	const cached = state.expandedHighlightCache;
	if (cached && cached.rawPath === rawPath && cached.rawContent === args.content && cached.language === language && cached.theme === theme) {
		return { lines: cached.lines, language };
	}

	const lines = trimTrailingEmptyLines(highlightCode(normalized, language));
	state.expandedHighlightCache = { rawPath, rawContent: args.content, language, theme, lines };
	return { lines, language };
}

function expandedWriteHeader(state: CompactWriteState, args: WriteArgs, target: string, theme: Theme, argsComplete: boolean, error?: string): ExpandedToolHeader {
	const header = state.expandedCallHeader ?? new ExpandedToolHeader();
	state.expandedCallHeader = header;
	const summary = pendingWriteSummary(args, state);
	const suffix = error
		? metadataText([invalidText(error, theme)], theme)
		: summary
			? formatWriteSummary(summary, theme)
			: !argsComplete
				? metadataText(["preparing"], theme)
				: "";
	header.setParts(writePrefix(theme), target, suffix);
	return header;
}

function expandedWriteResult(
	result: any,
	args: WriteArgs,
	state: CompactWriteState,
	theme: Theme,
	isError: boolean,
): ExpandedDetailRail {
	const rawError = stripAnsi(textBlocks(result));
	const footer = new ToolDetailFooter();
	const footerParts = [] as string[];
	if (isError) {
		const hint = compactFileToolHint(rawError);
		if (hint) footerParts.push(hint);
	}
	footerParts.push(keyHint("app.tools.expand", "collapse"));
	footer.setText(footerParts.join(" · "));

	const sections: ExpandedDetailSection[] = [];
	if (isError && rawError) sections.push({ label: "error", content: new LineNumberedCodeBlock(rawError, theme, { showLineNumbers: false }) });
	const content = expandedWriteContent(state, args, theme, true);
	if (content) {
		const summary = summarizeWrite(args);
		sections.push({
			label: "content",
			metadata: content.language ?? (summary ? `${summary.lines} lines` : undefined),
			content: new LineNumberedCodeBlock(content.lines, theme),
		});
	}
	return new ExpandedDetailRail(theme, sections, footer);
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
			const writeArgs = args as WriteArgs;
			const rawPath = resolveToolPath(writeArgs);
			const displayPath = shortPath(rawPath);
			const target = writeTargetText(displayPath, rawPath, cwd, theme);
			if (context.expanded) return expandedWriteHeader(state, writeArgs, target, theme, context.argsComplete);

			const row = ensureCompactToolRow(state, context.lastComponent === state.builtInCallComponent ? undefined : context.lastComponent);
			const summary = pendingWriteSummary(writeArgs, state);
			return setCompactRow(row, writePrefix(theme), target, summary ? formatWriteSummary(summary, theme) : "");
		},
		renderResult(result, options, theme, context) {
			const state = context.state as CompactWriteState;
			const callText = getCompactCallText(state);
			const rawPath = resolveToolPath(context.args as WriteArgs);
			const displayPath = shortPath(rawPath);

			if (context.isError) {
				const rawError = textBlocks(result);
				const error = compactFileToolError(rawError);
				const hint = compactFileToolHint(rawError);
				settleCompactRow(state, callText, "failed", writePrefix(theme), writeTargetText(displayPath, rawPath, cwd, theme), metadataText([invalidText(error, theme)], theme));
				if (context.expanded) {
					expandedWriteHeader(state, context.args as WriteArgs, writeTargetText(displayPath, rawPath, cwd, theme), theme, context.argsComplete, error);
					return expandedWriteResult(result, context.args as WriteArgs, state, theme, true);
				}
				return hint ? new CompactHintBlock(hint, theme) : emptyComponent();
			}

			const summary = summarizeWrite(context.args as WriteArgs);
			const compactSummary = summary ? writeSummaryText(summary) : "invalid content";
			settleCompactSummaryRow(state, callText, "success", compactSummary, writePrefix(theme), writeTargetText(displayPath, rawPath, cwd, theme), formatWriteSummary(compactSummary, theme));
			if (context.expanded) {
				expandedWriteHeader(state, context.args as WriteArgs, writeTargetText(displayPath, rawPath, cwd, theme), theme, context.argsComplete);
				return expandedWriteResult(result, context.args as WriteArgs, state, theme, false);
			}
			return emptyComponent();
		},
	});
}
