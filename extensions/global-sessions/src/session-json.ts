export type JsonRecord = Record<string, unknown>;

const ANSI_ESCAPE = /\u001B(?:[@-_][0-?]*[ -/]*[@-~]|\[[0-?]*[ -/]*[@-~])/g;

export function isRecord(value: unknown): value is JsonRecord {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function stripAnsi(value: string): string {
	return value.replace(ANSI_ESCAPE, "");
}

export function displayText(value: string): string {
	return stripAnsi(value).replace(/\r\n?/g, "\n").replace(/\u0000/g, "").trim();
}

export function normalizeText(value: string): string {
	return displayText(value).replace(/\s+/g, " ").trim();
}

export function limitText(value: string, maxChars: number): string {
	if (value.length <= maxChars) return value;
	return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

export function textFromContent(content: unknown): string {
	if (typeof content === "string") return displayText(content);
	if (!Array.isArray(content)) return "";

	return content
		.filter(isRecord)
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => displayText(block.text as string))
		.filter(Boolean)
		.join("\n");
}

export function timestampMs(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value !== "string" || !value.trim()) return undefined;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

export function modelLabel(provider: unknown, model: unknown): string | undefined {
	const modelId = typeof model === "string" ? model.trim() : "";
	if (!modelId) return undefined;
	const providerName = typeof provider === "string" ? provider.trim() : "";
	return providerName ? `${providerName}/${modelId}` : modelId;
}
