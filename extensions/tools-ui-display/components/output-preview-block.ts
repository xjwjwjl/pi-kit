import { type Component, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { outputPreviewText } from "../style.js";

const GUIDE = "  │ ";
const CLOSE = "  ╰─";

/**
 * Compact preview block for tool output.
 *
 * Renders output as a guided block and keeps wrapped continuation lines aligned
 * under the same guide prefix.
 */
export class OutputPreviewBlock implements Component {
	private readonly lines: string[];
	private readonly theme: Theme;
	private readonly leadingBlankLine: boolean;

	constructor(preview: string, theme: Theme, options: { leadingBlankLine?: boolean } = {}) {
		this.lines = preview.split("\n");
		this.theme = theme;
		this.leadingBlankLine = options.leadingBlankLine ?? false;
	}

	invalidate() {}

	render(width: number): string[] {
		if (width <= 0) return [];

		const guide = this.theme.fg("borderMuted", GUIDE);
		const guideWidth = visibleWidth(GUIDE);
		const contentWidth = Math.max(1, width - guideWidth);
		const rendered = this.leadingBlankLine ? [""] : [];

		for (const line of this.lines) {
			const content = outputPreviewText(line, this.theme);
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
