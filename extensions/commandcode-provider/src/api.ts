import { COMMAND_CODE_BASE_URL } from "./constants.ts";

export interface CommandCodeModelRecord {
    id: string;
    name?: string;
    context_length?: number;
    owned_by?: string;
    // Keep provider-specific capability metadata so model-catalog can inspect it
    // without requiring the gateway to settle on one schema up front.
    [key: string]: unknown;
}

interface CommandCodeModelsResponse {
    object?: string;
    data?: unknown;
}

export type FetchFn = typeof globalThis.fetch;

const MODEL_REQUEST_TIMEOUT_MS = 10_000;

export async function fetchCommandCodeModels(
    apiKey: string,
    signal: AbortSignal,
    fetchFn: FetchFn = globalThis.fetch,
): Promise<CommandCodeModelRecord[]> {
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(MODEL_REQUEST_TIMEOUT_MS)]);
    const response = await fetchFn(`${COMMAND_CODE_BASE_URL}/models`, {
        method: "GET",
        headers: {
            Accept: "application/json",
            Authorization: `Bearer ${apiKey}`,
        },
        signal: requestSignal,
    });

    if (!response.ok) {
        const detail = await readErrorDetail(response);
        if (response.status === 401 || response.status === 403) {
            throw new Error("Command Code authentication was rejected. Run /login commandcode again.");
        }
        throw new Error(`Command Code model discovery failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}`);
    }

    const payload = (await response.json()) as CommandCodeModelsResponse;
    if (!Array.isArray(payload.data)) {
        throw new Error("Command Code model discovery returned an invalid response.");
    }

    return payload.data.filter(isModelRecord);
}

function isModelRecord(value: unknown): value is CommandCodeModelRecord {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const record = value as Partial<CommandCodeModelRecord>;
    return typeof record.id === "string" && record.id.trim().length > 0;
}

async function readErrorDetail(response: Response): Promise<string> {
    try {
        const text = (await response.text()).trim();
        return text.slice(0, 240).replace(/[\r\n]+/g, " ");
    } catch {
        return "";
    }
}
