import { parse as parseShell, type Script, type Word, type WordPart } from "unbash";
import { ALLOWED_EXECUTABLE_PREFIXES, KNOWN_EXECUTABLES } from "./executable-catalog.js";

export const MAX_RAW_COMMAND_BYTES = 4096;
export const MAX_ARGUMENTS = 100;
export const MAX_ARGUMENT_BYTES = 1024;

export interface VerifiedCommand {
	/** Canonical command identity used by the policy rules. */
	readonly executable: string;
	/** Safe invocation path/name passed to the remote argv executor. */
	readonly executionPath: string;
	readonly args: readonly string[];
}

export type VerificationFailureCode =
	| "EMPTY_COMMAND"
	| "NUL_BYTE"
	| "COMMAND_TOO_LONG"
	| "PARSE_ERROR"
	| "NOT_SINGLE_COMMAND"
	| "UNSUPPORTED_AST"
	| "COMMAND_ASYNC"
	| "ASSIGNMENT_NOT_ALLOWED"
	| "WORD_NOT_LITERAL"
	| "WORD_TOO_LONG"
	| "CONTROL_CHARACTER"
	| "WORD_EXPANSION"
	| "WORD_GLOB"
	| "WORD_BRACE_EXPANSION"
	| "WORD_TILDE_EXPANSION"
	| "EXECUTABLE_PATH_NOT_ALLOWED"
	| "EXECUTABLE_EMPTY";

export interface VerificationFailure {
	readonly ok: false;
	readonly code: VerificationFailureCode;
	readonly reason: string;
}

export interface VerificationSuccess {
	readonly ok: true;
	readonly command: VerifiedCommand;
}

export type VerificationResult = VerificationFailure | VerificationSuccess;

/**
 * Parse and verify the deliberately small shell subset accepted by remote_exec.
 *
 * Uses unbash (zero-dependency, tolerance-mode parser) to produce an AST, then
 * enforces a single static SimpleCommand without expansions, globs, redirects,
 * or other shell constructs. Callers receive only a static argv-like
 * VerifiedCommand — never parser nodes or a command string that can be
 * reinterpreted later.
 */
export function parseVerifiedCommand(rawCommand: string): VerificationResult {
	if (!rawCommand.trim()) {
		return failure("EMPTY_COMMAND", "command is empty");
	}
	if (rawCommand.includes("\n") || rawCommand.includes("\r")) {
		return failure("UNSUPPORTED_AST", "multiline commands are not allowed");
	}
	if (rawCommand.includes("\u0000")) {
		return failure("NUL_BYTE", "command contains NUL byte");
	}
	if (Buffer.byteLength(rawCommand, "utf8") > MAX_RAW_COMMAND_BYTES) {
		return failure("COMMAND_TOO_LONG", `command exceeds ${MAX_RAW_COMMAND_BYTES} bytes`);
	}

	let result: Script & { errors?: unknown[] };
	try {
		result = parseShell(rawCommand);
	} catch {
		return failure("PARSE_ERROR", "shell syntax could not be parsed safely");
	}

	const script = result as Script;
	if (result.errors && result.errors.length > 0) {
		return failure("PARSE_ERROR", "shell syntax could not be parsed safely");
	}

	if (script.commands.length !== 1) {
		return failure("NOT_SINGLE_COMMAND", "only one shell command is allowed");
	}

	const statement = script.commands[0]!;
	if (statement.background === true) {
		return failure("COMMAND_ASYNC", "background commands are not allowed");
	}
	if (statement.redirects.length > 0) {
		return failure("UNSUPPORTED_AST", "redirections and other shell operators are not allowed");
	}

	const cmd = statement.command;
	if (cmd.type !== "Command") {
		return failure("UNSUPPORTED_AST", "only a simple command is allowed");
	}
	if (cmd.redirects.length > 0) {
		return failure("UNSUPPORTED_AST", "redirections and other shell operators are not allowed");
	}

	// Check trailing shell syntax after the statement
	const trailingSyntax = findTrailingShellSyntax(rawCommand, statement.end);
	if (trailingSyntax) {
		return failure("UNSUPPORTED_AST", trailingSyntax);
	}

	// Prefix (assignments like FOO=bar)
	if (cmd.prefix.length > 0) {
		return failure("ASSIGNMENT_NOT_ALLOWED", "environment assignments are not allowed");
	}

	if (!cmd.name) {
		return failure("UNSUPPORTED_AST", "command name is not a literal word");
	}

	const name = resolveWord(cmd.name, rawCommand, "command name");
	if (!name.ok) return name;
	const executable = normalizeExecutable(name.text);
	if (!executable.ok) return executable;

	if (cmd.suffix.length > MAX_ARGUMENTS) {
		return failure("WORD_TOO_LONG", `command has more than ${MAX_ARGUMENTS} arguments`);
	}

	const args: string[] = [];
	for (const suffixWord of cmd.suffix) {
		const word = resolveWord(suffixWord, rawCommand, "argument");
		if (!word.ok) return word;
		args.push(word.text);
	}

	const command: VerifiedCommand = Object.freeze({
		executable: executable.executable,
		executionPath: executable.executionPath,
		args: Object.freeze(args),
	});
	return { ok: true, command };
}

