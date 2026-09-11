import { countLines, formatLineCount, plural, sanitizeInlineText, stripAnsi, trimTrailingEmptyLines } from "../core-utils.js";

const BASH_TAIL_LINES = 10;

export type BashStatus = {
	status: string;
	output: string;
};

function parseBuiltInBashStatusLine(value: string): string | undefined {
	if (!/^command\b/i.test(value)) return undefined;

	const exitMatch = value.match(/\bcode\s+(\d+)\b/i);
	if (exitMatch) return `exit ${exitMatch[1]}`;

	if (/timed out/i.test(value)) {
		const timeoutMatch = value.match(/\bafter\s+(\d+(?:\.\d+)?)\s+seconds?\b/i);
		return timeoutMatch ? `timeout ${timeoutMatch[1]}s` : "timeout";
	}

	if (/aborted/i.test(value)) return "aborted";
	return undefined;
}

function inferBashFailureStatus(value: string): string {
	const builtInStatus = parseBuiltInBashStatusLine(value);
	if (builtInStatus) return builtInStatus;

	const exitMatch = value.match(/\b(?:exit(?:ed)?(?:\s+with)?\s+code|code)\s+(\d+)\b/i);
	if (exitMatch) return `exit ${exitMatch[1]}`;

	if (/timed out/i.test(value)) {
		const timeoutMatch = value.match(/\b(\d+(?:\.\d+)?)\s+seconds?\b/i);
		return timeoutMatch ? `timeout ${timeoutMatch[1]}s` : "timeout";
	}

	if (/aborted/i.test(value)) return "aborted";
	return "failed";
}

export function splitBashStatus(rawText: string, isError: boolean): BashStatus {
	const raw = stripAnsi(rawText).trimEnd();
	if (!raw) return { status: isError ? "failed" : "ok", output: "" };

	const lines = raw.split("\n");
	let last = lines.length - 1;
	while (last >= 0 && lines[last].trim() === "") last--;

	const lastLine = last >= 0 ? lines[last].trim() : "";
	const builtInStatus = parseBuiltInBashStatusLine(lastLine);
	if (builtInStatus) {
		lines.splice(last, 1);
		while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
		return { status: builtInStatus, output: lines.join("\n") };
	}

	if (raw === "(no output)") {
		return { status: isError ? "failed" : "ok", output: "" };
	}

	return { status: isError ? inferBashFailureStatus(lastLine || raw) : "ok", output: raw };
}

export function hasMeaningfulOutput(output: string): boolean {
	return stripAnsi(output).trim().length > 0;
}

function outputLines(output: string): string[] {
	return trimTrailingEmptyLines(stripAnsi(output).split("\n")).filter((line) => line.trim().length > 0);
}

function firstShellCommand(command: string): string {
	return stripAnsi(command).trimStart().split(/\s+(?:&&|\|\||;)|[\n;]/, 1)[0]?.trim() ?? "";
}

function stripLeadingAssignments(command: string): string {
	return command.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*/, "");
}

type BashSemanticOutputKind = "search" | "search-lines" | "search-files" | "paths" | "file-count" | "entries";

function hasTopLevelShellChain(command: string): boolean {
	let quote: "'" | '"' | undefined;
	let escaped = false;
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
		if (char === "\n" || char === ";") return true;
		if ((char === "&" && next === "&") || (char === "|" && next === "|")) return true;
	}
	return false;
}

/** Split only unquoted, unescaped pipeline separators; `||` remains a shell chain. */
function splitTopLevelPipeline(command: string): string[] | undefined {
	let quote: "'" | '"' | undefined;
	let escaped = false;
	let start = 0;
	const segments: string[] = [];

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
		if (char === "|" && next === "|") {
			index++;
			continue;
		}
		if (char === "|") {
			segments.push(command.slice(start, index).trim());
			start = index + 1;
		}
	}

	if (segments.length === 0) return undefined;
	segments.push(command.slice(start).trim());
	return segments.some((segment) => !segment) ? undefined : segments;
}

function isFindWcLinePipeline(segments: string[]): boolean {
	if (segments.length !== 2) return false;
	const firstSegment = segments[0] ?? "";
	if (hasTopLevelShellChain(firstSegment)) return false;

	const first = stripLeadingAssignments(firstShellCommand(firstSegment));
	const second = segments[1] ?? "";
	return /^find\b/.test(first) && /^wc\s+(?:-[A-Za-z]*l[A-Za-z]*|--lines)\s*$/.test(second);
}

