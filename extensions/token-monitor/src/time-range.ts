import type { RangePreset, TimeRange } from "./types.ts";

const PRESET_SPAN_MS: Record<Exclude<RangePreset, "custom">, number> = {
	"1h": 60 * 60 * 1000,
	"6h": 6 * 60 * 60 * 1000,
	"24h": 24 * 60 * 60 * 1000,
	"7d": 7 * 24 * 60 * 60 * 1000,
	"30d": 30 * 24 * 60 * 60 * 1000,
};

const PRESET_LABELS: Record<Exclude<RangePreset, "custom">, string> = {
	"1h": "Last 1h",
	"6h": "Last 6h",
	"24h": "Last 24h",
	"7d": "Last 7d",
	"30d": "Last 30d",
};

export const RANGE_PRESETS: Exclude<RangePreset, "custom">[] = ["1h", "6h", "24h", "7d", "30d"];

export function rollingRange(preset: Exclude<RangePreset, "custom">, endMs = Date.now()): TimeRange {
	const span = PRESET_SPAN_MS[preset];
	return {
		preset,
		startMs: endMs - span,
		endMs,
		label: PRESET_LABELS[preset],
	};
}

export function customRange(startMs: number, endMs: number): TimeRange {
	if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
		throw new Error("Custom range end must be after its start.");
	}
	return {
		preset: "custom",
		startMs,
		endMs,
		label: "Custom range",
	};
}

export function parseLocalDateTime(value: string): number | undefined {
	const trimmed = value.trim();
	const match = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
	if (!match) return undefined;

	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const hour = Number(match[4] ?? 0);
	const minute = Number(match[5] ?? 0);
	const second = Number(match[6] ?? 0);
	const date = new Date(year, month - 1, day, hour, minute, second, 0);

	if (
		date.getFullYear() !== year ||
		date.getMonth() !== month - 1 ||
		date.getDate() !== day ||
		date.getHours() !== hour ||
		date.getMinutes() !== minute ||
		date.getSeconds() !== second
	) {
		return undefined;
	}
	return date.getTime();
}

export function rangeContains(range: TimeRange, timestampMs: number): boolean {
	return timestampMs >= range.startMs && timestampMs < range.endMs;
}

export function rangeUnit(range: TimeRange): "hour" | "day" {
	return range.endMs - range.startMs <= 48 * 60 * 60 * 1000 ? "hour" : "day";
}
