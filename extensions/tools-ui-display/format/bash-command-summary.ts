import { formatSize } from "@earendil-works/pi-coding-agent";
import { countLines, plural, shortPath, stripAnsi } from "../core-utils.js";

export type BashCommandDisplay = {
	/** One-line command label for collapsed rendering. */
	text: string;
	/** Additional collapsed metadata such as `42 lines · 1.2 KB`. */
	metadata?: string;
	/** Whether the original command was shortened or summarized. */
	summarized: boolean;
};

const MAX_INLINE_COMMAND_CHARS = 64;
const MAX_SEARCH_SUMMARY_CHARS = 48;
const ELLIPSIS = "…";

function normalizeCommand(command: string): string {
	return stripAnsi(command).replace(/\r\n?/g, "\n");
}

function byteSize(command: string): string {
	return formatSize(Buffer.byteLength(command, "utf8"));
}

function lineMetadata(command: string): string {
	return `${plural(countLines(command), "line")} · ${byteSize(command)}`;
}

function shellUnquote(value: string): string {
	return value.replace(/^['"]|['"]$/g, "");
}

function meaningfulLines(command: string): string[] {
	return command.split("\n").filter((line) => line.trim().length > 0);
}

function heredocRegex(): RegExp {
	return /<<-?\s*(['"]?)[A-Za-z_][A-Za-z0-9_]*\1/;
}

function hasHeredoc(line: string): boolean {
	return heredocRegex().test(line);
}

function pythonHeredocName(line: string): string | undefined {
	if (!hasHeredoc(line)) return undefined;
	const trimmed = line.trimStart();
	const direct = trimmed.match(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*(python3?|python)(?:\s|$)/);
	if (direct) return direct[1];
	if (/^(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*uv\s+run\s+python(?:\s|$)/.test(trimmed)) return "python";
	return undefined;
}

function catHeredocTarget(line: string): string | undefined {
	if (!hasHeredoc(line)) return undefined;
	const match = line.trimStart().match(/^cat\s+>\s*(\S+)/);
	return match ? shortPath(shellUnquote(match[1])) : undefined;
}

function summarizeMultilineCommand(command: string): BashCommandDisplay {
	const lines = meaningfulLines(command);
	const firstLine = lines[0] ?? "";
	const directPython = pythonHeredocName(firstLine);
	const containsPythonHeredoc = lines.some((line) => pythonHeredocName(line) !== undefined);
	const firstHeredocLine = lines.find(hasHeredoc);
	const catTarget = firstHeredocLine ? catHeredocTarget(firstHeredocLine) : undefined;

	let text = "shell script";
	if (directPython) {
		text = `${directPython} heredoc`;
	} else if (containsPythonHeredoc) {
		text = "shell script with python heredoc";
	} else if (catTarget) {
		text = `cat heredoc > ${catTarget}`;
	} else if (firstHeredocLine) {
		text = "heredoc script";
	}

	return { text, metadata: lineMetadata(command), summarized: true };
}

function truncateText(value: string, maxChars: number): string {
	if (value.length <= maxChars) return value;
	if (maxChars <= ELLIPSIS.length) return ELLIPSIS;
	return `${value.slice(0, Math.max(1, maxChars - ELLIPSIS.length))}${ELLIPSIS}`;
}

function truncateSingleLine(command: string): string {
	return truncateText(command, MAX_INLINE_COMMAND_CHARS);
}

type ShellSegment = {
	segment: string;
	hasChain: boolean;
};

function firstShellSegment(command: string): ShellSegment {
	let quote: "'" | '"' | undefined;
	let escaped = false;
	let segmentEnd = command.length;
	let hasChain = false;

	for (let index = 0; index < command.length; index++) {
		const char = command[index];
		const next = command[index + 1];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (char === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (char === quote) quote = undefined;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}
		if (char === "\n" || char === ";") {
			hasChain = true;
			if (segmentEnd === command.length) segmentEnd = index;
			continue;
		}
		if ((char === "&" && next === "&") || (char === "|" && next === "|")) {
			hasChain = true;
			if (segmentEnd === command.length) segmentEnd = index;
			index++;
			continue;
		}
		if (char === "|" && segmentEnd === command.length) {
			segmentEnd = index;
		}
	}

	return { segment: command.slice(0, segmentEnd).trim(), hasChain };
}

function splitShellWords(value: string): string[] {
	const words: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let escaped = false;

	const push = () => {
		if (!current) return;
		words.push(current);
		current = "";
	};

	for (let index = 0; index < value.length; index++) {
		const char = value[index];
		if (escaped) {
			current += char;
			escaped = false;
			continue;
		}
		if (char === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (char === quote) quote = undefined;
			else current += char;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}
		if (/\s/.test(char)) {
			push();
			continue;
		}
		current += char;
	}
	push();
	return words;
}

function stripAssignmentWords(words: string[]): string[] {
	let index = 0;
	while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index])) index++;
	return words.slice(index);
}

function isRedirectionWord(word: string): boolean {
	return /^(?:\d*)[<>]/.test(word);
}

function optionConsumesValue(option: string, valueOptions: Set<string>): boolean {
	if (option.includes("=")) return false;
	if (valueOptions.has(option)) return true;
	if (/^-[ABCgmTt].+/.test(option)) return false;
	return false;
}

const RG_VALUE_OPTIONS = new Set([
	"-A",
	"--after-context",
	"-B",
	"--before-context",
	"-C",
	"--context",
	"-g",
	"--glob",
	"--iglob",
	"-m",
	"--max-count",
	"--max-depth",
	"-t",
	"--type",
	"-T",
	"--type-not",
]);

function isFixedStringSearch(words: string[]): boolean {
	return words.some((word) => word === "-F" || word === "--fixed-strings" || /^-[A-Za-z]*F[A-Za-z]*$/.test(word));
}

function formatSearchPattern(pattern: string, literal: boolean, maxChars?: number): string {
	if (maxChars === undefined) return literal ? pattern : `/${pattern}/`;
	if (literal) return truncateText(pattern, maxChars);
	return `/${truncateText(pattern, Math.max(1, maxChars - 2))}/`;
}

function summarizeSearchLabel(command: string, pattern: string, path: string, literal: boolean): string {
	const prefix = `${command} `;
	const suffix = ` in ${path}`;
	const patternBudget = Math.max(8, MAX_SEARCH_SUMMARY_CHARS - prefix.length - suffix.length);
	return `${prefix}${formatSearchPattern(pattern, literal, patternBudget)}${suffix}`;
}

function summarizeRgFiles(words: string[]): string {
	const paths = words.slice(1).filter((word) => !word.startsWith("-") && !isRedirectionWord(word));
	return `rg --files in ${shortPath(paths[0] ?? ".")}`;
}

function summarizeSearchCommand(words: string[]): string | undefined {
	const command = words[0];
	if (!command || (command !== "rg" && command !== "grep")) return undefined;
	if (command === "rg" && words.includes("--files")) return summarizeRgFiles(words);

	let pattern: string | undefined;
	const paths: string[] = [];
	const literal = isFixedStringSearch(words);

	for (let index = 1; index < words.length; index++) {
		const word = words[index];
		if (isRedirectionWord(word)) continue;
		if (word === "--") {
			if (pattern === undefined) {
				pattern = words[index + 1];
				index++;
			}
			continue;
		}
		if (word === "-e" || word === "--regexp") {
			pattern ??= words[index + 1];
			index++;
			continue;
		}
		if (word.startsWith("-e") && word.length > 2) {
			pattern ??= word.slice(2);
			continue;
		}
		if (word.startsWith("--regexp=")) {
			pattern ??= word.slice("--regexp=".length);
			continue;
		}
		if (word.startsWith("-")) {
			if (optionConsumesValue(word, RG_VALUE_OPTIONS)) index++;
			continue;
		}
		if (pattern === undefined) pattern = word;
		else paths.push(word);
	}

	if (!pattern) return undefined;
	return summarizeSearchLabel(command, pattern, shortPath(paths[0] ?? "."), literal);
}

function findArgValue(words: string[], option: string): string | undefined {
	const index = words.indexOf(option);
	return index >= 0 ? words[index + 1] : undefined;
}

function summarizeFindCommand(words: string[]): string | undefined {
	if (words[0] !== "find") return undefined;
	const expressionStart = words.findIndex((word, index) => index > 0 && (word.startsWith("-") || word === "(" || word === "!"));
	const pathWords = expressionStart < 0 ? words.slice(1) : words.slice(1, expressionStart);
	const path = shortPath(pathWords[0] ?? ".");
	const pattern = findArgValue(words, "-name") ?? findArgValue(words, "-iname");
	const type = findArgValue(words, "-type");
	const target = pattern ?? (type === "d" ? "dirs" : type === "f" ? "files" : "paths");
	return `find ${target} in ${path}`;
}

function summarizeLsCommand(words: string[]): string | undefined {
	if (words[0] !== "ls") return undefined;
	const paths = words.slice(1).filter((word) => !word.startsWith("-") && !isRedirectionWord(word));
	return `ls ${shortPath(paths[0] ?? ".")}`;
}

function summarizeSemanticSingleLineCommand(command: string): string | undefined {
	const { segment, hasChain } = firstShellSegment(command);
	if (!segment || hasChain) return undefined;
	const words = stripAssignmentWords(splitShellWords(segment));
	const commandName = words[0];
	if (commandName === "rg" || commandName === "grep") return summarizeSearchCommand(words);
	if (commandName === "find") return summarizeFindCommand(words);
	if (commandName === "ls") return summarizeLsCommand(words);
	return undefined;
}

export function summarizeBashCommand(command: string): BashCommandDisplay {
	const normalized = normalizeCommand(command);
	if (normalized.length === 0) return { text: "...", summarized: false };

	if (normalized.includes("\n")) {
		return summarizeMultilineCommand(normalized);
	}

	const semantic = summarizeSemanticSingleLineCommand(normalized);
	const text = semantic ?? normalized;
	if (text.length > MAX_INLINE_COMMAND_CHARS) {
		return {
			text: truncateSingleLine(text),
			summarized: true,
		};
	}

	return { text, summarized: semantic !== undefined };
}
