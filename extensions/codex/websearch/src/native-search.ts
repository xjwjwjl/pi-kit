export const CODEX_PROVIDER = "openai-codex";
export const NATIVE_WEB_SEARCH_TOOL_TYPE = "web_search";

const WEB_SEARCH_TOOL_ALIASES = new Set([
  NATIVE_WEB_SEARCH_TOOL_TYPE,
  "web_search_preview",
  "web_search_preview_2025_03_11",
  "web_search_2025_08_26",
]);

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasWebSearchTool(tools: unknown[]): boolean {
  return tools.some(
    (tool) => isObject(tool) && typeof tool.type === "string" && WEB_SEARCH_TOOL_ALIASES.has(tool.type),
  );
}

export interface NativeWebSearchToolOptions {
  /**
   * Provider-side search depth. Only set for providers that accept it (the public
   * OpenAI Responses API); the Codex backend keeps the bare tool shape.
   */
  searchContextSize?: string;
}

/**
 * Adds the provider-side web search tool to a Responses payload.
 * Returns undefined when the payload cannot be safely rewritten.
 */
export function addNativeWebSearchTool(
  payload: unknown,
  options: NativeWebSearchToolOptions = {},
): JsonObject | undefined {
  if (!isObject(payload)) return undefined;
  if (payload.tools !== undefined && !Array.isArray(payload.tools)) return undefined;

  const existingTools = Array.isArray(payload.tools) ? payload.tools : [];
  const searchTool = {
    type: NATIVE_WEB_SEARCH_TOOL_TYPE,
    ...(options.searchContextSize ? { search_context_size: options.searchContextSize } : {}),
  };
  const tools = hasWebSearchTool(existingTools) ? existingTools : [...existingTools, searchTool];

  return { ...payload, tools };
}

export function isCodexModel(
  model: { provider?: string; api?: string } | undefined,
): boolean {
  return model?.provider === CODEX_PROVIDER && model.api === "openai-codex-responses";
}
