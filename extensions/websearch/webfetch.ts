import axios, { type AxiosResponse } from "axios";
import { randomUUID } from "node:crypto";
import { lookup } from "node:dns";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LRUCache } from "lru-cache";
import {
	postDeepSeekMessage,
	resolveApiKeyInfo,
	resolveConfiguredTimeZone,
	truncateToolOutput,
	type ProgressReporter,
} from "./runtime.js";
import { addCurrentDateContext } from "./temporal.js";

const DEFAULT_MODEL = "deepseek-v4-flash";
const FETCH_TIMEOUT_MS = 60_000;
const MAX_HTTP_CONTENT_LENGTH = 10 * 1024 * 1024;
const MAX_REDIRECTS = 10;
const MAX_URL_LENGTH = 2_000;
export const MAX_MARKDOWN_LENGTH = 100_000;
const CACHE_TTL_MS = 15 * 60 * 1_000;
const MAX_CACHE_SIZE_BYTES = 50 * 1024 * 1024;
const BINARY_OUTPUT_DIR = join(tmpdir(), "pi-deepseek-webfetch");
const BINARY_FILE_TTL_MS = CACHE_TTL_MS;

interface DeepSeekResponse {
	content?: Array<{ type?: string; text?: string }>;
}

interface CacheEntry {
	bytes: number;
	code: number;
	codeText: string;
	content: string;
	contentType: string;
	persistedPath?: string;
	persistedSize?: number;
}

interface FetchedContent extends CacheEntry {
	cached: boolean;
}

interface RedirectInfo {
	type: "redirect";
	originalUrl: string;
	redirectUrl: string;
	statusCode: number;
}

export interface WebFetchToolResult {
	content: Array<{ type: "text"; text: string }>;
	details:
		| {
				ok: true;
				path: "fetched" | "redirect";
				url: string;
				bytes: number;
				code: number;
				codeText: string;
				result: string;
				durationMs: number;
				contentType?: string;
				cached: boolean;
				redirectUrl?: string;
				persistedPath?: string;
				persistedSize?: number;
		  }
		| {
				ok: false;
				reason: "empty_url" | "empty_prompt" | "missing_api_key" | "invalid_url" | "request_failed";
				error?: string;
		  };
}

type TurndownService = { turndown(input: string): string };

const URL_CACHE = new LRUCache<string, CacheEntry>({
	maxSize: MAX_CACHE_SIZE_BYTES,
	ttl: CACHE_TTL_MS,
	dispose: (entry) => {
		deletePersistedFile(entry.persistedPath);
	},
});

let turndownServicePromise: Promise<TurndownService> | undefined;

export function clearDeepSeekWebFetchCache(): void {
	URL_CACHE.clear();
}

export async function executeDeepSeekWebFetch(
	rawUrl: string,
	rawPrompt: string,
	signal?: AbortSignal,
	onProgress?: ProgressReporter,
): Promise<WebFetchToolResult> {
	const url = rawUrl.trim();
	const prompt = rawPrompt.trim();
	if (!url) return buildError("empty_url", "Error: url must not be empty.");
	if (!prompt) return buildError("empty_prompt", "Error: prompt must not be empty.");

	const apiKey = resolveApiKeyInfo().apiKey;
	if (!apiKey) {
		return buildError(
			"missing_api_key",
			"Error: missing DeepSeek Web Search API key. Configure deepseek-websearch.apiKey in Pi's global settings.json.",
		);
	}

	const start = Date.now();
	try {
		const fetched = await getUrlMarkdownContent(url, signal, onProgress);
		if (isRedirectInfo(fetched)) {
			const codeText = redirectStatusText(fetched.statusCode);
			const result = buildRedirectMessage(fetched, prompt, codeText);
			return {
				content: [{ type: "text", text: truncateToolOutput(result) }],
				details: {
					ok: true,
					path: "redirect",
					url,
					bytes: Buffer.byteLength(result),
					code: fetched.statusCode,
					codeText,
					result,
					durationMs: Date.now() - start,
					cached: false,
					redirectUrl: fetched.redirectUrl,
				},
			};
		}

		onProgress?.("Applying your prompt to the fetched content with DeepSeek Flash...");
		let result = await applyPromptToMarkdown(
			addCurrentDateContext(prompt, new Date(), resolveConfiguredTimeZone()),
			fetched.content,
			apiKey,
			signal,
			onProgress,
		);
		if (fetched.persistedPath) {
			result += `\n\n[Binary content (${fetched.contentType}, ${formatFileSize(fetched.persistedSize ?? fetched.bytes)}) also saved to ${fetched.persistedPath}]`;
		}

		return {
			content: [{ type: "text", text: truncateToolOutput(result) }],
			details: {
				ok: true,
				path: "fetched",
				url,
				bytes: fetched.bytes,
				code: fetched.code,
				codeText: fetched.codeText,
				result,
				durationMs: Date.now() - start,
				contentType: fetched.contentType,
				cached: fetched.cached,
				persistedPath: fetched.persistedPath,
				persistedSize: fetched.persistedSize,
			},
		};
	} catch (error) {
		const message = formatError(error);
		return buildError("request_failed", `Error: DeepSeek Web Fetch request failed. ${message}`, message);
	}
}

