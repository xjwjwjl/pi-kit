/**
 * DeepSeek Balance & Usage Extension
 *
 * Commands:
 *   /deepseek-balance  – check account balance via public API (api.deepseek.com)
 *   /deepseek-usage    – check monthly usage cost & amount via platform API (platform.deepseek.com)
 *
 * Usage:
 *   /deepseek-balance [--provider <name>]
 *   /deepseek-usage [--month <1-12>] [--year <YYYY>] [--provider <name>]
 *   /deepseek-usage [YYYY-MM]
 *
 * The /deepseek-usage command calls private dashboard endpoints that require a
 * platform userToken (NOT an API key). Set DEEPSEEK_PLATFORM_TOKEN env var with
 * the userToken from browser DevTools → Application → Local Storage →
 * platform.deepseek.com → userToken. API keys (sk-...) are rejected with 40003.
 */

import { spawn } from "node:child_process";
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_PROVIDER = "deepseek";
const BALANCE_URL = "https://api.deepseek.com/user/balance";
const PLATFORM_BASE = "https://platform.deepseek.com";
const USAGE_COST_URL = `${PLATFORM_BASE}/api/v0/usage/by_api_key/cost`;
const USAGE_AMOUNT_URL = `${PLATFORM_BASE}/api/v0/usage/by_api_key/amount`;
const HTTP_STATUS_MARKER = "__PI_DS_HTTP__:";
const PLATFORM_TOKEN_ENV_VARS = ["DEEPSEEK_PLATFORM_TOKEN", "DEEPSEEK_USER_TOKEN"];

/** Browser UA required to bypass Cloudflare WAF on platform.deepseek.com */
const BROWSER_UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const CURRENCY_SYMBOLS: Record<string, string> = {
	CNY: "¥",
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BalanceInfo {
	currency?: string;
	total_balance?: string;
	granted_balance?: string;
	topped_up_balance?: string;
}

interface BalanceResponse {
	is_available?: boolean;
	balance_infos?: BalanceInfo[];
}

/** Flexible wrapper for platform API responses – shape is undocumented. */
interface UsageApiEnvelope {
	code?: number;
	msg?: string;
	data?: UsageDataPayload;
}

interface UsageDataPayload {
	bizCode?: number;
	bizMsg?: string;
	bizData?: Record<string, unknown>;
	/** Some endpoints nest data one level deeper */
	[key: string]: unknown;
}

interface ParsedArgs {
	provider: string;
}

interface UsageArgs {
	provider: string;
	month: number; // 1-12
	year: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseArgs(args: string): ParsedArgs {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	let provider = DEFAULT_PROVIDER;

	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (token.startsWith("--provider=")) {
			provider = token.slice("--provider=".length).trim() || provider;
			continue;
		}
		if (token === "--provider" || token === "-p") {
			const next = tokens[i + 1];
			if (next && !next.startsWith("-")) {
				provider = next;
				i++;
			}
			continue;
		}
		provider = token;
	}

	return { provider };
}

function parseUsageArgs(args: string): UsageArgs {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	let provider = DEFAULT_PROVIDER;

	const now = new Date();
	let month = now.getMonth() + 1; // 1-12
	let year = now.getFullYear();

	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];

		// YYYY-MM shorthand
		const monthYearMatch = token.match(/^(\d{4})-(\d{1,2})$/);
		if (monthYearMatch) {
			year = Number(monthYearMatch[1]);
			month = Number(monthYearMatch[2]);
			continue;
		}

		if (token.startsWith("--provider=")) {
			provider = token.slice("--provider=".length).trim() || provider;
			continue;
		}
		if (token === "--provider" || token === "-p") {
			const next = tokens[i + 1];
			if (next && !next.startsWith("-")) {
				provider = next;
				i++;
			}
			continue;
		}
		if (token.startsWith("--month=")) {
			month = Number(token.slice("--month=".length)) || month;
			continue;
		}
		if (token === "--month" || token === "-m") {
			const next = tokens[i + 1];
			if (next) { month = Number(next) || month; i++; }
			continue;
		}
		if (token.startsWith("--year=")) {
			year = Number(token.slice("--year=".length)) || year;
			continue;
		}
		if (token === "--year" || token === "-y") {
			const next = tokens[i + 1];
			if (next) { year = Number(next) || year; i++; }
			continue;
		}

		// fallback: treat bare token as provider
		provider = token;
	}

	// clamp
	if (month < 1) month = 1;
	if (month > 12) month = 12;

	return { provider, month, year };
}

