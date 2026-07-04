import { type Component, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripAnsi, trimTrailingEmptyLines } from "../core-utils.js";
import { paramText } from "../style.js";

const GUIDE = "  │ ";
const CLOSE = "  ╰─";

function styleDiffLine(line: string, theme: Theme): string {
	if (/^\+/.test(line)) return paramText("added", line, theme);
	if (/^-/.test(line)) return paramText("removed", line, theme);
	return paramText("context", line, theme);
}

/** Compact guided block for small edit diffs. */
export class DiffPreviewBlock implements Component {
	private readonly lines: string[];
	private readonly theme: Theme;

	constructor(diff: string, theme: Theme) {
		this.lines = trimTrailingEmptyLines(stripAnsi(diff).split("\n"));
		this.theme = theme;
	}

	invalidate() {}

	render(width: number): string[] {
		if (width <= 0 || this.lines.length === 0) return [];

		const guide = this.theme.fg("borderMuted", GUIDE);
		const guideWidth = visibleWidth(GUIDE);
		const contentWidth = Math.max(1, width - guideWidth);
		const rendered = [""];

		for (const line of this.lines) {
			const content = styleDiffLine(line, this.theme);
			const wrapped = wrapTextWithAnsi(content, contentWidth);
			if (wrapped.length === 0) {
				rendered.push(guide);
				continue;
			}
			for (const wrappedLine of wrapped) {
				rendered.push(`${guide}${wrappedLine}`);
			}
		}

		rendered.push(this.theme.fg("borderMuted", CLOSE));
		return rendered;
	}
}
