import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import { addCurrentDateContext, resolveTimeZone } from "./temporal.js";

const SETTINGS_KEY = "deepseek-websearch";
const DEFAULT_BASE_URL = "https://api.deepseek.com/anthropic/v1/messages";
const DEFAULT_MODEL = "deepseek-v4-flash";
const WEB_SEARCH_TOOL_TYPE = "web_search_20250305";
const WEB_SEARCH_TOOL_NAME = "web_search";
const DEFAULT_SYSTEM_PROMPT =
	"You are a web research assistant. Use web search when needed and answer concisely with sources. For time-sensitive requests, prefer primary or official sources and identify each material source's as-of date/time when available. For requests about today, the evidence must match the requested date and time zone. For current or latest requests, establish recency from the gathered evidence and report the source's as-of date/time; do not claim freshness when it is missing, stale, or contradicted. If freshness cannot be verified, say so plainly.";
const STRICT_WEB_SEARCH_SYSTEM_PROMPT =
	"You are a web research assistant. You must use the web search tool for every request. Do not answer from prior knowledge. Return a concise answer grounded in the gathered web results and include source URLs. For time-sensitive requests, prefer primary or official sources and state each material source's as-of date/time when available. For today, require evidence matching the requested date and time zone; for current or latest, establish recency from the gathered evidence and say freshness cannot be verified when it is missing, stale, or contradicted.";
const STRICT_WEB_SEARCH_RETRY_INSTRUCTION =
	"Important: you must use the web search tool for this request. Do not answer from prior knowledge. Return a concise answer grounded in fetched web results and cite source URLs. For a time-sensitive request, verify that today matches the requested date/time zone, or establish recency for current/latest from source as-of dates; do not call stale or undated evidence current.";
const FINALIZER_SYSTEM_PROMPT =
	"You are a concise answer finalizer. You already have web search results. Do not emit tool calls, DSML markup, XML-like tags, or thinking. Answer in plain text and rely only on the gathered evidence. For time-sensitive requests, state the source's as-of date/time when available. For today, require evidence matching the requested date/time zone; for current/latest, establish recency from the gathered evidence. If freshness is missing, stale, or contradicted, say it cannot be verified instead of calling the result current or latest.";
const DEFAULT_MAX_USES = 1;
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_HTTP_RETRIES = 1;
const DEFAULT_HTTP_RETRY_DELAY_MS = 500;
const MAX_HTTP_RETRY_DELAY_MS = 5_000;
const MAX_ERROR_TEXT_LENGTH = 4_000;
const MAX_RENDERED_SOURCES = 10;

type JsonObject = Record<string, unknown>;
export type ProgressReporter = (message: string) => void;

interface ExtensionSettings {
	apiKey?: string;
	timeZone?: string;
}

interface ResolvedConfig {
	apiKey: string;
	model: string;
	systemPrompt: string;
	timeZone: string;
}

interface ApiKeyResolution {
	apiKey: string;
	source: "settings" | "missing";
}

interface ResponseContentBlock {
	type?: string;
	text?: string;
	thinking?: string;
	content?: unknown;
}

interface DeepSeekResponse {
	content?: ResponseContentBlock[];
	usage?: Record<string, unknown>;
	model?: string;
}

export interface WebSearchResultItem {
	title?: string;
	url?: string;
}

export interface WebSearchToolResult {
	content: Array<{ type: "text"; text: string }>;
	details:
		| {
				ok: true;
				query: string;
				model: string;
				answer: string;
				path: "direct" | "finalized" | "fallback";
				sources: WebSearchResultItem[];
				usage: Record<string, unknown>;
		  }
		| {
				ok: false;
				reason: "empty_query" | "missing_api_key" | "missing_sources" | "request_failed";
				error?: string;
		  };
}

type WebSearchAnswerPath = Extract<WebSearchToolResult["details"], { ok: true }>["path"];

interface SourcedDeepSeekResponse {
	response: DeepSeekResponse;
	results: WebSearchResultItem[];
}

// Public interface

export function resolveApiKeyInfo(): ApiKeyResolution {
	const settingsApiKey = readSettingsConfig().apiKey;
	if (settingsApiKey) {
		return { apiKey: settingsApiKey, source: "settings" };
	}

	return { apiKey: "", source: "missing" };
}

