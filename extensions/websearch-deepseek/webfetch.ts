import { formatSize } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { postDeepSeekJson } from "./client.js";
import { missingApiKeyMessage, resolveConfig } from "./config.js";
import { truncateForModel } from "./text.js";

export const MAX_URL_LENGTH = 8_192;
const MAX_STRUCTURED_CONTENT_CHARS = 200_000;

export const FETCH_OUTPUT_SCHEMA = Type.Object(
	{
		url: Type.String({ description: "The URL that was fetched." }),
		title: Type.String({ description: "Page title, or the hostname when the page has no title." }),
		content: Type.String({ description: "Page content as Markdown, capped for transport." }),
		bytes: Type.Integer({ minimum: 0, description: "UTF-8 byte length of the full page content." }),
		truncated: Type.Boolean({ description: "Whether the content was truncated." }),
		fetchedAt: Type.String({ description: "ISO timestamp of when the page was fetched." }),
	},
	{ additionalProperties: false },
);

export type FetchOutput = Static<typeof FETCH_OUTPUT_SCHEMA>;

export interface WebFetchToolResult {
	content: Array<{ type: "text"; text: string }>;
	details: {
		url: string;
		title: string;
		bytes: number;
		truncated: boolean;
		fetchedAt: string;
		contentChars: number;
	};
	structuredContent: FetchOutput;
}

interface DeepSeekFetchResponse {
	title?: unknown;
	content?: unknown;
}

export async function executeDeepSeekWebFetch(
	rawUrl: string,
	signal?: AbortSignal,
	onProgress?: (message: string) => void,
): Promise<WebFetchToolResult> {
	const config = resolveConfig();
	if (!config.apiKey) throw new Error(missingApiKeyMessage(config.settingsPath));

	const url = validateWebFetchUrl(rawUrl);
	onProgress?.(`Fetching ${new URL(url).hostname} with DeepSeek...`);

	try {
		const payload = await postDeepSeekJson<DeepSeekFetchResponse | null>(
			`${config.baseUrl}/v1/tools/fetch`,
			{ url },
			config.apiKey,
			{ signal },
		);
		const content = isObject(payload) && typeof payload.content === "string" ? payload.content : "";
		if (!content.trim()) {
			throw new Error("DeepSeek Fetch returned no usable content for this URL.");
		}

		const title = (isObject(payload) ? nonEmptyString(payload.title) : undefined) ?? new URL(url).hostname;
		const bytes = Buffer.byteLength(content, "utf8");
		const fetchedAt = new Date().toISOString();
		const structuredContentTruncated = content.length > MAX_STRUCTURED_CONTENT_CHARS;
		const structuredContent = structuredContentTruncated
			? content.slice(0, MAX_STRUCTURED_CONTENT_CHARS)
			: content;
		const modelBody = truncateForModel(
			`# ${title}\n\nURL: ${url}\nFetched: ${fetchedAt} · ${formatSize(bytes)}\n\n${content}`,
		);
		const truncated = structuredContentTruncated || modelBody.truncated;
		const output: FetchOutput = {
			url,
			title,
			content: structuredContent,
			bytes,
			truncated,
			fetchedAt,
		};

		return {
			content: [{ type: "text", text: modelBody.text }],
			details: {
				url,
				title,
				bytes,
				truncated,
				fetchedAt,
				contentChars: content.length,
			},
			structuredContent: output,
		};
	} catch (error) {
		throw new Error(`DeepSeek Fetch failed: ${describeError(error)}`);
	}
}

export function validateWebFetchUrl(rawUrl: string): string {
	const url = rawUrl.trim();
	if (!url) throw new Error("The URL must not be empty.");
	if (url.length > MAX_URL_LENGTH) {
		throw new Error(`The URL must not exceed ${MAX_URL_LENGTH} characters.`);
	}

	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error("The URL is invalid.");
	}

	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error("Only HTTP and HTTPS URLs are supported.");
	}
	if (parsed.username || parsed.password) {
		throw new Error("URLs with embedded credentials are not supported.");
	}
	if (!parsed.hostname) {
		throw new Error("The URL must include a host.");
	}

	parsed.hash = "";
	return parsed.toString();
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

function extractUrls(text: string): string[] {
	return text.match(/https?:\/\/[^\s<>"')\]]+/gi)?.map(trimTrailingUrlPunctuation) ?? [];
}

function trimTrailingUrlPunctuation(value: string): string {
	return value.replace(/[.,;:!?]+$/g, "");
}

function nonEmptyString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeError(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === "string" && error.trim()) return error.trim();
	return "Unknown error";
}
