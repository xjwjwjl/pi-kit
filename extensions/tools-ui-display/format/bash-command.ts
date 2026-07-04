import type { Theme } from "@earendil-works/pi-coding-agent";
import { bashArgumentText, commandNameText } from "../style.js";

type ShellWord = { start: number; end: number; text: string };

function commandSeparatorLength(value: string, index: number): number {
	const char = value[index];
	const next = value[index + 1];
	if (char === "\n" || char === "\r" || char === ";") return 1;
	if (char === "|") return next === "|" || next === "&" ? 2 : 1;
	if (char === "&" && next === "&") return 2;
	return 0;
}

function redirectionLength(value: string, index: number): number {
	const char = value[index];
	const next = value[index + 1];
	if (char !== "<" && char !== ">") return 0;
	if (next === char || next === "&" || next === "|") return 2;
	return 1;
}

function readShellWord(value: string, start: number): ShellWord | undefined {
	let index = start;
	let quote: "'" | '"' | undefined;
	let escaped = false;
	let commandSubstitutionDepth = 0;

	while (index < value.length) {
		const char = value[index];
		const next = value[index + 1];
		if (escaped) {
			escaped = false;
			index++;
			continue;
		}
		if (char === "\\" && quote !== "'") {
			escaped = true;
			index++;
			continue;
		}
		if (quote) {
			if (char === quote) quote = undefined;
			index++;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			index++;
			continue;
		}
		if (char === "$" && next === "(") {
			commandSubstitutionDepth++;
			index += 2;
			continue;
		}
		if (commandSubstitutionDepth > 0) {
			if (char === "(") commandSubstitutionDepth++;
			else if (char === ")") commandSubstitutionDepth--;
			index++;
			continue;
		}
		if (/\s/.test(char) || commandSeparatorLength(value, index) > 0 || redirectionLength(value, index) > 0) break;
		index++;
	}

	return index > start ? { start, end: index, text: value.slice(start, index) } : undefined;
}

function isShellAssignmentWord(value: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]*=/.test(value);
}

function isStandaloneCloseToken(value: string): boolean {
	return /^[)\]}]+$/.test(value);
}

function cleanHeredocDelimiter(value: string): string {
	return value.replace(/^['"]|['"]$/g, "");
}

function heredocDelimiters(line: string): string[] {
	const delimiters: string[] = [];
	let index = 0;
	let quote: "'" | '"' | undefined;
	let escaped = false;

	while (index < line.length) {
		const char = line[index];
		if (escaped) {
			escaped = false;
			index++;
			continue;
		}
		if (char === "\\" && quote !== "'") {
			escaped = true;
			index++;
			continue;
		}
		if (quote) {
			if (char === quote) quote = undefined;
			index++;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			index++;
			continue;
		}
		if (char !== "<" || line[index + 1] !== "<") {
			index++;
			continue;
		}

		index += line[index + 2] === "-" ? 3 : 2;
		while (index < line.length && /\s/.test(line[index])) index++;
		const delimiter = readShellWord(line, index);
		if (delimiter) {
			delimiters.push(cleanHeredocDelimiter(delimiter.text));
			index = delimiter.end;
		}
	}

	return delimiters;
}

function commandNameSpansInLine(line: string, offset: number): ShellWord[] {
	const spans: ShellWord[] = [];
	let index = 0;
	let expectingCommand = true;

	while (index < line.length) {
		const separatorLength = commandSeparatorLength(line, index);
		if (separatorLength > 0) {
			expectingCommand = true;
			index += separatorLength;
			continue;
		}
		if (/\s/.test(line[index])) {
			index++;
			continue;
		}

		const redirectLength = redirectionLength(line, index);
		if (redirectLength > 0) {
			index += redirectLength;
			while (index < line.length && /\s/.test(line[index])) index++;
			const target = readShellWord(line, index);
			if (target) index = target.end;
			continue;
		}

		const word = readShellWord(line, index);
		if (!word) {
			index++;
			continue;
		}
		if (expectingCommand) {
			if (isShellAssignmentWord(word.text)) {
				index = word.end;
				continue;
			}
			if (!isStandaloneCloseToken(word.text)) {
				spans.push({ start: offset + word.start, end: offset + word.end, text: word.text });
				expectingCommand = false;
			}
		}
		index = word.end;
	}

	return spans;
}

function commandNameSpans(value: string): ShellWord[] {
	const spans: ShellWord[] = [];
	const pendingHeredocs: string[] = [];
	let lineStart = 0;

	while (lineStart <= value.length) {
		const newlineIndex = value.indexOf("\n", lineStart);
		const lineEnd = newlineIndex === -1 ? value.length : newlineIndex;
		const line = value.slice(lineStart, lineEnd).replace(/\r$/, "");
		const trimmed = line.trim();

		if (pendingHeredocs.length > 0) {
			if (trimmed === pendingHeredocs[0]) pendingHeredocs.shift();
		} else {
			spans.push(...commandNameSpansInLine(line, lineStart));
			pendingHeredocs.push(...heredocDelimiters(line));
		}

		if (newlineIndex === -1) break;
		lineStart = newlineIndex + 1;
	}

	return spans;
}

export function commandText(value: string, theme: Theme): string {
	const spans = commandNameSpans(value);
	if (spans.length === 0) return bashArgumentText(value, theme);

	let text = "";
	let cursor = 0;
	for (const span of spans) {
		text += bashArgumentText(value.slice(cursor, span.start), theme);
		text += commandNameText(span.text, theme);
		cursor = span.end;
	}
	return `${text}${bashArgumentText(value.slice(cursor), theme)}`;
}
