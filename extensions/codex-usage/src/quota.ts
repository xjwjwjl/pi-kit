import type { UsageResponse, UsageWindow, TimeRange } from "./types.ts";

const DAY_SECONDS = 24 * 60 * 60;

export function classifyRateLimitWindows(rateLimit: UsageResponse["rate_limit"]): {
	fiveHWindow: UsageWindow | null;
	sevenDWindow: UsageWindow | null;
} {
	const windows = [rateLimit?.primary_window, rateLimit?.secondary_window]
		.filter((window): window is UsageWindow => Boolean(window));
	const withDuration = windows.filter((window) =>
		typeof window.limit_window_seconds === "number" && window.limit_window_seconds > 0,
	);

	const shortWindows = withDuration
		.filter((window) => window.limit_window_seconds! < DAY_SECONDS)
		.sort((a, b) => a.limit_window_seconds! - b.limit_window_seconds!);
	const longWindows = withDuration
		.filter((window) => window.limit_window_seconds! >= DAY_SECONDS)
		.sort((a, b) => a.limit_window_seconds! - b.limit_window_seconds!);

	return {
		fiveHWindow: shortWindows[0] ?? null,
		sevenDWindow: longWindows[0] ?? null,
	};
}

export function resolveResetDate(window: UsageWindow | null | undefined, now: Date): Date | null {
	if (!window) return null;
	if (window.reset_at && window.reset_at > 0) return new Date(window.reset_at * 1000);
	if (window.reset_after_seconds && window.reset_after_seconds > 0) {
		return new Date(now.getTime() + window.reset_after_seconds * 1000);
	}
	return null;
}

export function inferWindowRange(window: UsageWindow | null | undefined, now: Date): TimeRange | null {
	if (!window || !window.limit_window_seconds || window.limit_window_seconds <= 0) return null;
	const end = resolveResetDate(window, now);
	if (!end) return null;
	return {
		start: new Date(end.getTime() - window.limit_window_seconds * 1000),
		end,
	};
}

export function remainingPercent(window: UsageWindow | null | undefined): number | null {
	if (!window || typeof window.used_percent !== "number") return null;
	return clamp(100 - window.used_percent, 0, 100);
}

export function formatWindowDuration(window: UsageWindow): string {
	const seconds = window.limit_window_seconds;
	if (!seconds || seconds <= 0) return "window";
	if (seconds % DAY_SECONDS === 0) return `${seconds / DAY_SECONDS}d`;
	if (seconds % 3600 === 0) return `${seconds / 3600}h`;
	if (seconds % 60 === 0) return `${seconds / 60}m`;
	return `${seconds}s`;
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}