function hasSearchContextFlag(command: string): boolean {
	return /(?:^|\s)(?:-(?!-)[A-Za-z]*[ABC][A-Za-z]*\d*|--(?:after-context|before-context|context)(?:[=\s]|$))/.test(command);
}

function bashOutputKind(command: string | undefined): BashSemanticOutputKind | undefined {
	if (!command) return undefined;
	const normalized = stripAnsi(command).trimStart();
	if (hasTopLevelShellChain(normalized)) return undefined;

	const pipeline = splitTopLevelPipeline(normalized);
	if (pipeline) return isFindWcLinePipeline(pipeline) ? "file-count" : undefined;

	const first = stripLeadingAssignments(firstShellCommand(normalized));
	if (/^rg\s+--files(?:\s|$)/.test(first)) return "paths";
	if (/^(?:rg|grep)\b/.test(first)) {
		if (/(?:^|\s)(?:-(?!-)[A-Za-z]*l[A-Za-z]*|--files-with-matches)(?:\s|$)/.test(first)) return "search-files";
		if (hasSearchContextFlag(first)) return "search-lines";
		return "search";
	}
	if (/^find\b/.test(first)) return "paths";
	if (/^ls\b/.test(first)) return hasTopLevelShellChain(normalized) ? undefined : "entries";
	return undefined;
}

/** Commands whose empty output is itself the result the user was asking for. */
type BashEmptyResult = "no-changes" | "clean";

function bashEmptyResult(command: string | undefined): BashEmptyResult | undefined {
	if (!command) return undefined;
	const normalized = stripAnsi(command).trimStart();
	if (hasTopLevelShellChain(normalized) || splitTopLevelPipeline(normalized)) return undefined;

	const first = stripLeadingAssignments(firstShellCommand(normalized));
	const subcommand = /^git\s+(?:--no-pager\s+|-C\s+\S+\s+)*([a-z][a-z-]*)\b/.exec(first)?.[1];
	if (subcommand === "diff") return "no-changes";
	if (subcommand === "status" && /(?:^|\s)(?:-s|--short|--porcelain(?:=v\d)?)(?:\s|$)/.test(first)) return "clean";
	return undefined;
}

function inferSearchFileCount(lines: string[]): number | undefined {
	const files = new Set<string>();
	for (const line of lines) {
		const match = line.match(/^(.+?):\d+(?::\d+)?:/);
		if (match?.[1]) files.add(match[1]);
	}
	return files.size > 0 ? files.size : undefined;
}

function summarizeSearchOutput(lines: string[]): string {
	const matches = plural(lines.length, "match", "matches");
	const files = inferSearchFileCount(lines);
	return files === undefined ? matches : `${matches} · ${plural(files, "file")}`;
}

function summarizeSearchLinesOutput(lines: string): string {
	const count = outputLines(lines).filter((line) => line.trim() !== "--").length;
	return plural(count, "search line");
}

function summarizeFileCountOutput(output: string, fallbackLines: string[]): string {
	const match = stripAnsi(output).trim().match(/^\d+$/);
	if (!match) return summarizePathOutput(fallbackLines);
	return plural(Number(match[0]), "file");
}

function summarizePathOutput(lines: string[]): string {
	return plural(lines.length, "path");
}

function summarizeEntryOutput(lines: string[]): string {
	const entries = lines.filter((line) => !/^total\s+\d+\b/.test(line.trim())).length;
	return entries === 0 ? "empty" : plural(entries, "entry", "entries");
}

/** Outputs this small read better as their own content than as a line count. */
const CONTENT_PREVIEW_MAX_LINES = 2;
/** Bound the suffix before the row's own width-aware truncation applies. */
const CONTENT_PREVIEW_MAX_CHARS = 160;

function contentPreview(firstLine: string): string {
	const inline = sanitizeInlineText(firstLine).trim();
	return inline.length > CONTENT_PREVIEW_MAX_CHARS ? `${inline.slice(0, CONTENT_PREVIEW_MAX_CHARS - 1)}…` : inline;
}

function summarizeGenericOutput(lines: string[]): string {
	if (lines.length > CONTENT_PREVIEW_MAX_LINES) return formatLineCount(lines.length);
	const preview = contentPreview(lines[0] ?? "");
	if (lines.length === 1) return preview;
	return `${preview} · ${plural(lines.length - 1, "more line")}`;
}

