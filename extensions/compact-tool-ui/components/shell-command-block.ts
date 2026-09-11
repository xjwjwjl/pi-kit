import { type Component, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	bashArgumentText,
	commandNameText,
	paramText,
	shellContinuationText,
	shellOperatorText,
	shellRedirectionText,
} from "../style.js";
import type { BashCommandLayoutLine, BashCommandRenderLayout } from "../format/bash-command-layout.js";

const INDENT = "  ";
const CONTINUATION = " \\";

function styleToken(token: BashCommandLayoutLine["tokens"][number], theme: Theme): string {
	switch (token.role) {
		case "command":
			return commandNameText(token.text, theme);
		case "redirection":
			return shellRedirectionText(token.text, theme);
		case "assignment":
			return paramText("env", token.text, theme);
		default:
			return /^--?[A-Za-z0-9]/.test(token.text) ? paramText("flag", token.text, theme) : bashArgumentText(token.text, theme);
	}
}

function appendContinuation(line: string, width: number, theme: Theme): string {
	const marker = shellContinuationText(CONTINUATION, theme);
	return visibleWidth(line) + visibleWidth(marker) <= width ? `${line}${marker}` : line;
}

/** Structured expanded Bash command renderer with conservative token wrapping. */
export class ShellCommandBlock implements Component {
	private readonly layout: BashCommandRenderLayout | string;
	private readonly theme: Theme;

	constructor(layout: BashCommandRenderLayout | string, theme: Theme) {
		this.layout = layout;
		this.theme = theme;
	}

	invalidate() {}

	render(width: number): string[] {
		if (width <= 0) return [];
		if (typeof this.layout === "string") return this.renderRaw(this.layout, width);

		return this.layout.lines.flatMap((line) => this.renderLine(line, width));
	}

	private renderRaw(source: string, width: number): string[] {
		const lines: string[] = [];
		for (const rawLine of source.split("\n")) {
			const wrapped = wrapTextWithAnsi(bashArgumentText(rawLine, this.theme), width);
			lines.push(...(wrapped.length > 0 ? wrapped : [""]));
		}
		return lines;
	}

	private renderLine(line: BashCommandLayoutLine, width: number): string[] {
		if (line.raw !== undefined) return this.renderRaw(line.raw, width);

		const baseIndent = INDENT.repeat(line.indent);
		const continuationIndent = `${baseIndent}${INDENT}`;
		const atoms = line.tokens.map((token) => ({ text: styleToken(token, this.theme), noSpaceBefore: false }));
		if (line.trailingOperator) atoms.push({ text: shellOperatorText(line.trailingOperator, this.theme), noSpaceBefore: line.trailingOperator === ";" });

		if (atoms.length === 0) return [baseIndent];

		const rendered: string[] = [];
		let current = baseIndent;
		let hasAtom = false;

		for (let index = 0; index < atoms.length; index++) {
			const atom = atoms[index];
			if (!atom) continue;
			const separator = hasAtom && !atom.noSpaceBefore ? " " : "";
			const candidate = `${current}${separator}${atom.text}`;
			const hasRemainingAtom = index < atoms.length - 1;
			const continuationBudget = hasRemainingAtom ? visibleWidth(CONTINUATION) : 0;
			if (visibleWidth(candidate) <= width - continuationBudget) {
				current = candidate;
				hasAtom = true;
				continue;
			}

			if (hasAtom) {
				rendered.push(appendContinuation(current, width, this.theme));
				current = continuationIndent;
				hasAtom = false;
			}

			const available = Math.max(1, width - visibleWidth(current) - continuationBudget);
			const wrapped = wrapTextWithAnsi(atom.text, available);
			current += wrapped[0] ?? "";
			for (const part of wrapped.slice(1)) {
				rendered.push(current);
				current = `${continuationIndent}${part}`;
			}
			hasAtom = true;
		}

		rendered.push(current);
		return rendered;
	}
}
