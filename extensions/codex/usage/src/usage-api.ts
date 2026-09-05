import { spawn } from "node:child_process";
import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import type { CodexCredential, UsageResponse, UsageResult } from "./types.ts";

const USAGE_API = "https://chatgpt.com/backend-api/wham/usage";

export function readCodexCredential(): CodexCredential | null {
	try {
		const stored = readStoredCredential("openai-codex");
		if (!stored || stored.type !== "oauth" || typeof stored.access !== "string" || !stored.access) return null;
		return {
			access: stored.access,
			expires: typeof stored.expires === "number" ? stored.expires : undefined,
		};
	} catch {
		return null;
	}
}

export function extractEmailFromJWT(token: string): string {
	try {
		const parts = token.split(".");
		if (parts.length < 2) return "";
		const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf-8"));
		return payload?.["https://api.openai.com/profile"]?.email || payload?.email || "";
	} catch {
		return "";
	}
}

export async function fetchUsage(
	credential: CodexCredential,
	signal?: AbortSignal,
): Promise<UsageResult> {
	if (signal?.aborted) return { status: "cancelled", usage: null };
	if (typeof credential.expires === "number" && Date.now() >= credential.expires) {
		return { status: "expired", usage: null, error: "OAuth token expired" };
	}

	try {
		const response = await curlGet(USAGE_API, credential.access, signal);
		if (signal?.aborted) return { status: "cancelled", usage: null };
		const parsed = JSON.parse(response) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return { status: "error", usage: null, error: "invalid usage response" };
		}
		const usage = parsed as UsageResponse;
		return { status: "success", usage: normalizeUsageResponse(usage) };
	} catch (error) {
		if (signal?.aborted) return { status: "cancelled", usage: null };
		return { status: "error", usage: null, error: describeRequestError(error) };
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

function describeRequestError(error: unknown): string {
	if (error instanceof Error && error.message) return error.message;
	return String(error);
}

function createAbortError(): Error {
	const error = new Error("curl request cancelled");
	error.name = "AbortError";
	return error;
}

function curlEscape(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function curlGet(url: string, accessToken: string, signal?: AbortSignal): Promise<string> {
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
				rejectOnce(new Error(`curl exit ${code}: ${stderr.trim() || stdout.slice(0, 160).trim()}`));
			}
		});
		signal?.addEventListener("abort", onAbort, { once: true });

		try {
			child.stdin.end([
				`url = "${curlEscape(url)}"`,
				'request = "GET"',
				`header = "Authorization: Bearer ${curlEscape(accessToken)}"`,
				'header = "Accept: application/json"',
				"connect-timeout = 10",
				"max-time = 20",
				"",
			].join("\n"));
		} catch (error) {
			rejectOnce(error);
		}
	});
}
