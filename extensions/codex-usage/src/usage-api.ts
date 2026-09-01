import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import type { UsageResponse } from "./types.ts";

const USAGE_API = "https://chatgpt.com/backend-api/wham/usage";
const AUTH_PATH = path.join(
	process.env.HOME || process.env.USERPROFILE || "",
	".pi",
	"agent",
	"auth.json",
);

export function loadAccessToken(): string | null {
	if (!fs.existsSync(AUTH_PATH)) return null;
	try {
		const raw = fs.readFileSync(AUTH_PATH, "utf-8");
		const doc = JSON.parse(raw);
		return doc?.["openai-codex"]?.access || null;
	} catch {
		return null;
	}
}

export function extractEmailFromJWT(token: string): string {
	try {
		const parts = token.split(".");
		if (parts.length < 2) return "";
		const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8"));
		return payload?.["https://api.openai.com/profile"]?.email
			|| payload?.email
			|| "";
	} catch {
		return "";
	}
}

export async function fetchUsage(accessToken: string): Promise<UsageResponse> {
	// Node fetch/undici does not honor http_proxy/https_proxy by default.
	// Use curl, which works with the user's proxy environment. Feed config via stdin
	// so the bearer token is not exposed in process arguments.
	const body = await curlGet(USAGE_API, accessToken);
	return JSON.parse(body) as UsageResponse;
}

function curlEscape(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

function curlGet(url: string, accessToken: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn("curl", ["-sS", "--fail-with-body", "-K", "-"], { windowsHide: true });
		let stdout = "";
		let stderr = "";

		child.stdout.setEncoding("utf-8");
		child.stderr.setEncoding("utf-8");
		child.stdout.on("data", (chunk) => { stdout += chunk; });
		child.stderr.on("data", (chunk) => { stderr += chunk; });
		child.on("error", reject);
		child.on("close", (code) => {
			if (code !== 0) {
				reject(new Error(`curl exit ${code}: ${stderr.trim() || stdout.slice(0, 160).trim()}`));
				return;
			}
			resolve(stdout);
		});

		child.stdin.end([
			`url = "${curlEscape(url)}"`,
			`request = "GET"`,
			`header = "Authorization: Bearer ${curlEscape(accessToken)}"`,
			`header = "Accept: application/json"`,
			`connect-timeout = 10`,
			`max-time = 20`,
			"",
		].join("\n"));
	});
}