function summarizeEmptySemanticOutput(kind: ReturnType<typeof bashOutputKind>, emptyResult: BashEmptyResult | undefined): string | undefined {
	if (kind === "search" || kind === "search-lines" || kind === "search-files") return "no matches";
	if (kind === "paths" || kind === "file-count") return "no paths";
	if (kind === "entries") return "empty";
	if (emptyResult === "no-changes") return "no changes";
	if (emptyResult === "clean") return "clean";
	return undefined;
}

export function summarizeSuccessfulBashOutput(output: string, command?: string): string | undefined {
	const kind = bashOutputKind(command);
	const emptyResult = bashEmptyResult(command);
	if (!hasMeaningfulOutput(output)) return summarizeEmptySemanticOutput(kind, emptyResult);
	// Count content lines only: blank lines are noise in a summary and must not inflate it.
	const lines = outputLines(output);
	if (lines.length === 0) return summarizeEmptySemanticOutput(kind, emptyResult);

	if (kind === "search") return summarizeSearchOutput(lines);
	if (kind === "search-lines") return summarizeSearchLinesOutput(output);
	if (kind === "search-files") return plural(lines.length, "file");
	if (kind === "file-count") return summarizeFileCountOutput(output, lines);
	if (kind === "paths") return summarizePathOutput(lines);
	if (kind === "entries") return summarizeEntryOutput(lines);

	return summarizeGenericOutput(lines);
}

function exitStatusCode(status: string): string | undefined {
	return status.match(/^exit\s+(\d+)$/i)?.[1];
}

function appendExitStatus(summary: string, status: string): string {
	const code = exitStatusCode(status);
	return code ? `${summary} · exit ${code}` : summary;
}

function hasTestFailure(output: string, command?: string): boolean {
	const commandLooksLikeTest = command !== undefined && /\b(?:test|vitest|jest|mocha|ava|playwright|pytest|cargo\s+test|go\s+test)\b/i.test(command);
	return (
		/^(?:FAIL|FAILED)\b/m.test(output) ||
		/\bTests?:\s+.*\bfailed\b/i.test(output) ||
		/\b\d+\s+(?:failed|failing)\b/i.test(output) ||
		/\btest(?:s| suite)?\s+failed\b/i.test(output) ||
		(commandLooksLikeTest && /\bfail(?:ed|ure|ing)?\b/i.test(output))
	);
}

function hasTypeScriptErrors(output: string, command?: string): boolean {
	return /\berror\s+TS\d{4}\b/.test(output) || Boolean(command && /\btsc\b/.test(command) && /\bFound\s+\d+\s+errors?\b/i.test(output));
}

function classifyBashFailure(output: string, command?: string): string | undefined {
	if (hasTypeScriptErrors(output, command)) return "tsc errors";
	if (hasTestFailure(output, command)) return "test failed";
	if (/\bcommand not found\b/i.test(output) || /^.+?:\s+not found$/im.test(output)) return "command not found";
	if (/\bpermission denied\b/i.test(output)) return "permission denied";
	if (/\bmodule not found\b/i.test(output) || /\bCannot find module\b/i.test(output)) return "module not found";
	return undefined;
}

export function summarizeFailedBashOutput(status: string, output: string, command?: string): string {
	if (/^(?:timeout|aborted|failed)\b/i.test(status) && status !== "failed") return status;
	const classification = classifyBashFailure(stripAnsi(output), command);
	return classification ? appendExitStatus(classification, status) : status;
}

export function tail(text: string, maxLines = BASH_TAIL_LINES): string {
	const lines = trimTrailingEmptyLines(stripAnsi(text).split("\n"));
	return lines.slice(Math.max(0, lines.length - maxLines)).join("\n");
}

/** Count output lines the same way `tail` trims them, so shown/total stay consistent. */
export function outputLineCount(output: string): number {
	return trimTrailingEmptyLines(stripAnsi(output).split("\n")).length;
}

export function previewTail(output: string, maxLines: number): string {
	return hasMeaningfulOutput(output) ? tail(output, maxLines) : "";
}

export function summarizeBashStream(output: string): string {
	if (!hasMeaningfulOutput(output)) return "running";
	return `${formatLineCount(countLines(stripAnsi(output).trimEnd()))} so far`;
}
