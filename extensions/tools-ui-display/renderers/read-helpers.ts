import { imageBlocks } from "../core-utils.js";

export function readContinuationOffset(text: string): number | undefined {
	const match = text.match(/\n\n\[[^\n]*\boffset=(\d+)\b[^\n]*\]\s*$/s);
	if (!match) return undefined;
	const nextOffset = Number(match[1]);
	return Number.isFinite(nextOffset) ? nextOffset : undefined;
}

export function stripReadContinuationNotice(text: string): string {
	return readContinuationOffset(text) === undefined ? text : text.replace(/\n\n\[[^\n]*\boffset=\d+\b[^\n]*\]\s*$/s, "");
}

function summarizeRequestedReadRange(result: any): string | undefined {
	const truncation = result?.details?.truncation;
	if (truncation?.firstLineExceedsLimit) {
		return "truncated";
	}
	return undefined;
}

export function summarizeRead(result: any, args?: any): string | undefined {
	const images = imageBlocks(result);
	if (images.length > 0) {
		const mime = images[0]?.mimeType ?? "image";
		return images.length === 1 ? mime : `${images.length} images`;
	}

	const hasRequestedRange = args?.offset !== undefined || args?.limit !== undefined;
	if (hasRequestedRange) {
		return summarizeRequestedReadRange(result);
	}

	const truncation = result?.details?.truncation;
	if (truncation?.truncated) {
		return "truncated";
	}

	return undefined;
}
