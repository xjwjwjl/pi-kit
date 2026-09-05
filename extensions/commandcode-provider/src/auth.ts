import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import type { ApiKeyCredential, ProviderAuthInteraction } from "@earendil-works/pi-ai";
import {
    COMMAND_CODE_CALLBACK_HOST,
    COMMAND_CODE_CALLBACK_PATH,
    COMMAND_CODE_CALLBACK_PORT,
    COMMAND_CODE_CALLBACK_PORT_ATTEMPTS,
    COMMAND_CODE_LOGIN_PATH,
    COMMAND_CODE_LOGIN_TIMEOUT_MS,
    COMMAND_CODE_STUDIO_URL,
} from "./constants.ts";

export interface CommandCodeAuthCallback {
    apiKey: string;
    state: string;
    userId?: string;
    userName?: string;
    keyName?: string;
}

export interface CommandCodeAuthDependencies {
    listenPort?: number;
    portAttempts?: number;
    timeoutMs?: number;
}

export function buildCommandCodeLoginUrl(input: {
    port: number;
    state: string;
    studioUrl?: string;
}): string {
    const url = new URL(COMMAND_CODE_LOGIN_PATH, input.studioUrl ?? COMMAND_CODE_STUDIO_URL);
    url.searchParams.set("callback", `http://localhost:${input.port}${COMMAND_CODE_CALLBACK_PATH}`);
    url.searchParams.set("state", input.state);
    return url.toString();
}

export function parseCommandCodeCallback(value: unknown, expectedState: string): CommandCodeAuthCallback {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Command Code returned an invalid login callback.");
    }

    const payload = value as Record<string, unknown>;
    if (typeof payload.error === "string") {
        throw new Error(payload.error_description && typeof payload.error_description === "string"
            ? payload.error_description
            : payload.error);
    }
    if (payload.state !== expectedState) {
        throw new Error("Command Code login callback state did not match.");
    }
    if (typeof payload.apiKey !== "string" || payload.apiKey.trim().length === 0) {
        throw new Error("Command Code login callback did not contain an API key.");
    }

    return {
        apiKey: payload.apiKey.trim(),
        state: expectedState,
        ...(typeof payload.userId === "string" ? { userId: payload.userId } : {}),
        ...(typeof payload.userName === "string" ? { userName: payload.userName } : {}),
        ...(typeof payload.keyName === "string" ? { keyName: payload.keyName } : {}),
    };
}

export async function loginCommandCode(
    interaction: ProviderAuthInteraction,
    dependencies: CommandCodeAuthDependencies = {},
): Promise<ApiKeyCredential> {
    interaction.signal.throwIfAborted();

    const state = randomBytes(32).toString("base64url");
    const callback = await startCallbackServer({
        state,
        signal: interaction.signal,
        startPort: dependencies.listenPort ?? COMMAND_CODE_CALLBACK_PORT,
        portAttempts: dependencies.portAttempts ?? COMMAND_CODE_CALLBACK_PORT_ATTEMPTS,
        timeoutMs: dependencies.timeoutMs ?? COMMAND_CODE_LOGIN_TIMEOUT_MS,
    });

    const loginUrl = buildCommandCodeLoginUrl({ port: callback.port, state });
    interaction.notify({
        type: "auth_url",
        url: loginUrl,
        instructions: "Complete Command Code login in your browser. Return here when it finishes.",
    });
    interaction.notify({ type: "progress", message: "Waiting for Command Code browser login…" });

    try {
        const result = await callback.waitForCallback();
        interaction.signal.throwIfAborted();
        return { type: "api_key", key: result.apiKey };
    } finally {
        await callback.close();
    }
}

interface CallbackServerHandle {
    port: number;
    waitForCallback: () => Promise<CommandCodeAuthCallback>;
    close: () => Promise<void>;
}

async function startCallbackServer(input: {
    state: string;
    signal: AbortSignal;
    startPort: number;
    portAttempts: number;
    timeoutMs: number;
}): Promise<CallbackServerHandle> {
    let resolveCallback!: (value: CommandCodeAuthCallback) => void;
    let rejectCallback!: (reason?: unknown) => void;
    let callbackSettled = false;

    const callbackPromise = new Promise<CommandCodeAuthCallback>((resolve, reject) => {
        resolveCallback = resolve;
        rejectCallback = reject;
    });

    const server = createServer((request, response) => {
        void handleCallbackRequest({
            request,
            response,
            expectedState: input.state,
            onSuccess: (value) => {
                if (callbackSettled) return;
                callbackSettled = true;
                resolveCallback(value);
            },
            onFailure: (error) => {
                if (callbackSettled) return;
                callbackSettled = true;
                rejectCallback(error);
            },
        });
    });

    const port = await listenOnAvailablePort(
        server,
        input.startPort,
        input.portAttempts,
        input.signal,
    );

    const timeout = setTimeout(() => {
        if (callbackSettled) return;
        callbackSettled = true;
        rejectCallback(new Error(`Command Code login timed out after ${Math.ceil(input.timeoutMs / 1000)} seconds.`));
    }, input.timeoutMs);
    timeout.unref?.();

    const onAbort = () => {
        if (callbackSettled) return;
        callbackSettled = true;
        rejectCallback(createAbortError());
    };
    input.signal.addEventListener("abort", onAbort, { once: true });

    return {
        port,
        waitForCallback: () => callbackPromise,
        close: async () => {
            clearTimeout(timeout);
            input.signal.removeEventListener("abort", onAbort);
            await closeServer(server);
        },
    };
}

