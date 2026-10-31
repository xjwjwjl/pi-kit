import { isCredentialExpired } from "./codex-credential.ts";
import { curlJson, describeError, isAbortError } from "./codex-http.ts";
import type { CodexCredential } from "./types.ts";
import type {
	ConsumeResetCreditRequest,
	ConsumeResetCreditResult,
	ResetCredit,
	ResetCreditOutcome,
	ResetCreditsResult,
	ResetCreditsSnapshot,
} from "./reset-types.ts";

export const RESET_CREDITS_API = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
export const RESET_CREDITS_CONSUME_API = `${RESET_CREDITS_API}/consume`;

export async function fetchResetCredits(
	credential: CodexCredential,
	signal?: AbortSignal,
): Promise<ResetCreditsResult> {
	if (signal?.aborted) return { status: "cancelled", credits: null };
	if (isCredentialExpired(credential)) return { status: "expired", credits: null, error: "OAuth token expired" };

	try {
		const response = await curlJson(RESET_CREDITS_API, {
			accessToken: credential.access,
			headers: accountHeaders(credential),
			signal,
		});
		if (signal?.aborted) return { status: "cancelled", credits: null };
		return { status: "success", credits: parseResetCreditsResponse(JSON.parse(response)) };
	} catch (error) {
		if (signal?.aborted || isAbortError(error)) return { status: "cancelled", credits: null };
		return { status: "error", credits: null, error: describeError(error) };
	}
}

export async function consumeResetCredit(
	credential: CodexCredential,
	request: ConsumeResetCreditRequest,
	signal?: AbortSignal,
): Promise<ConsumeResetCreditResult> {
	if (signal?.aborted) return { status: "cancelled", outcome: null };
	if (isCredentialExpired(credential)) return { status: "expired", outcome: null, error: "OAuth token expired" };

	try {
		const response = await curlJson(RESET_CREDITS_CONSUME_API, {
			method: "POST",
			accessToken: credential.access,
			headers: {
				...accountHeaders(credential),
				"Content-Type": "application/json",
			},
			body: JSON.stringify(buildConsumeResetCreditPayload(request)),
			signal,
		});
		if (signal?.aborted) return { status: "cancelled", outcome: null };
		return { status: "success", outcome: parseConsumeResetCreditResponse(JSON.parse(response)) };
	} catch (error) {
		if (signal?.aborted || isAbortError(error)) return { status: "cancelled", outcome: null };
		return { status: "error", outcome: null, error: describeError(error) };
	}
}

export function buildConsumeResetCreditPayload(request: ConsumeResetCreditRequest): Record<string, string> {
	// Wire format of the Codex backend client (codex-rs/backend-client):
	// the idempotency key is sent as `redeem_request_id`.
	return {
		redeem_request_id: request.idempotencyKey,
		...(request.creditId ? { credit_id: request.creditId } : {}),
	};
}

export function parseResetCreditsResponse(value: unknown): ResetCreditsSnapshot {
	if (!isRecord(value)) throw new Error("invalid reset-credit response");

	const credits = Array.isArray(value.credits)
		? value.credits.map(normalizeResetCredit).filter((credit): credit is ResetCredit => credit !== undefined)
		: [];
	const availableCount = nonNegativeInteger(value.available_count) ?? credits.length;
	const totalEarnedCount = nonNegativeInteger(value.total_earned_count);

	return {
		availableCount,
		...(totalEarnedCount === undefined ? {} : { totalEarnedCount }),
		credits,
	};
}

export function parseConsumeResetCreditResponse(value: unknown): ResetCreditOutcome {
	// Backend responds with { code: "reset" | "nothing_to_reset" | "no_credit" | "already_redeemed", windows_reset }.
	// Older/unknown deployments may use `outcome` with camelCase values, so accept both spellings.
	if (!isRecord(value)) throw new Error("invalid reset-credit consume response");
	const outcome = normalizeConsumeOutcome(value.code ?? value.outcome);
	if (!outcome) throw new Error("invalid reset-credit consume response");
	return outcome;
}

function normalizeConsumeOutcome(value: unknown): ResetCreditOutcome | undefined {
	if (typeof value !== "string") return undefined;
	switch (value) {
		case "reset":
			return "reset";
		case "nothing_to_reset":
		case "nothingToReset":
			return "nothingToReset";
		case "no_credit":
		case "noCredit":
			return "noCredit";
		case "already_redeemed":
		case "alreadyRedeemed":
			return "alreadyRedeemed";
		default:
			return undefined;
	}
}

function normalizeResetCredit(value: unknown): ResetCredit | undefined {
	if (!isRecord(value) || typeof value.id !== "string" || value.id.length === 0) return undefined;

	return {
		id: value.id,
		...(typeof value.reset_type === "string" ? { reset_type: value.reset_type } : {}),
		...(typeof value.is_supported_by_plan === "boolean"
			? { is_supported_by_plan: value.is_supported_by_plan }
			: {}),
		...(typeof value.status === "string" ? { status: value.status } : {}),
		...(normalizeTimestamp(value.granted_at) !== undefined
			? { granted_at: normalizeTimestamp(value.granted_at) }
			: {}),
		...(normalizeTimestamp(value.expires_at) !== undefined
			? { expires_at: normalizeTimestamp(value.expires_at) }
			: value.expires_at === null
				? { expires_at: null }
				: {}),
		...(value.title === null || typeof value.title === "string" ? { title: value.title } : {}),
		...(value.description === null || typeof value.description === "string" ? { description: value.description } : {}),
	};
}

function normalizeTimestamp(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.length > 0) {
		const parsed = Date.parse(value);
		return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : undefined;
	}
	return undefined;
}

function accountHeaders(credential: CodexCredential): Record<string, string> {
	return credential.accountId ? { "ChatGPT-Account-Id": credential.accountId } : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonNegativeInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}
