import type { AgentToolResult, ExtensionAPI, Theme, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { highlightCode, keyHint } from "@earendil-works/pi-coding-agent";
import { getCapabilities } from "@earendil-works/pi-tui";
import { ExpandedDetailRail, type ExpandedDetailSection } from "../components/expanded-detail-rail.js";
import { ExpandedToolHeader } from "../components/expanded-tool-header.js";
import { LineNumberedCodeBlock } from "../components/line-numbered-code-block.js";
import { ToolDetailFooter } from "../components/tool-detail-footer.js";
import { sanitizeInlineText, stripAnsi } from "../core-utils.js";
import { descText, invalidText, metadataText, numericText, separatorText, toolNameText, type ToolUiStatus } from "../style.js";
import { countLines, emptyComponent, formatLineCount, formatVisibleDuration, imageBlocks, linkPath, plural } from "../tui-utils.js";
import {
	codemodeCallCounts,
	codemodeCallGroups,
	codemodeCallPreviews,
	codemodeCallTarget,
	codemodeFullOutputPath,
	codemodeModelCost,
	codemodeOutput,
	formatCodemodeCallDuration,
	formatCodemodeCost,
	nonnegativeNumber,
	type CodemodeCallPreview,
} from "./codemode-helpers.js";
import { type CompactSummaryRowState, ensureCompactToolRow, getCompactCallText, setCompactRow, settleCompactSummaryRow } from "./compact-text.js";
import { registerCompactToolRenderer, type ToolRenderShellSource } from "./render-shell.js";

type RenderContext = Parameters<NonNullable<ToolRenderers["renderCall"]>>[2];

type CodeHighlightCache = {
	code: string;
	theme: Theme;
	colors: Theme["colors"];
	lines: string[];
};

type CompactCodemodeState = CompactSummaryRowState & {
	calls?: CodemodeCallPreview[];
	finalDurationMs?: number;
	imageCount?: number;
	fullOutputPath?: string;
	expandedCallHeader?: ExpandedToolHeader;
	codeHighlightCache?: CodeHighlightCache;
};

function scriptCode(args: unknown): string | undefined {
	if (typeof args !== "object" || args === null) return undefined;
	const code = (args as { code?: unknown }).code;
	return typeof code === "string" ? code : undefined;
}

function statusOf(state: CompactCodemodeState, context: RenderContext): ToolUiStatus {
	if (context.isError) return "failed";
	return state.compactStatus ?? (context.executionStarted ? "running" : "pending");
}

function statusParts(state: CompactCodemodeState, status: ToolUiStatus): string[] {
	const counts = codemodeCallCounts(state.calls);
	const parts: string[] = [];
	if (status === "pending") parts.push("preparing");
	if (status === "failed") parts.push("failed");
	if (status === "success") parts.push("done");
	if (status === "running") {
		if (counts.running === 0) parts.push("running");
		if (counts.ok > 0) parts.push(`${counts.ok} done`);
	}
	if (counts.running > 0) parts.push(`${counts.running} running`);
	if (counts.error > 0) parts.push(`${counts.error} failed`);
	if (counts.cancelled > 0) parts.push(`${counts.cancelled} cancelled`);
	if (counts.unknown > 0) parts.push(`${counts.unknown} unknown`);
	return parts;
}

function styledStatus(parts: string[], theme: Theme): string[] {
	return parts.map((part) => {
		if (/failed/.test(part)) return invalidText(part, theme);
		if (/running|cancelled|unknown/.test(part)) return theme.fg("warning", part);
		return numericText(part, theme);
	});
}

function codemodeOverview(state: CompactCodemodeState, theme: Theme, context: RenderContext) {
	const groups = codemodeCallGroups(state.calls);
	const body = groups.length > 0
		? groups.map(([name, count]) => `${toolNameText(name, theme)} ×${numericText(String(count), theme)}`).join(separatorText(theme))
		: descText("script", theme);
	const status = statusOf(state, context);
	const essential = statusParts(state, status);
	if (state.fullOutputPath) essential.push("truncated");
	const extra: string[] = [];
	if (state.calls?.length === 0) extra.push("0 calls");
	const duration = formatVisibleDuration(state.finalDurationMs);
	if (duration) extra.push(duration);
	const cost = codemodeModelCost(state.calls);
	if (cost !== undefined) extra.push(formatCodemodeCost(cost));
	if (state.imageCount) extra.push(plural(state.imageCount, "image"));

	const core = styledStatus(essential, theme);
	const full = metadataText([...core, ...extra.map((part) => numericText(part, theme))], theme);
	const compact = metadataText([...core, duration ? numericText(duration, theme) : undefined], theme);
	const fallback = metadataText(core, theme);
	return {
		body,
		summary: [...essential, ...extra].join(" · "),
		suffix: full,
		candidates: [full, compact, { text: fallback, fallback: true }],
	};
}

function updateExpandedHeader(state: CompactCodemodeState, overview: ReturnType<typeof codemodeOverview>, theme: Theme): ExpandedToolHeader {
	const header = state.expandedCallHeader ?? new ExpandedToolHeader();
	state.expandedCallHeader = header;
	header.setParts(`${toolNameText("codemode", theme)} `, overview.body, overview.suffix, overview.candidates);
	return header;
}

function callStatus(call: CodemodeCallPreview, theme: Theme): string {
	switch (call.status) {
		case "ok": return theme.fg("success", "ok");
		case "error": return invalidText("failed", theme);
		case "running": return theme.fg("warning", "running");
		case "cancelled": return theme.fg("warning", "cancelled");
		case "unknown": return theme.fg("muted", "unknown");
	}
}

function expandedCalls(calls: CodemodeCallPreview[] | undefined, theme: Theme, isPartial: boolean): string[] {
	if (!calls) return [descText("Call details unavailable.", theme)];
	if (calls.length === 0) return [descText(isPartial ? "No tool calls yet." : "No tool calls were made.", theme)];
	return calls.flatMap((call) => {
		const target = sanitizeInlineText(codemodeCallTarget(call));
		const metadata = [callStatus(call, theme), formatCodemodeCallDuration(call.durationMs)];
		if (call.cost) metadata.push(formatCodemodeCost(call.cost));
		const lines = [`${toolNameText(call.name, theme)}${target ? ` ${descText(target, theme)}` : ""}${metadataText(metadata, theme)}`];
		// Keep every available argument, even when the row uses a shorter path/command label.
		if (target !== call.args && call.args) lines.push(`  ${descText(`args: ${call.args}`, theme)}`);
		if (call.error) lines.push(...call.error.split("\n").map((line) => `  ${invalidText(line, theme)}`));
		return lines;
	});
}

function expandedCode(state: CompactCodemodeState, code: string, theme: Theme, argsComplete: boolean): string[] {
	const normalized = stripAnsi(code.replace(/\r\n?/g, "\n")).replace(/\t/g, "   ");
	if (!argsComplete) return normalized.split("\n");
	const cached = state.codeHighlightCache;
	// Pi passes a stable theme proxy; its concrete palette changes even when its identity does not.
	const colors = theme.colors;
	if (cached?.code === code && cached.theme === theme && cached.colors === colors) return cached.lines;
	const lines = highlightCode(normalized, "javascript");
	state.codeHighlightCache = { code, theme, colors, lines };
	return lines;
}

function fullOutputText(path: string, cwd: string): string {
	const label = sanitizeInlineText(path);
	try {
		return linkPath(label, path, cwd);
	} catch {
		// Broken paths in an old result must not replace all of the details with Pi's fallback UI.
		return label;
	}
}

function expandedCodemodeResult(
	state: CompactCodemodeState,
	result: AgentToolResult<unknown>,
	output: string,
	theme: Theme,
	context: RenderContext,
	isPartial: boolean,
): ExpandedDetailRail {
	const sections: ExpandedDetailSection[] = [{
		label: "calls",
		metadata: state.calls ? plural(state.calls.length, "call") : undefined,
		content: expandedCalls(state.calls, theme, isPartial),
	}];
	const code = scriptCode(context.args);
	if (code !== undefined) {
		sections.push({
			label: "code",
			metadata: `javascript · ${formatLineCount(countLines(code))}`,
			content: new LineNumberedCodeBlock(expandedCode(state, code, theme, context.argsComplete), theme),
		});
	}
	if (output) {
		const failed = state.compactStatus === "failed";
		const lines = output.split("\n").map((line) => theme.fg(failed ? "error" : "toolOutput", line));
		sections.push({ label: failed ? "error" : "output", content: new LineNumberedCodeBlock(lines, theme, { showLineNumbers: false }) });
	}
	const images = imageBlocks(result);
	if (images.length > 0) {
		const mimeTypes = [...new Set(images.map((image) => sanitizeInlineText(String(image.mimeType ?? "image"))))];
		sections.push({
			label: "images",
			metadata: `${plural(images.length, "image")} · ${mimeTypes.join(", ")}`,
			content: [descText(context.showImages && getCapabilities().images ? "Image attachments are rendered by Pi below." : "Image attachments are hidden.", theme)],
		});
	}
	if (state.fullOutputPath) sections.push({ label: "full output", content: [fullOutputText(state.fullOutputPath, context.cwd)] });
	const footer = new ToolDetailFooter();
	footer.setText([state.fullOutputPath ? "truncated" : undefined, keyHint("app.tools.expand", "collapse")].filter(Boolean).join(" · "));
	return new ExpandedDetailRail(theme, sections, footer);
}

/** Presentation only: keep the native tool's sandbox, loadout, store and nested-call execution. */
export function registerCompactCodemode(pi: ExtensionAPI, renderShellSource?: ToolRenderShellSource) {
	const renderers: ToolRenderers = {
		renderCall(args, theme, context) {
			const state = context.state as CompactCodemodeState;
			const overview = codemodeOverview(state, theme, context);
			if (context.expanded) return updateExpandedHeader(state, overview, theme);
			const row = ensureCompactToolRow(state, context.lastComponent);
			return setCompactRow(row, `${toolNameText("codemode", theme)} `, overview.body, overview.suffix, overview.candidates);
		},
		renderResult(result, options, theme, context) {
			const state = context.state as CompactCodemodeState;
			const output = codemodeOutput(result);
			state.calls = codemodeCallPreviews(result.details);
			state.finalDurationMs = options.isPartial ? undefined : nonnegativeNumber(context.durationMs) ?? output.durationMs;
			state.imageCount = imageBlocks(result).length;
			state.fullOutputPath = codemodeFullOutputPath(result.details);
			const status: ToolUiStatus = context.isError || output.failed ? "failed" : options.isPartial ? "running" : "success";
			state.compactStatus = status;
			const overview = codemodeOverview(state, theme, context);
			settleCompactSummaryRow(state, getCompactCallText(state), status, overview.summary, `${toolNameText("codemode", theme)} `, overview.body, overview.suffix, overview.candidates);
			if (state.expandedCallHeader) updateExpandedHeader(state, overview, theme);
			if (options.expanded) return expandedCodemodeResult(state, result, output.text, theme, context, options.isPartial);
			return emptyComponent();
		},
	};
	registerCompactToolRenderer(pi, "codemode", () => renderers, renderShellSource);
}
