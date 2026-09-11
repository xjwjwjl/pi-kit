import { parse } from "unbash";
import type { Command, Node, ParsedScript, Statement } from "unbash";
import { stripAnsi } from "../core-utils.js";

export const MAX_FORMAT_COMMAND_BYTES = 32 * 1024;
export const MAX_FORMAT_COMMAND_TOKENS = 512;

export type BashCommandTokenRole = "command" | "assignment" | "argument" | "redirection";

export type BashCommandToken = {
	role: BashCommandTokenRole;
	text: string;
	start: number;
	end: number;
};

type SimpleLayoutNode = {
	kind: "simple";
	tokens: BashCommandToken[];
	start: number;
	end: number;
};

type CompositeLayoutNode = {
	kind: "pipeline" | "and-or";
	children: BashLayoutNode[];
	operators: string[];
	start: number;
	end: number;
};

type RawLayoutNode = {
	kind: "raw";
	source: string;
	start: number;
	end: number;
};

export type BashLayoutNode = SimpleLayoutNode | CompositeLayoutNode | RawLayoutNode;

export type BashLayoutStatement = {
	node: BashLayoutNode;
	terminator?: ";";
};

export type BashCommandLayout = {
	source: string;
	statements: BashLayoutStatement[];
	statementCount: number;
	tokenCount: number;
	formatted: boolean;
};

type SourceRange = {
	start: number;
	end: number;
};

function inRange(index: number, ranges: SourceRange[]): boolean {
	return ranges.some((range) => index >= range.start && index < range.end);
}

function validRange(source: string, start: unknown, end: unknown): start is number {
	return typeof start === "number" && typeof end === "number" && start >= 0 && end >= start && end <= source.length;
}

function normalizedSource(command: string): string {
	return stripAnsi(command).replace(/\r\n?/g, "\n");
}