export function isWebFetchUrlInProvenance(url: string, texts: readonly string[]): boolean {
	const target = normalizeWebFetchUrl(url);
	if (!target) return false;

	return texts
		.flatMap(extractUrls)
		.some((candidate) => normalizeWebFetchUrl(candidate) === target);
}

export function normalizeWebFetchUrl(rawUrl: string): string | undefined {
	try {
		const url = new URL(trimTrailingUrlPunctuation(rawUrl.trim()));
		if (url.protocol === "http:") url.protocol = "https:";
		if (url.protocol !== "https:") return undefined;
		url.hash = "";
		return url.toString();
	} catch {
		return undefined;
	}
}

function buildError(
	reason: Extract<WebFetchToolResult["details"], { ok: false }>["reason"],
	text: string,
	error?: string,
): WebFetchToolResult {
	return {
		content: [{ type: "text", text }],
		details: { ok: false, reason, error },
	};
}

async function getUrlMarkdownContent(
	rawUrl: string,
	signal?: AbortSignal,
	onProgress?: ProgressReporter,
): Promise<FetchedContent | RedirectInfo> {
	const { originalUrl, fetchUrl } = validateAndNormalizeUrl(rawUrl);
	const cached = URL_CACHE.get(originalUrl);
	if (cached) {
		onProgress?.("Using cached web content...");
		return { ...cached, cached: true };
	}

	const hostname = new URL(fetchUrl).hostname;
	onProgress?.(`Fetching ${hostname}...`);
	const response = await getWithPermittedRedirects(fetchUrl, signal ?? new AbortController().signal);
	if (isRedirectInfo(response)) return response;

	const rawBuffer = Buffer.isBuffer(response.data) ? response.data : Buffer.from(response.data);
	const contentType = String(response.headers["content-type"] ?? "");
	const bytes = rawBuffer.length;
	const persisted = isBinaryContentType(contentType)
		? await persistBinaryContent(rawBuffer, contentType)
		: undefined;

	let content: string;
	let cacheBytes: number;
	if (contentType.toLowerCase().includes("text/html")) {
		onProgress?.("Converting HTML to Markdown...");
		content = (await getTurndownService()).turndown(rawBuffer.toString("utf8"));
		cacheBytes = Buffer.byteLength(content);
	} else {
		content = rawBuffer.toString("utf8");
		cacheBytes = bytes;
	}

	const entry: CacheEntry = {
		bytes,
		code: response.status,
		codeText: response.statusText,
		content,
		contentType,
		persistedPath: persisted?.path,
		persistedSize: persisted?.size,
	};
	URL_CACHE.set(originalUrl, entry, { size: Math.max(1, cacheBytes) });
	return { ...entry, cached: false };
}

function validateAndNormalizeUrl(rawUrl: string): { originalUrl: string; fetchUrl: string } {
	if (rawUrl.length > MAX_URL_LENGTH) throw new Error(`Invalid URL: exceeds ${MAX_URL_LENGTH} characters.`);

	let url: URL;
	try {
		url = new URL(rawUrl);
	} catch {
		throw new Error("Invalid URL.");
	}

	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("Invalid URL: only HTTP and HTTPS URLs are supported.");
	}
	if (url.username || url.password) throw new Error("Invalid URL: credentials are not allowed.");
	if (isPrivateOrLocalHost(url.hostname)) throw new Error("Invalid URL: private or local hosts are not allowed.");
	if (url.hostname.split(".").length < 2) throw new Error("Invalid URL: hostname must be publicly resolvable.");

	const originalUrl = url.toString();
	if (url.protocol === "http:") url.protocol = "https:";
	return { originalUrl, fetchUrl: url.toString() };
}

