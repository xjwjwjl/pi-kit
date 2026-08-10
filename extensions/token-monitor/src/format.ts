import os from "node:os";
import path from "node:path";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { MetricTotals, TimeRange } from "./types.ts";

export function formatCount(value: number): string {
	if (!Number.isFinite(value) || value <= 0) return "0";
	if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (value >= 10_000) return `${(value / 1_000).toFixed(1)}K`;
	return Math.round(value).toLocaleString("en-US");
}

export function formatCost(value: number): string {
	if (!Number.isFinite(value) || value <= 0) return "$0.00";
	if (value >= 1) return `$${value.toFixed(2)}`;
	if (value >= 0.1) return `$${value.toFixed(3)}`;
	return `$${value.toFixed(4)}`;
}

export function formatDateTime(timestampMs: number): string {
	const date = new Date(timestampMs);
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function formatRangeDate(timestampMs: number): string {
	const date = new Date(timestampMs);
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatRange(range: TimeRange): string {
	if (range.preset !== "custom") return range.label;
	return `${formatRangeDate(range.startMs)} - ${formatRangeDate(range.endMs)}`;
}

export function formatPath(value: string, maxWidth = 34): string {
	const home = os.homedir();
	let display = value;
	if (display === home) display = "~";
	else if (display.startsWith(`${home}${path.sep}`)) display = `~${display.slice(home.length)}`;
	if (display.length <= maxWidth) return display;

	const parts = display.split(/[\\/]+/).filter(Boolean);
	if (parts.length <= 2) return truncateToWidth(display, maxWidth, "...");
	const prefix = display.startsWith("~") ? "~" : parts[0] ?? "";
	for (let count = parts.length - 1; count >= 1; count--) {
		const candidate = `${prefix}/.../${parts.slice(parts.length - count).join("/")}`;
		if (visibleWidth(candidate) <= maxWidth || count === 1) return truncateToWidth(candidate, maxWidth, "...");
	}
	return truncateToWidth(display, maxWidth, "...");
}

export function padRight(value: string, width: number): string {
	const clipped = truncateToWidth(value, Math.max(1, width), "");
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

export function padLeft(value: string, width: number): string {
	const clipped = truncateToWidth(value, Math.max(1, width), "");
	return " ".repeat(Math.max(0, width - visibleWidth(clipped))) + clipped;
}

export function padLine(value: string, width: number): string {
	return padRight(truncateToWidth(value, Math.max(1, width), ""), width);
}

export function formatTotalsSummary(totals: MetricTotals): string {
	return `${formatCount(totals.tokens)} tokens | ${formatCost(totals.cost)} | ${formatCount(totals.requests)} requests`;
}

export function averageTokens(totals: MetricTotals): string {
	return totals.requests > 0 ? formatCount(totals.tokens / totals.requests) : "0";
}

export function share(value: number, total: number): string {
	if (total <= 0 || value <= 0) return "0%";
	const percent = (value / total) * 100;
	return percent >= 10 ? `${Math.round(percent)}%` : `${percent.toFixed(1)}%`;
}

export function bar(value: number, total: number, width: number): string {
	const length = total > 0 ? Math.round((value / total) * width) : 0;
	return "#".repeat(Math.max(0, Math.min(width, length))) + " ".repeat(Math.max(0, width - length));
}

export function stopLabel(stopReason: string | undefined): string {
	return stopReason && stopReason.trim() ? stopReason : "unknown";
}
