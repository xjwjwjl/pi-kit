import { isCredentialExpired } from "./codex-credential.ts";
import { curlJson, describeError, isAbortError } from "./codex-http.ts";
import type { CodexCredential, UsageResponse, UsageResult } from "./types.ts";

const USAGE_API = "https://chatgpt.com/backend-api/wham/usage";

export async function fetchUsage(
	credential: CodexCredential,
	signal?: AbortSignal,
): Promise<UsageResult> {
	if (signal?.aborted) return { status: "cancelled", usage: null };
	if (isCredentialExpired(credential)) {
		return { status: "expired", usage: null, error: "OAuth token expired" };
	}

	try {
		const response = await curlJson(USAGE_API, { accessToken: credential.access, signal });
		if (signal?.aborted) return { status: "cancelled", usage: null };
		const parsed = JSON.parse(response) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return { status: "error", usage: null, error: "invalid usage response" };
		}
		const usage = parsed as UsageResponse;
		return { status: "success", usage: normalizeUsageResponse(usage) };
	} catch (error) {
		if (signal?.aborted || isAbortError(error)) return { status: "cancelled", usage: null };
		return { status: "error", usage: null, error: describeError(error) };
	}
}

function normalizeUsageResponse(usage: UsageResponse): UsageResponse {
	const rateLimit = usage.rate_limit;
	return {
		...usage,
		allowed: usage.allowed ?? rateLimit?.allowed,
		limit_reached: usage.limit_reached ?? rateLimit?.limit_reached,
	};
}
