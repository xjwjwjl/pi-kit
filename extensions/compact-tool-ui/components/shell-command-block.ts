import { type Component, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { bashArgumentText } from "../style.js";

/** Expanded Bash command renderer with ANSI-safe visual wrapping. */
export class ShellCommandBlock implements Component {
	private readonly source: string;
	private readonly theme: Theme;
	private layout?: { width: number; colors: Theme["colors"]; lines: string[] };

	constructor(source: string, theme: Theme) {
		// Pi measures tabs as three cells; emitting literal tab stops would overflow terminals.
		this.source = source.replace(/\t/g, "   ");
		this.theme = theme;
	}

	invalidate() {
		this.layout = undefined;
	}

	render(width: number): string[] {
		if (width <= 0) return [];

		const colors = this.theme.colors;
		if (this.layout?.width === width && this.layout.colors === colors) return this.layout.lines;

		const lines = this.source.split("\n").flatMap((rawLine) => {
			const wrapped = wrapTextWithAnsi(bashArgumentText(rawLine, this.theme), width);
			return wrapped.length > 0 ? wrapped : [""];
		});
		this.layout = { width, colors, lines };
		return lines;
	}
}
