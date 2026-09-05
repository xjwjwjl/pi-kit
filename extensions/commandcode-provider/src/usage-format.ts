import type { Theme } from "@earendil-works/pi-coding-agent";
import type { LocalScanResult } from "./local-scan.ts";
import type {
    CommandCodeUsageData,
    CommandCodeUsageResult,
    TimeRange,
    UsageWindow,
    WindowStats,
} from "./usage-types.ts";

const BAR_WIDTH = 20;
const MODEL_COLUMN_WIDTH = 40;

type StatusColor = "accent" | "text" | "dim" | "muted" | "success" | "warning" | "error";

function styled(theme: Theme | undefined, color: StatusColor, text: string): string {
    return theme ? theme.fg(color, text) : text;
}

export function formatLoadingNotice(theme?: Theme): string {
    const label = theme?.bold ? theme.bold("Command Code usage") : "Command Code usage";
    return `${styled(theme, "dim", "Fetching")} ${styled(theme, "accent", label)}${styled(theme, "dim", "...")}`;
}

export function formatCommandCodeUsage(
    result: CommandCodeUsageResult,
    now: Date = new Date(),
    theme?: Theme,
    scan?: LocalScanResult | null,
): string[] {
    if (!result.usage) {
        return [
            `${styled(theme, "accent", theme?.bold("Command Code Usage") ?? "Command Code Usage")}  ${styled(theme, "warning", "UNAVAILABLE")}`,
            styled(theme, "text", result.error ?? (result.status === "cancelled" ? "Request cancelled." : "Usage data unavailable.")),
        ];
    }

    const data = result.usage;
    const lines = [
        `${styled(theme, "accent", theme?.bold("Command Code Usage") ?? "Command Code Usage")} · ${styled(theme, "dim", `${formatPlan(data)} Plan`)} · ${statusColor(data.subscription?.status, theme)}`,
        styled(theme, "dim", "─".repeat(56)),
    ].concat(formatMonthlyCycle(data, theme));

    lines.push("", ...formatWindowBlock("5-hour", data.credits?.windowLimits?.fiveHour, scan?.fiveHour.range ?? null, scan?.fiveHour.stats ?? null, now, theme));
    lines.push("", ...formatWindowBlock("Weekly", data.credits?.windowLimits?.weekly, scan?.weekly.range ?? null, scan?.weekly.stats ?? null, now, theme));

    if (data.errors.length > 0) {
        lines.push("", styled(theme, "accent", "Partial data"));
        for (const error of data.errors) {
            lines.push(`  ${styled(theme, "dim", error.section.padEnd(13))} ${styled(theme, "warning", error.message)}`);
        }
    }

    return lines;
}

function formatPlan(data: CommandCodeUsageData): string {
    const planId = data.subscription?.planId;
    if (!planId) return "Unknown plan";
    return planId
        .replace(/^individual[-_]?/i, "")
        .replace(/^teams?[-_]?/i, "Teams ")
        .split(/[-_]/g)
        .filter(Boolean)
        .map((part) => {
            const normalized = part.toLowerCase();
            if (normalized === "goat") return "GOAT";
            if (normalized === "v1") return "V1";
            return `${normalized[0]!.toUpperCase()}${normalized.slice(1)}`;
        })
        .join(" ");
}

function statusColor(status: string | undefined, theme?: Theme): string {
    const value = (status ?? "active").toLowerCase();
    const color: StatusColor = value === "active" ? "success" : "warning";
    return styled(theme, color, status ?? "active");
}

function metric(label: string, value: string, theme?: Theme): string {
    return `${styled(theme, "dim", label)} ${styled(theme, "text", value)}`;
}

function formatMonthlyCycle(data: CommandCodeUsageData, theme?: Theme): string[] {
    const left = data.credits?.credits.monthlyCredits ?? 0;
    const spent = data.summary?.totalMonthlyCredits ?? 0;
    const total = left + spent;
    const percent = total > 0 ? Math.round((left / total) * 100) : null;
    const meter = renderBar(percent, theme);
    const color = remainingColor(percent);
    const pct = percent === null ? styled(theme, "dim", "unknown") : styled(theme, color, `${percent}%`);
    const cycle = [
        `${styled(theme, "accent", "Billing".padEnd(7))}  ${meter}  ${pct}`,
    ];
    if (data.summary) {
        cycle.push(`    ${formatTokenLine({ total: data.summary.totalTokens, input: data.summary.totalTokensIn, output: data.summary.totalTokensOut }, theme)}`);
        cycle.push(`    ${metric("requests", formatNumber(data.summary.totalCount), theme)}   ${metric("completed", formatNumber(data.summary.completedCount), theme)}   ${metric("failed", formatNumber(data.summary.failedCount), theme)}`);
    }
    return cycle;
}