/** Return [start, end) Unix timestamps (seconds) for the given month in UTC. */
function getMonthTimestamps(year: number, month: number): { start: number; end: number } {
	// month is 1-12; Date.UTC uses 0-indexed month
	const start = Math.floor(Date.UTC(year, month - 1, 1, 0, 0, 0) / 1000);
	const end = Math.floor(Date.UTC(year, month, 1, 0, 0, 0) / 1000);
	return { start, end };
}

function curlEscape(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

function scrubHttpErrorBody(body: string): string {
	const compact = body.replace(/\s+/g, " ").trim();
	if (!compact) return "";
	return compact.length > 300 ? `${compact.slice(0, 300)}...` : compact;
}

// ---------------------------------------------------------------------------
// Shared curl helper (supports api-key and platform token)
// ---------------------------------------------------------------------------

type AuthConfig =
	| { type: "api-key"; key: string }
	| { type: "platform-token"; token: string };

function curlGet(url: string, auth: AuthConfig, timeoutMs = 20_000): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn("curl", ["-sS", "-K", "-"], { windowsHide: true });
		let stdout = "";
		let stderr = "";
		let settled = false;

		const timer = setTimeout(() => {
			finish(() => reject(new Error("DeepSeek request timed out after 20s")));
			child.kill();
		}, timeoutMs);

		function finish(done: () => void) {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			done();
		}

		child.stdout.setEncoding("utf-8");
		child.stderr.setEncoding("utf-8");
		child.stdout.on("data", (chunk) => { stdout += chunk; });
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		child.on("error", (error) => {
			finish(() => reject(new Error(`Failed to start curl: ${error.message}`)));
		});
		child.on("close", (code) => {
			finish(() => {
				if (code !== 0) {
					reject(new Error(`curl exit ${code}: ${stderr.trim() || scrubHttpErrorBody(stdout)}`));
					return;
				}

				const markerIndex = stdout.lastIndexOf(`\n${HTTP_STATUS_MARKER}`);
				if (markerIndex < 0) {
					reject(new Error("curl response did not include HTTP status"));
					return;
				}

				const body = stdout.slice(0, markerIndex);
				const statusText = stdout.slice(markerIndex + 1 + HTTP_STATUS_MARKER.length).trim();
				const status = Number(statusText);
				if (!Number.isFinite(status)) {
					reject(new Error(`Invalid HTTP status from curl: ${statusText}`));
					return;
				}
				if (status < 200 || status >= 300) {
					const bodyText = scrubHttpErrorBody(body);
					reject(new Error(`DeepSeek API HTTP ${status}${bodyText ? `: ${bodyText}` : ""}`));
					return;
				}

				resolve(body);
			});
		});

		const authHeader =
			auth.type === "api-key"
				? `header = "Authorization: Bearer ${curlEscape(auth.key)}"`
				: `header = "Authorization: Bearer ${curlEscape(auth.token)}"`;

		const isPlatform = url.startsWith(PLATFORM_BASE);
		const config = [
			`url = "${curlEscape(url)}"`,
			`request = "GET"`,
			`header = "Accept: application/json"`,
			authHeader,
			...isPlatform ? [`header = "User-Agent: ${curlEscape(BROWSER_UA)}"`] : [],
			`connect-timeout = 10`,
			`max-time = 20`,
			`write-out = "\\n${curlEscape(HTTP_STATUS_MARKER)}%{http_code}"`,
		];

		child.stdin.end(`${config.join("\n")}\n`);
	});
}

// ---------------------------------------------------------------------------
// Platform token resolution
// ---------------------------------------------------------------------------

