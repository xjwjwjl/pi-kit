import { normalizeIdentifier } from "../core/access.js";
import { scanSql, type SqlToken } from "./lexer.js";
import type { SqlDialect } from "../types.js";

export type SqlReference = { database?: string; table: string };

export type UnsafeSqlSource = {
	source: string;
	reason: "function_source" | "unknown_source_expression";
};

export type SqlStatementAnalysis = {
	dialect: SqlDialect;
	normalizedSql: string;
	visibleSql: string;
	maskedSql: string;
	tokens: SqlToken[];
	statementKind: string;
	hasMultipleStatements: boolean;
	references: SqlReference[];
	unsafeSources: UnsafeSqlSource[];
	hasSourceClause: boolean;
};

type QueryExtraction = {
	references: SqlReference[];
	unsafeSources: UnsafeSqlSource[];
	hasSourceClause: boolean;
};

const STATEMENT_START_KEYWORDS = new Set([
	"select",
	"show",
	"describe",
	"desc",
	"explain",
	"insert",
	"update",
	"delete",
	"merge",
	"replace",
	"create",
	"alter",
	"drop",
	"truncate",
	"grant",
	"revoke",
	"set",
	"use",
	"call",
	"system",
	"kill",
	"attach",
	"detach",
	"backup",
	"restore",
	"optimize",
	"load",
]);

const SOURCE_BOUNDARY_KEYWORDS = new Set([
	"where",
	"group",
	"order",
	"having",
	"limit",
	"union",
	"except",
	"intersect",
	"join",
	"left",
	"right",
	"inner",
	"outer",
	"full",
	"cross",
	"array",
	"on",
	"using",
	"prewhere",
	"window",
	"qualify",
	"settings",
	"format",
	"set",
]);

function emptyExtraction(): QueryExtraction {
	return { references: [], unsafeSources: [], hasSourceClause: false };
}

function pushUniqueRef(target: SqlReference[], ref: SqlReference): void {
	const key = `${normalizeIdentifier(ref.database ?? "")}.${normalizeIdentifier(ref.table)}`;
	if (!target.some((item) => `${normalizeIdentifier(item.database ?? "")}.${normalizeIdentifier(item.table)}` === key)) {
		target.push(ref);
	}
}

function pushUniqueUnsafe(target: UnsafeSqlSource[], unsafe: UnsafeSqlSource): void {
	if (!target.some((item) => item.source === unsafe.source && item.reason === unsafe.reason)) target.push(unsafe);
}

function mergeExtraction(target: QueryExtraction, extra: QueryExtraction): void {
	for (const ref of extra.references) pushUniqueRef(target.references, ref);
	for (const source of extra.unsafeSources) pushUniqueUnsafe(target.unsafeSources, source);
	target.hasSourceClause = target.hasSourceClause || extra.hasSourceClause;
}

function isKeyword(token: SqlToken | undefined, keyword: string): boolean {
	return token?.type === "word" && token.normalized === normalizeIdentifier(keyword);
}

function isIdentifierToken(token: SqlToken | undefined): token is Extract<SqlToken, { type: "word" | "quoted_identifier" }> {
	return token?.type === "word" || token?.type === "quoted_identifier";
}

function isStatementStartToken(token: SqlToken | undefined): boolean {
	return token?.type === "word" && STATEMENT_START_KEYWORDS.has(token.normalized);
}

function isSourceBoundaryToken(token: SqlToken | undefined): boolean {
	if (!token) return true;
	if (token.type === "symbol") {
		return token.value === "," || token.value === ")" || token.value === ";";
	}
	if (token.type !== "word") return false;
	return SOURCE_BOUNDARY_KEYWORDS.has(token.normalized);
}

function consumeSourceSuffix(tokens: SqlToken[], start: number, end: number): number {
	let index = start;
	while (index < end) {
		if (isKeyword(tokens[index], "final")) {
			index++;
			continue;
		}
		if (isKeyword(tokens[index], "as") && isIdentifierToken(tokens[index + 1]) && isSourceBoundaryToken(tokens[index + 2])) {
			index += 2;
			continue;
		}
		if (isIdentifierToken(tokens[index]) && isSourceBoundaryToken(tokens[index + 1])) {
			index++;
			continue;
		}
		break;
	}
	return index;
}

function findMatchingParen(tokens: SqlToken[], openIndex: number, end: number): number {
	let depth = 0;
	for (let index = openIndex; index < end; index++) {
		const token = tokens[index];
		if (token?.type !== "symbol") continue;
		if (token.value === "(") depth++;
		if (token.value === ")") {
			depth--;
			if (depth === 0) return index;
		}
	}
	return -1;
}

