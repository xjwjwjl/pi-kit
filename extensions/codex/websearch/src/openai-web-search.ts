import { Type } from "typebox";

export const OPENAI_WEB_SEARCH_TOOL_NAME = "openai_web_search";
export const OPENAI_WEB_SEARCH_MODELS = ["gpt-6-luna", "gpt-6.1-sol"] as const;
export type OpenAIWebSearchModel = (typeof OPENAI_WEB_SEARCH_MODELS)[number];
export const DEFAULT_OPENAI_WEB_SEARCH_MODEL: OpenAIWebSearchModel = "gpt-6-luna";
const MAX_ANSWER_CHARS = 16_000;
const MAX_SOURCES = 20;

export function isOpenAIWebSearchModel(value: string): value is OpenAIWebSearchModel {
  return (OPENAI_WEB_SEARCH_MODELS as readonly string[]).includes(value);
}

export interface OpenAIWebSearchSource {
  title?: string;
  url?: string;
  /** Provider-side source name used when the provider exposes no URL, for example an internal API source. */
  name?: string;
  type?: string;
}

/** Result shape of a successful search, as declared by `OPENAI_WEB_SEARCH_OUTPUT_SCHEMA`. */
export interface OpenAIWebSearchStructuredContent {
  model: string;
  answer: string;
  sources: OpenAIWebSearchSource[];
}

export const OPENAI_WEB_SEARCH_OUTPUT_SCHEMA = Type.Object({
  model: Type.String({ description: "Internal OpenAI model that produced the answer." }),
  answer: Type.String({ description: "Source-grounded answer to the query." }),
  sources: Type.Array(
    Type.Object({
      title: Type.Optional(Type.String({ description: "Source title, when the provider supplies one." })),
      url: Type.Optional(Type.String({ description: "HTTP(S) source URL, when available." })),
      name: Type.Optional(Type.String({ description: "Provider-side source name when no URL is exposed." })),
      type: Type.Optional(Type.String({ description: "Provider source type, for example \"api\"." })),
    }),
    { description: "Deduplicated sources backing the answer." },
  ),
});

interface JsonObject {
  [key: string]: unknown;
}

export interface OpenAIWebSearchResponse {
  status?: string;
  output?: unknown[];
  usage?: unknown;
  error?: { message?: string };
}

export interface OpenAIWebSearchResult {
  content: Array<{ type: "text"; text: string }>;
  details: {
    model: string;
    answer: string;
    sources: OpenAIWebSearchSource[];
    usage?: unknown;
  };
  structuredContent: OpenAIWebSearchStructuredContent;
}

export const OPENAI_WEB_SEARCH_INSTRUCTIONS =
  "Search the web for the user's query and return a source-grounded answer, with depth proportional to the query. Always use web search. Prefer primary or official sources for current or consequential facts. Cite sources alongside key claims, including URLs and relevant dates when available. Resolve conflicting evidence when possible; otherwise state the uncertainty. Do not claim information is current or latest unless its freshness can be verified.";

export function buildOpenAIWebSearchResult(
  payload: OpenAIWebSearchResponse,
  model: string,
  options: { requireUrlSources?: boolean } = {},
): OpenAIWebSearchResult {
  if (payload.status !== "completed") {
    throw new Error(`OpenAI Responses API did not complete successfully (status: ${payload.status ?? "unknown"}).`);
  }

  const parsed = parseSearchResponse(payload);
  const deduped = dedupeSources(parsed.sources);
  const sources = (options.requireUrlSources ? deduped.filter((source) => source.url) : deduped).slice(0, MAX_SOURCES);
  if (sources.length === 0) {
    throw new Error(
      options.requireUrlSources
        ? "OpenAI web search returned no usable source URLs."
        : "OpenAI web search returned no usable sources.",
    );
  }

  const answer = truncateAnswer(parsed.answer);
  const contentText = `${answer}\n\n${formatSources(sources)}`;

  return {
    content: [{ type: "text", text: contentText }],
    details: {
      model,
      answer,
      sources,
      ...(payload.usage !== undefined ? { usage: payload.usage } : {}),
    },
    structuredContent: { model, answer, sources },
  };
}

