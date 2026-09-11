import { type Component, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { bashArgumentText } from "../style.js";

/** Expanded Bash command renderer with ANSI-safe visual wrapping. */
export class ShellCommandBlock implements Component {
	private readonly source: string;
	private readonly theme: Theme;

	constructor(source: string, theme: Theme) {
		this.source = source;
		this.theme = theme;
	}

	invalidate() {}

	render(width: number): string[] {
		if (width <= 0) return [];

		return this.source.split("\n").flatMap((rawLine) => {
			const wrapped = wrapTextWithAnsi(bashArgumentText(rawLine, this.theme), width);
			return wrapped.length > 0 ? wrapped : [""];
		});
	}
}
