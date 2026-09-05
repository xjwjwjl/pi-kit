import type { Theme } from "@earendil-works/pi-coding-agent";
import { remainingPercent, resolveResetDate } from "./quota.ts";
import type { TimeRange, UsageViewData, UsageWindow, WindowStats } from "./types.ts";

const MODEL_COLUMN_WIDTH = 16;

export function formatLoadingNotice(theme?: Theme): string {
	const label = theme && typeof theme.bold === "function" ? theme.bold("Codex usage") : "Codex usage";
	return `${styled(theme, "dim", "Fetching")} ${styled(theme, "accent", label)}${styled(theme, "dim", "...")}`;
}

export function formatReport(data: UsageViewData, theme?: Theme): string {
	const title = styled(theme, "accent", theme?.bold("Codex Usage") ?? "Codex Usage");
	const status = data.apiError || data.allowed === null
		? styled(theme, "warning", "unavailable")
		: data.limitReached
			? styled(theme, "warning", "limit reached")
			: !data.allowed
				? styled(theme, "warning", "not allowed")
				: styled(theme, "success", "available");
	const plan = data.plan && data.plan !== "unknown" ? `${data.plan} Plan` : (data.plan || "unknown");
	const separator = styled(theme, "dim", "─".repeat(44));
	const lines = [`${title} · ${styled(theme, "dim", plan)} · ${status}`, separator];
	if (data.apiError) {
		lines.push(styled(theme, "error", `API error: ${data.apiError}`));
		lines.push("");
	}
	const windows: string[][] = [];
	if (data.shortWindow) windows.push(formatWindowBlock(windowLabel(data.shortWindow), data.shortWindow, data.shortRange, data.shortStats, data.observedAt, theme));
	if (data.longWindow) windows.push(formatWindowBlock(windowLabel(data.longWindow), data.longWindow, data.longRange, data.longStats, data.observedAt, theme));
	if (windows.length === 0) lines.push(styled(theme, "dim", "No quota windows available"));
	else lines.push(windows.map((window) => window.join("\n")).join("\n\n"));
	return "\n" + lines.join("\n");
}

function windowLabel(window: UsageWindow): string {
	const seconds = window.limit_window_seconds;
	if (!seconds || seconds <= 0) return "window";
	if (seconds === 5 * 60 * 60) return "5-hour";
	if (seconds === 7 * 24 * 60 * 60) return "Weekly";
	const hours = seconds / 3600;
	if (Number.isInteger(hours) && hours > 0 && hours < 24) return `${hours}-hour`;
	const days = seconds / (24 * 3600);
	if (Number.isInteger(days) && days > 0) return `${days}-day`;
	return `${seconds}s`;
}

function formatWindowBlock(label: string, window: UsageWindow, range: TimeRange | null, stats: WindowStats, observedAt: Date, theme?: Theme): string[] {
	const pct = remainingPercent(window);
	const pctText = pct === null ? "unknown" : `${pct}%`;
	const reset = formatResetAt(window, observedAt);
	const bar = renderBar(pct, 20, theme);
	const pctCell = pct === null ? styled(theme, "dim", "unknown") : styled(theme, remainingColor(pct), pctText);
	const heading = `${styled(theme, "accent", label.padEnd(7))}  ${bar}  ${pctCell} ${styled(theme, "dim", `· resets in ${reset}`)}`;
	const rangeLine = `    ${styled(theme, "dim", `period ${formatRange(range, observedAt)}`)}`;
	const activityLine = `    ${metric("total", `${fmtNum(stats.totalTokens)} tokens`, theme)}   ${metric("cost", fmtCost(stats.cost), theme)}   ${metric("sessions", String(stats.sessions), theme)}`;
	const tokenLine = `    ${metric("input", fmtNum(stats.input), theme)}   ${metric("output", fmtNum(stats.output), theme)}   ${metric("cache read", fmtNum(stats.cacheRead), theme)}   ${metric("cache write", fmtNum(stats.cacheWrite), theme)}`;
	return [heading, rangeLine, activityLine, tokenLine, ...formatModelLines(stats, theme)];
}