function formatWindowBlock(label: string, window: UsageWindow | null | undefined, range: TimeRange | null, stats: WindowStats | null, now: Date, theme?: Theme): string[] {
    const lines: string[] = [];
    if (!window) {
        lines.push(`  ${styled(theme, "dim", label.padEnd(12))} ${styled(theme, "warning", "unavailable")}`);
        return lines;
    }

    const usedPct = percentage(window.used, window.cap);
    const percent = usedPct === null ? null : Math.max(0, 100 - usedPct);
    const meter = renderBar(percent, theme);
    const color = remainingColor(percent);
    const reset = formatResetAt(window.resetAt, now);
    const pct = percent === null ? styled(theme, "dim", "unknown") : styled(theme, color, `${percent}%`);
    const heading = `${styled(theme, "accent", label.padEnd(7))}  ${meter}  ${pct} ${styled(theme, "dim", `· resets in ${reset}`)}`;
    lines.push(heading);

    if (range) lines.push(`    ${styled(theme, "dim", `period ${formatRange(range, now)}`)}`);
    if (stats) {
        lines.push(`    ${formatTokenLine({ total: stats.totalTokens, input: stats.input, output: stats.output, cacheRead: stats.cacheRead, cacheWrite: stats.cacheWrite }, theme)}`);
        lines.push(...formatModelLines(stats, theme));
    }
    return lines;
}

interface TokenLineValues {
    total: number | undefined;
    input: number | undefined;
    output: number | undefined;
    cacheRead?: number | undefined;
    cacheWrite?: number | undefined;
}

/** Render a `total  in  out [cacheRead  cacheWrite]` metric row using K/M abbreviations. */
function formatTokenLine(values: TokenLineValues, theme?: Theme): string {
    const parts = [
        metric("total", fmtNum(numOf(values.total)), theme),
        metric("in", fmtNum(numOf(values.input)), theme),
        metric("out", fmtNum(numOf(values.output)), theme),
    ];
    if (typeof values.cacheRead === "number") parts.push(metric("cacheRead", fmtNum(values.cacheRead), theme));
    if (typeof values.cacheWrite === "number") parts.push(metric("cacheWrite", fmtNum(values.cacheWrite), theme));
    return parts.join("   ");
}

function numOf(value: number | undefined): number {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function formatRange(range: TimeRange, now: Date): string {
    return `${formatClock(range.start, now)} → ${formatClock(range.end, now)}`;
}

function percentage(used?: number, cap?: number): number | null {
    if (typeof used !== "number" || typeof cap !== "number" || !Number.isFinite(used) || !Number.isFinite(cap) || cap <= 0) return null;
    return Math.max(0, Math.min(100, Math.round((used / cap) * 100)));
}

/** Threshold on *remaining* percentage: little left = red, plenty = green. */
function remainingColor(percent: number | null): StatusColor {
    if (percent === null) return "dim";
    if (percent <= 10) return "error";
    if (percent <= 50) return "warning";
    return "success";
}

function renderBar(percent: number | null, theme?: Theme): string {
    if (percent === null) return styled(theme, "dim", "░".repeat(BAR_WIDTH));
    const filled = Math.round((percent / 100) * BAR_WIDTH);
    return styled(theme, remainingColor(percent), "█".repeat(filled)) + styled(theme, "dim", "░".repeat(BAR_WIDTH - filled));
}

function formatResetAt(value: number | undefined, now: Date): string {
    const resetAt = toDate(value);
    if (!resetAt) return "-";

    const diffMs = resetAt.getTime() - now.getTime();
    if (diffMs <= 0) return "now";
    return formatDuration(diffMs);
}

function toDate(value: number | undefined): Date | null {
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    const milliseconds = value < 1_000_000_000_000 ? value * 1_000 : value;
    const date = new Date(milliseconds);
    return Number.isFinite(date.getTime()) ? date : null;
}

function formatDuration(milliseconds: number): string {
    const minutes = Math.max(1, Math.ceil(milliseconds / 60_000));
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    if (hours >= 24) {
        const days = Math.floor(hours / 24);
        const remainingHours = hours % 24;
        return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`;
    }
    if (hours > 0) return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
    return `${minutes}m`;
}

function formatClock(date: Date, reference: Date): string {
    const sameYear = date.getFullYear() === reference.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const hour = String(date.getHours()).padStart(2, "0");
    const minute = String(date.getMinutes()).padStart(2, "0");
    return sameYear ? `${month}-${day} ${hour}:${minute}` : `${date.getFullYear()}-${month}-${day} ${hour}:${minute}`;
}

function formatNumber(value?: number): string {
    return typeof value === "number" && Number.isFinite(value) ? Math.round(value).toLocaleString("en-US") : "-";
}

function fmtNum(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return `${Math.round(n)}`;
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
        return [`    ${metric("model", model, theme)}   ${metric("total", fmtNum(modelStats.totalTokens), theme)}   ${metric("in", fmtNum(modelStats.input), theme)}   ${metric("out", fmtNum(modelStats.output), theme)}`];
    }
    const rows = entries.map(([model, modelStats]) => ({ model, total: fmtNum(modelStats.totalTokens), input: fmtNum(modelStats.input), output: fmtNum(modelStats.output) }));
    const totalWidth = Math.max(...rows.map((row) => row.total.length));
    const inputWidth = Math.max(...rows.map((row) => row.input.length));
    const outputWidth = Math.max(...rows.map((row) => row.output.length));
    const lines = [`    ${styled(theme, "dim", "models")}`];
    for (const row of rows) {
        const modelCell = styled(theme, "accent", fixedWidth(row.model, MODEL_COLUMN_WIDTH));
        lines.push(`      ${modelCell} ${modelMetric("total", row.total, totalWidth, theme)}   ${modelMetric("in", row.input, inputWidth, theme)}   ${modelMetric("out", row.output, outputWidth, theme)}`);
    }
    return lines;
}
