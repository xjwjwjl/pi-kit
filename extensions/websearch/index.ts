import { defineTool, getMarkdownTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Markdown, Text } from "@earendil-works/pi-tui";
import { executeDeepSeekWebSearchQuery, resolveConfiguredTimeZone } from "./runtime.js";
import { buildCurrentDateInstruction } from "./temporal.js";
import { executeDeepSeekWebFetch, isWebFetchUrlInProvenance, type WebFetchToolResult } from "./webfetch.js";

const DEEPSEEK_WEBSEARCH_PARAMETERS = {
	type: "object",
	properties: {
		query: {
			type: "string",
			description: "The web search query to send to DeepSeek Web Search.",
		},
	},
	required: ["query"],
	additionalProperties: false,
} as const;

const DEEPSEEK_WEBFETCH_PARAMETERS = {
	type: "object",
	properties: {
		url: {
			type: "string",
			description: "The public HTTP or HTTPS URL to fetch. It must appear in a user message or a prior deepseek_websearch/deepseek_webfetch result.",
		},
		prompt: {
			type: "string",
			description: "The information to extract or analyze from the fetched page.",
		},
	},
	required: ["url", "prompt"],
	additionalProperties: false,
} as const;

const deepSeekWebSearchTool = defineTool({
	name: "deepseek_websearch",
	label: "DeepSeek Web Search",
	description:
		"Search the web and return a sourced answer for current, time-sensitive, or source-backed questions. Prefer this tool over memory for facts that may have changed. Output is capped to Pi's standard context limit.",
	promptSnippet: "Search the web and return a concise sourced answer",
	promptGuidelines: [
		"Use deepseek_websearch by default when the user asks for latest, current, recent, live, or otherwise time-sensitive information.",
		"Do not rely on memory or parametric knowledge for time-sensitive facts when deepseek_websearch can verify them.",
		"Use deepseek_websearch when the user asks for web-backed or source-backed information.",
		"Use deepseek_websearch instead of guessing when the answer depends on external web information.",
		"When using deepseek_websearch, pass a focused search query that includes the target topic and recency hints when useful.",
		"For relative-time requests, include the relevant location and exact date/time-zone context; prefer primary or official sources and report an as-of date/time or that freshness cannot be verified.",
		"When a current answer depends on a specific source page, use deepseek_webfetch to verify that page's publication, data, or forecast date before calling it latest.",
	],
	parameters: DEEPSEEK_WEBSEARCH_PARAMETERS,

	async execute(_toolCallId, params: { query: string }, signal, onUpdate) {
		const result = await executeDeepSeekWebSearchQuery(params.query, signal, (message) => {
			onUpdate?.({ content: [{ type: "text", text: message }] });
		});
		if (!result.details.ok) {
			const fallbackMessage = `DeepSeek Web Search failed: ${result.details.reason}`;
			const textMessage = result.content.find((block) => block.type === "text")?.text;
			throw new Error(result.details.error ?? textMessage ?? fallbackMessage);
		}
		return result;
	},
});

