import { stripAnsi, trimTrailingEmptyLines } from "../core-utils.js";

export type EditReplacement = {
	oldText?: unknown;
	newText?: unknown;
};

export type EditArgs = {
	path?: string;
	file_path?: string;
	edits?: EditReplacement[] | string;
	oldText?: unknown;
	newText?: unknown;
};

export type EditDiffStat = {
	added: number;
	removed: number;
	lines: number;
};

const INLINE_DIFF_MAX_LINES = 64;

export function summarizeEditDiff(diff: string | undefined): EditDiffStat | undefined {
	if (typeof diff !== "string") return undefined;
	const lines = trimTrailingEmptyLines(stripAnsi(diff).split("\n"));
	let added = 0;
	let removed = 0;

	for (const line of lines) {
		if (/^\+(?!\+\+)/.test(line)) {
			added += 1;
		} else if (/^-(?!--)/.test(line)) {
			removed += 1;
		}
	}

	return { added, removed, lines: lines.length };
}

export function editDiffStatText(stat: EditDiffStat | undefined): string | undefined {
	if (!stat || (stat.added === 0 && stat.removed === 0)) return undefined;
	return `+${stat.added} -${stat.removed}`;
}

export function editSummaryText(diff: string | undefined): string | undefined {
	return editDiffStatText(summarizeEditDiff(diff));
}

export function shouldInlineEditDiff(diff: string | undefined, maxLines = INLINE_DIFF_MAX_LINES): boolean {
	const stat = summarizeEditDiff(diff);
	return Boolean(diff && stat && stat.lines > 0 && (maxLines === 0 || stat.lines <= maxLines));
}

export function compactEditError(text: string): string {
	const line = stripAnsi(text)
		.split("\n")
		.map((value) => value.trim())
		.find(Boolean) ?? "error";

	const indexedNotFound = line.match(/Could not find edits\[(\d+)\]/i);
	if (indexedNotFound) return `edits[${indexedNotFound[1]}] oldText not found`;
	if (/Could not find the exact text/i.test(line)) return "oldText not found";

	const indexedDuplicate = line.match(/Found\s+\d+\s+occurrences of edits\[(\d+)\]/i);
	if (indexedDuplicate) return `edits[${indexedDuplicate[1]}] oldText not unique`;
	if (/Found\s+\d+\s+occurrences of the text/i.test(line)) return "oldText not unique";

	const overlap = line.match(/(edits\[\d+\]\s+and\s+edits\[\d+\]\s+overlap)/i);
	if (overlap) return overlap[1];

	if (/No changes made/i.test(line)) return "no changes made";
	if (/Could not edit file/i.test(line) && /(?:ENOENT|not found|no such file)/i.test(line)) return "path not found";
	if (/(?:EACCES|EPERM|permission denied)/i.test(line)) return "permission denied";

	return line;
}
