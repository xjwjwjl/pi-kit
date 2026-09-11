import { formatLineCount, imageBlocks, textBlocks } from "../core-utils.js";

export type ReadContinuationInfo = {
	nextOffset: number;
	remaining?: number;
};

export function readContinuationInfo(text: string): ReadContinuationInfo | undefined {
	const match = text.match(/\n\n\[([^\n]*\boffset=(\d+)\b[^\n]*)\]\s*$/s);
	if (!match) return undefined;
	const nextOffset = Number(match[2]);
	if (!Number.isFinite(nextOffset)) return undefined;
	const remainingMatch = match[1]?.match(/^(\d+)\s+more\s+lines?\b/i);
	return { nextOffset, remaining: remainingMatch ? Number(remainingMatch[1]) : undefined };
}

export function readContinuationOffset(text: string): number | undefined {
	return readContinuationInfo(text)?.nextOffset;
}

export function stripReadContinuationNotice(text: string): string {
	return readContinuationInfo(text) ? text.replace(/\n\n\[[^\n]*\boffset=\d+\b[^\n]*\]\s*$/s, "") : text;
}

export function stripReadTruncationNotice(text: string): string {
	return text.replace(/\n\n\[Showing lines? [^\n]*\]\s*$/i, "").replace(/\n\n\[Line [^\n]*\]\s*$/i, "");
}

function truncationSummary(truncation: any): string | undefined {
	if (truncation?.truncated !== true) return undefined;
	const outputLines = truncation.outputLines;
	const totalLines = truncation.totalLines;
	if (
		typeof outputLines === "number" &&
		Number.isFinite(outputLines) &&
		outputLines > 0 &&
		typeof totalLines === "number" &&
		Number.isFinite(totalLines) &&
		totalLines > outputLines
	) {
		return `${outputLines}/${totalLines}L`;
	}
	return "truncated";
}

/**
 * Read has two distinct ways to stop early, and only one of them sets `details.truncation`:
 * the built-in line/byte cap, and a user `limit` that ended before EOF. The second one only
 * leaves a continuation notice in the text, so it must be parsed or the collapsed row would
 * silently hide that the file continues.
 */
export function summarizeRead(result: any): string | undefined {
	const images = imageBlocks(result);
	if (images.length > 0) {
		const mime = images[0]?.mimeType ?? "image";
		return images.length === 1 ? mime : `${images.length} images`;
	}

	const truncation = truncationSummary(result?.details?.truncation);
	if (truncation) return truncation;

	const continuation = readContinuationInfo(textBlocks(result));
	return continuation?.remaining !== undefined ? `${formatLineCount(continuation.remaining)} more` : undefined;
}
