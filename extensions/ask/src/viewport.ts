/** Intrinsic inline content limit; the host allocation may be smaller. */
export const INLINE_MAX_HEIGHT = 14;

export function getInlineMaxHeight(rows: number): number {
	const height = Number.isFinite(rows) ? Math.max(1, Math.floor(rows)) : 24;
	return Math.min(INLINE_MAX_HEIGHT, Math.max(1, height - 4));
}

export interface LineRange {
	start: number;
	end: number;
}

/** Keep the active row (or wrapped label) visible unless the user explicitly pages away. */
export function resolveViewport(
	lineCount: number,
	height: number,
	offset: number,
	anchor?: LineRange,
): { start: number; end: number; hiddenBefore: number; hiddenAfter: number } {
	const visibleHeight = Math.max(1, Math.floor(height));
	const maxOffset = Math.max(0, lineCount - visibleHeight);
	let start = Math.max(0, Math.min(maxOffset, offset));
	if (anchor) {
		if (anchor.end - anchor.start > visibleHeight || anchor.start < start) {
			start = anchor.start;
		} else if (anchor.end > start + visibleHeight) {
			start = anchor.end - visibleHeight;
		}
	}
	start = Math.max(0, Math.min(maxOffset, start));
	const end = Math.min(lineCount, start + visibleHeight);
	return { start, end, hiddenBefore: start, hiddenAfter: lineCount - end };
}
