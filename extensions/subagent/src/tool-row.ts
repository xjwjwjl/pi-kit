/** Compact foreground-agent cards. Rendering never starts timers, tools, or file reads. */
import { type Component, Markdown, type MarkdownTheme, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { type RowTheme, formatTokens, singleLine } from "./tool-format.ts";
import { readProgress, type ActivityStatus, type ProgressPhase, type ProgressSnapshot, type ToolActivity } from "./progress.ts";

export const CELL_GAP = 2;
const CELL_SEPARATOR = " ".repeat(CELL_GAP);
const ANSI_RESET = "\x1b[0m";

declare const plainBrand: unique symbol;
export type Plain = string & { readonly [plainBrand]: true };
export const plain = (text: string): Plain => singleLine(text) as Plain;

export function present(...parts: Array<string | undefined>): string {
	return parts.filter((part): part is string => typeof part === "string" && part.length > 0).join(CELL_SEPARATOR);
}

export function toolDuration(ms: number): string {
	const total = Math.max(0, Math.round(ms / 1_000));
	if (total < 60) return `${total}s`;
	const minutes = Math.floor(total / 60);
	const seconds = total % 60;
	if (minutes < 60) return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/** Cut before styling: the TUI helper's full reset must not escape into the surrounding row. */
function cut(text: Plain, width: number): string {
	return truncateToWidth(text, Math.max(0, width), "").replaceAll(ANSI_RESET, "");
}

function ellipsis(text: Plain, width: number): string {
	if (visibleWidth(text) <= width) return text;
	if (width <= 1) return width > 0 ? "…" : "";
	return `${cut(text, width - 1)}…`;
}

function record(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function string(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function nonnegative(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function argument(value: unknown): string {
	if (typeof value === "string") return value;
	return JSON.stringify(value, null, 2) ?? String(value);
}

function firstLine(text: string): string | undefined {
	return text.split("\n").map((line) => plain(line).trim()).find(Boolean);
}

export function textLines(result: { content: Array<{ type: string; text?: string }> }): string[] {
	return (Array.isArray(result.content) ? result.content : [])
		.filter((part) => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n")
		.split("\n");
}

type DisplayStatus = "queued" | "starting" | "preparing" | "cleaning" | "processing" | "returned" | "failed" | "cancelled" | "turn-limit" | "aborted";

/** Resolved at call time; displayed so definition and override effects are inspectable. */
export interface ResolvedAgent {
	name: string;
	source: string;
	model: string;
	thinking: string;
	tools: string;
}

interface ResultView {
	body: string;
	agent?: ResolvedAgent;
	isPartial: boolean;
	progress?: ProgressSnapshot;
	status: DisplayStatus;
	error?: string;
	reason?: string;
	cleanupWarning?: string;
	turnLimit?: number;
	truncated: boolean;
	fullOutputPath?: string;
	tokens?: number;
	toolUses?: number;
	durationMs?: number;
}

function resolvedAgent(value: unknown): ResolvedAgent | undefined {
	const meta = record(value);
	const name = string(meta.name), source = string(meta.source), model = string(meta.model);
	const thinking = string(meta.thinking), tools = string(meta.tools);
	if (!name || !source || !model || !thinking || !tools) return undefined;
	return { name, source, model, thinking, tools };
}

function resultView(
	result: { content: Array<{ type: string; text?: string }>; details?: unknown },
	context: { isError?: boolean; durationMs?: number },
	isPartial: boolean,
): ResultView {
	const meta = record(result.details);
	const progress = readProgress(meta.progress);
	const lines = textLines(result);
	// Strip only our exact machine header and its single empty separator line.
	// Further leading blanks and all internal spacing belong to the report itself.
	if (typeof meta.header === "string" && lines[0] === meta.header) {
		lines.shift();
		if (lines[0] === "") lines.shift();
	}
	const body = lines.join("\n");
	const reason = string(meta.reason);
	let status: DisplayStatus;
	if (meta.status === "aborted") status = reason === "cancelled" ? "cancelled" : reason === "turn_limit" ? "turn-limit" : "aborted";
	else if (meta.status === "failed" || context.isError) status = "failed";
	else status = isPartial ? phaseStatus(progress?.phase) : "returned";
	return {
		body, agent: resolvedAgent(meta.agent), status, reason, isPartial, progress,
		error: string(meta.errorSummary) ?? (status === "failed" ? firstLine(body) : undefined),
		cleanupWarning: string(meta.cleanupWarning), turnLimit: nonnegative(meta.turnLimit),
		truncated: meta.truncated === true,
		fullOutputPath: string(meta.fullOutputPath),
		tokens: isPartial ? undefined : nonnegative(meta.tokens),
		toolUses: isPartial ? progress?.toolUses : nonnegative(meta.toolUses),
		durationMs: isPartial ? progress?.elapsedMs : nonnegative(context.durationMs) ?? progress?.elapsedMs,
	};
}

const STATUS_LABEL: Record<DisplayStatus, string> = {
	queued: "queued", starting: "starting", preparing: "preparing result", cleaning: "cleaning up",
	processing: "running", returned: "returned", failed: "failed",
	cancelled: "stopped", "turn-limit": "stopped", aborted: "stopped",
};

/** A partial call's phase is more specific than "running"; keep the row honest about waiting. */
function phaseStatus(phase: ProgressPhase | undefined): DisplayStatus {
	switch (phase) {
		case "queued": return "queued";
		case "starting": return "starting";
		case "cleanup": return "cleaning";
		case "preparing": return "preparing";
		default: return "processing";
	}
}

function statusColor(status: DisplayStatus): string {
	if (status === "failed") return "error";
	if (status === "aborted" || status === "turn-limit") return "warning";
	if (status === "returned" || status === "cancelled" || status === "queued") return "muted";
	return "accent";
}

/** Omit unknown values, rather than inventing elapsed time or actual model/tool configuration. */
function statisticValues(result: ResultView | undefined): { duration: string; tokens: string; calls: string } {
	return {
		duration: result?.durationMs !== undefined && (result.durationMs >= 1_000 || result.isPartial) ? toolDuration(result.durationMs) : "",
		tokens: result?.tokens !== undefined && result.tokens > 0 ? `${formatTokens(result.tokens)} tokens` : "",
		calls: result?.toolUses !== undefined && result.toolUses > 0 ? `${result.toolUses} tool ${result.toolUses === 1 ? "call" : "calls"}` : "",
	};
}

function metrics(result: ResultView | undefined): string[] {
	const { duration, tokens, calls } = statisticValues(result);
	return [duration, tokens, calls].filter(Boolean);
}

function toolDisplayStatus(tool: ToolActivity | null, isPartial: boolean): ActivityStatus | "" {
	if (!tool) return "";
	return !isPartial && tool.status === "running" ? "unfinished" : tool.status;
}

function toolCallDuration(durationMs: number | undefined): string {
	if (durationMs === undefined) return "";
	return durationMs < 1_000 ? `${Math.round(durationMs)}ms` : toolDuration(durationMs);
}

function notices(result: ResultView | undefined): Array<{ text: string; color: string }> {
	if (!result) return [];
	const out: Array<{ text: string; color: string }> = [];
	if (result.status === "failed") out.push({ text: `× ${firstLine(result.error ?? "") || "no error details"}`, color: "error" });
	if (result.status === "cancelled") out.push({ text: "↳ cancelled", color: "muted" });
	if (result.status === "turn-limit") out.push({
		text: `↳ turn limit reached${result.turnLimit !== undefined ? ` (max_turns=${result.turnLimit})` : ""}`, color: "warning",
	});
	if (result.status === "aborted") out.push({ text: `↳ ${result.reason === "sdk_abort" ? "session aborted" : result.reason || firstLine(result.body) || "no reason provided"}`, color: "warning" });
	if (result.cleanupWarning !== undefined) out.push({ text: `! cleanup warning: ${firstLine(result.cleanupWarning) || "no details"}`, color: "warning" });
	if (result.truncated) out.push({ text: "! report truncated · ctrl+o for path", color: "warning" });
	return out;
}

export interface ToolRowContext {
	args?: Record<string, unknown>;
	state: Record<string, unknown>;
	expanded: boolean;
	isError?: boolean;
	isPartial?: boolean;
	durationMs?: number;
	outputPad?: number;
}

export interface ToolRowProps {
	label: string;
	detail: string;
	theme: RowTheme;
	args?: Record<string, unknown>;
	expanded: boolean;
	outputPad?: number;
}

/** Shared card data keeps the header current; result content stays in the result slot for HTML snapshots. */
export class ToolRow implements Component {
	private props: ToolRowProps;
	private result?: ResultView;
	private markdown?: Markdown;
	private markdownText = "";

	constructor(props: ToolRowProps) {
		this.props = props;
	}

	update(props: ToolRowProps): void {
		if (this.props.theme !== props.theme) this.invalidate();
		this.props = props;
	}

	updateResult(result: ResultView, theme: RowTheme, context: Partial<ToolRowContext>): void {
		if (this.result && !this.result.isPartial && result.isPartial) return;
		this.update({ ...this.props, theme, expanded: context.expanded ?? this.props.expanded,
			...(context.args !== undefined ? { args: context.args } : {}),
			...(context.outputPad !== undefined ? { outputPad: context.outputPad } : {}),
		});
		this.result = result;
	}

	render(width: number): string[] {
		return this.renderPart(width, "call");
	}

	renderResult(width: number, standalone: boolean): string[] {
		return this.renderPart(width, standalone ? "standalone" : "result");
	}

	private renderPart(width: number, part: "call" | "result" | "standalone"): string[] {
		if (width <= 0) return [];
		const pad = Math.min(Math.floor(nonnegative(this.props.outputPad) ?? 0), Math.floor((width - 1) / 2));
		const innerWidth = width - pad * 2;
		const headline = this.headline(innerWidth);
		const theme = this.props.theme;
		const lines = part === "result" ? [] : [...headline.lines];
		if (part !== "call") {
			for (const notice of notices(this.result)) {
				const indent = innerWidth >= 8 ? "  " : "";
				lines.push(`${indent}${theme.fg(notice.color, ellipsis(plain(notice.text), innerWidth - indent.length))}`);
			}
		}
		// Before a result exists, expansion can already show the assigned task. Once it
		// arrives, only the result slot owns details, so snapshot-based consumers retain them.
		if (this.props.expanded && (part !== "call" || !this.result)) {
			lines.push(...this.details(innerWidth, headline.detailWhole));
		}
		return lines.map((line) => `${" ".repeat(pad)}${line}`);
	}

	private headline(width: number): { lines: string[]; detailWhole: boolean } {
		const { theme } = this.props;
		const label = plain(this.props.label);
		const detail = plain(this.props.detail);
		const status = this.result?.status ?? "processing";
		const warning = this.result?.cleanupWarning !== undefined;
		const statusText = warning && status === "returned" ? "returned (warning)" : STATUS_LABEL[status];
		const { tokens, calls, duration } = statisticValues(this.result);
		const stats = [tokens, calls, duration].filter(Boolean);
		const variants = Array.from({ length: stats.length + 1 }, (_, index) => [...stats.slice(index), statusText].join(" · "));
		// Keep the compact one-row summary: optional statistics yield before the task or status.
		const titleBudget = visibleWidth(label) + (detail ? CELL_GAP + Math.min(visibleWidth(detail), Math.max(8, Math.floor(width * 0.4))) : 0);
		const suffix = variants.find((candidate) => titleBudget + CELL_GAP + visibleWidth(candidate) <= width)
			?? ellipsis(plain(statusText), width);
		const titleWidth = Math.max(0, width - visibleWidth(suffix) - CELL_GAP);
		const nameWidth = Math.min(visibleWidth(label), titleWidth);
		const detailWidth = Math.max(0, titleWidth - nameWidth - CELL_GAP);
		const title = [nameWidth > 0 ? theme.fg("toolTitle", ellipsis(label, nameWidth)) : "",
			detailWidth > 0 && detail ? theme.bold(ellipsis(detail, detailWidth)) : ""].filter(Boolean).join(CELL_SEPARATOR);
		const statusStart = suffix.endsWith(statusText) ? suffix.length - statusText.length : 0;
		const statusRole = warning && status === "returned" ? "warning" : statusColor(status);
		const summary = theme.fg("muted", suffix.slice(0, statusStart)) + theme.fg(statusRole, suffix.slice(statusStart));
		const gap = title ? " ".repeat(Math.max(CELL_GAP, width - visibleWidth(title) - visibleWidth(suffix))) : "";
		return { lines: [`${title}${gap}${summary}`], detailWhole: visibleWidth(detail) <= detailWidth };
	}

	private details(width: number, detailWhole: boolean): string[] {
		const { theme } = this.props;
		const guide = width >= 8 ? "  │ " : "";
		const contentWidth = width - visibleWidth(guide);
		const rail = (line: string) => `${theme.fg("borderMuted", guide)}${line}`;
		const out: string[] = [];
		const wrap = (text: string, color = "muted"): string[] => text.replace(/\r\n?/g, "\n").split("\n").flatMap((line) =>
			wrapTextWithAnsi(plain(line), contentWidth).map((piece) => theme.fg(color, cut(plain(piece), contentWidth))),
		);
		const section = (label: string, lines: string[]) => {
			if (out.length > 0) out.push(rail(""));
			out.push(...wrap(label).map((line) => rail(theme.bold(line))));
			out.push(...lines.map(rail));
		};
		if (this.result && !this.result.isPartial) {
			section("report", this.body(contentWidth));
			if (this.result.truncated || this.result.fullOutputPath) {
				section("full report", wrap(this.result.fullOutputPath
					? `${this.result.fullOutputPath}\nUse read to view the full report.\nExpanding does not load the file.`
					: "full report path unavailable"));
			}
		}
		const recent = this.result?.progress?.tools ?? [];
		const pinned = this.result?.progress?.slots.filter((tool): tool is ToolActivity => tool !== null && !recent.some((item) => item.id === tool.id)) ?? [];
		const history = [...pinned, ...recent];
		if (history.length > 0) {
			section("activity", history.flatMap((tool) => {
				const status = toolDisplayStatus(tool, this.result?.isPartial ?? false);
				return wrap([tool.name, tool.target, status, toolCallDuration(tool.durationMs)]
					.filter(Boolean).join(" · "));
			}));
		}
		const args = record(this.props.args);
		const config = Object.entries(args).filter(([key, value]) => key !== "description" && key !== "prompt" && value !== undefined);
		const agent = this.result?.agent;
		if (agent || config.length > 0) {
			const labels: Record<string, string> = { tools: "additional tools", model: "model override", thinking: "thinking override" };
			const lines: string[] = [];
			if (agent) {
				lines.push(...wrap(`agent: ${agent.name} [${agent.source}]`));
				lines.push(...wrap(`model: ${agent.model}`));
				lines.push(...wrap(`thinking: ${agent.thinking}`));
				lines.push(...wrap(`tools: ${agent.tools}`));
			}
			lines.push(...config.flatMap(([key, value]) => wrap(`${labels[key] ?? key}: ${argument(value)}`)));
			if (config.some(([key]) => key === "tools")) lines.push(...wrap("Adds to base tools; not a permission boundary."));
			section("config", lines);
		}
		const description = string(args.description);
		if (description !== undefined && (!detailWhole || description.includes("\n"))) section("description", wrap(description, "toolOutput"));
		if (args.prompt !== undefined) section("prompt", wrap(argument(args.prompt), "toolOutput"));
		const footer = metrics(this.result).join(" · ");
		if (footer) {
			if (out.length > 0) out.push(rail(""));
			out.push(...wrap(footer).map(rail));
		}
		if (guide && out.length > 0) out.push(theme.fg("borderMuted", "  ╰─"));
		return out;
	}

	private body(width: number): string[] {
		const text = this.result?.body.split("\n").map(plain).join("\n") ?? "";
		if (!text.trim()) return [this.props.theme.fg("muted", "(no output)")].map((line) => truncateToWidth(line, width, "").replaceAll(ANSI_RESET, ""));
		if (!this.markdown) {
			const theme = this.props.theme;
			this.markdown = new Markdown(text, 0, 0, markdownTheme(theme), { color: (value) => theme.fg("toolOutput", value) });
			this.markdownText = text;
		} else if (this.markdownText !== text) {
			this.markdown.setText(text);
			this.markdownText = text;
		}
		// Markdown handles ordinary wrapping. Guard the terminal even at impossible widths
		// (for example a two-column CJK character in a one-column viewport).
		return this.markdown.render(width).flatMap((line) => wrapTextWithAnsi(line, width))
			.map((line) => truncateToWidth(line, width, "").replaceAll(ANSI_RESET, ""));
	}

	invalidate(): void {
		this.markdown = undefined;
		this.markdownText = "";
	}
}

interface RowState {
	component?: ToolRow;
	resultComponent?: ToolResult;
	hasCall?: boolean;
}

/** The result owns notices/details; result-only consumers additionally get the task header. */
export class ToolResult implements Component {
	private state: RowState;

	constructor(state: RowState) {
		this.state = state;
	}

	render(width: number): string[] {
		return this.state.component?.renderResult(width, !this.state.hasCall) ?? [];
	}

	invalidate(): void {
		this.state.component?.invalidate();
	}
}

function markdownTheme(theme: RowTheme): MarkdownTheme {
	return {
		heading: (text) => theme.fg("mdHeading", text), link: (text) => theme.fg("mdLink", text),
		linkUrl: (text) => theme.fg("mdLinkUrl", text), code: (text) => theme.fg("mdCode", text),
		codeBlock: (text) => theme.fg("mdCodeBlock", text), codeBlockBorder: (text) => theme.fg("mdCodeBlockBorder", text),
		quote: (text) => theme.fg("mdQuote", text), quoteBorder: (text) => theme.fg("mdQuoteBorder", text),
		hr: (text) => theme.fg("mdHr", text), listBullet: (text) => theme.fg("mdListBullet", text),
		bold: (text) => theme.bold(text), italic: (text) => theme.italic?.(text) ?? text,
		underline: (text) => theme.underline?.(text) ?? text, strikethrough: (text) => theme.strikethrough?.(text) ?? text,
	};
}

export function toolRow(
	context: ToolRowContext,
	theme: RowTheme,
	text: { label: string; detail: string },
): Component {
	const state = context.state as RowState;
	const props = { ...text, theme, args: context.args, expanded: context.expanded, outputPad: context.outputPad };
	const row = state.component ?? new ToolRow(props);
	state.component = row;
	state.hasCall = true;
	row.update(props);
	return row;
}

export function toolResult(
	result: { content: Array<{ type: string; text?: string }>; details?: unknown },
	options: { expanded: boolean; isPartial?: boolean },
	theme: RowTheme,
	context: Partial<ToolRowContext> & { state: Record<string, unknown> },
): Component {
	const state = context.state as RowState;
	const row = state.component ?? new ToolRow({ label: "agent", detail: string(record(context.args).description) ?? "",
		theme, args: context.args, expanded: options.expanded, outputPad: context.outputPad });
	state.component = row;
	row.updateResult(resultView(result, context, options.isPartial ?? context.isPartial ?? false), theme, { ...context, expanded: options.expanded });
	const component = state.resultComponent ?? new ToolResult(state);
	state.resultComponent = component;
	return component;
}
