import { type Component, sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripAnsi, trimTrailingEmptyLines } from "../core-utils.js";
import { paramText } from "../style.js";

const GUIDE = "  │ ";
const CLOSE = "  ╰─";
const MIDDLE_MARKER = "…";
const MIDDLE_TRUNCATION_HEAD_RATIO = 0.6;
// Avoid Windows Terminal's last-column auto-wrap and leave room for terminals
// that render the guide or truncation marker wider than the Unicode width table reports.
const RIGHT_EDGE_GUARD = 4;

type DiffLinePreview = {
	head: string;
	marker?: string;
	tail?: string;
};

function truncateDiffLine(line: string, maxWidth: number): DiffLinePreview {
	if (maxWidth <= 0) return { head: "" };
	if (visibleWidth(line) <= maxWidth) return { head: line };

	const markerWidth = visibleWidth(MIDDLE_MARKER);
	if (maxWidth <= markerWidth) return { head: "", marker: sliceByColumn(MIDDLE_MARKER, 0, maxWidth, true) };

	const availableWidth = maxWidth - markerWidth;
	const headWidth = Math.max(1, Math.ceil(availableWidth * MIDDLE_TRUNCATION_HEAD_RATIO));
	const tailWidth = Math.max(0, availableWidth - headWidth);
	const lineWidth = visibleWidth(line);
	const head = sliceByColumn(line, 0, headWidth, true);
	const tail = tailWidth > 0 ? sliceByColumn(line, Math.max(headWidth, lineWidth - tailWidth), tailWidth, true) : "";
	return { head, marker: MIDDLE_MARKER, tail };
}

function styleDiffLine(line: DiffLinePreview, theme: Theme): string {
	const token = /^\+/.test(line.head) ? "added" : /^-/.test(line.head) ? "removed" : "context";
	const style = (text: string) => paramText(token, text, theme);
	return `${style(line.head)}${line.marker ? theme.fg("dim", line.marker) : ""}${style(line.tail ?? "")}`;
}

/** Compact guided block for small edit diffs. */
export class DiffPreviewBlock implements Component {
	private readonly lines: string[];
	private readonly theme: Theme;

	constructor(diff: string, theme: Theme) {
		// Match Pi's built-in diff renderer: terminal tabs use tab stops while
		// visibleWidth() uses a fixed width, so normalize before measuring.
		this.lines = trimTrailingEmptyLines(stripAnsi(diff).split("\n").map((line) => line.replace(/\t/g, "   ")));
		this.theme = theme;
	}

	invalidate() {}

	render(width: number): string[] {
		if (width <= 0 || this.lines.length === 0) return [];

		const guide = this.theme.fg("borderMuted", GUIDE);
		const maxRenderedWidth = Math.max(1, width - RIGHT_EDGE_GUARD);
		const contentWidth = Math.max(0, maxRenderedWidth - visibleWidth(GUIDE));
		const rendered = [""];

		for (const line of this.lines) {
			const content = styleDiffLine(truncateDiffLine(line, contentWidth), this.theme);
			// Enforce the final budget after ANSI styling too, rather than relying only
			// on the content calculation above.
			rendered.push(sliceByColumn(`${guide}${content}`, 0, maxRenderedWidth, true));
		}

		rendered.push(sliceByColumn(this.theme.fg("borderMuted", CLOSE), 0, maxRenderedWidth, true));
		return rendered;
	}
}