function looksLikeSubquery(tokens: SqlToken[], start: number, end: number): boolean {
	for (let index = start; index < end; index++) {
		const token = tokens[index];
		if (token?.type === "symbol" && token.value === "(") return false;
		if (isKeyword(token, "select") || isKeyword(token, "with")) return true;
		return false;
	}
	return false;
}

function parseNestedSubqueries(tokens: SqlToken[], start: number, end: number, visibleAliases: Set<string>): QueryExtraction {
	const extraction = emptyExtraction();
	let index = start;
	while (index < end) {
		const token = tokens[index];
		if (token?.type === "symbol" && token.value === "(") {
			const closeIndex = findMatchingParen(tokens, index, end);
			if (closeIndex === -1) break;
			const nested = looksLikeSubquery(tokens, index + 1, closeIndex)
				? parseSqlTokens(tokens, index + 1, closeIndex, new Set(visibleAliases))
				: parseNestedSubqueries(tokens, index + 1, closeIndex, visibleAliases);
			mergeExtraction(extraction, nested);
			index = closeIndex + 1;
			continue;
		}
		index++;
	}
	return extraction;
}

function tryParseStandardCte(
	tokens: SqlToken[],
	start: number,
	end: number,
	visibleAliases: Set<string>,
): { alias?: string; extraction: QueryExtraction; matched: boolean } {
	const extraction = emptyExtraction();
	const nameToken = tokens[start];
	if (!isIdentifierToken(nameToken)) return { extraction, matched: false };

	let index = start + 1;
	if (tokens[index]?.type === "symbol" && tokens[index].value === "(") {
		const closeIndex = findMatchingParen(tokens, index, end);
		if (closeIndex === -1) return { extraction, matched: false };
		index = closeIndex + 1;
	}
	if (!isKeyword(tokens[index], "as")) return { extraction, matched: false };
	index++;
	if (!(tokens[index]?.type === "symbol" && tokens[index].value === "(")) return { extraction, matched: false };
	const closeIndex = findMatchingParen(tokens, index, end);
	if (closeIndex === -1 || closeIndex !== end - 1 || !looksLikeSubquery(tokens, index + 1, closeIndex)) {
		return { extraction, matched: false };
	}

	const alias = normalizeIdentifier(nameToken.value);
	const scopedAliases = new Set(visibleAliases);
	scopedAliases.add(alias);
	mergeExtraction(extraction, parseSqlTokens(tokens, index + 1, closeIndex, scopedAliases));
	return { alias, extraction, matched: true };
}

function processWithItem(
	tokens: SqlToken[],
	start: number,
	end: number,
	visibleAliases: Set<string>,
): { alias?: string; extraction: QueryExtraction } {
	const extraction = emptyExtraction();
	let itemStart = start;
	let itemEnd = end;
	while (itemStart < itemEnd && tokens[itemStart]?.type === "symbol" && tokens[itemStart].value === ",") itemStart++;
	while (itemEnd > itemStart && tokens[itemEnd - 1]?.type === "symbol" && tokens[itemEnd - 1].value === ",") itemEnd--;
	if (itemStart >= itemEnd) return { extraction };

	const standardCte = tryParseStandardCte(tokens, itemStart, itemEnd, visibleAliases);
	if (standardCte.matched) {
		mergeExtraction(extraction, standardCte.extraction);
		return { alias: standardCte.alias, extraction };
	}

	let alias: string | undefined;
	let depth = 0;
	for (let index = itemStart; index < itemEnd; index++) {
		const token = tokens[index];
		if (token?.type === "symbol" && token.value === "(") depth++;
		else if (token?.type === "symbol" && token.value === ")") depth--;
		else if (depth === 0 && isKeyword(token, "as")) {
			const aliasToken = tokens[index + 1];
			if (isIdentifierToken(aliasToken) && index + 2 === itemEnd) {
				alias = normalizeIdentifier(aliasToken.value);
			}
		}
	}

	mergeExtraction(extraction, parseNestedSubqueries(tokens, itemStart, itemEnd, visibleAliases));
	return { alias, extraction };
}

