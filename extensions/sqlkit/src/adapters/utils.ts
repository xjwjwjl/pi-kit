// ── 适配器共享工具函数 ──
import type { ResolvedDataSource } from "../types.js";
import { asPositiveInt, asTrimmedString } from "../utils.js";

export function getStringOption(source: ResolvedDataSource, key: string): string | undefined {
	return asTrimmedString(source.options[key]);
}

export function getNumberOption(source: ResolvedDataSource, key: string, fallback: number): number {
	return asPositiveInt(source.options[key], fallback);
}

export function containsIgnoreCase(value: unknown, needle: string | undefined): boolean {
	if (!needle) return false;
	return String(value ?? "").toLowerCase().includes(needle.toLowerCase());
}

export function pushMatch(target: string[], value: string): void {
	if (!target.includes(value)) target.push(value);
}