async function listenOnAvailablePort(
    server: Server,
    startPort: number,
    attempts: number,
    signal: AbortSignal,
): Promise<number> {
    for (let offset = 0; offset < Math.max(1, attempts); offset++) {
        signal.throwIfAborted();
        const port = startPort + offset;
        try {
            await listen(server, port, signal);
            return port;
        } catch (error) {
            if (isAddressInUse(error) && offset + 1 < Math.max(1, attempts)) continue;
            throw error;
        }
    }
    throw new Error("Unable to find a free local port for Command Code login.");
}

function listen(server: Server, port: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        const onAbort = () => {
            cleanup();
            reject(createAbortError());
        };
        const onError = (error: Error) => {
            cleanup();
            reject(error);
        };
        const onListening = () => {
            cleanup();
            resolve();
        };
        const cleanup = () => {
            signal.removeEventListener("abort", onAbort);
            server.removeListener("error", onError);
            server.removeListener("listening", onListening);
        };

        if (signal.aborted) {
            reject(createAbortError());
            return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, COMMAND_CODE_CALLBACK_HOST);
    });
}

async function handleCallbackRequest(input: {
    request: IncomingMessage;
    response: ServerResponse;
    expectedState: string;
    onSuccess: (value: CommandCodeAuthCallback) => void;
    onFailure: (error: Error) => void;
}): Promise<void> {
    const { request, response } = input;
    applyCorsHeaders(response);

    const requestUrl = new URL(request.url ?? "/", "http://localhost");
    if (requestUrl.pathname !== COMMAND_CODE_CALLBACK_PATH) {
        sendJson(response, 404, { success: false, error: "Not found" });
        return;
    }
    if (request.method === "OPTIONS") {
        response.writeHead(204);
        response.end();
        return;
    }
    if (request.method !== "POST") {
        sendJson(response, 405, { success: false, error: "Method not allowed. Use POST." });
        return;
    }

    const body = await readRequestBody(request).catch(() => undefined);
    if (body === undefined) {
        sendJson(response, 413, { success: false, error: "Request body too large" });
        return;
    }

    let payload: unknown;
    try {
        payload = JSON.parse(body);
    } catch {
        sendJson(response, 400, { success: false, error: "Invalid JSON" });
        return;
    }

    if (isCallbackError(payload)) {
        sendJson(response, 200, { success: true });
        input.onFailure(new Error(payload.error_description ?? payload.error));
        return;
    }

    const state = payload && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as Record<string, unknown>).state
        : undefined;
    if (state !== input.expectedState) {
        sendJson(response, 403, { success: false, error: "Invalid state token" });
        return;
    }

    try {
        const callback = parseCommandCodeCallback(payload, input.expectedState);
        sendJson(response, 200, { success: true });
        input.onSuccess(callback);
    } catch (error) {
        sendJson(response, 400, { success: false, error: getErrorMessage(error) });
    }
}

function applyCorsHeaders(response: ServerResponse): void {
    response.setHeader("Access-Control-Allow-Origin", COMMAND_CODE_STUDIO_URL);
    response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type");
    response.setHeader("Vary", "Origin");
    response.setHeader("Content-Type", "application/json");
}

function sendJson(response: ServerResponse, status: number, payload: Record<string, unknown>): void {
    response.writeHead(status);
    response.end(JSON.stringify(payload));
}

function readRequestBody(request: IncomingMessage): Promise<string | undefined> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        const maxBytes = 32 * 1024;

        request.setEncoding("utf8");
        request.on("data", (chunk: string) => {
            size += Buffer.byteLength(chunk);
            if (size <= maxBytes) chunks.push(Buffer.from(chunk));
        });
        request.on("end", () => resolve(size <= maxBytes ? Buffer.concat(chunks).toString("utf8") : undefined));
        request.on("error", reject);
    });
}

function isCallbackError(value: unknown): value is { error: string; error_description?: string } {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const payload = value as Record<string, unknown>;
    return typeof payload.error === "string";
}

function isAddressInUse(error: unknown): boolean {
    return Boolean(error && typeof error === "object" && "code" in error && error.code === "EADDRINUSE");
}

async function closeServer(server: Server): Promise<void> {
    if (!server.listening) return;
    await new Promise<void>((resolve, reject) => {
        server.close((error) => {
            if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") reject(error);
            else resolve();
        });
    });
}

function createAbortError(): Error {
    const error = new Error("Command Code login cancelled.");
    error.name = "AbortError";
    return error;
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
