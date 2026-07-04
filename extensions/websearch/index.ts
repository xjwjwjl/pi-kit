import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { executeDeepSeekWebSearchQuery } from "./runtime.js";

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

const deepSeekWebSearchTool = defineTool({
	name: "deepseek_websearch",
	label: "DeepSeek Web Search",
	description:
		"Search the web and return a sourced answer for current, time-sensitive, or source-backed questions. Prefer this tool over memory for facts that may have changed.",
	promptSnippet: "Search the web and return a concise sourced answer",
	promptGuidelines: [
		"Use deepseek_websearch by default when the user asks for latest, current, recent, live, or otherwise time-sensitive information.",
		"Do not rely on memory or parametric knowledge for time-sensitive facts when deepseek_websearch can verify them.",
		"Use deepseek_websearch when the user asks for web-backed or source-backed information.",
		"Use deepseek_websearch instead of guessing when the answer depends on external web information.",
		"When using deepseek_websearch, pass a focused search query that includes the target topic and recency hints when useful.",
	],
	parameters: DEEPSEEK_WEBSEARCH_PARAMETERS,

	async execute(_toolCallId, params: { query: string }, signal) {
		const result = await executeDeepSeekWebSearchQuery(params.query, signal);
		if (!result.details.ok) {
			const fallbackMessage = `DeepSeek Web Search failed: ${result.details.reason}`;
			const textMessage = result.content.find((block) => block.type === "text")?.text;
			throw new Error(result.details.error ?? textMessage ?? fallbackMessage);
		}
		return result;
	},
});

export default function deepSeekWebSearchExtension(pi: ExtensionAPI): void {
	pi.registerTool(deepSeekWebSearchTool);
}
