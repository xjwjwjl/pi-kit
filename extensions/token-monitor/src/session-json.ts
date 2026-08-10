export type JsonRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonRecord {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function stringValue(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const result = value.trim();
	return result || undefined;
}

export function timestampMs(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value !== "string" || !value.trim()) return undefined;
	const result = Date.parse(value);
	return Number.isFinite(result) ? result : undefined;
}

export function nonNegativeNumber(value: unknown): number {
	if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, value);
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return Math.max(0, parsed);
	}
	return 0;
}
