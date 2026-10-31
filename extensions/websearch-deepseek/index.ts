import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionToolContext,
	Theme,
	ToolRenderContext,
	ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { defineTool, formatSize, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Markdown, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	executeDeepSeekSearch,
	SEARCH_OUTPUT_SCHEMA,
	type SearchToolResult,
} from "./search.js";
import {
	executeDeepSeekWebFetch,
	FETCH_OUTPUT_SCHEMA,
	isWebFetchUrlInProvenance,
	type WebFetchToolResult,
} from "./webfetch.js";

const SEARCH_PARAMETERS = Type.Object(
	{
		query: Type.String({
			description:
				"Focused search query, 1-128 Unicode characters. Supports site:, -site:, lang:, after:, before:, and quoted phrases.",
			minLength: 1,
		}),
		count: Type.Optional(
			Type.Integer({
				description: "Number of results to return, 1-50. Defaults to 8.",
				minimum: 1,
				maximum: 50,
			}),
		),
	},
	{ additionalProperties: false },
);

const FETCH_PARAMETERS = Type.Object(
	{
		url: Type.String({
			description:
				"Public HTTP or HTTPS URL. It must appear in a user message or a prior deepseek_websearch/deepseek_webfetch result.",
			minLength: 1,
			maxLength: 8_192,
		}),
	},
	{ additionalProperties: false },
);

const deepSeekWebSearchTool = defineTool({
	name: "deepseek_websearch",
	label: "DeepSeek Web Search",
	description:
		"Search the web with DeepSeek's search API and return ranked results with titles, URLs, publication dates, authority scores, and summaries. Use this for current, time-sensitive, or source-backed questions. The tool returns sources only; synthesize the answer yourself, and call deepseek_webfetch when you need a full page.",
	promptSnippet: "Search the web and return ranked sources with dates and summaries",
	promptGuidelines: [
		"Use deepseek_websearch for current, time-sensitive, or source-backed questions.",
		"Pass a focused query; use site:, after:, before:, lang:, and quoted phrases when useful.",
		"The tool returns sources, not an answer. Synthesize from the summaries and cite the URLs; call deepseek_webfetch when you need the full page.",
	],
	parameters: SEARCH_PARAMETERS,
	outputSchema: SEARCH_OUTPUT_SCHEMA,
	annotations: { readOnlyHint: true, openWorldHint: true },

	async execute(_toolCallId, params, signal, onUpdate) {
		return executeDeepSeekSearch(params.query, params.count, signal, (message) => {
			onUpdate?.({ content: [{ type: "text", text: message }] });
		});
	},

	renderCall(args, theme) {
		const query = typeof args?.query === "string" ? args.query : "";
		let text = theme.fg("toolTitle", theme.bold("deepseek_websearch "));
		text += theme.fg("accent", query);
		if (args?.count !== undefined) text += theme.fg("dim", ` · ${args.count}`);
		return new Text(text, 0, 0);
	},

	renderResult(result, options, theme, context) {
		return renderSearchResult(result, options, theme, context);
	},
});

const deepSeekWebFetchTool = defineTool({
	name: "deepseek_webfetch",
	label: "DeepSeek Web Fetch",
	description:
		"Fetch a public HTTP or HTTPS URL through DeepSeek and return its title and Markdown content. The tool does not extract or summarize; interpret the returned content yourself.",
	promptSnippet: "Fetch a public URL and return its Markdown content",
	promptGuidelines: [
		"Use deepseek_webfetch to read a URL from a user message or a prior deepseek_websearch/deepseek_webfetch result.",
		"The tool returns raw Markdown; extract or summarize it yourself.",
	],
	parameters: FETCH_PARAMETERS,
	outputSchema: FETCH_OUTPUT_SCHEMA,
	annotations: { readOnlyHint: true, openWorldHint: true },

	async execute(_toolCallId, params, signal, onUpdate, ctx) {
		if (!isWebFetchUrlInProvenance(params.url, collectWebFetchProvenance(ctx))) {
			throw new Error(
				"deepseek_webfetch can only retrieve URLs that appeared in a user message or a prior deepseek_websearch/deepseek_webfetch result.",
			);
		}

		return executeDeepSeekWebFetch(params.url, signal, (message) => {
			onUpdate?.({ content: [{ type: "text", text: message }] });
		});
	},

	renderCall(args, theme) {
		let text = theme.fg("toolTitle", theme.bold("deepseek_webfetch "));
		text += theme.fg("accent", formatHost(args?.url));
		return new Text(text, 0, 0);
	},

	renderResult(result, options, theme, context) {
		return renderFetchResult(result, options, theme, context);
	},
});

export default function deepSeekWebSearchExtension(pi: ExtensionAPI): void {
	pi.registerTool(deepSeekWebSearchTool);
	pi.registerTool(deepSeekWebFetchTool);
}

function renderSearchResult(
	result: AgentToolResult<SearchToolResult["details"]>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ToolRenderContext,
) {
	if (options.isPartial) return new Text(theme.fg("warning", "Searching the web..."), 0, 0);

	const details = result.details;
	if (context.isError || !details) {
		return new Text(theme.fg("error", getResultText(result)), 0, 0);
	}

	const text = getResultText(result);
	if (options.expanded) return new Text(text, 0, 0);

	const count = details.results.length;
	const label = count === 0 ? "No results" : `${count} result${count === 1 ? "" : "s"}`;
	let summary = theme.fg(count === 0 ? "warning" : "success", label);
	summary += theme.fg("dim", ` · ${details.query}`);
	return new Text(summary, 0, 0);
}

function renderFetchResult(
	result: AgentToolResult<WebFetchToolResult["details"]>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ToolRenderContext,
) {
	if (options.isPartial) return new Text(theme.fg("warning", "Fetching the page..."), 0, 0);

	const details = result.details;
	if (context.isError || !details) {
		return new Text(theme.fg("error", getResultText(result)), 0, 0);
	}

	if (options.expanded) {
		return new Markdown(getResultText(result), 0, 0, getMarkdownTheme());
	}

	let summary = theme.fg("success", details.title);
	summary += theme.fg("dim", ` · ${formatSize(details.bytes)}`);
	if (details.truncated) summary += theme.fg("warning", " · truncated");
	return new Text(summary, 0, 0);
}

function getResultText(result: AgentToolResult<unknown>): string {
	return result.content
		.filter((item): item is { type: "text"; text: string } => item.type === "text")
		.map((item) => item.text)
		.join("\n")
		.trim();
}

function formatHost(url: unknown): string {
	if (typeof url !== "string") return "";
	try {
		return new URL(url).host;
	} catch {
		return url.length > 80 ? `${url.slice(0, 77)}...` : url;
	}
}

function collectWebFetchProvenance(ctx: ExtensionToolContext): string[] {
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
		.map((block) => block.text as string)
		.join("\n");
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
