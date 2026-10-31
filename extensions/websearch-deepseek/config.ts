import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { resolveTimeZone } from "./temporal.js";

export const SETTINGS_KEY = "websearch-deepseek";
export const DEFAULT_BASE_URL = "https://api.deepseek.com";

export interface ExtensionSettings {
	apiKey?: string;
	baseUrl?: string;
	timeZone?: string;
}

export interface DeepSeekConfig {
	apiKey: string;
	apiKeySource: "settings" | "environment" | "missing";
	baseUrl: string;
	timeZone: string;
	settingsPath: string;
}

export function resolveConfig(): DeepSeekConfig {
	const settingsPath = join(getAgentDir(), "settings.json");
	const settings = readSettings(settingsPath);
	const settingsApiKey = settings.apiKey?.trim();
	const environmentApiKey = process.env.DEEPSEEK_API_KEY?.trim();
	const apiKey = settingsApiKey || environmentApiKey || "";

	return {
		apiKey,
		apiKeySource: settingsApiKey ? "settings" : environmentApiKey ? "environment" : "missing",
		baseUrl: normalizeBaseUrl(settings.baseUrl),
		timeZone: resolveTimeZone(settings.timeZone),
		settingsPath,
	};
}

export function missingApiKeyMessage(settingsPath: string): string {
	return `DeepSeek API key is not configured. Set "websearch-deepseek.apiKey" in ${settingsPath} or export DEEPSEEK_API_KEY.`;
}

export function normalizeBaseUrl(value?: string): string {
	const raw = value?.trim() || DEFAULT_BASE_URL;
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error(`Invalid "websearch-deepseek.baseUrl": ${raw}`);
	}

	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error(`Invalid "websearch-deepseek.baseUrl": only HTTP and HTTPS are supported.`);
	}

	url.hash = "";
	url.search = "";
	let pathname = url.pathname.replace(/\/+$/, "");
	if (pathname === "/v1") pathname = "";
	url.pathname = pathname;
	return url.toString().replace(/\/$/, "");
}

function readSettings(settingsPath: string): ExtensionSettings {
	try {
		const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
		if (!isObject(parsed)) return {};
		const settings = parsed[SETTINGS_KEY];
		return isObject(settings) ? (settings as ExtensionSettings) : {};
	} catch {
		return {};
	}
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
