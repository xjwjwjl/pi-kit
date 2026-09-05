import type { CommandCodeQuotaData, QuotaWindow } from "./quota-types.ts";

export const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

export interface SelectedStatusWindow {
	window: QuotaWindow | null;
	label: string;
}

/** A window is usable for a percentage only when it has a positive cap. */
export function hasQuotaCap(window: QuotaWindow | null | undefined): window is QuotaWindow & { cap: number } {
	return typeof window?.cap === "number" && Number.isFinite(window.cap) && window.cap > 0;
}

/**
 * Choose the status-bar window: prefer the short (5-hour) window, fall back to
 * the weekly window. Both are returned with a display label.
 */
export function selectStatusWindow(quota: CommandCodeQuotaData | null | undefined): SelectedStatusWindow {
	const fiveHour = quota?.fiveHour ?? null;
	const weekly = quota?.weekly ?? null;
	if (hasQuotaCap(fiveHour)) return { window: fiveHour, label: "5h" };
	if (hasQuotaCap(weekly)) return { window: weekly, label: "7d" };
	return { window: null, label: "" };
}

/** Remaining percentage: 100 - used/cap*100, clamped to [0,100]. Null when no usable cap. */
export function remainingPercent(window: QuotaWindow | null | undefined): number | null {
	if (!hasQuotaCap(window)) return null;
	const used = typeof window.used === "number" && Number.isFinite(window.used) ? window.used : 0;
	return clamp(100 - (used / window.cap) * 100, 0, 100);
}

export function windowBoundary(now: number): number {
	return Math.floor(now / REFRESH_INTERVAL_MS) * REFRESH_INTERVAL_MS;
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}