// ── word resolution ──

function resolveWord(
	word: Word,
	source: string,
	role: "command name" | "argument",
): { ok: true; text: string } | VerificationFailure {
	const text = word.value;

	if (text.includes("\u0000")) {
		return failure("NUL_BYTE", `${role} contains NUL byte`);
	}
	if (/[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
		return failure("CONTROL_CHARACTER", `${role} contains a control character`);
	}
	if (Buffer.byteLength(text, "utf8") > MAX_ARGUMENT_BYTES) {
		return failure("WORD_TOO_LONG", `${role} exceeds ${MAX_ARGUMENT_BYTES} bytes`);
	}

	const safety = checkWordParts(word.parts);
	if (!safety.ok) return safety;

	if (!word.parts) {
		// Plain unquoted word — scan for glob, brace, tilde in the value
		const syntax = scanCharSyntax(word.value, 0);
		if (syntax) return syntax;
	} else {
		// Has parts — scan Literal parts (unquoted portions) for glob/brace/tilde
		for (const part of word.parts) {
			if (part.type === "Literal") {
				const syntax = scanCharSyntax(part.value, 0);
				if (syntax) return syntax;
			}
		}
	}

	return { ok: true, text };
}

// ── part safety ──

function checkWordParts(parts: WordPart[] | undefined): VerificationFailure | { ok: true } {
	if (!parts || parts.length === 0) return { ok: true };
	for (const part of parts) {
		const result = checkPart(part);
		if (!result.ok) return result;
	}
	return { ok: true };
}

function checkPart(part: WordPart): VerificationFailure | { ok: true } {
	if (part.type === "Literal" || part.type === "SingleQuoted") {
		return { ok: true };
	}
	if (part.type === "DoubleQuoted") {
		return checkWordParts(part.parts);
	}
	if (part.type === "BraceExpansion") {
		return failure("WORD_BRACE_EXPANSION", "word contains brace expansion");
	}
	if (part.type === "ExtendedGlob") {
		return failure("WORD_GLOB", "word contains extended glob syntax");
	}
	// ParameterExpansion, CommandExpansion, ArithmeticExpansion, SimpleExpansion,
	// ProcessSubstitution, AnsiCQuoted, LocaleString → all unsafe.
	return failure("WORD_EXPANSION", "word contains a shell expansion or unsupported syntax");
}

// ── char-level syntax scan (for unquoted glob / brace / tilde) ──

function scanCharSyntax(
	text: string,
	_startOffset: number,
): VerificationFailure | undefined {
	for (let index = 0; index < text.length; index++) {
		const ch = text[index] ?? "";
		if (ch === "*" || ch === "?" || ch === "[") {
			return failure("WORD_GLOB", "argument contains unquoted glob syntax");
		}
		if (ch === "{" || ch === "}") {
			return failure("WORD_BRACE_EXPANSION", "argument contains unquoted brace expansion syntax");
		}
		if (ch === "~" && index === 0) {
			return failure("WORD_TILDE_EXPANSION", "argument contains unquoted tilde expansion syntax");
		}
	}
	return undefined;
}

// ── executable normalization ──

function normalizeExecutable(rawExecutable: string):
	| { ok: true; executable: string; executionPath: string }
	| VerificationFailure {
	if (!rawExecutable) return failure("EXECUTABLE_EMPTY", "command name is empty");

	if (rawExecutable.startsWith("/")) {
		const normalized = rawExecutable.replace(/\/+/g, "/");
		const basename = normalized.slice(normalized.lastIndexOf("/") + 1);
		if (!KNOWN_EXECUTABLES.has(basename) || !isAllowedAbsoluteExecutablePath(normalized, basename)) {
			return failure("EXECUTABLE_PATH_NOT_ALLOWED", `executable path is not allowed: ${rawExecutable}`);
		}
		return { ok: true, executable: basename, executionPath: normalized };
	}

	if (rawExecutable.includes("/") || !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(rawExecutable)) {
		return failure("EXECUTABLE_PATH_NOT_ALLOWED", `executable path is not allowed: ${rawExecutable}`);
	}
	if (!KNOWN_EXECUTABLES.has(rawExecutable)) {
		return failure("EXECUTABLE_PATH_NOT_ALLOWED", `executable is not in the command catalog: ${rawExecutable}`);
	}

	return { ok: true, executable: rawExecutable, executionPath: rawExecutable };
}

function isAllowedAbsoluteExecutablePath(path: string, basename: string): boolean {
	return ALLOWED_EXECUTABLE_PREFIXES.some((prefix) => path === `${prefix}${basename}`);
}

// ── trailing syntax ──

function findTrailingShellSyntax(source: string, statementEnd: number): string | undefined {
	const trailing = source.slice(statementEnd).trimStart();
	if (/^(?:;|&&|\|\||\||&|>>?|<<?)/.test(trailing)) {
		return "shell operator is not allowed after the command";
	}
	return undefined;
}

// ── helpers ──

function failure(code: VerificationFailureCode, reason: string): VerificationFailure {
	return { ok: false, code, reason };
}
