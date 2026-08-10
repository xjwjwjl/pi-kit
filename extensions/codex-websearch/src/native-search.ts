export const CODEX_PROVIDER = "openai-codex";
export const NATIVE_WEB_SEARCH_TOOL_TYPE = "web_search";

const WEB_SEARCH_TOOL_ALIASES = new Set([
  NATIVE_WEB_SEARCH_TOOL_TYPE,
  "web_search_preview",
  "web_search_preview_2025_03_11",
]);

type JsonObject = Record<string, unknown>;

export interface NativeSearchPayloadOptions {
  requireSearch?: boolean;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasWebSearchTool(tools: unknown[]): boolean {
  return tools.some(
    (tool) => isObject(tool) && typeof tool.type === "string" && WEB_SEARCH_TOOL_ALIASES.has(tool.type),
  );
}

/**
 * Adds Codex's server-side web search tool to a Responses payload.
 * Returns undefined when the payload cannot be safely rewritten.
 */
export function addNativeWebSearchTool(
  payload: unknown,
  options: NativeSearchPayloadOptions = {},
): JsonObject | undefined {
  if (!isObject(payload)) return undefined;
  if (payload.tools !== undefined && !Array.isArray(payload.tools)) return undefined;

  const existingTools = Array.isArray(payload.tools) ? payload.tools : [];
  const tools = hasWebSearchTool(existingTools)
    ? existingTools
    : [...existingTools, { type: NATIVE_WEB_SEARCH_TOOL_TYPE }];

  return {
    ...payload,
    tools,
    ...(options.requireSearch ? { tool_choice: { type: NATIVE_WEB_SEARCH_TOOL_TYPE } } : {}),
  };
}

export function isCodexModel(
  model: { provider?: string; api?: string } | undefined,
): boolean {
  return model?.provider === CODEX_PROVIDER && model.api === "openai-codex-responses";
}
