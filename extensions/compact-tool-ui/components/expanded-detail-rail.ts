import { type Component, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { paramText } from "../style.js";
import { ToolDetailFooter } from "./tool-detail-footer.js";

const GUIDE = "  │ ";
const SECTION = "  ├─ ";
const CLOSE = "  ╰─";

type DetailContent = Component | string[];

export type ExpandedDetailSection = {
	label: string;
	metadata?: string;
	content?: DetailContent;
};

/** Shared expanded layout: named sections on a low-contrast detail rail. */
export class ExpandedDetailRail implements Component {
	private sections: ExpandedDetailSection[] = [];
	private footer?: ToolDetailFooter;
	private readonly theme: Theme;

	constructor(theme: Theme, sections: ExpandedDetailSection[] = [], footer?: ToolDetailFooter) {
		this.theme = theme;
		this.sections = sections;
		this.footer = footer;
	}

	setSections(sections: ExpandedDetailSection[]) {
		this.sections = sections;
	}

	setFooter(footer: ToolDetailFooter | undefined) {
		this.footer = footer;
	}

	invalidate() {}

	render(width: number): string[] {
		if (width <= 0) return [];

		const guide = this.theme.fg("borderMuted", GUIDE);
		const guideWidth = visibleWidth(GUIDE);
		const contentWidth = Math.max(1, width - guideWidth);
		const lines: string[] = [];

		for (const section of this.sections) {
			const metadata = section.metadata ? this.theme.fg("dim", ` · ${section.metadata}`) : "";
			const title = `${this.theme.fg("borderMuted", SECTION)}${paramText("group", section.label, this.theme)}${metadata}`;
			lines.push(...wrapTextWithAnsi(title, width));

			if (!section.content) continue;
			const contentLines = Array.isArray(section.content)
				? section.content.flatMap((line) => wrapTextWithAnsi(line, contentWidth))
				: section.content.render(contentWidth);
			for (const line of contentLines.length > 0 ? contentLines : [""]) {
				lines.push(`${guide}${line}`);
			}
		}

		const footerLines = this.footer?.render(contentWidth) ?? [];
		if (footerLines.length === 0) {
			lines.push(this.theme.fg("borderMuted", CLOSE));
		} else {
			lines.push(`${this.theme.fg("borderMuted", CLOSE)} ${footerLines[0]}`);
			for (const line of footerLines.slice(1)) lines.push(`${guide}${line}`);
		}

		return lines;
	}
}
