import { Type, type Static } from "typebox";
import { postDeepSeekJson } from "./client.js";
import { missingApiKeyMessage, resolveConfig } from "./config.js";
import { getCurrentLocalDate } from "./temporal.js";
import { truncateForModel } from "./text.js";

export const DEFAULT_SEARCH_COUNT = 8;
export const MAX_SEARCH_COUNT = 50;
export const MAX_QUERY_CHARS = 128;
const MAX_SUMMARY_CHARS = 700;

export const SEARCH_OUTPUT_SCHEMA = Type.Object(
	{
		query: Type.String({ description: "The search query that was sent to DeepSeek." }),
		currentDate: Type.String({ description: "Current local date in YYYY-MM-DD format." }),
		timeZone: Type.String({ description: "IANA time zone used for currentDate." }),
		results: Type.Array(
			Type.Object({
				title: Type.String({ description: "Result title." }),
				url: Type.String({ description: "Result URL." }),
				summary: Type.String({ description: "Result summary suitable for model reading." }),
				siteName: Type.Optional(Type.String({ description: "Site name, when available." })),
				date: Type.Optional(Type.String({ description: "Publication date in UTC RFC 3339 format, when available." })),
				authority: Type.Integer({ minimum: -1, maximum: 4, description: "Authority score; -1 means unknown." }),
				rerankScore: Type.Number({ minimum: 0, maximum: 3, description: "DeepSeek rerank score." }),
			}),
		),
	},
	{ additionalProperties: false },
);

export type SearchOutput = Static<typeof SEARCH_OUTPUT_SCHEMA>;

export interface SearchResult {
	title: string;
	url: string;
	summary: string;
	siteName?: string;
	date?: string;
	authority: number;
	rerankScore: number;
}

export interface SearchToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: {
		query: string;
		count: number;
		currentDate: string;
		timeZone: string;
		results: SearchResult[];
	};
	structuredContent: SearchOutput;
}

interface DeepSeekSearchResponse {
	results?: unknown;
}

export async function executeDeepSeekSearch(
	rawQuery: string,
	count: number | undefined,
	signal?: AbortSignal,
	onProgress?: (message: string) => void,
): Promise<SearchToolResult> {
	const config = resolveConfig();
	if (!config.apiKey) throw new Error(missingApiKeyMessage(config.settingsPath));

	const query = rawQuery.trim();
	const queryLength = Array.from(query).length;
	if (queryLength === 0 || queryLength > MAX_QUERY_CHARS) {
		throw new Error(`The search query must be 1-${MAX_QUERY_CHARS} Unicode characters.`);
	}

	const resolvedCount = count ?? DEFAULT_SEARCH_COUNT;
	if (!Number.isInteger(resolvedCount) || resolvedCount < 1 || resolvedCount > MAX_SEARCH_COUNT) {
		throw new Error(`The search count must be an integer between 1 and ${MAX_SEARCH_COUNT}.`);
	}

	onProgress?.("Searching the web with DeepSeek...");

	try {
		const payload = await postDeepSeekJson<DeepSeekSearchResponse | null>(
			`${config.baseUrl}/v1/tools/search`,
			{ query, count: resolvedCount, need_content: false },
			config.apiKey,
			{ signal },
		);
		const results = mapResults(isObject(payload) ? payload.results : undefined, resolvedCount);
		const currentDate = getCurrentLocalDate(new Date(), config.timeZone);
		const structuredContent: SearchOutput = {
			query,
			currentDate,
			timeZone: config.timeZone,
			results,
		};

		return {
			content: [{ type: "text", text: formatSearchOutput(structuredContent) }],
			details: {
				query,
				count: resolvedCount,
				currentDate,
				timeZone: config.timeZone,
				results,
			},
			structuredContent,
		};
	} catch (error) {
		throw new Error(`DeepSeek Search failed: ${describeError(error)}`);
	}
}

function mapResults(rawResults: unknown, count: number): SearchResult[] {
	if (!Array.isArray(rawResults)) {
		throw new Error("DeepSeek Search returned an invalid response.");
	}

	const seen = new Set<string>();
	const results: SearchResult[] = [];

	for (const item of rawResults) {
		if (!isObject(item)) continue;

		const url = normalizeResultUrl(item.url);
		if (!url || seen.has(url)) continue;
		seen.add(url);

		const title = nonEmptyString(item.title) ?? "Untitled";
		const summary = nonEmptyString(item.summary) ?? nonEmptyString(item.snippet) ?? "";
		const siteName = nonEmptyString(item.site_name);
		const date = nonEmptyString(item.date);

		results.push({
			title,
			url,
			summary,
			...(siteName ? { siteName } : {}),
			...(date ? { date } : {}),
			authority: clampInteger(item.authority, -1, 4, -1),
			rerankScore: clampNumber(item.rerank_score, 0, 3, 0),
		});

		if (results.length >= count) break;
	}

	return results;
}

function formatSearchOutput(output: SearchOutput): string {
	const lines = [
		`Current date: ${output.currentDate} (${output.timeZone})`,
		`Query: ${JSON.stringify(output.query)}`,
		`Results: ${output.results.length} (publication dates are UTC; null = unknown)`,
		"",
	];

	if (output.results.length === 0) {
		lines.push("No results. Try broader keywords or search operators such as site:, after:, or before:.");
		return lines.join("\n");
	}

	for (const [index, result] of output.results.entries()) {
		const meta = [
			result.date ?? "date unknown",
			`authority ${result.authority}`,
			`score ${result.rerankScore.toFixed(1)}`,
		].join(" · ");
		lines.push(`${index + 1}. ${result.title}${result.siteName ? ` — ${result.siteName}` : ""}`);
		lines.push(`   ${result.url}`);
		lines.push(`   ${meta}`);
		const summary = truncateSummary(result.summary);
		if (summary) lines.push(`   ${summary}`);
		lines.push("");
	}

	return truncateForModel(lines.join("\n").trim()).text;
}

function truncateSummary(summary: string): string {
	const normalized = summary.replace(/\s+/g, " ").trim();
	if (normalized.length <= MAX_SUMMARY_CHARS) return normalized;
	return `${normalized.slice(0, MAX_SUMMARY_CHARS - 1)}…`;
}

function normalizeResultUrl(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	try {
		const url = new URL(value.trim());
		if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
		url.hash = "";
		return url.toString();
	} catch {
		return undefined;
	}
}

function nonEmptyString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(Math.max(Math.round(value), min), max);
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(Math.max(value, min), max);
}

function describeError(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === "string" && error.trim()) return error.trim();
	return "Unknown error";
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