function resolvePlatformToken(): string | null {
	for (const name of PLATFORM_TOKEN_ENV_VARS) {
		const v = process.env[name];
		if (v && v.trim()) return v.trim();
	}
	return null;
}

// ---------------------------------------------------------------------------
// Styling
// ---------------------------------------------------------------------------

function styled(theme: Theme | undefined, color: string, text: string): string {
	return theme ? theme.fg(color as any, text) : text;
}

function value(v: unknown): string {
	if (typeof v === "string" && v.trim()) return v.trim();
	if (typeof v === "number" && Number.isFinite(v)) return String(v);
	return "-";
}

function fmtNum(n: unknown, decimals = 4): string {
	if (typeof n === "number" && Number.isFinite(n)) {
		return n.toFixed(decimals);
	}
	if (typeof n === "string") {
		const p = parseFloat(n);
		if (Number.isFinite(p)) return p.toFixed(decimals);
	}
	return value(n);
}

// ---------------------------------------------------------------------------
// Balance (existing command)
// ---------------------------------------------------------------------------

async function fetchBalance(apiKey: string): Promise<BalanceResponse> {
	const body = await curlGet(BALANCE_URL, { type: "api-key", key: apiKey });
	try {
		return JSON.parse(body) as BalanceResponse;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`DeepSeek returned invalid JSON: ${message}`);
	}
}

function formatBalance(data: BalanceResponse, theme?: Theme): string {
	const infos = Array.isArray(data.balance_infos) ? data.balance_infos : [];

	const title = theme
		? styled(theme, "accent", theme.bold("DeepSeek Balance"))
		: "DeepSeek Balance";

	let body: string;
	if (infos.length === 0) {
		body = styled(theme, "muted", "no balance data");
	} else {
		body = infos.map((info) => {
			const raw = value(info.currency);
			const symbol = CURRENCY_SYMBOLS[raw.toUpperCase()] ?? raw;
			const total = value(info.total_balance);
			return `${styled(theme, "accent", symbol)} ${styled(theme, "text", total)}`;
		}).join(" · ");
	}

	return `${title}  ${body}`;
}

// ---------------------------------------------------------------------------
// Usage (new command)
// ---------------------------------------------------------------------------

async function fetchUsageApi(url: string, token: string): Promise<UsageApiEnvelope> {
	const body = await curlGet(url, { type: "platform-token", token });
	try {
		return JSON.parse(body) as UsageApiEnvelope;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`DeepSeek returned invalid JSON: ${message}`);
	}
}

/**
 * Walk into bizData or a nested field to find the actual payload.
 * Tries data.bizData first, then data directly.
 */
function unwrapUsageData(data: unknown): Record<string, unknown> | null {
	if (data && typeof data === "object" && !Array.isArray(data)) {
		const obj = data as Record<string, unknown>;
		// Some endpoints nest inside bizData
		if (obj.bizData && typeof obj.bizData === "object" && !Array.isArray(obj.bizData)) {
			return obj.bizData as Record<string, unknown>;
		}
		return obj;
	}
	return null;
}

function formatUsageCost(payload: Record<string, unknown>, theme?: Theme): string {
	const lines: string[] = [];
	lines.push(styled(theme, "accent", theme?.bold("Cost") ?? "Cost"));

	// Try common keys
	if (payload.total_cost !== undefined) {
		lines.push(`  Total cost:    ${styled(theme, "text", fmtNum(payload.total_cost))}`);
	}
	if (payload.total_amount !== undefined) {
		lines.push(`  Total amount:  ${styled(theme, "text", fmtNum(payload.total_amount))}`);
	}
	if (payload.currency !== undefined) {
		lines.push(`  Currency:      ${styled(theme, "muted", value(payload.currency))}`);
	}
	if (payload.models && Array.isArray(payload.models)) {
		for (const m of payload.models) {
			if (typeof m === "object" && m !== null) {
				const model = m as Record<string, unknown>;
				const name = value(model.model ?? model.name ?? "");
				const cost = fmtNum(model.cost ?? model.total_cost ?? "");
				lines.push(`  ${name}:  ${styled(theme, "text", cost)}`);
			}
		}
	}
	if (payload.cost_breakdown && typeof payload.cost_breakdown === "object") {
		const cb = payload.cost_breakdown as Record<string, unknown>;
		for (const [k, v] of Object.entries(cb)) {
			lines.push(`  ${k}:  ${styled(theme, "text", fmtNum(v))}`);
		}
	}

	// Fallback: dump known numeric fields
	if (lines.length <= 1) {
		for (const [k, v] of Object.entries(payload)) {
			if (typeof v === "number" || (typeof v === "string" && !Number.isNaN(parseFloat(v)))) {
				lines.push(`  ${k}:  ${styled(theme, "text", fmtNum(v))}`);
			}
		}
	}

	return lines.join("\n");
}

