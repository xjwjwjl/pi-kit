import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { createReadToolDefinition, getLanguageFromPath, highlightCode, keyHint } from "@earendil-works/pi-coding-agent";
import { CompactHintBlock } from "../components/compact-hint-block.js";
import { ExpandedDetailRail, type ExpandedDetailSection } from "../components/expanded-detail-rail.js";
import { ExpandedToolHeader } from "../components/expanded-tool-header.js";
import { LineNumberedCodeBlock } from "../components/line-numbered-code-block.js";
import { ToolDetailFooter } from "../components/tool-detail-footer.js";
import { invalidText, metadataText, paramText, readMetadataText, readPathText, toolNameText } from "../style.js";
import { countLines, emptyComponent, formatLineCount, imageBlocks, linkPath, shortPath, textBlocks } from "../tui-utils.js";
import { compactFileToolError, compactFileToolHint } from "./compact-error.js";
import { type CompactSummaryRowState, ensureCompactToolRow, getCompactCallText, setCompactRow, settleCompactSummaryRow, settleCompactRow } from "./compact-text.js";
import { readContinuationInfo, stripReadContinuationNotice, stripReadTruncationNotice, summarizeRead } from "./read-helpers.js";
import { type BuiltInRendererSlots } from "./render-expanded-result.js";
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

type ReadHighlightCache = {
	rawPath: string;
	body: string;
	language: string;
	theme: Theme;
	lines: string[];
};

type CompactReadState = CompactSummaryRowState & BuiltInRendererSlots & {
	expandedCallHeader?: ExpandedToolHeader;
	expandedHighlightCache?: ReadHighlightCache;
};

function readTargetText(args: ReadArgs, cwd: string, theme: Theme): string {
	const rawPath = resolveToolPath(args);
	const styled = readPathText(shortPath(rawPath), theme);
	const linked = rawPath ? linkPath(styled, rawPath, cwd) : styled;
	return `${linked}${lineRangeText(args, theme)}`;
}

function readPrefix(theme: Theme): string {
	return `${toolNameText("read", theme)} `;
}

function replaceTabs(text: string): string {
	return text.replace(/\t/g, "   ");
}

function expandedReadHeader(state: CompactReadState, target: string, suffix: string, theme: Theme): ExpandedToolHeader {
	const header = state.expandedCallHeader ?? new ExpandedToolHeader();
	state.expandedCallHeader = header;
	header.setParts(readPrefix(theme), target, suffix ? metadataText([suffix], theme) : "");
	return header;
}

function expandedReadLines(state: CompactReadState, rawPath: string | undefined, body: string, language: string | undefined, theme: Theme): string[] {
	const normalized = replaceTabs(body);
	if (!language || !rawPath) return normalized.split("\n");
	const cached = state.expandedHighlightCache;
	if (cached?.rawPath === rawPath && cached.body === body && cached.language === language && cached.theme === theme) return cached.lines;
	const lines = highlightCode(normalized, language);
	state.expandedHighlightCache = { rawPath, body, language, theme, lines };
	return lines;
}

function expandedReadResult(state: CompactReadState, result: any, args: ReadArgs, theme: Theme, isError: boolean): ExpandedDetailRail {
	const raw = textBlocks(result);
	const continuation = readContinuationInfo(raw);
	const body = stripReadTruncationNotice(stripReadContinuationNotice(raw)).trimEnd();
	const footer = new ToolDetailFooter();
	const footerParts: string[] = [];
	const truncation = result?.details?.truncation;
	if (truncation?.truncated) footerParts.push("truncated");
	if (continuation?.remaining !== undefined) footerParts.push(`${continuation.remaining} more lines`);
	if (continuation?.nextOffset !== undefined) footerParts.push(`next offset=${continuation.nextOffset}`);
	footerParts.push(keyHint("app.tools.expand", "collapse"));
	footer.setText(footerParts.join(" · "));

	const sections: ExpandedDetailSection[] = [];
	if (isError) {
		if (body) sections.push({ label: "error", content: new LineNumberedCodeBlock(body, theme, { showLineNumbers: false }) });
		return new ExpandedDetailRail(theme, sections, footer);
	}

	const images = imageBlocks(result);
	const rawPath = resolveToolPath(args);
	const language = rawPath ? getLanguageFromPath(rawPath) : undefined;
	if (body && images.length === 0) {
		const highlighted = expandedReadLines(state, rawPath, body, language, theme);
		const range = resolveReadRange(args);
		const startLine = range?.start ?? 1;
		const metadata = language ? language : `${countLines(body)} lines`;
		sections.push({ label: "content", metadata, content: new LineNumberedCodeBlock(highlighted, theme, { startLine }) });
	}
	if (images.length > 0) {
		const mime = images[0]?.mimeType ?? "image";
		const note = body || "image attachment";
		sections.push({ label: "image", metadata: images.length === 1 ? mime : `${images.length} images`, content: note.split("\n") });
	}
	return new ExpandedDetailRail(theme, sections, footer);
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
			const target = readTargetText(args as ReadArgs, cwd, theme);
			if (context.expanded) {
				const suffix = state.compactSummary ? state.compactSummary : "";
				return expandedReadHeader(state, target, suffix, theme);
			}

			const row = ensureCompactToolRow(state, context.lastComponent === state.builtInCallComponent ? undefined : context.lastComponent);
			const summary = state.compactSummary ? readMetadataText(state.compactSummary, theme) : "";
			return setCompactRow(row, readPrefix(theme), target, summary);
		},
		renderResult(result, options, theme, context) {
			const state = context.state as CompactReadState;
			const callText = getCompactCallText(state);
			const args = context.args as ReadArgs;
			const target = readTargetText(args, cwd, theme);

			if (context.isError) {
				const rawError = textBlocks(result);
				const error = compactFileToolError(rawError);
				const hint = compactFileToolHint(rawError);
				settleCompactRow(state, callText, "failed", readPrefix(theme), target, metadataText([invalidText(error, theme)], theme));
				if (context.expanded) {
					expandedReadHeader(state, target, error, theme);
					return expandedReadResult(state, result, args, theme, true);
				}
				return hint ? new CompactHintBlock(hint, theme) : emptyComponent();
			}

			const summary = summarizeRead(result);
			settleCompactSummaryRow(state, callText, "success", summary, readPrefix(theme), target, readMetadataText(summary, theme));
			if (context.expanded) {
				const raw = textBlocks(result);
				const body = stripReadTruncationNotice(stripReadContinuationNotice(raw)).trimEnd();
				const images = imageBlocks(result);
				const expandedSummary = images.length > 0 ? (images.length === 1 ? images[0]?.mimeType ?? "image" : `${images.length} images`) : formatLineCount(countLines(body));
				expandedReadHeader(state, target, expandedSummary, theme);
				return expandedReadResult(state, result, args, theme, false);
			}
			return emptyComponent();
		},
	});
}