export async function executeDeepSeekWebSearchQuery(
	rawQuery: string,
	signal?: AbortSignal,
	onProgress?: ProgressReporter,
): Promise<WebSearchToolResult> {
	const config = resolveConfig();
	const query = normalizeQuery(rawQuery);

	if (!query) {
		return {
			content: [{ type: "text", text: "Error: query must not be empty." }],
			details: { ok: false, reason: "empty_query" },
		};
	}

	if (!config.apiKey) {
		return {
			content: [
				{
					type: "text",
					text: "Error: missing DeepSeek Web Search API key. Configure deepseek-websearch.apiKey in ~/.pi/agent/settings.json.",
				},
			],
			details: { ok: false, reason: "missing_api_key" },
		};
	}

	try {
		const result = await runWebSearchPipeline(addCurrentDateContext(query, new Date(), config.timeZone), config, signal, onProgress);
		if (result.details.ok) result.details.query = query;
		return result;
	} catch (error) {
		const message = formatErrorMessage(error);
		return {
			content: [{ type: "text", text: `Error: DeepSeek Web Search request failed. ${message}` }],
			details: {
				ok: false,
				reason: "request_failed",
				error: message,
			},
		};
	}
}

// Configuration

function resolveConfig(): ResolvedConfig {
	const settings = readSettingsConfig();
	return {
		apiKey: settings.apiKey ?? "",
		model: DEFAULT_MODEL,
		systemPrompt: DEFAULT_SYSTEM_PROMPT,
		timeZone: resolveTimeZone(settings.timeZone),
	};
}

export function resolveConfiguredTimeZone(): string {
	return resolveTimeZone(readSettingsConfig().timeZone);
}

function readSettingsConfig(): ExtensionSettings {
	const settings = readJsonFile(getAgentConfigPath("settings.json"));
	if (!isObject(settings)) return {};

	const section = settings[SETTINGS_KEY];
	if (!isObject(section)) return {};

	return {
		apiKey: typeof section.apiKey === "string" && section.apiKey.trim().length > 0 ? section.apiKey.trim() : undefined,
		timeZone: typeof section.timeZone === "string" && section.timeZone.trim().length > 0 ? section.timeZone.trim() : undefined,
	};
}

function getAgentConfigPath(fileName: string): string {
	const configuredDir = process.env.PI_CODING_AGENT_DIR?.trim();
	return join(configuredDir || join(homedir(), ".pi", "agent"), fileName);
}

