import os from "node:os";

export function textBlocks(result: { content?: Array<any> } | undefined): string {
	return (result?.content ?? [])
		.filter((block) => block?.type === "text")
		.map((block) => (typeof block.text === "string" ? block.text : ""))
		.join("\n");
}

export function imageBlocks(result: { content?: Array<any> } | undefined): Array<any> {
	return (result?.content ?? []).filter((block) => block?.type === "image");
}

const CSI_SEQUENCE = /(?:\x1b\[[0-?]*[ -/]*[@-~]|\x9b[0-?]*[ -/]*[@-~])/g;
const OSC_SEQUENCE = /(?:\x1b\][\s\S]*?(?:\x07|\x1b\\)|\x9d[\s\S]*?(?:\x07|\x1b\\|\x9c))/g;
const STRING_CONTROL_SEQUENCE = /(?:\x1b[PX^_][\s\S]*?(?:\x1b\\|\x07)|[\x90\x98\x9e\x9f][\s\S]*?(?:\x1b\\|\x07|\x9c))/g;
const ESCAPE_SEQUENCE = /\x1b[ -/]*[@-~]/g;
const UNSAFE_CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;

export function stripAnsi(text: string): string {
	return text
		.replace(OSC_SEQUENCE, "")
		.replace(STRING_CONTROL_SEQUENCE, "")
		.replace(CSI_SEQUENCE, "")
		.replace(ESCAPE_SEQUENCE, "")
		.replace(/\r/g, "")
		.replace(UNSAFE_CONTROL_CHARS, "");
}

export function sanitizeInlineText(text: string): string {
	return stripAnsi(text).replace(/[\n\t]/g, " ");
}

export function trimTrailingEmptyLines(lines: string[]): string[] {
	let end = lines.length;
	while (end > 0 && lines[end - 1] === "") end--;
	return lines.slice(0, end);
}

export function countLines(text: string): number {
	const normalized = text.replace(/\r/g, "");
	if (!normalized) return 0;
	return normalized.endsWith("\n") ? normalized.slice(0, -1).split("\n").length : normalized.split("\n").length;
}

export function plural(count: number, one: string, many = `${one}s`): string {
	return `${count} ${count === 1 ? one : many}`;
}

/**
 * Compact line-count unit (`50L`) shared by every tool metadata row.
 *
 * The unit keeps a count to three characters on top of the number, so a metadata
 * slot never spells out `50 output lines` at the cost of the command or path next to it.
 */
export function formatLineCount(count: number): string {
	return `${count}L`;
}

export function formatDuration(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

/** Elapsed times below one second carry no signal on a compact metadata row. */
export const MIN_VISIBLE_DURATION_MS = 1000;

/** Format an elapsed time, or `undefined` when it is too small for a metadata slot. */
export function formatVisibleDuration(ms: number | undefined): string | undefined {
	if (ms === undefined || !Number.isFinite(ms) || ms < MIN_VISIBLE_DURATION_MS) return undefined;
	return formatDuration(ms);
}

export function shortPath(value: unknown): string {
	if (typeof value !== "string" || value.length === 0) return "...";
	const sanitized = sanitizeInlineText(value);
	const home = os.homedir();
	if (sanitized === home) return "~";
	if (sanitized.startsWith(home)) {
		const next = sanitized[home.length];
		if (next === "/" || next === "\\") return `~${sanitized.slice(home.length)}`;
	}
	return sanitized;
}

export function firstNonEmptyLine(text: string): string {
	return stripAnsi(text)
		.split("\n")
		.map((line) => line.trim())
		.find(Boolean) ?? "error";
}
