import { firstNonEmptyLine, stripAnsi } from "../core-utils.js";

function compactFallbackError(text: string): string {
	const line = firstNonEmptyLine(text).replace(/\s+/g, " ").trim();
	return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}

export function compactFileToolError(text: string): string {
	const stripped = stripAnsi(text);

	if (/(?:ENOENT|not found|no such file|cannot find|could not find|path does not exist)/i.test(stripped)) return "path not found";
	if (/(?:EACCES|EPERM|permission denied|operation not permitted|access denied)/i.test(stripped)) return "permission denied";
	if (/(?:invalid content|content must be|invalid\s+.*content|content\s+.*string)/i.test(stripped)) return "invalid content";

	return compactFallbackError(stripped);
}

export function compactFileToolHint(text: string): string | undefined {
	const error = compactFileToolError(text);
	if (error === "path not found") return "check file path";
	if (error === "permission denied") return "check file permissions";
	return undefined;
}
