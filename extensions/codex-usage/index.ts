/**
 * Codex Usage Extension
 *
 * Registers /codex-usage command to check ChatGPT/Codex account usage.
 * - Reads the openai-codex access token from pi's ~/.pi/agent/auth.json
 * - Calls /backend-api/wham/usage for official rate limit info
 * - Scans pi sessions to aggregate token usage inside the official 5h / 7d
 *   windows inferred from reset_at/reset_after_seconds + limit_window_seconds
 * - Renders a lightweight themed message block
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { spawn } from "node:child_process";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface UsageWindow {
	used_percent?: number;
	limit?: number;
	remaining?: number;
	used?: number;
	limit_window_seconds?: number;
	reset_after_seconds?: number;
	reset_at?: number;
}

interface UsageResponse {
	email?: string;
	plan_type?: string;
	rate_limit?: {
		allowed?: boolean;
		limit_reached?: boolean;
		primary_window?: UsageWindow | null;
		secondary_window?: UsageWindow | null;
	};
}

interface ModelStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
}

interface WindowStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
	sessions: number;
	models: Record<string, ModelStats>;
}

interface TimeRange {
	start: Date;
	end: Date;
}

interface UsageViewData {
	email: string;
	plan: string;
	allowed: boolean;
	limitReached: boolean;
	apiError?: string;
	primary: UsageWindow | null;
	secondary: UsageWindow | null;
	primaryRange: TimeRange | null;
	secondaryRange: TimeRange | null;
	fiveH: WindowStats;
	sevenD: WindowStats;
	now: Date;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const USAGE_API = "https://chatgpt.com/backend-api/wham/usage";

const AUTH_PATH = path.join(
	process.env.HOME || process.env.USERPROFILE || "",
	".pi",
	"agent",
	"auth.json",
);
const SESSIONS_DIR = path.join(
	process.env.HOME || process.env.USERPROFILE || "",
	".pi",
	"agent",
	"sessions",
);
const MODEL_COLUMN_WIDTH = 16;

// ---------------------------------------------------------------------------
// Token loading
// ---------------------------------------------------------------------------

function loadAccessToken(): string | null {
	if (!fs.existsSync(AUTH_PATH)) return null;
	try {
		const raw = fs.readFileSync(AUTH_PATH, "utf-8");
		const doc = JSON.parse(raw);
		return doc?.["openai-codex"]?.access || null;
	} catch {
		return null;
	}
}

function extractEmailFromJWT(token: string): string {
	try {
		const parts = token.split(".");
		if (parts.length < 2) return "";
		const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8"));
		return payload?.["https://api.openai.com/profile"]?.email
			|| payload?.email
			|| "";
	} catch {
		return "";
	}
}

// ---------------------------------------------------------------------------
// Usage API
// ---------------------------------------------------------------------------

async function fetchUsage(accessToken: string): Promise<UsageResponse> {
	// Node fetch/undici does not honor http_proxy/https_proxy by default.
	// Use curl, which works with the user's proxy environment. Feed config via stdin
	// so the bearer token is not exposed in process arguments.
	const body = await curlGet(USAGE_API, accessToken);
	return JSON.parse(body) as UsageResponse;
}

function curlEscape(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

function curlGet(url: string, accessToken: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn("curl", ["-sS", "--fail-with-body", "-K", "-"], { windowsHide: true });
		let stdout = "";
		let stderr = "";

		child.stdout.setEncoding("utf-8");
		child.stderr.setEncoding("utf-8");
		child.stdout.on("data", (chunk) => { stdout += chunk; });
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		child.on("error", reject);
		child.on("close", (code) => {
			if (code !== 0) {
				reject(new Error(`curl exit ${code}: ${stderr.trim() || stdout.slice(0, 160).trim()}`));
				return;
			}
			resolve(stdout);
		});

		child.stdin.end([
			`url = "${curlEscape(url)}"`,
			`request = "GET"`,
			`header = "Authorization: Bearer ${curlEscape(accessToken)}"`,
			`header = "Accept: application/json"`,
			`connect-timeout = 10`,
			`max-time = 20`,
			"",
		].join("\n"));
	});
}

// ---------------------------------------------------------------------------
// Session scanning — aggregates tokens within an explicit official time range
// ---------------------------------------------------------------------------

function emptyStats(): WindowStats {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: 0,
		sessions: 0,
		models: {},
	};
}

function ensureModelStats(stats: WindowStats, model: string): ModelStats {
	const key = model || "unknown";
	if (!stats.models[key]) {
		stats.models[key] = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: 0,
		};
	}
	return stats.models[key]!;
}

function messageTimestampMs(obj: any): number | null {
	const raw = obj?.message?.timestamp ?? obj?.timestamp;
	if (typeof raw === "number" && Number.isFinite(raw)) return raw;
	if (typeof raw === "string") {
		const parsed = Date.parse(raw);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
}

function resolveResetDate(window: UsageWindow | null | undefined, now: Date): Date | null {
	if (!window) return null;
	if (window.reset_at && window.reset_at > 0) return new Date(window.reset_at * 1000);
	if (window.reset_after_seconds && window.reset_after_seconds > 0) {
		return new Date(now.getTime() + window.reset_after_seconds * 1000);
	}
	return null;
}

function inferWindowRange(window: UsageWindow | null | undefined, now: Date): TimeRange | null {
	if (!window || !window.limit_window_seconds || window.limit_window_seconds <= 0) return null;
	const end = resolveResetDate(window, now);
	if (!end) return null;
	return {
		start: new Date(end.getTime() - window.limit_window_seconds * 1000),
		end,
	};
}

async function scanSessionsInRange(range: TimeRange): Promise<WindowStats> {
	const result = emptyStats();
	if (!fs.existsSync(SESSIONS_DIR)) return result;

	const startMs = range.start.getTime();
	const endMs = range.end.getTime();
	const subdirs = fs.readdirSync(SESSIONS_DIR).filter((name) => {
		try { return fs.statSync(path.join(SESSIONS_DIR, name)).isDirectory(); }
		catch { return false; }
	});

	for (const subdir of subdirs) {
		const subdirPath = path.join(SESSIONS_DIR, subdir);
		let files: string[];
		try { files = fs.readdirSync(subdirPath).filter((f) => f.endsWith(".jsonl")); }
		catch { continue; }

		for (const file of files) {
			const filePath = path.join(subdirPath, file);
			try {
				// Safe prefilter: if the file was not modified after the start of the range,
				// it cannot contain messages inside this official window.
				if (fs.statSync(filePath).mtimeMs < startMs) continue;
			} catch {
				continue;
			}

			let inWindow = false;
			try {
				const stream = fs.createReadStream(filePath, { encoding: "utf-8" });
				const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

				for await (const line of rl) {
					const trimmed = line.trim();
					if (!trimmed) continue;

					let obj: any;
					try { obj = JSON.parse(trimmed); } catch { continue; }

					if (obj.type !== "message") continue;
					const msg = obj.message;
					if (msg?.role !== "assistant" || msg?.provider !== "openai-codex") continue;

					const ts = messageTimestampMs(obj);
					if (ts === null || ts < startMs || ts >= endMs) continue;

					const usage = msg.usage;
					if (!usage) continue;

					inWindow = true;
					result.input += usage.input || 0;
					result.output += usage.output || 0;
					result.cacheRead += usage.cacheRead || 0;
					result.cacheWrite += usage.cacheWrite || 0;
					result.totalTokens += usage.totalTokens || 0;
					result.cost += usage.cost?.total || 0;

					const modelStats = ensureModelStats(result, String(msg?.model || "unknown"));
					modelStats.input += usage.input || 0;
					modelStats.output += usage.output || 0;
					modelStats.cacheRead += usage.cacheRead || 0;
					modelStats.cacheWrite += usage.cacheWrite || 0;
					modelStats.totalTokens += usage.totalTokens || 0;
					modelStats.cost += usage.cost?.total || 0;
				}
			} catch {
				continue;
			}

			if (inWindow) result.sessions++;
		}
	}

	return result;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function usedPercent(window: UsageWindow | null | undefined): number | null {
	if (!window) return null;
	if (typeof window.used_percent === "number") return clamp(window.used_percent, 0, 100);
	if (window.limit && window.limit > 0) {
		const used = window.used ?? (window.limit - (window.remaining ?? 0));
		return clamp(Math.round((used / window.limit) * 100), 0, 100);
	}
	return null;
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
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

function formatLoadingNotice(theme?: Theme): string {
	const label = theme && typeof theme.bold === "function" ? theme.bold("Codex usage") : "Codex usage";
	return `${styled(theme, "dim", "Fetching")} ${styled(theme, "accent", label)}${styled(theme, "dim", "...")}`;
}

function formatReport(data: UsageViewData, theme?: Theme): string {
	const title = styled(theme, "accent", theme?.bold("Codex Usage") ?? "Codex Usage");
	const status = data.limitReached
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
	lines.push(...formatWindowBlock("5h", data.primary, data.primaryRange, data.fiveH, data.now, theme));
	lines.push("");
	lines.push(...formatWindowBlock("7d", data.secondary, data.secondaryRange, data.sevenD, data.now, theme));
	return "\n" + lines.join("\n");
}

function formatWindowBlock(
	label: "5h" | "7d",
	window: UsageWindow | null,
	range: TimeRange | null,
	stats: WindowStats,
	now: Date,
	theme?: Theme,
): string[] {
	const pct = usedPercent(window);
	const pctText = pct === null ? "unknown" : `${pct}% used`;
	const reset = formatResetAt(window, now);
	const bar = renderBar(pct, 20, theme);
	const heading = `${styled(theme, "accent", label)}  ${bar}  ${pctText.padEnd(8)}  ${styled(theme, "dim", `reset ${reset}`)}`;
	const rangeLine = `    ${styled(theme, "dim", `window ${formatRange(range, now)}`)}`;

	if (stats.totalTokens === 0) {
		return [
			heading,
			rangeLine,
			`    ${styled(theme, "dim", "No recorded pi activity in this window")}`,
			`    ${metric("input", "0", theme)}   ${metric("output", "0", theme)}   ${metric("total", "0", theme)}`,
		];
	}

	return [
		heading,
		rangeLine,
		`    ${metric("input", fmtNum(stats.input), theme)}   ${metric("output", fmtNum(stats.output), theme)}   ${metric("total", fmtNum(stats.totalTokens), theme)}`,
		`    ${metric("cache", `${fmtNum(stats.cacheRead)}/${fmtNum(stats.cacheWrite)}`, theme)}   ${metric("cost", fmtCost(stats.cost), theme)}   ${metric("sessions", String(stats.sessions), theme)}`,
		...formatModelLines(stats, theme),
	];
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
	const color = percent >= 90 ? "error" : percent >= 70 ? "warning" : "success";
	return styled(theme, color, "█".repeat(filled)) + styled(theme, "dim", "░".repeat(empty));
}

function styled(theme: Theme | undefined, color: string, text: string): string {
	return theme ? theme.fg(color as any, text) : text;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function codexUsageExtension(pi: ExtensionAPI) {
	pi.registerCommand("codex-usage", {
		description: "Check ChatGPT/Codex account usage (rate limits & token stats)",
		handler: async (_args, ctx) => {
			const accessToken = loadAccessToken();
			if (!accessToken) {
				ctx.ui.notify("No openai-codex token found in ~/.pi/agent/auth.json", "error");
				return;
			}

			ctx.ui.notify(formatLoadingNotice(ctx.hasUI ? ctx.ui.theme : undefined), "info");

			let usageResult!: { ok: true; usage: UsageResponse } | { ok: false; error: string };
			let observedAt = new Date();
			let primaryRange: TimeRange | null = null;
			let secondaryRange: TimeRange | null = null;
			let fiveH = emptyStats();
			let sevenD = emptyStats();

			usageResult = await fetchUsage(accessToken)
				.then((usage) => ({ ok: true as const, usage }))
				.catch((error) => ({ ok: false as const, error: String(error) }));

			observedAt = new Date();

			if (usageResult.ok) {
				primaryRange = inferWindowRange(usageResult.usage.rate_limit?.primary_window ?? null, observedAt);
				secondaryRange = inferWindowRange(usageResult.usage.rate_limit?.secondary_window ?? null, observedAt);

				[fiveH, sevenD] = await Promise.all([
					primaryRange ? scanSessionsInRange(primaryRange) : Promise.resolve(emptyStats()),
					secondaryRange ? scanSessionsInRange(secondaryRange) : Promise.resolve(emptyStats()),
				]);
			}

			const usage = usageResult.ok ? usageResult.usage : null;
			const data: UsageViewData = {
				email: usage?.email || extractEmailFromJWT(accessToken) || "unknown",
				plan: usage?.plan_type || "unknown",
				allowed: usage?.rate_limit?.allowed ?? true,
				limitReached: usage?.rate_limit?.limit_reached ?? false,
				apiError: usageResult.ok ? undefined : usageResult.error,
				primary: usage?.rate_limit?.primary_window ?? null,
				secondary: usage?.rate_limit?.secondary_window ?? null,
				primaryRange,
				secondaryRange,
				fiveH,
				sevenD,
				now: observedAt,
			};

			ctx.ui.notify(formatReport(data, ctx.hasUI ? ctx.ui.theme : undefined), data.apiError ? "warning" : "info");
		},
	});
}