function formatUsageAmount(payload: Record<string, unknown>, theme?: Theme): string {
	const lines: string[] = [];
	lines.push(styled(theme, "accent", theme?.bold("Amount") ?? "Amount"));

	if (payload.total_tokens !== undefined) {
		lines.push(`  Total tokens:       ${styled(theme, "text", value(payload.total_tokens))}`);
	}
	if (payload.prompt_tokens !== undefined) {
		lines.push(`  Prompt tokens:      ${styled(theme, "text", value(payload.prompt_tokens))}`);
	}
	if (payload.completion_tokens !== undefined) {
		lines.push(`  Completion tokens:  ${styled(theme, "text", value(payload.completion_tokens))}`);
	}
	if (payload.total_requests !== undefined) {
		lines.push(`  Total requests:     ${styled(theme, "text", value(payload.total_requests))}`);
	}
	if (payload.total && Array.isArray(payload.total)) {
		for (const m of payload.total) {
			if (typeof m === "object" && m !== null) {
				const model = m as Record<string, unknown>;
				const name = value(model.model ?? model.name ?? "");
				const tokens = value(model.total_tokens ?? model.tokens ?? "");
				lines.push(`  ${name}:  ${styled(theme, "text", tokens)}`);
			}
		}
	}

	if (lines.length <= 1) {
		for (const [k, v] of Object.entries(payload)) {
			if (typeof v === "number") {
				lines.push(`  ${k}:  ${styled(theme, "text", value(v))}`);
			}
		}
	}

	return lines.join("\n");
}

