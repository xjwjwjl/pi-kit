import type {
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { addNativeWebSearchTool, isCodexModel } from "./src/native-search.js";
import {
  buildOpenAIWebSearchResult,
  DEFAULT_OPENAI_WEB_SEARCH_MODEL,
  isOpenAIWebSearchModel,
  OPENAI_WEB_SEARCH_INSTRUCTIONS,
  OPENAI_WEB_SEARCH_OUTPUT_SCHEMA,
  OPENAI_WEB_SEARCH_TOOL_NAME,
} from "./src/openai-web-search.js";
import type { OpenAIWebSearchModel, OpenAIWebSearchResponse } from "./src/openai-web-search.js";
import { renderOpenAIWebSearchCall, renderOpenAIWebSearchResult } from "./src/render.js";

const CODEX_AUTO_GUIDANCE =
  "Use Codex's built-in web_search for facts that may have changed, when the user asks to browse or verify information, or when source-backed evidence is needed. If you use web_search, include the most relevant full source URLs in the final answer because the client does not render native search citations.";
const GENERAL_AUTO_GUIDANCE =
  "Use openai_web_search for current or verifiable web research; make each query self-contained and preserve relevant context and constraints.";
const OPENAI_WEB_SEARCH_DESCRIPTION =
  "Use openai_web_search when the user requests web research or when answering accurately requires external, current, or verifiable information. It performs a separate OpenAI web search and returns a source-grounded answer with source references. Do not rely on memory alone for facts that may have changed. Make queries self-contained, preserving relevant context and constraints. For the optional model parameter, use gpt-6-luna for routine lookups or omit it; choose gpt-6.1-sol for complex research, multi-source comparisons, or conflicting evidence. It uses the openai credential when available, otherwise it can use Pi's openai-codex OAuth."

const OPENAI_WEB_SEARCH_PARAMETERS = Type.Object(
  {
    query: Type.String({
      description: "Focused web search question or query. Include relevant date, location, or recency context when needed.",
      minLength: 1,
      maxLength: 4_000,
    }),
    model: Type.Optional(
      Type.Union([Type.Literal("gpt-6-luna"), Type.Literal("gpt-6.1-sol")], {
        description:
          "OpenAI model used internally for search and synthesis. Use gpt-6-luna for routine lookups; choose gpt-6.1-sol for complex research, multi-source comparisons, or conflicting sources. Omit to use gpt-6-luna.",
      }),
    ),
  },
  { additionalProperties: false },
);

const OPENAI_WEB_SEARCH_TOOL = {
  name: OPENAI_WEB_SEARCH_TOOL_NAME,
  label: "OpenAI Web Search",
  description: OPENAI_WEB_SEARCH_DESCRIPTION,
  promptSnippet: "Search the web through OpenAI and return a concise sourced answer",
  parameters: OPENAI_WEB_SEARCH_PARAMETERS,
  annotations: { readOnlyHint: true, openWorldHint: true },
  outputSchema: OPENAI_WEB_SEARCH_OUTPUT_SCHEMA,
  renderCall: renderOpenAIWebSearchCall,
  renderResult: renderOpenAIWebSearchResult,

  async execute(
    _toolCallId: string,
    params: { query: string; model?: OpenAIWebSearchModel },
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback | undefined,
    ctx: ExtensionToolContext,
  ) {
    onUpdate?.({ content: [{ type: "text", text: "Searching the web with OpenAI..." }] });
    const query = params.query.trim();
    if (!query) throw new Error("The web search query must not be empty.");

    const model = params.model ?? DEFAULT_OPENAI_WEB_SEARCH_MODEL;
    if (!isOpenAIWebSearchModel(model)) {
      throw new Error(`Unsupported OpenAI web search model: ${String(model)}.`);
    }

    return executeNativeWebSearch(query, model, signal, ctx);
  },
};

const RESPONSE_EVENTS = new Set([
  "response.done",
  "response.completed",
  "response.incomplete",
  "response.failed",
]);
const SEARCH_SOURCES_INCLUDE = "web_search_call.action.sources";

/** Provider failures that are safe to retry with the other credential before any search output arrives. */
const AUTHENTICATION_ERROR_PATTERN =
  /\b(?:oauth|unauthori[sz]ed|unauthenticated|authentication|credential|api[\s_-]?key|access[\s_-]?token)\b|\b(?:invalidated|revoked|expired)\b.*\btoken\b|\btoken\b.*\b(?:invalid|expired|revoked|invalidated)\b|\b40[13]\b/i;
const TRANSPORT_ERROR_PATTERN =
  /\bfetch failed\b|\bnetwork\b|\bconnection\b|\bsocket\b|\bECONN(?:RESET|REFUSED|ABORTED)\b|\bENOTFOUND\b|\bEAI_AGAIN\b|\bETIMEDOUT\b|\bUND_ERR_[A-Z_]+\b|\btimeout\b|\btimed out\b|\bTLS\b|\bcertificate\b/i;

/**
 * Providers that can run a server-side web_search, in preference order. Both Pi's
 * `openai` provider (API key or ChatGPT OAuth) and the legacy `openai-codex` OAuth
 * provider resolve to one of these, so a single code path covers every credential.
 */
const NATIVE_SEARCH_PROVIDERS = [
  {
    provider: "openai",
    api: "openai-responses",
    requireUrlSources: true,
    thinkingLevel: "low",
    searchContextSize: "medium",
  },
  {
    provider: "openai-codex",
    api: "openai-codex-responses",
    requireUrlSources: false,
    thinkingLevel: undefined,
    searchContextSize: undefined,
  },
] as const;

type NativeSearchTarget = (typeof NATIVE_SEARCH_PROVIDERS)[number] & {
  model: Parameters<ExtensionToolContext["modelRegistry"]["complete"]>[0];
};

class WebSearchAttemptError extends Error {
  readonly provider: string;
  readonly model: string;
  readonly retryable: boolean;

  constructor(message: string, provider: string, model: string, retryable: boolean) {
    super(message);
    this.name = "WebSearchAttemptError";
    this.provider = provider;
    this.model = model;
    this.retryable = retryable;
  }
}

async function executeNativeWebSearch(
  query: string,
  modelId: OpenAIWebSearchModel,
  signal: AbortSignal | undefined,
  ctx: ExtensionToolContext,
) {
  const triedProviders = new Set<string>();
  const failures: WebSearchAttemptError[] = [];

  for (;;) {
    const target = await findNativeSearchTarget(modelId, signal, ctx, triedProviders);
    if (!target) {
      if (failures.length === 0) {
        throw new Error(
          `No usable OpenAI credential found. Sign in with \`/login openai\` or \`/login openai-codex\`; ensure ${modelId} is available.`,
        );
      }
      throw buildFinalSearchError(failures);
    }

    triedProviders.add(target.provider);

    try {
      return await executeNativeWebSearchWithTarget(query, modelId, target, signal, ctx);
    } catch (error) {
      if (signal?.aborted) throw error;

      const attempt = toWebSearchAttemptError(error, target);
      failures.push(attempt);
      if (!attempt.retryable) throw buildFinalSearchError(failures);
    }
  }
}

async function executeNativeWebSearchWithTarget(
  query: string,
  modelId: OpenAIWebSearchModel,
  target: NativeSearchTarget,
  signal: AbortSignal | undefined,
  ctx: ExtensionToolContext,
) {
  let responsePayload: OpenAIWebSearchResponse | undefined;
  const collectedItems: unknown[] = [];
  let sawProviderOutput = false;

  let completion: Awaited<ReturnType<ExtensionToolContext["modelRegistry"]["complete"]>>;
  try {
    completion = await ctx.modelRegistry.complete(
      target.model,
      {
        systemPrompt: OPENAI_WEB_SEARCH_INSTRUCTIONS,
        messages: [{ role: "user", content: [{ type: "text", text: query }], timestamp: Date.now() }],
      },
      {
        signal,
        ...(target.thinkingLevel ? { thinkingLevel: target.thinkingLevel } : {}),
        onPayload(payload) {
          const searchPayload = addNativeWebSearchTool(
            payload,
            target.searchContextSize ? { searchContextSize: target.searchContextSize } : {},
          );
          if (!searchPayload) throw new Error("Could not prepare the OpenAI web_search request.");

          const existingInclude = Array.isArray(searchPayload.include)
            ? searchPayload.include.filter((value): value is string => typeof value === "string")
            : [];
          return {
            ...searchPayload,
            tool_choice: "required",
            include: existingInclude.includes(SEARCH_SOURCES_INCLUDE)
              ? existingInclude
              : [...existingInclude, SEARCH_SOURCES_INCLUDE],
          };
        },
        onProviderStreamEvent(event) {
          if (!isRecord(event) || typeof event.type !== "string") return;
          // Both Responses transports stream output items (web_search_call, message) in
          // response.output_item.done events; their final response.output can be empty.
          if (event.type === "response.output_item.done" && isRecord(event.item)) {
            collectedItems.push(event.item);
            sawProviderOutput = true;
            return;
          }
          if (
            event.type === "response.output_item.added" &&
            isRecord(event.item) &&
            event.item.type === "web_search_call"
          ) {
            sawProviderOutput = true;
          }
          if (event.type.startsWith("response.web_search_call.")) {
            sawProviderOutput = true;
          }
          if (RESPONSE_EVENTS.has(event.type) && isRecord(event.response)) {
            responsePayload = event.response as unknown as OpenAIWebSearchResponse;
            if (Array.isArray(responsePayload.output) && responsePayload.output.length > 0) {
              sawProviderOutput = true;
            }
          }
        },
      },
    );
  } catch (error) {
    const message = formatErrorMessage(error);
    throw new WebSearchAttemptError(
      message,
      target.provider,
      target.model.id,
      !sawProviderOutput && !signal?.aborted && isRetryableProviderError(message),
    );
  }

  if (completion.stopReason !== "stop") {
    const message =
      completion.errorMessage?.trim() || `OpenAI web search ended with ${completion.stopReason}.`;
    throw new WebSearchAttemptError(
      message,
      target.provider,
      target.model.id,
      !sawProviderOutput && !signal?.aborted && isRetryableProviderError(message),
    );
  }

  if (!responsePayload) {
    throw new WebSearchAttemptError(
      "OpenAI did not return a final Responses payload.",
      target.provider,
      target.model.id,
      !sawProviderOutput && !signal?.aborted,
    );
  }

  const payload = { ...responsePayload, output: mergeOutputItems(responsePayload.output, collectedItems) };
  let result: ReturnType<typeof buildOpenAIWebSearchResult>;
  try {
    result = buildOpenAIWebSearchResult(payload, modelId, {
      requireUrlSources: target.requireUrlSources,
    });
  } catch (error) {
    throw new WebSearchAttemptError(
      formatErrorMessage(error),
      target.provider,
      target.model.id,
      false,
    );
  }

  return { ...result, usage: completion.usage };
}

async function findNativeSearchTarget(
  modelId: OpenAIWebSearchModel,
  signal: AbortSignal | undefined,
  ctx: ExtensionToolContext,
  excludedProviders: ReadonlySet<string>,
): Promise<NativeSearchTarget | undefined> {
  for (const candidate of NATIVE_SEARCH_PROVIDERS) {
    if (excludedProviders.has(candidate.provider)) continue;

    const models = await ctx.modelRegistry.getAvailableOfType("chat", candidate.provider, { signal });
    const model = models.find((entry) => entry.id === modelId && entry.api === candidate.api);
    if (model) return { ...candidate, model };
  }

  return undefined;
}

function toWebSearchAttemptError(error: unknown, target: NativeSearchTarget): WebSearchAttemptError {
  return error instanceof WebSearchAttemptError
    ? error
    : new WebSearchAttemptError(formatErrorMessage(error), target.provider, target.model.id, false);
}

function buildFinalSearchError(failures: readonly WebSearchAttemptError[]): Error {
  const details =
    failures.length === 1
      ? `via ${formatSearchTarget(failures[0])}: ${failures[0].message}`
      : `via all available credentials:\n${failures
          .map((failure) => `- ${formatSearchTarget(failure)}: ${failure.message}`)
          .join("\n")}`;
  return new Error(`OpenAI web search failed ${details}${buildRecoveryHint(failures)}`);
}

function formatSearchTarget(failure: WebSearchAttemptError): string {
  return `${failure.provider} (${failure.model})`;
}

function buildRecoveryHint(failures: readonly WebSearchAttemptError[]): string {
  const providers = [...new Set(failures.map((failure) => failure.provider))];
  const loginCommands = providers.map((provider) => `\`/login ${provider}\``).join(" or ");
  const messages = failures.map((failure) => failure.message);

  if (messages.some(isAuthenticationError)) {
    return `\nRun ${loginCommands} to refresh the credential.`;
  }
  if (messages.some(isTransportError)) {
    return `\nCheck the network or proxy, then retry; if it persists, run ${loginCommands}.`;
  }
  return "";
}

function isRetryableProviderError(message: string): boolean {
  return isAuthenticationError(message) || isTransportError(message);
}

function isAuthenticationError(message: string): boolean {
  return AUTHENTICATION_ERROR_PATTERN.test(message);
}

function isTransportError(message: string): boolean {
  return TRANSPORT_ERROR_PATTERN.test(message);
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.trim() || error.name;
  if (typeof error === "string" && error.trim()) return error.trim();
  return "Unknown error";
}

/** Merge streamed output items into the final payload, preferring the final response's entries. */
function mergeOutputItems(finalOutput: unknown, collectedItems: unknown[]): unknown[] {
  const items = Array.isArray(finalOutput) ? [...finalOutput] : [];
  const seen = new Set(items.map(readItemId).filter((id): id is string => id !== undefined));

  for (const item of collectedItems) {
    const id = readItemId(item);
    if (id !== undefined) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    items.push(item);
  }
  return items;
}

function readItemId(item: unknown): string | undefined {
  return isRecord(item) && typeof item.id === "string" ? item.id : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export default function codexWebSearchExtension(pi: ExtensionAPI): void {
  // Register at load (hidden) so the TUI can resolve the tool definition while it replays the
  // transcript: on /reload the chat is rebuilt before session_start handlers run, and without a
  // definition those rows fall back to the generic renderer.
  pi.registerTool({ ...OPENAI_WEB_SEARCH_TOOL, exposure: "hidden" });
  let searchToolExposure: "direct" | "hidden" = "hidden";

  const syncSearchToolExposure = (model: { provider?: string; api?: string } | undefined) => {
    if (!model) {
      if (searchToolExposure === "direct") {
        pi.registerTool({ ...OPENAI_WEB_SEARCH_TOOL, exposure: "hidden" });
        searchToolExposure = "hidden";
      }
      return;
    }

    const exposure = isCodexModel(model) ? "hidden" : "direct";
    if (exposure === searchToolExposure) return;

    pi.registerTool({ ...OPENAI_WEB_SEARCH_TOOL, exposure });
    searchToolExposure = exposure;
  };

  pi.on("session_start", (_event, ctx) => {
    syncSearchToolExposure(ctx.model);
  });

  pi.on("model_select", (event) => {
    syncSearchToolExposure(event.model);
  });

  pi.on("before_agent_start", (event, ctx) => {
    syncSearchToolExposure(ctx.model);
    const guidance = isCodexModel(ctx.model) ? CODEX_AUTO_GUIDANCE : GENERAL_AUTO_GUIDANCE;
    return { systemPrompt: `${event.systemPrompt}\n\n${guidance}` };
  });

  pi.on("before_provider_request", (event, ctx) => {
    if (!isCodexModel(ctx.model)) return;
    return addNativeWebSearchTool(event.payload);
  });
}