const deepSeekWebFetchTool = defineTool({
	name: "deepseek_webfetch",
	label: "DeepSeek Web Fetch",
	description:
		"Fetch a public web page locally, convert HTML to Markdown, and use DeepSeek Flash to extract the requested information. Returns HTTP metadata and a concise grounded result.",
	promptSnippet: "Fetch a public URL and extract information from its content",
	promptGuidelines: [
		"Use deepseek_webfetch when the user provides a public URL and asks to read, summarize, or extract information from that exact page.",
		"Use deepseek_webfetch only for a URL explicitly present in a user message or a prior deepseek_websearch/deepseek_webfetch result.",
		"For deepseek_webfetch, make prompt specific about the information to extract from the page.",
		"For deepseek_webfetch summaries, request compact terminal-friendly Markdown with short headings and bullets; avoid Markdown tables unless the user explicitly needs one.",
		"For time-sensitive extraction, request the page's publication, data, or forecast date and do not call undated or mismatched content current.",
		"Do not use deepseek_webfetch for authenticated, private, localhost, or intranet URLs.",
	],
	parameters: DEEPSEEK_WEBFETCH_PARAMETERS,

	async execute(_toolCallId, params: { url: string; prompt: string }, signal, onUpdate, ctx) {
		if (!isWebFetchUrlInProvenance(params.url, collectWebFetchProvenance(ctx))) {
			throw new Error(
				"deepseek_webfetch can only retrieve URLs that appeared in a user message or a prior deepseek_websearch/deepseek_webfetch result.",
			);
		}

		const result = await executeDeepSeekWebFetch(params.url, params.prompt, signal, (message) => {
			onUpdate?.({ content: [{ type: "text", text: message }] });
		});
		if (!result.details.ok) {
			const fallbackMessage = `DeepSeek Web Fetch failed: ${result.details.reason}`;
			const textMessage = result.content.find((block) => block.type === "text")?.text;
			throw new Error(result.details.error ?? textMessage ?? fallbackMessage);
		}
		return result;
	},

	renderCall(args, theme) {
		let text = theme.fg("toolTitle", theme.bold("deepseek_webfetch "));
		text += theme.fg("accent", formatWebFetchHost(args.url));
		return new Text(text, 0, 0);
	},

	renderResult(result, { expanded, isPartial }, theme) {
		if (isPartial) return new Text(theme.fg("warning", "Fetching and extracting..."), 0, 0);

		const details = result.details as WebFetchToolResult["details"] | undefined;
		if (!details?.ok) {
			return new Text(theme.fg("error", getWebFetchResultText(result)), 0, 0);
		}
		if (details.path === "redirect") {
			return new Text(
				theme.fg("warning", `Redirect ${details.code}: ${details.redirectUrl ?? details.url}`),
				0,
				0,
			);
		}

		if (expanded) return new Markdown(details.result, 0, 0, getMarkdownTheme());

		let text = theme.fg("success", `Fetched ${details.code}`);
		text += theme.fg("dim", ` · ${formatWebFetchBytes(details.bytes)}`);
		if (details.cached) text += theme.fg("muted", " · cached");
		const preview = toWebFetchPreview(details.result);
		if (preview) text += `\n${theme.fg("dim", preview)}`;
		return new Text(text, 0, 0);
	},
});

export default function deepSeekWebSearchExtension(pi: ExtensionAPI): void {
	pi.on("before_agent_start", (event) => ({
		systemPrompt: `${event.systemPrompt}\n\n${buildCurrentDateInstruction(new Date(), resolveConfiguredTimeZone())}`,
	}));
	pi.registerTool(deepSeekWebSearchTool);
	pi.registerTool(deepSeekWebFetchTool);
}

function formatWebFetchHost(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return url.length > 80 ? `${url.slice(0, 77)}...` : url;
	}
}

function formatWebFetchBytes(bytes: number): string {
	if (bytes < 1_024) return `${bytes}B`;
	if (bytes < 1_024 * 1_024) return `${Math.round(bytes / 1_024)}KB`;
	return `${(bytes / (1_024 * 1_024)).toFixed(1)}MB`;
}

function getWebFetchResultText(result: { content?: Array<{ type?: string; text?: string }> }): string {
	return result.content?.find((block) => block.type === "text")?.text ?? "DeepSeek Web Fetch failed.";
}

function toWebFetchPreview(markdown: string): string {
	const preview = markdown
		.replace(/!?(?:\[([^\]]*)\]\([^)]*\))/g, "$1")
		.replace(/^[\s>*#`_-]+/gm, "")
		.replace(/[*_`]/g, "")
		.replace(/\s+/g, " ")
		.trim();
	return preview.length > 180 ? `${preview.slice(0, 177)}...` : preview;
}

function collectWebFetchProvenance(ctx: unknown): string[] {
	if (!isObject(ctx) || !isObject(ctx.sessionManager) || typeof ctx.sessionManager.buildSessionContext !== "function") {
		return [];
	}

	const session = ctx.sessionManager.buildSessionContext();
	if (!isObject(session) || !Array.isArray(session.messages)) return [];

	const texts: string[] = [];
	for (const message of session.messages) {
		if (!isObject(message)) continue;
		if (message.role === "user") {
			texts.push(contentToText(message.content));
		} else if (
			message.role === "toolResult" &&
			(message.toolName === "deepseek_websearch" || message.toolName === "deepseek_webfetch")
		) {
			texts.push(contentToText(message.content));
		}
	}
	return texts;
}

function contentToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(isObject)
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n");
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
