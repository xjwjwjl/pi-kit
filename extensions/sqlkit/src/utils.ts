import process from "node:process";

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asTrimmedString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

export function asBoolean(value: unknown, fallback = false): boolean {
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		if (value.toLowerCase() === "true") return true;
		if (value.toLowerCase() === "false") return false;
	}
	return fallback;
}

export function asPositiveInt(value: unknown, fallback: number): number {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
	if (typeof value === "string") {
		const parsed = Number.parseInt(value, 10);
		if (Number.isFinite(parsed) && parsed > 0) return parsed;
	}
	return fallback;
}

export function readPasswordOption(options: Record<string, unknown>): string {
	const envName = asTrimmedString(options.password_env);
	if (envName) return process.env[envName] ?? "";
	return typeof options.password === "string" ? options.password : "";
}

export function getContextCwd(ctx: unknown): string {
	if (isRecord(ctx) && typeof ctx.cwd === "string" && ctx.cwd) return ctx.cwd;
	return process.cwd();
}

export function escapeSqlString(value: string): string {
	return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

export function truncateText(value: string, maxChars: number): string {
	if (value.length <= maxChars) return value;
	return `${value.slice(0, maxChars)}...`;
}
