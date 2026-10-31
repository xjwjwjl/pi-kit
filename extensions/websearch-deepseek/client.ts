const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RETRIES = 2;
const BASE_RETRY_DELAY_MS = 500;
const MAX_RETRY_DELAY_MS = 5_000;
const MAX_ERROR_TEXT_LENGTH = 4_000;

export class DeepSeekApiError extends Error {
	readonly status: number;
	readonly code?: string;
	readonly type?: string;
	readonly retryable: boolean;

	constructor(message: string, status: number, options: { code?: string; type?: string; retryable: boolean }) {
		super(message);
		this.name = "DeepSeekApiError";
		this.status = status;
		this.code = options.code;
		this.type = options.type;
		this.retryable = options.retryable;
	}
}

export interface DeepSeekRequestOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
	maxRetries?: number;
}

export async function postDeepSeekJson<T>(
	url: string,
	body: unknown,
	apiKey: string,
	options: DeepSeekRequestOptions = {},
): Promise<T> {
	const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;

	for (let attempt = 0; ; attempt += 1) {
		let response: Response;
		try {
			response = await fetchWithTimeout(
				url,
				{
					method: "POST",
					headers: {
						Authorization: `Bearer ${apiKey}`,
						"Content-Type": "application/json",
						Accept: "application/json",
					},
					body: JSON.stringify(body),
				},
				options.signal,
				options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
			);
		} catch (error) {
			if (options.signal?.aborted) throw error;
			if (attempt < maxRetries) {
				await sleep(getBackoffDelayMs(attempt), options.signal);
				continue;
			}
			throw new Error(`DeepSeek request failed: ${formatError(error)}`);
		}

		if (response.ok) {
			try {
				return (await response.json()) as T;
			} catch {
				throw new Error(`DeepSeek returned invalid JSON (HTTP ${response.status}).`);
			}
		}

		const errorText = truncateErrorText(await response.text());
		const apiError = buildApiError(response.status, response.statusText, errorText);
		if (!apiError.retryable || attempt >= maxRetries) throw apiError;

		await sleep(getRetryDelayMs(response.headers, attempt), options.signal);
	}
}

function buildApiError(status: number, statusText: string, bodyText: string): DeepSeekApiError {
	const parsed = parseErrorBody(bodyText);
	const detail = parsed.message || bodyText || statusText || "Unknown error";
	const retryable = status === 408 || status === 429 || status >= 500;
	const message = formatStatusMessage(status, detail);
	return new DeepSeekApiError(message, status, {
		code: parsed.code,
		type: parsed.type,
		retryable,
	});
}

function formatStatusMessage(status: number, detail: string): string {
	switch (status) {
		case 400:
			return `DeepSeek rejected the request: ${detail}`;
		case 401:
			return "DeepSeek API key is invalid or missing.";
		case 402:
			return "DeepSeek API balance is insufficient.";
		case 403:
			return "DeepSeek refused the request (security policy).";
		case 404:
			return "DeepSeek could not retrieve usable content for this request.";
		case 408:
			return "DeepSeek request timed out.";
		case 413:
			return "DeepSeek request body is too large.";
		case 429:
			return "DeepSeek rate limit exceeded. Retry later.";
		default:
			if (status >= 500) return `DeepSeek server error (HTTP ${status}).`;
			return `DeepSeek API error (HTTP ${status}): ${detail}`;
	}
}

function parseErrorBody(bodyText: string): { message?: string; code?: string; type?: string } {
	if (!bodyText) return {};
	try {
		const parsed: unknown = JSON.parse(bodyText);
		if (!isObject(parsed)) return {};
		const error = parsed.error;
		if (!isObject(error)) return {};
		return {
			message: typeof error.message === "string" ? error.message : undefined,
			code: typeof error.code === "string" ? error.code : undefined,
			type: typeof error.type === "string" ? error.type : undefined,
		};
	} catch {
		return {};
	}
}

async function fetchWithTimeout(
	input: string,
	init: RequestInit,
	parentSignal: AbortSignal | undefined,
	timeoutMs: number,
): Promise<Response> {
	const controller = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);

	const abortFromParent = () => {
		controller.abort(parentSignal?.reason);
	};

	if (parentSignal?.aborted) {
		clearTimeout(timer);
		throw parentSignal.reason ?? new Error("DeepSeek request was aborted.");
	}
	parentSignal?.addEventListener("abort", abortFromParent, { once: true });

	try {
		return await fetch(input, { ...init, signal: controller.signal });
	} catch (error) {
		if (timedOut) {
			throw new Error(`DeepSeek request timed out after ${timeoutMs}ms.`);
		}
		throw error;
	} finally {
		clearTimeout(timer);
		parentSignal?.removeEventListener("abort", abortFromParent);
	}
}

function getRetryDelayMs(headers: Headers, attempt: number): number {
	const retryAfter = headers.get("retry-after")?.trim();
	if (retryAfter) {
		const seconds = Number(retryAfter);
		if (Number.isFinite(seconds)) {
			return clampDelay(seconds * 1_000);
		}
		const date = Date.parse(retryAfter);
		if (Number.isFinite(date)) {
			return clampDelay(date - Date.now());
		}
	}
	return getBackoffDelayMs(attempt);
}

function getBackoffDelayMs(attempt: number): number {
	return Math.min(BASE_RETRY_DELAY_MS * 2 ** attempt, MAX_RETRY_DELAY_MS);
}

function clampDelay(delayMs: number): number {
	return Math.min(Math.max(delayMs, 0), MAX_RETRY_DELAY_MS);
}

function sleep(delayMs: number, signal?: AbortSignal): Promise<void> {
	if (delayMs <= 0) return Promise.resolve();

	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", abort);
			resolve();
		}, delayMs);

		const abort = () => {
			clearTimeout(timer);
			reject(signal?.reason ?? new Error("DeepSeek request was aborted."));
		};

		if (signal?.aborted) {
			abort();
			return;
		}
		signal?.addEventListener("abort", abort, { once: true });
	});
}

function truncateErrorText(text: string): string {
	const normalized = text.trim();
	if (normalized.length <= MAX_ERROR_TEXT_LENGTH) return normalized;
	return `${normalized.slice(0, MAX_ERROR_TEXT_LENGTH)}... [truncated ${normalized.length - MAX_ERROR_TEXT_LENGTH} chars]`;
}

function formatError(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === "string" && error.trim()) return error.trim();
	return "Unknown error";
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
