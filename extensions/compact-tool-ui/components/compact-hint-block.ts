import { type Component, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { descText } from "../style.js";

const CLOSE = "  ╰─ ";

/** Compact one-line guided hint for actionable collapsed tool failures. */
export class CompactHintBlock implements Component {
	private readonly hint: string;
	private readonly theme: Theme;

	constructor(hint: string, theme: Theme) {
		this.hint = hint;
		this.theme = theme;
	}

	invalidate() {}

	render(width: number): string[] {
		if (width <= 0 || this.hint.length === 0) return [];

		const guide = this.theme.fg("borderMuted", CLOSE);
		const guideWidth = visibleWidth(CLOSE);
		const contentWidth = Math.max(1, width - guideWidth);
		const wrapped = wrapTextWithAnsi(descText(this.hint, this.theme), contentWidth);
		if (wrapped.length === 0) return [];

		return ["", ...wrapped.map((line, index) => `${index === 0 ? guide : " ".repeat(guideWidth)}${line}`)];
	}
}