function readJsonFile(path: string): unknown {
	if (!existsSync(path)) return undefined;

	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

// Pipeline

async function runWebSearchPipeline(
	query: string,
	config: ResolvedConfig,
	signal?: AbortSignal,
	onProgress?: ProgressReporter,
): Promise<WebSearchToolResult> {
	const sourcedResponse = await requestResponseWithSources(query, config, signal, onProgress);
	if (!sourcedResponse) return buildMissingSourcesError();

	const { answer, path } = await resolveAnswerFromSourcedResponse(
		query,
		sourcedResponse.response,
		sourcedResponse.results,
		config,
		signal,
		onProgress,
	);

	return buildSuccessfulWebSearchResult(query, config, sourcedResponse, answer, path);
}

async function requestResponseWithSources(
	query: string,
	config: ResolvedConfig,
	signal?: AbortSignal,
	onProgress?: ProgressReporter,
): Promise<SourcedDeepSeekResponse | undefined> {
	onProgress?.("Searching the web with DeepSeek...");
	let response = await callDeepSeekWebSearch(query, config, signal, DEFAULT_MAX_USES, onProgress);
	let results = extractSearchResults(response);

	if (results.length === 0) {
		onProgress?.("No usable sources returned; retrying the web search...");
		response = await retryDeepSeekWebSearchForSources(query, config, signal, onProgress);
		results = extractSearchResults(response);
	}

	if (results.length === 0) return undefined;
	return { response, results };
}

async function resolveAnswerFromSourcedResponse(
	query: string,
	response: DeepSeekResponse,
	results: WebSearchResultItem[],
	config: ResolvedConfig,
	signal?: AbortSignal,
	onProgress?: ProgressReporter,
): Promise<{ answer: string; path: WebSearchAnswerPath }> {
	const initialAnswer = extractResponseText(response);
	const needsFinalizer = isIncompleteAnswer(initialAnswer);
	const finalizedAnswer = needsFinalizer ? await finalizeIncompleteAnswer(query, response, config, signal, onProgress) : "";
	const answer = needsFinalizer ? finalizedAnswer || buildIncompleteAnswerFallback(results) : initialAnswer;
	const path = !needsFinalizer ? "direct" : finalizedAnswer ? "finalized" : "fallback";

	return { answer, path };
}

function buildSuccessfulWebSearchResult(
	query: string,
	config: ResolvedConfig,
	sourcedResponse: SourcedDeepSeekResponse,
	answer: string,
	path: WebSearchAnswerPath,
): WebSearchToolResult {
	const sources = formatSources(sourcedResponse.results);
	const contentText = truncateToolOutput([answer || "DeepSeek returned no final answer text.", sources].join("\n\n"));

	return {
		content: [{ type: "text", text: contentText }],
		details: {
			ok: true,
			query,
			model: sourcedResponse.response.model ?? config.model,
			answer,
			path,
			sources: sourcedResponse.results,
			usage: sourcedResponse.response.usage ?? {},
		},
	};
}

export function truncateToolOutput(content: string): string {
	const truncation = truncateHead(content, {
		maxLines: DEFAULT_MAX_LINES,
		maxBytes: DEFAULT_MAX_BYTES,
	});
	if (!truncation.truncated) return truncation.content;

	return `${truncation.content}\n\n[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).]`;
}

function buildMissingSourcesError(): WebSearchToolResult {
	const error = "DeepSeek Web Search did not return any web sources after retrying with a stricter search prompt.";
	return {
		content: [{ type: "text", text: `Error: ${error}` }],
		details: {
			ok: false,
			reason: "missing_sources",
			error,
		},
	};
}

// DeepSeek requests

export async function postDeepSeekMessage<T>(
	body: unknown,
	apiKey: string,
	signal?: AbortSignal,
	onProgress?: ProgressReporter,
): Promise<T> {
	const response = await fetchWithRetry(
		DEFAULT_BASE_URL,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-api-key": apiKey,
				"anthropic-version": "2023-06-01",
			},
			body: JSON.stringify(body),
		},
		signal,
		onProgress,
	);

	if (!response.ok) {
		const errorText = truncateErrorText(await response.text());
		throw new Error(`HTTP ${response.status}: ${errorText}`);
	}

	return (await response.json()) as T;
}

async function callDeepSeekWebSearch(
	query: string,
	config: ResolvedConfig,
	signal?: AbortSignal,
	maxUses = DEFAULT_MAX_USES,
	onProgress?: ProgressReporter,
): Promise<DeepSeekResponse> {
	const body = {
		model: config.model,
		max_tokens: 4096,
		system: [{ type: "text", text: config.systemPrompt }],
		messages: [{ role: "user", content: query }],
		tools: [buildWebSearchTool(maxUses)],
	};

	return postDeepSeekMessage<DeepSeekResponse>(body, config.apiKey, signal, onProgress);
}

async function retryDeepSeekWebSearchForSources(
	query: string,
	config: ResolvedConfig,
	signal?: AbortSignal,
	onProgress?: ProgressReporter,
): Promise<DeepSeekResponse> {
	return callDeepSeekWebSearch(
		`${query}\n\n${STRICT_WEB_SEARCH_RETRY_INSTRUCTION}`,
		{ ...config, systemPrompt: STRICT_WEB_SEARCH_SYSTEM_PROMPT },
		signal,
		DEFAULT_MAX_USES,
		onProgress,
	);
}