function formatUsageResponse(
	costEnvelope: UsageApiEnvelope | null,
	amountEnvelope: UsageApiEnvelope | null,
	month: number,
	year: number,
	theme?: Theme,
): string {
	const parts: string[] = [];

	const header = theme
		? styled(theme, "accent", theme.bold(`DeepSeek Usage — ${year}-${String(month).padStart(2, "0")}`))
		: `DeepSeek Usage — ${year}-${String(month).padStart(2, "0")}`;
	parts.push(header);

	let hasData = false;

	// Cost
	const costPayload = costEnvelope ? unwrapUsageData(costEnvelope.data) : null;
	if (costPayload) {
		parts.push("");
		parts.push(formatUsageCost(costPayload, theme));
		hasData = true;
	} else if (costEnvelope) {
		parts.push("");
		parts.push(styled(theme, "warning", `Cost API returned empty data (code: ${costEnvelope.code ?? "-"})`));
	}

	// Amount
	const amountPayload = amountEnvelope ? unwrapUsageData(amountEnvelope.data) : null;
	if (amountPayload) {
		parts.push("");
		parts.push(formatUsageAmount(amountPayload, theme));
		hasData = true;
	} else if (amountEnvelope) {
		parts.push("");
		parts.push(styled(theme, "warning", `Amount API returned empty data (code: ${amountEnvelope.code ?? "-"})`));
	}

	if (!hasData) {
		parts.push("");
		parts.push(styled(theme, "muted", "No usage data available."));
	}

	return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Extension entry
// ---------------------------------------------------------------------------

export default function deepseekBalanceExtension(pi: ExtensionAPI) {
	// ── /deepseek-balance ────────────────────────────────────────────────

	async function handleBalanceCommand(args: string, ctx: ExtensionCommandContext) {
		const { provider } = parseArgs(args);

		ctx.modelRegistry.refresh();
		const loadError = ctx.modelRegistry.getError();
		if (loadError) {
			ctx.ui.notify(`Failed to load models.json: ${loadError}`, "error");
			return;
		}

		const model = ctx.modelRegistry.getAll().find((candidate) => candidate.provider === provider);
		if (!model) {
			const providers = [...new Set(ctx.modelRegistry.getAll().map((c) => c.provider))]
				.sort()
				.join(", ");
			ctx.ui.notify(
				`No provider named "${provider}" found.${providers ? ` Available providers: ${providers}` : ""}`,
				"error",
			);
			return;
		}

		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) {
			ctx.ui.notify(`Failed to resolve API key for "${provider}": ${auth.error}`, "error");
			return;
		}
		if (!auth.apiKey) {
			ctx.ui.notify(`No API key configured for provider "${provider}".`, "error");
			return;
		}

		try {
			const data = await fetchBalance(auth.apiKey);
			ctx.ui.notify(
				formatBalance(data, ctx.hasUI ? ctx.ui.theme : undefined),
				data.is_available === false ? "warning" : "info",
			);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`DeepSeek balance check failed: ${message}`, "error");
		}
	}

	pi.registerCommand("deepseek-balance", {
		description: "Check DeepSeek balance using the provider API key from pi models.json",
		getArgumentCompletions: (prefix: string) => {
			const items = [DEFAULT_PROVIDER, "--provider"];
			const filtered = items.filter((item) => item.startsWith(prefix));
			return filtered.length > 0 ? filtered.map((item) => ({ value: item, label: item })) : null;
		},
		handler: handleBalanceCommand,
	});

	// ── /deepseek-usage ──────────────────────────────────────────────────

	async function handleUsageCommand(args: string, ctx: ExtensionCommandContext) {
		const { month, year } = parseUsageArgs(args);

		const platformToken = resolvePlatformToken();
		if (!platformToken) {
			ctx.ui.notify(
				"DEEPSEEK_PLATFORM_TOKEN not set. " +
				"Get it from browser DevTools → Application → Local Storage → platform.deepseek.com → userToken. " +
				"API keys (sk-...) are rejected by the platform usage API (error 40003).",
				"error",
			);
			return;
		}

		const { start, end } = getMonthTimestamps(year, month);
		const costUrl = `${USAGE_COST_URL}?start=${start}&end=${end}&tz=0`;
		const amountUrl = `${USAGE_AMOUNT_URL}?start=${start}&end=${end}&tz=0`;

		try {
			const [costResult, amountResult] = await Promise.allSettled([
				fetchUsageApi(costUrl, platformToken),
				fetchUsageApi(amountUrl, platformToken),
			]);

			const costEnvelope = costResult.status === "fulfilled" ? costResult.value : null;
			const amountEnvelope = amountResult.status === "fulfilled" ? amountResult.value : null;

			const theme = ctx.hasUI ? ctx.ui.theme : undefined;

			// Show individual errors as non-blocking warnings
			if (costResult.status === "rejected") {
				ctx.ui.notify(`Cost API failed: ${costResult.reason}`, "warning");
			}
			if (amountResult.status === "rejected") {
				ctx.ui.notify(`Amount API failed: ${amountResult.reason}`, "warning");
			}

			if (!costEnvelope && !amountEnvelope) {
				ctx.ui.notify("Both cost and amount API calls failed.", "error");
				return;
			}

			const output = formatUsageResponse(costEnvelope, amountEnvelope, month, year, theme);
			ctx.ui.notify(output, "info");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`DeepSeek usage check failed: ${message}`, "error");
		}
	}

	pi.registerCommand("deepseek-usage", {
		description: "Check DeepSeek monthly usage (cost & amount) via platform API",
		getArgumentCompletions: (prefix: string) => {
			const items = ["--month", "--year", "--provider", DEFAULT_PROVIDER];
			const filtered = items.filter((item) => item.startsWith(prefix));
			return filtered.length > 0 ? filtered.map((item) => ({ value: item, label: item })) : null;
		},
		handler: handleUsageCommand,
	});
}
