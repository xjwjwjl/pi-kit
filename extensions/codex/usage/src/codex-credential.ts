import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import type { CodexCredential } from "./types.ts";

/**
 * Read the current `openai-codex` OAuth credential through Pi's credential store.
 *
 * `accountId` is only present on newer Codex logins; the reset-credit endpoints
 * require it as a `ChatGPT-Account-Id` header when available.
 */
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

export function isCredentialExpired(credential: CodexCredential): boolean {
	return typeof credential.expires === "number" && Date.now() >= credential.expires;
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