function isPrivateOrLocalHost(hostname: string): boolean {
	const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
	if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
		return true;
	}
	if (host.includes(":") && (host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:"))) {
		return true;
	}

	const octets = host.split(".");
	if (octets.length !== 4 || octets.some((octet) => !/^\d{1,3}$/.test(octet))) return false;
	const numbers = octets.map(Number);
	if (numbers.some((octet) => octet > 255)) return true;
	const [first, second] = numbers;
	return (
		first === 0 ||
		first === 10 ||
		first === 127 ||
		(first === 100 && second >= 64 && second <= 127) ||
		(first === 169 && second === 254) ||
		(first === 172 && second >= 16 && second <= 31) ||
		(first === 192 && second === 168) ||
		first >= 224
	);
}

async function getWithPermittedRedirects(
	url: string,
	signal: AbortSignal,
	depth = 0,
): Promise<AxiosResponse<ArrayBuffer> | RedirectInfo> {
	if (depth > MAX_REDIRECTS) throw new Error(`Too many redirects (exceeded ${MAX_REDIRECTS}).`);

	try {
		return await axios.get<ArrayBuffer>(url, {
			signal,
			timeout: FETCH_TIMEOUT_MS,
			maxRedirects: 0,
			responseType: "arraybuffer",
			maxContentLength: MAX_HTTP_CONTENT_LENGTH,
			lookup: safePublicLookup,
			headers: {
				Accept: "text/markdown, text/html, text/plain, */*",
				"User-Agent": "Pi-DeepSeek-WebFetch/1.0",
			},
		});
	} catch (error) {
		if (axios.isAxiosError(error) && error.response && [301, 302, 307, 308].includes(error.response.status)) {
			const location = error.response.headers.location;
			if (!location) throw new Error("Redirect missing Location header.");
			const redirectUrl = new URL(location, url).toString();
			if (!isPermittedRedirect(url, redirectUrl)) {
				return {
					type: "redirect",
					originalUrl: url,
					redirectUrl,
					statusCode: error.response.status,
				};
			}
			return getWithPermittedRedirects(redirectUrl, signal, depth + 1);
		}
		throw error;
	}
}

function safePublicLookup(
	hostname: string,
	_options: object,
	callback: (error: Error | null, address?: string, family?: number) => void,
): void {
	lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
		if (error) {
			callback(error);
			return;
		}

		const publicAddress = addresses.find((entry) => !isPrivateOrLocalHost(entry.address));
		if (!publicAddress) {
			callback(new Error(`Refusing to fetch ${hostname}: DNS resolved only to private or local addresses.`));
			return;
		}
		callback(null, publicAddress.address, publicAddress.family);
	});
}

function isPermittedRedirect(originalUrl: string, redirectUrl: string): boolean {
	try {
		const original = new URL(originalUrl);
		const redirect = new URL(redirectUrl);
		if (redirect.protocol !== original.protocol || redirect.port !== original.port) return false;
		if (redirect.username || redirect.password) return false;
		return stripWww(original.hostname) === stripWww(redirect.hostname);
	} catch {
		return false;
	}
}

function stripWww(hostname: string): string {
	return hostname.replace(/^www\./i, "");
}

function isRedirectInfo(value: AxiosResponse<ArrayBuffer> | RedirectInfo): value is RedirectInfo {
	return "type" in value && value.type === "redirect";
}