async function finalizeIncompleteAnswer(
	query: string,
	response: DeepSeekResponse,
	config: ResolvedConfig,
	signal?: AbortSignal,
	onProgress?: ProgressReporter,
): Promise<string> {
	try {
		onProgress?.("Finalizing the sourced answer...");
		const assistantContent = buildFinalizerAssistantContent(response);
		if (assistantContent.length === 0) return "";

		const body = {
			model: DEFAULT_MODEL,
			max_tokens: 2048,
			system: [{ type: "text", text: FINALIZER_SYSTEM_PROMPT }],
			messages: [
				{ role: "user", content: query },
				{ role: "assistant", content: assistantContent },
				{
					role: "user",
					content:
						"You already searched the web. Using only the gathered search results above, provide the final answer in plain text with brief source citations as URLs. If the evidence is conflicting or insufficient, say so briefly.",
				},
			],
		};

		const finalized = await postDeepSeekMessage<DeepSeekResponse>(
			body,
			config.apiKey,
			signal,
			onProgress,
		);
		const text = extractResponseText(finalized).trim();
		if (!text || hasDsmlMarkup(text)) return "";
		return text;
	} catch (error) {
		if (signal?.aborted) throw error;
		return "";
	}
}

function buildWebSearchTool(maxUses: number): JsonObject {
	return {
		type: WEB_SEARCH_TOOL_TYPE,
		name: WEB_SEARCH_TOOL_NAME,
		max_uses: maxUses,
	};
}

// Response parsing and rendering

function extractResponseText(response: DeepSeekResponse): string {
	if (!Array.isArray(response.content)) return "";

	return response.content
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text!.trim())
		.filter((text) => text.length > 0)
		.join("\n\n");
}

function isIncompleteAnswer(answer: string): boolean {
	const trimmed = answer.trim();
	if (!trimmed) return true;
	return hasDsmlMarkup(trimmed);
}

function hasDsmlMarkup(text: string): boolean {
	return /<\s*(?:\|DSML\||｜｜DSML｜｜)|<\s*tool_calls?\b|server_tool_use|web_search_tool_result/i.test(text);
}

function buildIncompleteAnswerFallback(results: WebSearchResultItem[]): string {
	if (results.length === 0) {
		return "DeepSeek completed web search but did not produce a clean final answer or any sources.";
	}

	return "DeepSeek completed web search but did not produce a clean final answer. Review the sources below.";
}

function buildFinalizerAssistantContent(response: DeepSeekResponse): ResponseContentBlock[] {
	if (!Array.isArray(response.content)) return [];

	return response.content.filter((block) => {
		if (!block || typeof block !== "object") return false;
		return block.type !== "thinking";
	});
}

function extractSearchResults(response: DeepSeekResponse): WebSearchResultItem[] {
	if (!Array.isArray(response.content)) return [];

	const items: WebSearchResultItem[] = [];
	for (const block of response.content) {
		if (block.type !== "web_search_tool_result" || !Array.isArray(block.content)) continue;
		for (const item of block.content) {
			if (!isObject(item)) continue;
			items.push({
				title: typeof item.title === "string" ? item.title : undefined,
				url: typeof item.url === "string" ? item.url : undefined,
			});
		}
	}

	return dedupeSearchResults(items);
}

function dedupeSearchResults(results: WebSearchResultItem[]): WebSearchResultItem[] {
	const seen = new Set<string>();
	const deduped: WebSearchResultItem[] = [];

	for (const item of results) {
		const normalizedUrl = normalizeSourceUrl(item.url);
		if (!normalizedUrl) continue;
		if (seen.has(normalizedUrl)) continue;
		seen.add(normalizedUrl);

		deduped.push({
			title: item.title,
			url: normalizedUrl,
		});
	}

	return deduped;
}

function normalizeSourceUrl(rawUrl: string | undefined): string | undefined {
	const raw = rawUrl?.trim();
	if (!raw) return undefined;

	try {
		const url = new URL(raw);
		if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;

		url.hash = "";

		const keysToDelete: string[] = [];
		for (const key of url.searchParams.keys()) {
			if (
				key.startsWith("utm_") ||
				key.startsWith("hss_") ||
				key.startsWith("ajs_") ||
				key === "source" ||
				key === "from" ||
				key === "frompage"
			) {
				keysToDelete.push(key);
			}
		}

		for (const key of keysToDelete) {
			url.searchParams.delete(key);
		}

		const normalized = url.toString();
		return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
	} catch {
		return undefined;
	}
}

