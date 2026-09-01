import type { Theme } from "@earendil-works/pi-coding-agent";
import { formatWindowDuration, remainingPercent, resolveResetDate } from "./quota.ts";
import type {
	ScanQuality,
	TimeRange,
	UsageViewData,
	UsageWindow,
	WindowStats,
} from "./types.ts";

const MODEL_COLUMN_WIDTH = 16;

export function formatLoadingNotice(theme?: Theme): string {
	const label = theme && typeof theme.bold === "function" ? theme.bold("Codex usage") : "Codex usage";
	return `${styled(theme, "dim", "Fetching")} ${styled(theme, "accent", label)}${styled(theme, "dim", "...")}`;
}

function formatScanQuality(quality: ScanQuality, theme?: Theme): string {
	const parts = [
		`scan ${quality.parsedFiles}/${quality.totalFiles} files`,
		`${quality.skippedFiles} skipped`,
	];
	if (quality.malformedLines > 0) parts.push(`${quality.malformedLines} malformed`);
	if (quality.duplicateEntries > 0) parts.push(`${quality.duplicateEntries} deduped`);
	return styled(theme, "dim", parts.join(" · "));
}

export function formatReport(data: UsageViewData, theme?: Theme): string {
	const title = styled(theme, "accent", theme?.bold("Codex Usage") ?? "Codex Usage");
	const status = data.apiError || data.allowed === null
		? styled(theme, "warning", "UNAVAILABLE")
		: data.limitReached
			? styled(theme, "error", "LIMIT REACHED")
			: !data.allowed
				? styled(theme, "warning", "NOT ALLOWED")
				: styled(theme, "success", "AVAILABLE");
	const separator = styled(theme, "dim", "─".repeat(44));

	const lines = [
		`${title}  ${status}  ${styled(theme, "accent", data.plan)}`,
		data.email,
		separator,
	];
	if (data.apiError) {
		lines.push(styled(theme, "error", `API error: ${data.apiError}`));
		lines.push("");
	}
	lines.push(formatScanQuality(data.scanQuality, theme));
	const windows: string[][] = [];
	if (data.fiveHWindow) {
		windows.push(formatWindowBlock(formatWindowDuration(data.fiveHWindow), data.fiveHWindow, data.fiveHRange, data.fiveH, data.now, theme));
	}
	if (data.sevenDWindow) {
		windows.push(formatWindowBlock(formatWindowDuration(data.sevenDWindow), data.sevenDWindow, data.sevenDRange, data.sevenD, data.now, theme));
	}

	if (windows.length === 0) {
		lines.push(styled(theme, "dim", "No quota windows available"));
	} else {
		lines.push(windows.map((window) => window.join("\n")).join("\n\n"));
	}
	return "\n" + lines.join("\n");
}

function formatWindowBlock(
	label: string,
	window: UsageWindow,
	range: TimeRange | null,
	stats: WindowStats,
	now: Date,
	theme?: Theme,
): string[] {
	const pct = remainingPercent(window);
	const pctText = pct === null ? "unknown" : `${pct}%`;
	const reset = formatResetAt(window, now);
	const bar = renderBar(pct, 20, theme);
	const heading = `${styled(theme, "accent", label)}  ${bar}  ${metric("quota", pctText, theme)}  ${styled(theme, "dim", `reset ${reset}`)}`;
	const rangeLine = `    ${styled(theme, "dim", `period ${formatRange(range, now)}`)}`;
	const activityLine = `    ${metric("total", `${fmtNum(stats.totalTokens)} tokens`, theme)}   ${metric("cost", fmtCost(stats.cost), theme)}   ${metric("sessions", String(stats.sessions), theme)}`;
	const tokenLine = `    ${metric("input", fmtNum(stats.input), theme)}   ${metric("output", fmtNum(stats.output), theme)}   ${metric("cache read", fmtNum(stats.cacheRead), theme)}   ${metric("cache write", fmtNum(stats.cacheWrite), theme)}`;

	return [
		heading,
		rangeLine,
		activityLine,
		tokenLine,
		...formatModelLines(stats, theme),
	];
}

