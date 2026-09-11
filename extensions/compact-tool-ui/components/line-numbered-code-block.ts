import { type Component, sliceByColumn, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { paramText } from "../style.js";

const NUMBER_COLUMN_MIN_WIDTH = 64;
const NUMBER_SEPARATOR = " ";

export type LineNumberedCodeBlockOptions = {
	startLine?: number;
	showLineNumbers?: boolean;
	maxVisualLines?: number;
};

/** ANSI-safe code block with optional line numbers and aligned continuations. */
export class LineNumberedCodeBlock implements Component {
	private readonly lines: string[];
	private readonly theme: Theme;
	private readonly startLine: number;
	private readonly showLineNumbers: boolean;
	private readonly maxVisualLines?: number;

	constructor(lines: string[] | string, theme: Theme, options: LineNumberedCodeBlockOptions = {}) {
		this.lines = (Array.isArray(lines) ? lines : lines.split("\n")).map((line) => line.replace(/\t/g, "   "));
		this.theme = theme;
		this.startLine = options.startLine ?? 1;
		this.showLineNumbers = options.showLineNumbers ?? true;
		this.maxVisualLines = options.maxVisualLines;
	}

	invalidate() {}

	render(width: number): string[] {
		if (width <= 0) return [];

		const lastLine = this.startLine + Math.max(0, this.lines.length - 1);
		const numberWidth = String(lastLine).length;
		const numberPrefixWidth = numberWidth + NUMBER_SEPARATOR.length;
		const renderNumbers = this.showLineNumbers && width >= NUMBER_COLUMN_MIN_WIDTH && width > numberPrefixWidth + 8;
		const prefixWidth = renderNumbers ? numberPrefixWidth : 0;
		const contentWidth = Math.max(1, width - prefixWidth);
		const continuationPrefix = " ".repeat(prefixWidth);
		const output: string[] = [];

		for (let index = 0; index < this.lines.length; index++) {
			const line = this.lines[index] ?? "";
			const wrapped = wrapTextWithAnsi(line, contentWidth);
			const number = renderNumbers ? `${String(this.startLine + index).padStart(numberWidth, " ")}${NUMBER_SEPARATOR}` : "";
			if (wrapped.length === 0) {
				output.push(number);
				continue;
			}
			output.push(`${renderNumbers ? paramText("separator", number, this.theme) : ""}${wrapped[0]}`);
			for (const continuation of wrapped.slice(1)) output.push(`${continuationPrefix}${continuation}`);
		}

		const rendered = output.map((line) => (visibleWidth(line) > width ? sliceByColumn(line, 0, width, true) : line));
		if (this.maxVisualLines !== undefined && this.maxVisualLines > 0 && rendered.length > this.maxVisualLines) {
			return rendered.slice(-this.maxVisualLines);
		}
		return rendered;
	}
}