function formatSources(results: WebSearchResultItem[]): string {
	if (results.length === 0) return "Sources: none returned.";

	const lines = results.slice(0, MAX_RENDERED_SOURCES).map((item, index) => {
		const title = item.title ?? "Untitled";
		const url = item.url ?? "";
		return `${index + 1}. ${title}${url ? ` - ${url}` : ""}`;
	});
	return `Sources:\n${lines.join("\n")}`;
}

// Shared helpers

async function fetchWithRequestSignal(
	input: RequestInfo | URL,
	init: RequestInit,
	signal?: AbortSignal,
): Promise<Response> {
	const requestSignal = createRequestSignal(signal);
	try {
		return await fetch(input, { ...init, signal: requestSignal.signal });
	} finally {
		requestSignal.cleanup();
	}
}

async function fetchWithRetry(
	input: RequestInfo | URL,
	init: RequestInit,
	signal?: AbortSignal,
	onProgress?: ProgressReporter,
): Promise<Response> {
	for (let attempt = 0; ; attempt += 1) {
		const response = await fetchWithRequestSignal(input, init, signal);
		if (!isRetryableStatus(response.status) || attempt >= MAX_HTTP_RETRIES) return response;

		const delayMs = getRetryDelayMs(response.headers);
		onProgress?.(`DeepSeek returned HTTP ${response.status}; retrying in ${delayMs}ms...`);
		try {
			await response.body?.cancel();
		} catch {
			// The retry is still safe when the error body cannot be cancelled.
		}
		await waitForRetryDelay(delayMs, signal);
	}
}

function isRetryableStatus(status: number): boolean {
	return status === 429 || status === 503;
}

function getRetryDelayMs(headers: Headers): number {
	const retryAfter = headers.get("retry-after")?.trim();
	if (retryAfter && /^\d+(?:\.\d+)?$/.test(retryAfter)) {
		return Math.min(Math.max(Number(retryAfter) * 1_000, 0), MAX_HTTP_RETRY_DELAY_MS);
	}
	return DEFAULT_HTTP_RETRY_DELAY_MS;
}

function waitForRetryDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
	if (delayMs <= 0) return Promise.resolve();

	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			signal?.removeEventListener("abort", abort);
			resolve();
		}, delayMs);
		const abort = () => {
			clearTimeout(timeout);
			reject(signal?.reason ?? new Error("DeepSeek Web Search request was aborted."));
		};

		if (signal?.aborted) {
			abort();
			return;
		}
		signal?.addEventListener("abort", abort, { once: true });
	});
}

function createRequestSignal(parentSignal?: AbortSignal): { signal: AbortSignal; cleanup: () => void } {
	const controller = new AbortController();
	const timeout = setTimeout(() => {
		if (!controller.signal.aborted) {
			controller.abort(new Error(`DeepSeek Web Search request timed out after ${REQUEST_TIMEOUT_MS}ms.`));
		}
	}, REQUEST_TIMEOUT_MS);

	if (typeof timeout === "object" && "unref" in timeout && typeof timeout.unref === "function") {
		timeout.unref();
	}

	const abortFromParent = () => {
		if (!controller.signal.aborted) {
			controller.abort(parentSignal?.reason ?? new Error("DeepSeek Web Search request was aborted."));
		}
	};

	if (parentSignal?.aborted) {
		abortFromParent();
	} else {
		parentSignal?.addEventListener("abort", abortFromParent, { once: true });
	}

	return {
		signal: controller.signal,
		cleanup: () => {
			clearTimeout(timeout);
			parentSignal?.removeEventListener("abort", abortFromParent);
		},
	};
}

function normalizeQuery(value: string): string {
	return value.trim();
}

function formatErrorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === "string" && error.trim().length > 0) return error.trim();
	return "Unknown error";
}

function truncateErrorText(text: string): string {
	const normalized = text.trim();
	if (normalized.length <= MAX_ERROR_TEXT_LENGTH) return normalized;
	const omitted = normalized.length - MAX_ERROR_TEXT_LENGTH;
	return `${normalized.slice(0, MAX_ERROR_TEXT_LENGTH)}... [truncated ${omitted} chars]`;
}

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
