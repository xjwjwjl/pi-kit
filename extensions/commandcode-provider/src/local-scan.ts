import type { CommandCodeUsageData } from "./usage-types.ts";
import { scanSessionsInRanges } from "./session-scanner.ts";
import type { ScanQuality, TimeRange, WindowStats } from "./usage-types.ts";

interface WindowDescriptor {
    range: TimeRange | null;
    stats: WindowStats;
}

export interface LocalScanResult {
    fiveHour: WindowDescriptor;
    weekly: WindowDescriptor;
    quality: ScanQuality;
    scanned: boolean;
}

const FIVE_HOUR_SECONDS = 5 * 60 * 60;
const WEEKLY_SECONDS = 7 * 24 * 60 * 60;

/**
 * Derive the scan time range for an API quota window from its resetAt and an
 * assumed duration. Falls back to null when no resetAt is available so the
 * scanner skips that window rather than spanning the whole history.
 */
function rangeForWindow(resetAtMs: number | undefined, durationSeconds: number): TimeRange | null {
    if (typeof resetAtMs !== "number" || !Number.isFinite(resetAtMs) || resetAtMs <= 0) return null;
    const end = new Date(resetAtMs);
    return {
        start: new Date(end.getTime() - durationSeconds * 1000),
        end,
    };
}

function toResetMs(value: number | undefined): number | undefined {
    if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
    // Command Code may return milliseconds or seconds; normalize seconds to ms.
    return value < 1_000_000_000_000 ? value * 1_000 : value;
}

export async function scanLocalUsage(data: CommandCodeUsageData): Promise<LocalScanResult> {
    const fiveHour = data.credits?.windowLimits?.fiveHour;
    const weekly = data.credits?.windowLimits?.weekly;

    const fiveRange = rangeForWindow(toResetMs(fiveHour?.resetAt), FIVE_HOUR_SECONDS);
    const weeklyRange = rangeForWindow(toResetMs(weekly?.resetAt), WEEKLY_SECONDS);

    const scan = await scanSessionsInRanges([fiveRange, weeklyRange]);
    return {
        fiveHour: { range: fiveRange, stats: scan.stats[0]! },
        weekly: { range: weeklyRange, stats: scan.stats[1]! },
        quality: scan.quality,
        scanned: true,
    };
}
