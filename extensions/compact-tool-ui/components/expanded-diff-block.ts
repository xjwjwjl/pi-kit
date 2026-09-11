import { type Component, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { paramText } from "../style.js";
import { stripAnsi } from "../core-utils.js";

function styleDiffLine(line: string, theme: Theme): string {
	if (/^\+\+\+|^---/.test(line)) return paramText("context", line, theme);
	if (/^\+/.test(line)) return paramText("added", line, theme);
	if (/^-/.test(line)) return paramText("removed", line, theme);
	if (/^@@/.test(line)) return paramText("operator", line, theme);
	return paramText("context", line, theme);
}

/** Full expanded diff renderer; it wraps but never middle-truncates diff content. */
export class ExpandedDiffBlock implements Component {
	private readonly lines: string[];
	private readonly theme: Theme;

	constructor(diff: string, theme: Theme) {
		this.lines = stripAnsi(diff).replace(/\t/g, "   ").split("\n");
		this.theme = theme;
	}

	invalidate() {}

	render(width: number): string[] {
		if (width <= 0) return [];
		return this.lines.flatMap((line) => wrapTextWithAnsi(styleDiffLine(line, this.theme), width));
	}
}