function cleanHeredocDelimiter(value: string): string {
	return value.replace(/^['"]|['"]$/g, "");
}

function collectRedirects(value: unknown, redirects: any[] = [], seen = new Set<object>()): any[] {
	if (!value || typeof value !== "object") return redirects;
	if (seen.has(value as object)) return redirects;
	seen.add(value as object);

	if (Array.isArray(value)) {
		for (const item of value) collectRedirects(item, redirects, seen);
		return redirects;
	}

	const record = value as Record<string, unknown>;
	if (Array.isArray(record.redirects)) redirects.push(...record.redirects);
	for (const [key, child] of Object.entries(record)) {
		if (key === "redirects" || key === "parts" || key === "expression") continue;
		collectRedirects(child, redirects, seen);
	}
	return redirects;
}

function heredocRanges(source: string, redirects: any[]): SourceRange[] | undefined {
	const heredocs = redirects
		.filter((redirect) => redirect?.operator === "<<" || redirect?.operator === "<<-")
		.sort((left, right) => (left.pos ?? 0) - (right.pos ?? 0));
	if (heredocs.length === 0) return [];
	if (heredocs.some((redirect) => !validRange(source, redirect.pos, redirect.end) || !redirect.target)) return undefined;

	const openerEnd = Math.max(...heredocs.map((redirect) => redirect.end as number));
	const firstNewline = source.indexOf("\n", openerEnd);
	if (firstNewline < 0) return undefined;

	let cursor = firstNewline + 1;
	const ranges: SourceRange[] = [];
	for (const redirect of heredocs) {
		const content = typeof redirect.content === "string" ? redirect.content : undefined;
		const delimiter = cleanHeredocDelimiter(source.slice(redirect.target.pos, redirect.target.end));
		if (content === undefined || !delimiter) return undefined;
		if (source.slice(cursor, cursor + content.length) !== content) return undefined;

		const delimiterStart = cursor + content.length;
		const delimiterEnd = source.indexOf("\n", delimiterStart);
		const lineEnd = delimiterEnd < 0 ? source.length : delimiterEnd;
		const actualDelimiter = source.slice(delimiterStart, lineEnd);
		const comparableDelimiter = redirect.operator === "<<-" ? actualDelimiter.replace(/^\t+/, "") : actualDelimiter;
		if (comparableDelimiter !== delimiter) return undefined;

		const rangeEnd = delimiterEnd < 0 ? source.length : delimiterEnd + 1;
		ranges.push({ start: cursor, end: rangeEnd });
		cursor = rangeEnd;
	}
	return ranges;
}

function isCommentStart(source: string, index: number): boolean {
	if (index === 0) return true;
	const previous = source[index - 1];
	return previous === undefined || /\s/.test(previous) || /[;|&(){}<>]/.test(previous);
}

function containsShellComment(source: string, ignored: SourceRange[]): boolean {
	let quote: "'" | '"' | undefined;
	let escaped = false;
	for (let index = 0; index < source.length; index++) {
		if (inRange(index, ignored)) continue;
		const char = source[index];
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
		if (char === "#" && isCommentStart(source, index)) return true;
	}
	return false;
}

function containsBacktick(source: string, ignored: SourceRange[]): boolean {
	let quote: "'" | '"' | undefined;
	let escaped = false;
	for (let index = 0; index < source.length; index++) {
		if (inRange(index, ignored)) continue;
		const char = source[index];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (char === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (quote === '"' && char === "`") return true;
			if (char === quote) quote = undefined;
			continue;
		}
		if (char === "'") {
			quote = char;
			continue;
		}
		if (char === '"') {
			quote = char;
			continue;
		}
		if (char === "`") return true;
	}
	return false;
}

function simpleParameterExpansion(part: any): boolean {
	return (
		part?.type === "ParameterExpansion" &&
		(part.operator !== undefined || part.operand !== undefined || part.slice !== undefined || part.replace !== undefined ||
			part.indirect !== undefined || part.length !== undefined || part.indexParts !== undefined)
	);
}

function validatePart(part: any, source: string, seenScripts: Set<object>): boolean {
	if (simpleParameterExpansion(part)) return false;
	if (part?.script) {
		if (seenScripts.has(part.script) || part.script.source || part.script.errors?.length) return false;
		seenScripts.add(part.script);
		if (!validateScript(part.script, source, seenScripts)) return false;
	}
	if (part?.parts && !validateParts(part.parts, source, seenScripts)) return false;
	if (part?.expression && !validateExpression(part.expression, source, seenScripts)) return false;
	return true;
}

function validateWord(word: any, source: string, seenScripts: Set<object>): boolean {
	if (!word || !validRange(source, word.pos, word.end) || source.slice(word.pos, word.end) !== word.text) return false;
	try {
		return validateParts(word.parts ?? [], source, seenScripts);
	} catch {
		return false;
	}
}

function validateParts(parts: any[], source: string, seenScripts: Set<object>): boolean {
	return parts.every((part) => validatePart(part, source, seenScripts));
}

function validateExpression(expression: any, source: string, seenScripts: Set<object>): boolean {
	if (!expression || typeof expression !== "object") return true;
	if (expression.type === "ArithmeticCommandExpansion" && expression.script) {
		if (seenScripts.has(expression.script) || expression.script.source || expression.script.errors?.length) return false;
		seenScripts.add(expression.script);
		if (!validateScript(expression.script, source, seenScripts)) return false;
	}
	for (const value of Object.values(expression)) {
		if (value && typeof value === "object" && !validateExpression(value, source, seenScripts)) return false;
	}
	return true;
}

function validateSimpleCommand(command: Command, source: string, seenScripts: Set<object>): boolean {
	if (!validRange(source, command.pos, command.end) || !command.name) return false;
	if (source.slice(command.name.pos, command.name.end) === "eval") return false;
	if (!validateWord(command.name, source, seenScripts)) return false;
	for (const assignment of command.prefix ?? []) {
		if (!validRange(source, assignment.pos, assignment.end)) return false;
		if (assignment.value && !validateWord(assignment.value, source, seenScripts)) return false;
	}
	for (const word of command.suffix ?? []) {
		if (!validateWord(word, source, seenScripts)) return false;
	}
	for (const redirect of command.redirects ?? []) {
		if (!validRange(source, redirect.pos, redirect.end)) return false;
		if (redirect.target && !validateWord(redirect.target, source, seenScripts)) return false;
	}
	return true;
}

function validateNode(node: any, source: string, seenScripts: Set<object>): boolean {
	if (!node || !validRange(source, node.pos, node.end)) return false;
	switch (node.type) {
		case "Statement":
			return !node.background && (!node.redirects || node.redirects.length === 0) && validateNode(node.command, source, seenScripts);
		case "Command":
			return validateSimpleCommand(node, source, seenScripts);
		case "Pipeline":
			return (
				!node.negated && !node.time &&
				node.operators?.every((operator: string) => operator === "|" || operator === "|&") &&
				node.commands?.every((child: Node) => validateNode(child, source, seenScripts))
			);
		case "AndOr":
			return (
				node.operators?.every((operator: string) => operator === "&&" || operator === "||") &&
				node.commands?.every((child: Node) => validateNode(child, source, seenScripts))
			);
		default:
			return false;
	}
}

function tokenFromRange(role: BashCommandTokenRole, source: string, value: any): BashCommandToken | undefined {
	if (!validRange(source, value?.pos, value?.end)) return undefined;
	const text = source.slice(value.pos, value.end);
	if (!text || text.includes("\n")) return undefined;
	return { role, text, start: value.pos, end: value.end };
}

function adaptSimpleCommand(command: Command, source: string): SimpleLayoutNode | undefined {
	const tokens: BashCommandToken[] = [];
	for (const assignment of command.prefix ?? []) {
		const token = tokenFromRange("assignment", source, assignment);
		if (!token) return undefined;
		tokens.push(token);
	}
	const name = tokenFromRange("command", source, command.name);
	if (!name) return undefined;
	tokens.push(name);
	for (const word of command.suffix ?? []) {
		const token = tokenFromRange("argument", source, word);
		if (!token) return undefined;
		tokens.push(token);
	}
	for (const redirect of command.redirects ?? []) {
		const token = tokenFromRange("redirection", source, redirect);
		if (!token) return undefined;
		tokens.push(token);
	}

	tokens.sort((left, right) => left.start - right.start);
	let previousEnd = command.pos;
	for (const token of tokens) {
		if (token.start < previousEnd || token.start < command.pos || token.end > command.end) return undefined;
		previousEnd = token.end;
	}
	return { kind: "simple", tokens, start: command.pos, end: command.end };
}

function adaptNode(node: any, source: string): BashLayoutNode | undefined {
	if (!node || !validRange(source, node.pos, node.end)) return undefined;
	switch (node.type) {
		case "Statement":
			if (node.background || node.redirects?.length) return undefined;
			return adaptNode(node.command, source);
		case "Command":
			return adaptSimpleCommand(node, source);
		case "Pipeline":
			if (node.negated || node.time || !node.operators?.every((operator: string) => operator === "|" || operator === "|&")) return undefined;
			{
				const children = node.commands?.map((child: Node) => adaptNode(child, source));
				if (!children || children.some((child: BashLayoutNode | undefined): child is undefined => child === undefined)) return undefined;
				return { kind: "pipeline", children, operators: [...node.operators], start: node.pos, end: node.end };
			}
		case "AndOr":
			if (!node.operators?.every((operator: string) => operator === "&&" || operator === "||")) return undefined;
			{
				const children = node.commands?.map((child: Node) => adaptNode(child, source));
				if (!children || children.some((child: BashLayoutNode | undefined): child is undefined => child === undefined)) return undefined;
				return { kind: "and-or", children, operators: [...node.operators], start: node.pos, end: node.end };
			}
		default:
			return undefined;
	}
}

function statementTerminator(source: string, start: number, end: number): ";" | undefined {
	for (let index = start; index < end; index++) {
		const char = source[index];
		if (char === " " || char === "\t" || char === "\n") continue;
		if (char === ";") return ";";
		return undefined;
	}
	return undefined;
}

function validateScript(script: ParsedScript, source: string, seenScripts: Set<object>): boolean {
	if (script.errors?.length) return false;
	return script.commands.every((statement: Statement) => validateNode(statement, source, seenScripts));
}

function countAstTokens(node: any): number {
	if (!node) return 0;
	if (node.type === "Statement") return countAstTokens(node.command);
	if (node.type === "Command") {
		return (node.prefix?.length ?? 0) + (node.name ? 1 : 0) + (node.suffix?.length ?? 0) + (node.redirects?.length ?? 0);
	}
	if (node.type === "Pipeline" || node.type === "AndOr") return (node.commands ?? []).reduce((total: number, child: Node) => total + countAstTokens(child), 0);
	return 0;
}

function rawHeredocLayout(source: string, statements: Statement[], tokenCount: number): BashCommandLayout {
	return {
		source,
		statements: [{ node: { kind: "raw", source, start: 0, end: source.length } }],
		statementCount: statements.length,
		tokenCount,
		formatted: false,
	};
}

function countLayoutTokens(node: BashLayoutNode): number {
	if (node.kind === "simple") return node.tokens.length;
	if (node.kind === "raw") return 0;
	return node.children.reduce((total, child) => total + countLayoutTokens(child), 0);
}

export function adaptBashCommand(command: string, argsComplete = true): BashCommandLayout | undefined {
	if (!argsComplete) return undefined;
	const source = normalizedSource(command);
	if (!source.trim() || Buffer.byteLength(source, "utf8") > MAX_FORMAT_COMMAND_BYTES) return undefined;

	let script: ReturnType<typeof parse>;
	try {
		script = parse(source);
	} catch {
		return undefined;
	}
	if (script.errors?.length) return undefined;

	const redirects = collectRedirects(script);
	const ignoredHeredocRanges = heredocRanges(source, redirects);
	if (ignoredHeredocRanges === undefined) return undefined;
	if (containsShellComment(source, ignoredHeredocRanges) || containsBacktick(source, ignoredHeredocRanges)) return undefined;

	const seenScripts = new Set<object>();
	if (!validateScript(script, source, seenScripts)) return undefined;
	const astTokenCount = script.commands.reduce((total, statement) => total + countAstTokens(statement), 0);
	if (astTokenCount > MAX_FORMAT_COMMAND_TOKENS) return undefined;
	if (ignoredHeredocRanges.length > 0) return rawHeredocLayout(source, script.commands, astTokenCount);

	const statements: BashLayoutStatement[] = [];
	for (let index = 0; index < script.commands.length; index++) {
		const statement = script.commands[index];
		const node = adaptNode(statement, source);
		if (!node) return undefined;
		const nextStart = script.commands[index + 1]?.pos ?? source.length;
		statements.push({ node, terminator: statementTerminator(source, statement.end, nextStart) });
	}
	if (statements.length === 0) return undefined;
	const tokenCount = statements.reduce((total, statement) => total + countLayoutTokens(statement.node), 0);
	if (tokenCount > MAX_FORMAT_COMMAND_TOKENS) return undefined;

	return {
		source,
		statements,
		statementCount: statements.length,
		tokenCount,
		formatted: statements.length > 1 || statements.some(({ node }) => node.kind === "pipeline" || node.kind === "and-or"),
	};
}
