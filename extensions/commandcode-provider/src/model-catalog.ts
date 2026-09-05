import type { OpenAICompletionsCompat, Model, RefreshModelsContext, ThinkingLevelMap } from "@earendil-works/pi-ai";
import { fetchCommandCodeModels, type CommandCodeModelRecord } from "./api.ts";
import { COMMAND_CODE_BASE_URL, COMMAND_CODE_PROVIDER_ID } from "./constants.ts";

// Source: pi's built-in provider catalog (zai.json / deepseek.json). Declared
// before FALLBACK_COMMAND_CODE_MODELS so the top-level model calls can use them.
const GLM_THINKING_LEVEL_MAP: ThinkingLevelMap = {
    off: null,
    minimal: null,
    low: null,
    medium: null,
    high: "high",
    max: "max",
};

const DEEPSEEK_THINKING_LEVEL_MAP: ThinkingLevelMap = {
    off: null,
    minimal: null,
    low: "low",
    medium: null,
    high: "high",
    max: "max",
};

export const FALLBACK_COMMAND_CODE_MODELS: readonly Model<"openai-completions">[] = [
    createCommandCodeModel({
        id: "z-ai/glm-5.3-flash",
        name: "GLM-5.3 Flash",
        context_length: 1_048_576,
    }),
    createCommandCodeModel({
        id: "Qwen/Qwen3.8-Flash",
        name: "Qwen 3.8 Flash",
        context_length: 1_000_000,
    }),
    createCommandCodeModel({
        id: "deepseek/deepseek-v4-flash-fast",
        name: "DeepSeek V4 Flash Fast",
        context_length: 1_000_000,
    }),
    createCommandCodeModel({
        id: "deepseek/deepseek-v4-flash-vision-exp",
        name: "DeepSeek V4 Flash Vision",
        context_length: 1_000_000,
    }),
    createCommandCodeModel({
        id: "deepseek/deepseek-v4-flash",
        name: "DeepSeek V4 Flash",
        context_length: 1_000_000,
    }),
];

export async function fetchCommandCodeModelsForProvider(
    context: RefreshModelsContext,
): Promise<readonly Model<"openai-completions">[]> {
    if (!context.allowNetwork || context.signal.aborted) return [];

    const credential = context.credential;
    const apiKey = credential?.type === "oauth"
        ? credential.access
        : credential?.type === "api_key"
            ? credential.key
            : process.env.COMMANDCODE_API_KEY;
    if (!apiKey) throw new Error("Command Code is not authenticated. Run /login commandcode first.");

    const records = await fetchCommandCodeModels(apiKey, context.signal);
    return records.map(createCommandCodeModel);
}

export function createCommandCodeModel(record: CommandCodeModelRecord): Model<"openai-completions"> {
    const id = record.id.trim();
    const contextWindow = positiveInteger(record.context_length) ?? 1_000_000;

    return {
        id,
        name: typeof record.name === "string" && record.name.trim().length > 0 ? record.name.trim() : id,
        api: "openai-completions",
        provider: COMMAND_CODE_PROVIDER_ID,
        baseUrl: COMMAND_CODE_BASE_URL,
        reasoning: true,
        input: isVisionModel(id, record.name) ? ["text", "image"] : ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow,
        maxTokens: Math.min(128_000, contextWindow),
        ...thinkingConfig(id),
    };
}

/**
 * Reasoning/thinking config is model-family specific. Command Code aggregates
 * upstream models that speak different native protocols (Z.ai GLM uses
 * `thinking: { type }`, DeepSeek uses `thinking: { type }` plus
 * `reasoning_effort`). We send the upstream-native format and map pi thinking
 * levels to each family's supported effort values.
 */
function thinkingConfig(id: string): {
    thinkingLevelMap?: ThinkingLevelMap;
    compat?: Partial<OpenAICompletionsCompat>;
} {
    if (isGlmModel(id) || isZaiModel(id)) {
        return {
            thinkingLevelMap: GLM_THINKING_LEVEL_MAP,
            compat: {
                supportsDeveloperRole: false,
                supportsReasoningEffort: true,
                thinkingFormat: "zai",
            },
        };
    }
    if (isDeepSeekModel(id)) {
        return {
            thinkingLevelMap: DEEPSEEK_THINKING_LEVEL_MAP,
            compat: {
                supportsDeveloperRole: false,
                supportsReasoningEffort: true,
                thinkingFormat: "deepseek",
            },
        };
    }
    // Default openai shim: GLM/DeepSeek handled above; other families (e.g.
    // Qwen) keep OpenAI-style reasoning_effort passthrough.
    return {
        compat: {
            supportsDeveloperRole: false,
            supportsReasoningEffort: true,
        },
    };
}

function isGlmModel(id: string): boolean {
    return /glm/i.test(id);
}

function isZaiModel(id: string): boolean {
    return /z-ai|zai/i.test(id);
}

function isDeepSeekModel(id: string): boolean {
    return /deepseek/i.test(id);
}

function positiveInteger(value: unknown): number | undefined {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function isVisionModel(id: string, name?: string): boolean {
    return /vision|multimodal|image/i.test(`${id} ${name ?? ""}`);
}