function formatResetAt(window: UsageWindow | null | undefined, now: Date): string {
	if (!window) return "-";
	const resetDate = resolveResetDate(window, now);
	if (!resetDate) return "-";
	const diffMs = resetDate.getTime() - now.getTime();
	const relative = formatRelativeDuration(diffMs);
	const absolute = formatClock(resetDate, now);
	return `${relative} (${absolute})`;
}

function formatRelativeDuration(diffMs: number): string {
	if (diffMs <= 0) return "now";
	const diffMin = Math.round(diffMs / 60000);
	if (diffMin < 60) return `${diffMin}m`;
	const diffHr = Math.floor(diffMin / 60);
	const rmMin = diffMin % 60;
	if (diffHr < 24) return rmMin > 0 ? `${diffHr}h${rmMin}m` : `${diffHr}h`;
	const days = Math.floor(diffHr / 24);
	const hours = diffHr % 24;
	return hours > 0 ? `${days}d${hours}h` : `${days}d`;
}

function formatClock(date: Date, now: Date): string {
	const sameYear = date.getFullYear() === now.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	const hour = String(date.getHours()).padStart(2, "0");
	const minute = String(date.getMinutes()).padStart(2, "0");
	return sameYear
		? `${month}-${day} ${hour}:${minute}`
		: `${date.getFullYear()}-${month}-${day} ${hour}:${minute}`;
}

function formatRange(range: TimeRange | null, now: Date): string {
	if (!range) return "window unavailable";
	return `${formatClock(range.start, now)} → ${formatClock(range.end, now)}`;
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
	if (text.length > width) {
		return `${text.slice(0, Math.max(0, width - 1))}…`;
	}
	return text.padEnd(width, " ");
}

function rightAlign(text: string, width: number): string {
	return text.length >= width ? text : `${" ".repeat(width - text.length)}${text}`;
}

function modelMetric(label: string, value: string, width: number, theme?: Theme): string {
	return `${styled(theme, "dim", label)} ${styled(theme, "text", rightAlign(value, width))}`;
}

function formatModelLines(stats: WindowStats, theme?: Theme): string[] {
	const entries = Object.entries(stats.models)
		.sort((a, b) => b[1].totalTokens - a[1].totalTokens);
	if (entries.length === 0) return [];
	if (entries.length === 1) {
		const [model, modelStats] = entries[0]!;
		return [
			`    ${metric("model", model, theme)}   ${metric("tokens", fmtNum(modelStats.totalTokens), theme)}   ${metric("in", fmtNum(modelStats.input), theme)}   ${metric("out", fmtNum(modelStats.output), theme)}`,
		];
	}

	const rows = entries.map(([model, modelStats]) => ({
		model,
		total: fmtNum(modelStats.totalTokens),
		input: fmtNum(modelStats.input),
		output: fmtNum(modelStats.output),
		cost: fmtCost(modelStats.cost),
	}));

	const totalWidth = Math.max(...rows.map((r) => r.total.length));
	const inputWidth = Math.max(...rows.map((r) => r.input.length));
	const outputWidth = Math.max(...rows.map((r) => r.output.length));
	const lines = [`    ${styled(theme, "dim", "models")}`];
	for (const row of rows) {
		const modelCell = styled(theme, "accent", fixedWidth(row.model, MODEL_COLUMN_WIDTH));
		lines.push(
			`      ${modelCell} ${modelMetric("total", row.total, totalWidth, theme)}   ${modelMetric("in", row.input, inputWidth, theme)}   ${modelMetric("out", row.output, outputWidth, theme)}   ${metric("cost", row.cost, theme)}`,
		);
	}
	return lines;
}

function metric(label: string, value: string, theme?: Theme): string {
	return `${styled(theme, "dim", label)} ${styled(theme, "text", value)}`;
}

function renderBar(percent: number | null, width: number, theme?: Theme): string {
	if (percent === null) return styled(theme, "dim", "░".repeat(width));
	const filled = clamp(Math.round((percent / 100) * width), 0, width);
	const empty = width - filled;
	const color = percent < 10 ? "error" : percent <= 50 ? "warning" : "success";
	return styled(theme, color, "█".repeat(filled)) + styled(theme, "dim", "░".repeat(empty));
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

function styled(theme: Theme | undefined, color: string, text: string): string {
	return theme ? theme.fg(color as any, text) : text;
}