function parseWithClause(
	tokens: SqlToken[],
	withIndex: number,
	end: number,
	visibleAliases: Set<string>,
): { aliases: Set<string>; extraction: QueryExtraction; nextIndex: number } | undefined {
	let index = withIndex + 1;
	if (isKeyword(tokens[index], "recursive")) index++;

	const aliases = new Set(visibleAliases);
	const extraction = emptyExtraction();
	let itemStart = index;
	let depth = 0;

	for (let cursor = index; cursor < end; cursor++) {
		const token = tokens[cursor];
		if (token?.type === "symbol" && token.value === "(") depth++;
		else if (token?.type === "symbol" && token.value === ")") depth--;
		else if (depth === 0 && token?.type === "symbol" && token.value === ",") {
			const item = processWithItem(tokens, itemStart, cursor, aliases);
			if (item.alias) aliases.add(item.alias);
			mergeExtraction(extraction, item.extraction);
			itemStart = cursor + 1;
			continue;
		}

		if (depth === 0 && isStatementStartToken(token)) {
			const item = processWithItem(tokens, itemStart, cursor, aliases);
			if (item.alias) aliases.add(item.alias);
			mergeExtraction(extraction, item.extraction);
			return { aliases, extraction, nextIndex: cursor };
		}
	}

	return undefined;
}

function parseSingleSource(
	tokens: SqlToken[],
	start: number,
	end: number,
	visibleAliases: Set<string>,
	options: { allowDefinitionParens?: boolean } = {},
): { extraction: QueryExtraction; nextIndex: number } {
	const extraction = emptyExtraction();
	let index = start;

	if (isKeyword(tokens[index], "lateral")) {
		const source = parseSingleSource(tokens, index + 1, end, visibleAliases, options);
		mergeExtraction(extraction, source.extraction);
		return { extraction, nextIndex: source.nextIndex };
	}

	if (tokens[index]?.type === "symbol" && tokens[index].value === "(") {
		extraction.hasSourceClause = true;
		const closeIndex = findMatchingParen(tokens, index, end);
		if (closeIndex === -1) return { extraction, nextIndex: end };
		const nested = looksLikeSubquery(tokens, index + 1, closeIndex)
			? parseSqlTokens(tokens, index + 1, closeIndex, new Set(visibleAliases))
			: parseNestedSubqueries(tokens, index + 1, closeIndex, visibleAliases);
		mergeExtraction(extraction, nested);
		return { extraction, nextIndex: consumeSourceSuffix(tokens, closeIndex + 1, end) };
	}

	const first = tokens[index];
	if (!isIdentifierToken(first)) return { extraction, nextIndex: index + 1 };
	index++;

	let database: string | undefined;
	let table = first.value;
	if (tokens[index]?.type === "symbol" && tokens[index].value === ".") {
		const second = tokens[index + 1];
		if (!isIdentifierToken(second)) return { extraction, nextIndex: index + 1 };
		database = first.value;
		table = second.value;
		index += 2;
	}

	if (tokens[index]?.type === "symbol" && tokens[index].value === "(") {
		extraction.hasSourceClause = true;
		if (options.allowDefinitionParens) {
			if (!visibleAliases.has(normalizeIdentifier(table))) {
				pushUniqueRef(extraction.references, { database, table });
			}
			const closeIndex = findMatchingParen(tokens, index, end);
			return { extraction, nextIndex: closeIndex === -1 ? index : closeIndex + 1 };
		}
		pushUniqueUnsafe(extraction.unsafeSources, {
			source: database ? `${database}.${table}` : table,
			reason: "function_source",
		});
		const closeIndex = findMatchingParen(tokens, index, end);
		if (closeIndex !== -1) {
			mergeExtraction(extraction, parseNestedSubqueries(tokens, index + 1, closeIndex, visibleAliases));
			index = consumeSourceSuffix(tokens, closeIndex + 1, end);
		}
		return { extraction, nextIndex: index };
	}

	extraction.hasSourceClause = true;
	if (!visibleAliases.has(normalizeIdentifier(table))) {
		pushUniqueRef(extraction.references, { database, table });
	}
	return { extraction, nextIndex: consumeSourceSuffix(tokens, index, end) };
}

function sourceStartAfterTableKeyword(tokens: SqlToken[], tableKeywordIndex: number, end: number): number {
	let index = tableKeywordIndex + 1;
	if (isKeyword(tokens[index], "if") && isKeyword(tokens[index + 1], "not") && isKeyword(tokens[index + 2], "exists")) {
		return Math.min(end, index + 3);
	}
	if (isKeyword(tokens[index], "if") && isKeyword(tokens[index + 1], "exists")) {
		return Math.min(end, index + 2);
	}
	return index;
}

function parseSourceList(
	tokens: SqlToken[],
	start: number,
	end: number,
	visibleAliases: Set<string>,
): { extraction: QueryExtraction; nextIndex: number } {
	const extraction = emptyExtraction();
	let index = start;
	while (index < end) {
		const parsed = parseSingleSource(tokens, index, end, visibleAliases);
		mergeExtraction(extraction, parsed.extraction);
		index = parsed.nextIndex;
		if (!(tokens[index]?.type === "symbol" && tokens[index].value === ",")) break;
		index++;
	}
	return { extraction, nextIndex: index };
}

