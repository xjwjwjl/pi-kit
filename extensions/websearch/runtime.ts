import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SETTINGS_KEY = "deepseek-websearch";
const DEFAULT_BASE_URL = "https://api.deepseek.com/anthropic/v1/messages";
const DEFAULT_MODEL = "deepseek-v4-flash";
const WEB_SEARCH_TOOL_TYPE = "web_search_20250305";
const WEB_SEARCH_TOOL_NAME = "web_search";
const DEFAULT_SYSTEM_PROMPT = "You are a web research assistant. Use web search when needed and answer concisely with sources.";
const STRICT_WEB_SEARCH_SYSTEM_PROMPT =
	"You are a web research assistant. You must use the web search tool for every request. Do not answer from prior knowledge. Return a concise answer grounded in the gathered web results and include source URLs.";
const STRICT_WEB_SEARCH_RETRY_INSTRUCTION =
	"Important: you must use the web search tool for this request. Do not answer from prior knowledge. Return a concise answer grounded in fetched web results and cite source URLs.";
const FINALIZER_SYSTEM_PROMPT =
	"You are a concise answer finalizer. You already have web search results. Do not emit tool calls, DSML markup, XML-like tags, or thinking. Answer in plain text and rely only on the gathered evidence.";
const DEFAULT_MAX_USES = 2;
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_ERROR_TEXT_LENGTH = 4_000;
const MAX_RENDERED_SOURCES = 10;

type JsonObject = Record<string, unknown>;

interface ExtensionSettings {
	apiKey?: string;
}

interface ResolvedConfig {
	apiKey: string;
	baseUrl: string;
	model: string;
	systemPrompt: string;
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
		return await runWebSearchPipeline(query, config, signal);
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
	return {
		apiKey: resolveApiKeyInfo().apiKey,
		baseUrl: DEFAULT_BASE_URL,
		model: DEFAULT_MODEL,
		systemPrompt: DEFAULT_SYSTEM_PROMPT,
	};
}

function readSettingsConfig(): ExtensionSettings {
	const settings = readJsonFile(getAgentConfigPath("settings.json"));
	if (!isObject(settings)) return {};

	const section = settings[SETTINGS_KEY];
	if (!isObject(section)) return {};

	return {
		apiKey: typeof section.apiKey === "string" && section.apiKey.trim().length > 0 ? section.apiKey.trim() : undefined,
	};
}

function getAgentConfigPath(fileName: string): string {
	return join(homedir(), ".pi", "agent", fileName);
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
): Promise<WebSearchToolResult> {
	const sourcedResponse = await requestResponseWithSources(query, config, signal);
	if (!sourcedResponse) return buildMissingSourcesError();

	const { answer, path } = await resolveAnswerFromSourcedResponse(
		query,
		sourcedResponse.response,
		sourcedResponse.results,
		config,
		signal,
	);

	return buildSuccessfulWebSearchResult(query, config, sourcedResponse, answer, path);
}

async function requestResponseWithSources(
	query: string,
	config: ResolvedConfig,
	signal?: AbortSignal,
): Promise<SourcedDeepSeekResponse | undefined> {
	let response = await callDeepSeekWebSearch(query, config, signal);
	let results = extractSearchResults(response);

	if (results.length === 0) {
		response = await retryDeepSeekWebSearchForSources(query, config, signal);
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
): Promise<{ answer: string; path: WebSearchAnswerPath }> {
	const initialAnswer = extractResponseText(response);
	const needsFinalizer = isIncompleteAnswer(initialAnswer);
	const finalizedAnswer = needsFinalizer ? await finalizeIncompleteAnswer(query, response, config, signal) : "";
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
	const contentText = [answer || "DeepSeek returned no final answer text.", sources].join("\n\n");

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

async function callDeepSeekWebSearch(
	query: string,
	config: ResolvedConfig,
	signal?: AbortSignal,
): Promise<DeepSeekResponse> {
	const body = {
		model: config.model,
		max_tokens: 4096,
		system: [{ type: "text", text: config.systemPrompt }],
		messages: [{ role: "user", content: query }],
		tools: [buildWebSearchTool()],
	};

	const response = await fetchWithRequestSignal(
		config.baseUrl,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-api-key": config.apiKey,
				"anthropic-version": "2023-06-01",
			},
			body: JSON.stringify(body),
		},
		signal,
	);

	if (!response.ok) {
		const errorText = truncateErrorText(await response.text());
		throw new Error(`HTTP ${response.status}: ${errorText}`);
	}

	return (await response.json()) as DeepSeekResponse;
}

async function retryDeepSeekWebSearchForSources(
	query: string,
	config: ResolvedConfig,
	signal?: AbortSignal,
): Promise<DeepSeekResponse> {
	return callDeepSeekWebSearch(
		`${query}\n\n${STRICT_WEB_SEARCH_RETRY_INSTRUCTION}`,
		{ ...config, systemPrompt: STRICT_WEB_SEARCH_SYSTEM_PROMPT },
		signal,
	);
}

async function finalizeIncompleteAnswer(
	query: string,
	response: DeepSeekResponse,
	config: ResolvedConfig,
	signal?: AbortSignal,
): Promise<string> {
	try {
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

		const response2 = await fetchWithRequestSignal(
			config.baseUrl,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-api-key": config.apiKey,
					"anthropic-version": "2023-06-01",
				},
				body: JSON.stringify(body),
			},
			signal,
		);

		if (!response2.ok) return "";

		const finalized = (await response2.json()) as DeepSeekResponse;
		const text = extractResponseText(finalized).trim();
		if (!text || hasDsmlMarkup(text)) return "";
		return text;
	} catch (error) {
		if (signal?.aborted) throw error;
		return "";
	}
}

function buildWebSearchTool(): JsonObject {
	return {
		type: WEB_SEARCH_TOOL_TYPE,
		name: WEB_SEARCH_TOOL_NAME,
		max_uses: DEFAULT_MAX_USES,
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
