import type { OpenAICompletionsCompat, Model, RefreshModelsContext, ThinkingLevelMap } from "@earendil-works/pi-ai";
import { fetchCommandCodeModels, type CommandCodeModelRecord } from "./api.ts";
import { COMMAND_CODE_BASE_URL, COMMAND_CODE_PROVIDER_ID } from "./constants.ts";

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

const CAPABILITY_CONTAINER_KEYS = [
    "capabilities",
    "capability",
    "features",
    "architecture",
    "metadata",
] as const;

const MODALITY_KEYS = [
    "input_modalities",
    "inputModalities",
    "supported_input_modalities",
    "supportedInputModalities",
    "supported_modalities",
    "supportedModalities",
    "input_types",
    "inputTypes",
    "supported_inputs",
    "supportedInputs",
    "input",
    "modalities",
] as const;

const VISION_FLAG_KEYS = [
    "vision",
    "supports_vision",
    "supportsVision",
    "image",
    "images",
    "supports_image",
    "supportsImage",
    "supports_images",
    "supportsImages",
    "image_input",
    "imageInput",
    "supports_image_input",
    "supportsImageInput",
    "supports_visual_input",
    "supportsVisualInput",
] as const;

const KNOWN_MODALITY_TOKENS = new Set([
    "text",
    "image",
    "vision",
    "audio",
    "video",
    "file",
    "document",
    "pdf",
]);

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
        input: modelInput(record, id),
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow,
        maxTokens: Math.min(128_000, contextWindow),
        ...thinkingConfig(id),
    };
}

type JsonRecord = Record<string, unknown>;
type ModelInput = Array<"text" | "image">;

function modelInput(record: CommandCodeModelRecord, id: string): ModelInput {
    const apiCapability = readImageCapability(record);
    const supportsImage = apiCapability ?? isVisionModel(id, record.name);
    return supportsImage ? ["text", "image"] : ["text"];
}

/**
 * Capability metadata wins over name matching. The gateway currently returns
 * the standard OpenAI model fields only, so keep the fallback for older or
 * incomplete catalogs and accept the common capability shapes when available.
 */
function readImageCapability(record: CommandCodeModelRecord): boolean | undefined {
    const root = record as JsonRecord;
    const sources = [
        ...CAPABILITY_CONTAINER_KEYS.map((key) => root[key]),
        root,
    ];

    for (const source of sources) {
        const result = readInputModalities(source);
        if (result !== undefined) return result;
    }
    for (const source of sources) {
        const result = readVisionFlags(source);
        if (result !== undefined) return result;
    }
    return undefined;
}

function readInputModalities(value: unknown): boolean | undefined {
    const source = asRecord(value);
    if (!source) return parseModalityValue(value);

    for (const key of MODALITY_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
        const result = parseModalityValue(source[key]);
        if (result !== undefined) return result;
    }
    return parseModalityMap(source);
}

function readVisionFlags(value: unknown): boolean | undefined {
    const source = asRecord(value);
    if (!source) return undefined;

    for (const key of VISION_FLAG_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
        const result = parseBooleanCapability(source[key]);
        if (result !== undefined) return result;
    }
    return undefined;
}

function parseModalityValue(value: unknown): boolean | undefined {
    if (Array.isArray(value)) return parseModalityEntries(value);
    if (typeof value === "string") {
        return parseModalityEntries(value.split(/[\s,|+/]+/));
    }
    const source = asRecord(value);
    return source ? parseModalityMap(source) : undefined;
}

function parseModalityEntries(values: readonly unknown[]): boolean | undefined {
    let sawKnownModality = false;
    for (const value of values) {
        const token = modalityToken(value);
        if (!token) continue;
        if (isImageModality(token)) return true;
        if (KNOWN_MODALITY_TOKENS.has(token)) sawKnownModality = true;
    }
    return sawKnownModality ? false : undefined;
}

function parseModalityMap(source: JsonRecord): boolean | undefined {
    let sawKnownModality = false;
    for (const [key, value] of Object.entries(source)) {
        const token = modalityToken(key);
        if (!token) continue;
        if (isImageModality(token)) {
            const enabled = parseBooleanCapability(value);
            if (enabled === true) return true;
            if (enabled === false) sawKnownModality = true;
            continue;
        }
        if (!KNOWN_MODALITY_TOKENS.has(token)) continue;
        if (parseBooleanCapability(value) === true) sawKnownModality = true;
    }
    return sawKnownModality ? false : undefined;
}

function modalityToken(value: unknown): string | undefined {
    if (typeof value === "string") {
        const token = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
        return token || undefined;
    }
    const source = asRecord(value);
    if (!source) return undefined;
    for (const key of ["type", "modality", "name", "id"]) {
        const token = modalityToken(source[key]);
        if (token) return token;
    }
    return undefined;
}

function parseBooleanCapability(value: unknown): boolean | undefined {
    if (typeof value === "boolean") return value;
    if (typeof value === "number") {
        if (value === 1) return true;
        if (value === 0) return false;
    }
    if (typeof value !== "string") return undefined;
    switch (value.trim().toLowerCase()) {
        case "true":
        case "yes":
        case "supported":
        case "enabled":
        case "on":
        case "1":
            return true;
        case "false":
        case "no":
        case "unsupported":
        case "disabled":
        case "off":
        case "0":
            return false;
        default:
            return undefined;
    }
}

function asRecord(value: unknown): JsonRecord | undefined {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value as JsonRecord
        : undefined;
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
    if (/vision|multimodal|image/i.test(`${id} ${name ?? ""}`)) return true;

    const slug = id.split("/").at(-1)?.trim().toLowerCase();
    return slug === "deepseek-flash"
        || slug === "deepseek-v4-flash"
        || slug === "deepseek-v4.1-flash";
}

function isImageModality(token: string): boolean {
    return token === "vision" || token.startsWith("image") || token.includes("vision");
}
