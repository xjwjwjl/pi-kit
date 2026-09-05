import type {
	SelectedQuotaWindows,
	TimeRange,
	UsageResponse,
	UsageWindow,
} from "./types.ts";

const DAY_SECONDS = 24 * 60 * 60;
export const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

export function selectQuotaWindows(usage: UsageResponse | null | undefined): SelectedQuotaWindows {
	const windows = [usage?.rate_limit?.primary_window, usage?.rate_limit?.secondary_window]
		.filter((window): window is UsageWindow => Boolean(window))
		.filter((window) => typeof window.limit_window_seconds === "number" && window.limit_window_seconds > 0);

	const short = windows
		.filter((window) => window.limit_window_seconds! < DAY_SECONDS)
		.sort((a, b) => a.limit_window_seconds! - b.limit_window_seconds!)[0] ?? null;
	const long = windows
		.filter((window) => window.limit_window_seconds! >= DAY_SECONDS)
		.sort((a, b) => a.limit_window_seconds! - b.limit_window_seconds!)[0] ?? null;

	return { short, long };
}

/** Backward-compatible name for callers that still use the old report terminology. */
export function classifyRateLimitWindows(rateLimit: UsageResponse["rate_limit"]): {
	fiveHWindow: UsageWindow | null;
	sevenDWindow: UsageWindow | null;
} {
	const selected = selectQuotaWindows(rateLimit ? { rate_limit: rateLimit } : null);
	return { fiveHWindow: selected.short, sevenDWindow: selected.long };
}

export function selectStatusWindow(usage: UsageResponse | null | undefined): UsageWindow | null {
	const selected = selectQuotaWindows(usage);
	if (hasUsagePercent(selected.short)) return selected.short;
	if (hasUsagePercent(selected.long)) return selected.long;
	return null;
}

export function hasUsagePercent(window: UsageWindow | null | undefined): window is UsageWindow & { used_percent: number } {
	return typeof window?.used_percent === "number" && Number.isFinite(window.used_percent);
}

export function resolveResetDate(window: UsageWindow | null | undefined, observedAt: Date): Date | null {
	if (!window) return null;
	if (typeof window.reset_at === "number" && Number.isFinite(window.reset_at) && window.reset_at > 0) {
		return new Date(window.reset_at * 1000);
	}
	if (typeof window.reset_after_seconds === "number"
		&& Number.isFinite(window.reset_after_seconds)
		&& window.reset_after_seconds > 0) {
		return new Date(observedAt.getTime() + window.reset_after_seconds * 1000);
	}
	return null;
}

export function inferWindowRange(window: UsageWindow | null | undefined, observedAt: Date): TimeRange | null {
	if (!window || typeof window.limit_window_seconds !== "number" || window.limit_window_seconds <= 0) return null;
	const end = resolveResetDate(window, observedAt);
	if (!end) return null;
	return {
		start: new Date(end.getTime() - window.limit_window_seconds * 1000),
		end,
	};
}

export function remainingPercent(window: UsageWindow | null | undefined): number | null {
	if (!hasUsagePercent(window)) return null;
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

export function windowBoundary(now: number): number {
	return Math.floor(now / REFRESH_INTERVAL_MS) * REFRESH_INTERVAL_MS;
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}
