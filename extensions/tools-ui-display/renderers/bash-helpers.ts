import { countLines, plural, stripAnsi, trimTrailingEmptyLines } from "../core-utils.js";

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

function pipesToWcLine(command: string): boolean {
	return /\|\s*wc\s+(?:-[A-Za-z]*l[A-Za-z]*|--lines)\b/.test(command);
}

function hasSearchContextFlag(command: string): boolean {
	return /(?:^|\s)(?:-(?!-)[A-Za-z]*[ABC][A-Za-z]*\d*|--(?:after-context|before-context|context)(?:[=\s]|$))/.test(command);
}

function bashOutputKind(command: string | undefined): BashSemanticOutputKind | undefined {
	if (!command) return undefined;
	const normalized = stripAnsi(command).trimStart();
	const first = stripLeadingAssignments(firstShellCommand(normalized));

	if (/^rg\s+--files(?:\s|$)/.test(first)) return "paths";
	if (/^(?:rg|grep)\b/.test(first)) {
		if (/(?:^|\s)(?:-(?!-)[A-Za-z]*l[A-Za-z]*|--files-with-matches)(?:\s|$)/.test(first)) return "search-files";
		if (hasSearchContextFlag(first)) return "search-lines";
		return "search";
	}
	if (/^find\b/.test(first)) return pipesToWcLine(normalized) ? "file-count" : "paths";
	if (/^ls\b/.test(first)) return hasTopLevelShellChain(normalized) ? undefined : "entries";
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

function summarizeOutputLines(count: number): string {
	return `${count} output ${count === 1 ? "line" : "lines"}`;
}

function summarizeEmptySemanticOutput(kind: ReturnType<typeof bashOutputKind>): string | undefined {
	if (kind === "search" || kind === "search-lines" || kind === "search-files") return "no matches";
	if (kind === "paths" || kind === "file-count") return "no paths";
	if (kind === "entries") return "empty";
	return undefined;
}

export function summarizeSuccessfulBashOutput(output: string, command?: string): string | undefined {
	const kind = bashOutputKind(command);
	if (!hasMeaningfulOutput(output)) return summarizeEmptySemanticOutput(kind);
	const lines = outputLines(output);
	if (lines.length === 0) return summarizeEmptySemanticOutput(kind);

	if (kind === "search") return summarizeSearchOutput(lines);
	if (kind === "search-lines") return summarizeSearchLinesOutput(output);
	if (kind === "search-files") return plural(lines.length, "file");
	if (kind === "file-count") return summarizeFileCountOutput(output, lines);
	if (kind === "paths") return summarizePathOutput(lines);
	if (kind === "entries") return summarizeEntryOutput(lines);

	return summarizeOutputLines(countLines(stripAnsi(output).trimEnd()));
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

export function previewTail(output: string, maxLines: number): string {
	return hasMeaningfulOutput(output) ? tail(output, maxLines) : "";
}

export function summarizeBashStream(output: string): string {
	if (!hasMeaningfulOutput(output)) return "running";
	return `${plural(countLines(stripAnsi(output).trimEnd()), "line")} so far`;
}