function consumeVariableList(tokens: SqlToken[], start: number, end: number): number {
	let index = start;
	while (index < end) {
		if (tokens[index]?.type !== "variable") return index;
		index++;
		if (tokens[index]?.type !== "symbol" || tokens[index].value !== ",") return index;
		index++;
	}
	return index;
}

function parseSqlTokens(tokens: SqlToken[], start: number, end: number, visibleAliases: Set<string>): QueryExtraction {
	const extraction = emptyExtraction();
	const scopeAliases = new Set(visibleAliases);
	let index = start;

	while (index < end) {
		const token = tokens[index];

		if (isKeyword(token, "with")) {
			const parsedWith = parseWithClause(tokens, index, end, scopeAliases);
			if (parsedWith) {
				for (const alias of parsedWith.aliases) scopeAliases.add(alias);
				mergeExtraction(extraction, parsedWith.extraction);
				index = parsedWith.nextIndex;
				continue;
			}
		}

		if (token?.type === "symbol" && token.value === "(") {
			const closeIndex = findMatchingParen(tokens, index, end);
			if (closeIndex === -1) break;
			const nested = looksLikeSubquery(tokens, index + 1, closeIndex)
				? parseSqlTokens(tokens, index + 1, closeIndex, new Set(scopeAliases))
				: parseNestedSubqueries(tokens, index + 1, closeIndex, scopeAliases);
			mergeExtraction(extraction, nested);
			index = closeIndex + 1;
			continue;
		}

		if (isKeyword(token, "from")) {
			const sources = parseSourceList(tokens, index + 1, end, scopeAliases);
			mergeExtraction(extraction, sources.extraction);
			index = sources.nextIndex;
			continue;
		}

		if (isKeyword(token, "join")) {
			if (isKeyword(tokens[index - 1], "array")) {
				index++;
				continue;
			}
			const source = parseSingleSource(tokens, index + 1, end, scopeAliases);
			mergeExtraction(extraction, source.extraction);
			index = source.nextIndex;
			continue;
		}

		if (isKeyword(token, "into")) {
			if (tokens[index + 1]?.type === "variable") {
				index = consumeVariableList(tokens, index + 1, end);
				continue;
			}
			const source = parseSingleSource(tokens, index + 1, end, scopeAliases, { allowDefinitionParens: true });
			mergeExtraction(extraction, source.extraction);
			index = source.nextIndex;
			continue;
		}

		if (isKeyword(token, "update")) {
			const sources = parseSourceList(tokens, index + 1, end, scopeAliases);
			mergeExtraction(extraction, sources.extraction);
			index = sources.nextIndex;
			continue;
		}

		if (isKeyword(token, "table")) {
			const source = parseSingleSource(tokens, sourceStartAfterTableKeyword(tokens, index, end), end, scopeAliases, {
				allowDefinitionParens: true,
			});
			mergeExtraction(extraction, source.extraction);
			index = source.nextIndex;
			continue;
		}

		index++;
	}

	return extraction;
}

export function classifySqlKind(tokens: SqlToken[]): string {
	const firstWord = tokens.find((token) => token.type === "word");
	if (!firstWord) return "unknown";
	if (firstWord.normalized !== "with") return firstWord.normalized;

	let depth = 0;
	for (let index = tokens.indexOf(firstWord) + 1; index < tokens.length; index++) {
		const token = tokens[index];
		if (token.type === "symbol") {
			if (token.value === "(") depth++;
			if (token.value === ")" && depth > 0) depth--;
			continue;
		}
		if (depth === 0 && isStatementStartToken(token)) return token.normalized;
	}
	return "select";
}

export function analyzeSql(statement: string, dialect: SqlDialect): SqlStatementAnalysis {
	const scanned = scanSql(statement);
	const extraction = parseSqlTokens(scanned.tokens, 0, scanned.tokens.length, new Set());
	return {
		dialect,
		normalizedSql: scanned.normalizedQuery,
		visibleSql: scanned.visibleSql,
		maskedSql: scanned.maskedSql,
		tokens: scanned.tokens,
		statementKind: classifySqlKind(scanned.tokens),
		hasMultipleStatements: scanned.hasMultipleStatements,
		references: extraction.references,
		unsafeSources: extraction.unsafeSources,
		hasSourceClause: extraction.hasSourceClause,
	};
}