async function applyPromptToMarkdown(
	prompt: string,
	markdownContent: string,
	apiKey: string,
	signal?: AbortSignal,
	onProgress?: ProgressReporter,
): Promise<string> {
	const content = markdownContent.length > MAX_MARKDOWN_LENGTH
		? `${markdownContent.slice(0, MAX_MARKDOWN_LENGTH)}\n\n[Content truncated due to length...]`
		: markdownContent;
	const response = await postDeepSeekMessage<DeepSeekResponse>(
		{
			model: DEFAULT_MODEL,
			max_tokens: 2_048,
			system: [{
				type: "text",
				text: "You are a concise web content extraction assistant. Answer only from the provided web-page content. Do not claim to have browsed beyond it. Return compact terminal-friendly Markdown: one optional short heading, brief paragraphs and flat bullet lists; do not use Markdown tables, HTML, or deep nesting unless the user explicitly requests a table. For time-sensitive requests, identify the page's publication, data, or forecast date/time when present. For today, compare it with the requested date and time zone. For current or latest, establish recency from the page evidence. Never call undated, stale, or contradicted content current, latest, or today; say freshness cannot be verified instead.",
			}],
			messages: [{
				role: "user",
				content: `Web page content:\n---\n${content}\n---\n\n${prompt}\n\nProvide a concise response based only on the content above. Format it as compact terminal-friendly Markdown: one optional short heading, brief paragraphs and flat bullet lists; do not use Markdown tables, HTML, or deep nesting unless explicitly requested. For time-sensitive requests, include the page's publication, data, or forecast date/time when available. For today, it must match the requested date/time zone; for current or latest, establish recency from the page evidence. If freshness is absent, stale, or contradicted, state that it cannot be verified. Quote source material only when necessary, keep quotes short, and state when the page is insufficient to answer.`, 
			}],
		},
		apiKey,
		signal,
		onProgress,
	);

	const result = extractResponseText(response);
	return result || "No response from model";
}

async function getTurndownService(): Promise<TurndownService> {
	return (turndownServicePromise ??= import("turndown").then((module) => {
		const Turndown = module.default as unknown as new () => TurndownService;
		return new Turndown();
	}));
}

async function persistBinaryContent(buffer: Buffer, contentType: string): Promise<{ path: string; size: number }> {
	await mkdir(BINARY_OUTPUT_DIR, { recursive: true });
	const path = join(BINARY_OUTPUT_DIR, `webfetch-${randomUUID()}${extensionForContentType(contentType)}`);
	await writeFile(path, buffer);

	const cleanupTimer = setTimeout(() => deletePersistedFile(path), BINARY_FILE_TTL_MS);
	if (typeof cleanupTimer === "object" && "unref" in cleanupTimer && typeof cleanupTimer.unref === "function") {
		cleanupTimer.unref();
	}

	return { path, size: buffer.length };
}

function deletePersistedFile(path: string | undefined): void {
	if (!path) return;
	void rm(path, { force: true }).catch(() => undefined);
}

function isBinaryContentType(contentType: string): boolean {
	const mime = contentType.toLowerCase().split(";", 1)[0]?.trim() ?? "";
	return !(
		mime.startsWith("text/") ||
		mime.includes("json") ||
		mime.includes("xml") ||
		mime.includes("javascript") ||
		mime.includes("markdown")
	);
}

function extensionForContentType(contentType: string): string {
	const mime = contentType.toLowerCase().split(";", 1)[0]?.trim();
	if (mime === "application/pdf") return ".pdf";
	if (mime === "image/png") return ".png";
	if (mime === "image/jpeg") return ".jpg";
	if (mime === "image/gif") return ".gif";
	if (mime === "image/webp") return ".webp";
	return ".bin";
}

function buildRedirectMessage(redirect: RedirectInfo, prompt: string, codeText: string): string {
	return `REDIRECT DETECTED: The URL redirects to a different host.\n\nOriginal URL: ${redirect.originalUrl}\nRedirect URL: ${redirect.redirectUrl}\nStatus: ${redirect.statusCode} ${codeText}\n\nTo complete your request, fetch the redirected URL with:\n- url: "${redirect.redirectUrl}"\n- prompt: "${prompt}"`;
}

function redirectStatusText(statusCode: number): string {
	if (statusCode === 301) return "Moved Permanently";
	if (statusCode === 308) return "Permanent Redirect";
	if (statusCode === 307) return "Temporary Redirect";
	return "Found";
}

function extractResponseText(response: DeepSeekResponse): string {
	return (response.content ?? [])
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text!.trim())
		.filter(Boolean)
		.join("\n\n");
}

function extractUrls(text: string): string[] {
	return text.match(/https?:\/\/[^\s<>"')\]]+/gi)?.map(trimTrailingUrlPunctuation) ?? [];
}

function trimTrailingUrlPunctuation(value: string): string {
	return value.replace(/[.,;:!?]+$/g, "");
}

function formatFileSize(bytes: number): string {
	if (bytes < 1_024) return `${bytes}B`;
	if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)}KB`;
	return `${(bytes / (1_024 * 1_024)).toFixed(1)}MB`;
}

function formatError(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === "string" && error.trim()) return error.trim();
	return "Unknown error";
}
