import { spawn } from "node:child_process";
import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import type {
	CodexCredential,
	ConsumeResetCreditRequest,
	ConsumeResetCreditResult,
	ResetCredit,
	ResetCreditOutcome,
	ResetCreditsResult,
	ResetCreditsSnapshot,
} from "./types.ts";

export const RESET_CREDITS_API = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
export const RESET_CREDITS_CONSUME_API = `${RESET_CREDITS_API}/consume`;

export function readCodexCredential(): CodexCredential | null {
	try {
		const stored = readStoredCredential("openai-codex");
		if (!stored || stored.type !== "oauth" || typeof stored.access !== "string" || !stored.access) return null;
		const accountId = (stored as { accountId?: unknown }).accountId;
		return {
			access: stored.access,
			expires: typeof stored.expires === "number" ? stored.expires : undefined,
			...(typeof accountId === "string" && accountId ? { accountId } : {}),
		};
	} catch {
		return null;
	}
}

export async function fetchResetCredits(
	credential: CodexCredential,
	signal?: AbortSignal,
): Promise<ResetCreditsResult> {
	if (signal?.aborted) return { status: "cancelled", credits: null };
	if (isExpired(credential)) return { status: "expired", credits: null, error: "OAuth token expired" };

	try {
		const response = await curlRequest(RESET_CREDITS_API, credential.access, {
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
	if (isExpired(credential)) return { status: "expired", outcome: null, error: "OAuth token expired" };

	try {
		const response = await curlRequest(RESET_CREDITS_CONSUME_API, credential.access, {
			method: "POST",
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

interface CurlRequestOptions {
	method?: "GET" | "POST";
	headers?: Record<string, string>;
	body?: string;
	signal?: AbortSignal;
}

function curlRequest(
	url: string,
	accessToken: string,
	options: CurlRequestOptions = {},
): Promise<string> {
	const signal = options.signal;
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(createAbortError());
			return;
		}

		const child = spawn("curl", ["-sS", "--fail-with-body", "--http1.1", "-K", "-"], { windowsHide: true });
		let stdout = "";
		let stderr = "";
		let settled = false;

		const finish = (callback: () => void) => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener("abort", onAbort);
			callback();
		};
		const rejectOnce = (error: unknown) => {
			if (settled) return;
			try {
				child.kill();
			} catch {
				// The process may already have exited.
			}
			finish(() => reject(error instanceof Error ? error : new Error(String(error))));
		};
		const onAbort = () => rejectOnce(createAbortError());

		child.stdout.setEncoding("utf-8");
		child.stderr.setEncoding("utf-8");
		child.stdout.on("data", (chunk: string) => { stdout += chunk; });
		child.stderr.on("data", (chunk: string) => { stderr += chunk; });
		child.stdin.on("error", rejectOnce);
		child.stdout.on("error", rejectOnce);
		child.stderr.on("error", rejectOnce);
		child.on("error", rejectOnce);
		child.on("close", (code) => {
			if (signal?.aborted) {
				rejectOnce(createAbortError());
			} else if (code === 0) {
				finish(() => resolve(stdout));
			} else {
				rejectOnce(new Error(formatCurlFailure(code, stderr, stdout)));
			}
		});
		signal?.addEventListener("abort", onAbort, { once: true });

		try {
			const config = [
				`url = "${curlEscape(url)}"`,
				`request = "${options.method ?? "GET"}"`,
				`header = "Authorization: Bearer ${curlEscape(accessToken)}"`,
				'header = "Accept: application/json"',
				...Object.entries(options.headers ?? {}).map(([name, value]) =>
					`header = "${curlEscape(`${name}: ${value}`)}"`),
				...(options.body === undefined ? [] : [`data-raw = "${curlEscape(options.body)}"`]),
				"connect-timeout = 10",
				"max-time = 20",
				"",
			].join("\n");
			child.stdin.end(config);
		} catch (error) {
			rejectOnce(error);
		}
	});
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

function isExpired(credential: CodexCredential): boolean {
	return typeof credential.expires === "number" && Date.now() >= credential.expires;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonNegativeInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function createAbortError(): Error {
	const error = new Error("curl request cancelled");
	error.name = "AbortError";
	return error;
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

function curlEscape(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * curl exits non-zero on HTTP errors (`--fail-with-body`) and prints the error to
 * stderr while the response body lands on stdout; surface both so backend
 * validation messages are not lost.
 */
function formatCurlFailure(code: number | null, stderr: string, stdout: string): string {
	const status = stderr.trim() || `curl exit ${code ?? "unknown"}`;
	const body = stdout.trim().replace(/\s+/g, " ");
	if (!body) return status;
	return `${status}; response body: ${body.length > 300 ? `${body.slice(0, 300)}…` : body}`;
}

function describeError(error: unknown): string {
	return error instanceof Error && error.message ? error.message : String(error);
}