function formatResetAt(window: UsageWindow | null | undefined, observedAt: Date): string {
	const resetDate = resolveResetDate(window, observedAt);
	if (!resetDate) return "unavailable";
	const diffMs = resetDate.getTime() - observedAt.getTime();
	return formatRelativeDuration(diffMs);
}

function formatRelativeDuration(diffMs: number): string {
	if (diffMs <= 0) return "now";
	const diffMin = Math.max(1, Math.ceil(diffMs / 60000));
	const hours = Math.floor(diffMin / 60);
	const remainingMinutes = diffMin % 60;
	if (hours >= 24) {
		const days = Math.floor(hours / 24);
		const remainingHours = hours % 24;
		return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`;
	}
	if (hours > 0) return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
	return `${diffMin}m`;
}

function formatClock(date: Date, reference: Date): string {
	const sameYear = date.getFullYear() === reference.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	const hour = String(date.getHours()).padStart(2, "0");
	const minute = String(date.getMinutes()).padStart(2, "0");
	return sameYear ? `${month}-${day} ${hour}:${minute}` : `${date.getFullYear()}-${month}-${day} ${hour}:${minute}`;
}

function formatRange(range: TimeRange | null, observedAt: Date): string {
	if (!range) return "window unavailable";
	return `${formatClock(range.start, observedAt)} → ${formatClock(range.end, observedAt)}`;
}

function fmtNum(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return `${Math.round(n)}`;
}

function fmtCost(n: number): string {
	return n > 0 ? `$${n.toFixed(n < 1 ? 3 : 2)}` : "$0";
}

function fixedWidth(text: string, width: number): string {
	return text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text.padEnd(width, " ");
}

function rightAlign(text: string, width: number): string {
	return text.length >= width ? text : `${" ".repeat(width - text.length)}${text}`;
}

function modelMetric(label: string, value: string, width: number, theme?: Theme): string {
	return `${styled(theme, "dim", label)} ${styled(theme, "text", rightAlign(value, width))}`;
}

function formatModelLines(stats: WindowStats, theme?: Theme): string[] {
	const entries = Object.entries(stats.models).sort((a, b) => b[1].totalTokens - a[1].totalTokens);
	if (entries.length === 0) return [];
	if (entries.length === 1) {
		const [model, modelStats] = entries[0]!;
		return [`    ${metric("model", model, theme)}   ${metric("tokens", fmtNum(modelStats.totalTokens), theme)}   ${metric("in", fmtNum(modelStats.input), theme)}   ${metric("out", fmtNum(modelStats.output), theme)}`];
	}
	const rows = entries.map(([model, modelStats]) => ({ model, total: fmtNum(modelStats.totalTokens), input: fmtNum(modelStats.input), output: fmtNum(modelStats.output), cost: fmtCost(modelStats.cost) }));
	const totalWidth = Math.max(...rows.map((row) => row.total.length));
	const inputWidth = Math.max(...rows.map((row) => row.input.length));
	const outputWidth = Math.max(...rows.map((row) => row.output.length));
	const lines = [`    ${styled(theme, "dim", "models")}`];
	for (const row of rows) {
		const modelCell = styled(theme, "accent", fixedWidth(row.model, MODEL_COLUMN_WIDTH));
		lines.push(`      ${modelCell} ${modelMetric("total", row.total, totalWidth, theme)}   ${modelMetric("in", row.input, inputWidth, theme)}   ${modelMetric("out", row.output, outputWidth, theme)}   ${metric("cost", row.cost, theme)}`);
	}
	return lines;
}

function metric(label: string, value: string, theme?: Theme): string {
	return `${styled(theme, "dim", label)} ${styled(theme, "text", value)}`;
}

function remainingColor(percent: number): string {
	return percent < 10 ? "error" : percent <= 50 ? "warning" : "success";
}

function renderBar(percent: number | null, width: number, theme?: Theme): string {
	if (percent === null) return styled(theme, "dim", "░".repeat(width));
	const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)));
	const color = remainingColor(percent);
	return styled(theme, color, "█".repeat(filled)) + styled(theme, "dim", "░".repeat(width - filled));
}

function styled(theme: Theme | undefined, color: string, text: string): string {
	return theme ? theme.fg(color as any, text) : text;
}