function parseSearchResponse(response: OpenAIWebSearchResponse): {
  answer: string;
  sources: OpenAIWebSearchSource[];
} {
  if (!Array.isArray(response.output)) {
    throw new Error("OpenAI Responses API returned no output items.");
  }

  let searchCallSeen = false;
  let completedSearch = false;
  const searchStatuses: string[] = [];
  const answerParts: string[] = [];
  const sources: OpenAIWebSearchSource[] = [];

  for (const item of response.output) {
    if (!isObject(item)) continue;

    if (item.type === "web_search_call") {
      const action = isObject(item.action) ? item.action : undefined;
      if (action?.type === "search") {
        searchCallSeen = true;
        const status = typeof item.status === "string" ? item.status : "unknown";
        if (status === "completed") {
          completedSearch = true;
          if (Array.isArray(action.sources)) {
            for (const source of action.sources) addSource(sources, source);
          }
        } else {
          searchStatuses.push(status);
        }
      }
    }

    if (item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const block of item.content) {
      if (!isObject(block)) continue;
      if (typeof block.text === "string" && (block.type === "output_text" || block.type === "text")) {
        const text = block.text.trim();
        if (text) answerParts.push(text);
      }
      if (Array.isArray(block.annotations)) {
        for (const annotation of block.annotations) {
          if (isObject(annotation) && annotation.type === "url_citation") addSource(sources, annotation);
        }
      }
    }
  }

  if (!searchCallSeen) {
    throw new Error("OpenAI did not return a web_search action; refusing to return an unsourced answer.");
  }
  if (!completedSearch) {
    const statuses = [...new Set(searchStatuses)].join(", ") || "unknown";
    throw new Error(`OpenAI web_search did not complete successfully (status: ${statuses}).`);
  }

  const answer = answerParts.join("\n\n");
  if (!answer) throw new Error("OpenAI web search completed without a text answer.");

  return { answer, sources };
}

function addSource(sources: OpenAIWebSearchSource[], value: unknown): void {
  if (!isObject(value)) return;
  const nested = isObject(value.url_citation) ? value.url_citation : value;
  const type = typeof nested.type === "string" && nested.type.trim() ? nested.type.trim() : undefined;
  const title = typeof nested.title === "string" && nested.title.trim() ? nested.title.trim() : undefined;

  const url = normalizeHttpUrl(typeof nested.url === "string" ? nested.url.trim() : "");
  if (url) {
    sources.push({ ...(title ? { title } : {}), url, ...(type ? { type } : {}) });
    return;
  }

  const name = typeof nested.name === "string" && nested.name.trim() ? nested.name.trim() : undefined;
  if (name) sources.push({ ...(title ? { title } : {}), name, ...(type ? { type } : {}) });
}

function dedupeSources(sources: OpenAIWebSearchSource[]): OpenAIWebSearchSource[] {
  const unique = new Map<string, OpenAIWebSearchSource>();
  for (const source of sources) {
    const key = source.url ?? source.name;
    if (!key) continue;
    const existing = unique.get(key);
    if (!existing) unique.set(key, source);
    else if (!existing.title && source.title) unique.set(key, { ...existing, title: source.title });
  }
  return [...unique.values()];
}

function normalizeHttpUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

async function readResponseBody(response: Response): Promise<OpenAIWebSearchResponse> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(`OpenAI Responses API returned invalid JSON (HTTP ${response.status}).`);
  }
  if (!isObject(body)) throw new Error("OpenAI Responses API returned an invalid response body.");
  return body as OpenAIWebSearchResponse;
}

function formatSources(sources: OpenAIWebSearchSource[]): string {
  const lines = sources.map((source, index) => {
    if (source.url) {
      return source.title
        ? `${index + 1}. [${escapeMarkdownLabel(source.title)}](<${source.url}>)`
        : `${index + 1}. <${source.url}>`;
    }
    return `${index + 1}. ${escapeMarkdownLabel(source.title ?? source.name ?? "Unnamed source")}${
      source.type ? ` (${source.type})` : ""
    }`;
  });
  return `Sources:\n${lines.join("\n")}`;
}

function escapeMarkdownLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/([\[\]])/g, "\\$1");
}

function truncateAnswer(answer: string): string {
  if (answer.length <= MAX_ANSWER_CHARS) return answer;
  return `${answer.slice(0, MAX_ANSWER_CHARS).trimEnd()}\n\n[Answer truncated.]`;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
