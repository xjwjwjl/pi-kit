import type { SqlDialect } from "../types.js";
import { analyzeSql } from "../sql/analyzer.js";
import type { SqlStatementAnalysis } from "../sql/analyzer.js";
import type { SqlToken } from "../sql/lexer.js";

type QueryGuardResult = {
	normalizedQuery: string;
	queryKind: string;
	analysis: SqlStatementAnalysis;
};

export const SQL_APPLY_SUPPORTED_STATEMENTS = [
	"INSERT",
	"UPDATE",
	"REPLACE",
	"MERGE",
	"CREATE DATABASE",
	"CREATE TABLE",
	"ALTER TABLE ADD",
];

export function classifySqlStatementKind(statement: string): string {
	const analysis = analyzeSql(statement, "mysql");
	if (!analysis.normalizedSql) return "unknown";
	return analysis.statementKind;
}

function enforceAllowedQueryKind(queryKind: string): void {
	const allowed = new Set(["select", "show", "describe", "desc", "explain"]);
	if (!allowed.has(queryKind)) {
		throw new Error(`Only read-only SELECT/SHOW/DESCRIBE/EXPLAIN statements are supported in this version. Received ${queryKind.toUpperCase()}.`);
	}
}

function unsupportedApplyStatement(reason: string): never {
	throw new Error(
		`sql_apply currently supports allowed apply statements only: ${SQL_APPLY_SUPPORTED_STATEMENTS.join(", ")}. ${reason}`,
	);
}

function isIdentifierToken(token: SqlToken | undefined): token is Extract<SqlToken, { type: "word" | "quoted_identifier" }> {
	return token?.type === "word" || token?.type === "quoted_identifier";
}

function consumeQualifiedIdentifier(tokens: SqlToken[], start: number): number | undefined {
	if (!isIdentifierToken(tokens[start])) return undefined;
	let cursor = start + 1;
	if (tokens[cursor]?.type === "symbol" && tokens[cursor].value === "." && isIdentifierToken(tokens[cursor + 1])) {
		cursor += 2;
	}
	return cursor;
}

function skipIfNotExists(tokens: SqlToken[], start: number): number {
	const maybeIf = tokens[start];
	const maybeNot = tokens[start + 1];
	const maybeExists = tokens[start + 2];
	return (
		maybeIf?.type === "word" &&
		maybeIf.normalized === "if" &&
		maybeNot?.type === "word" &&
		maybeNot.normalized === "not" &&
		maybeExists?.type === "word" &&
		maybeExists.normalized === "exists"
	)
		? start + 3
		: start;
}

function isCreateDatabaseStatement(tokens: SqlToken[]): boolean {
	if (!(tokens[0]?.type === "word" && tokens[0].normalized === "create")) return false;
	const kind = tokens[1];
	if (!(kind?.type === "word" && (kind.normalized === "database" || kind.normalized === "schema"))) return false;
	const afterOptions = skipIfNotExists(tokens, 2);
	const afterName = consumeQualifiedIdentifier(tokens, afterOptions);
	return afterName === tokens.length;
}

function isCreateTableStatement(tokens: SqlToken[]): boolean {
	if (!(tokens[0]?.type === "word" && tokens[0].normalized === "create")) return false;
	const table = tokens[1];
	if (!(table?.type === "word" && table.normalized === "table")) return false;
	const afterOptions = skipIfNotExists(tokens, 2);
	return consumeQualifiedIdentifier(tokens, afterOptions) != null;
}

export function alterTableTailStart(tokens: SqlToken[]): number | undefined {
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index];
		if (!(token.type === "word" && token.normalized === "alter")) continue;
		const tableToken = tokens[index + 1];
		if (!(tableToken?.type === "word" && tableToken.normalized === "table")) continue;
		let cursor = index + 2;
		const maybeIf = tokens[cursor];
		const maybeExists = tokens[cursor + 1];
		if (maybeIf?.type === "word" && maybeIf.normalized === "if" && maybeExists?.type === "word" && maybeExists.normalized === "exists") {
			cursor += 2;
		}
		const afterTarget = consumeQualifiedIdentifier(tokens, cursor);
		if (afterTarget == null) return undefined;
		cursor = afterTarget;
		const maybeOn = tokens[cursor];
		const maybeCluster = tokens[cursor + 1];
		if (maybeOn?.type === "word" && maybeOn.normalized === "on" && maybeCluster?.type === "word" && maybeCluster.normalized === "cluster") {
			cursor += 2;
			if (isIdentifierToken(tokens[cursor])) cursor++;
		}
		return cursor;
	}
	return undefined;
}

export function alterTableActions(tokens: SqlToken[]): string[] {
	const start = alterTableTailStart(tokens);
	if (start == null) return [];
	const actions: string[] = [];
	let expectAction = true;
	let depth = 0;
	for (let index = start; index < tokens.length; index++) {
		const token = tokens[index];
		if (token.type === "symbol" && token.value === "(") {
			depth++;
			continue;
		}
		if (token.type === "symbol" && token.value === ")") {
			if (depth > 0) depth--;
			continue;
		}
		if (depth === 0 && token.type === "symbol" && token.value === ",") {
			expectAction = true;
			continue;
		}
		if (expectAction && depth === 0 && token.type === "word") {
			actions.push(token.normalized);
			expectAction = false;
		}
	}
	return actions;
}

function enforceAllowedApplyStatement(tokens: SqlToken[], statementKind: string): void {
	if (statementKind === "insert" || statementKind === "update" || statementKind === "replace" || statementKind === "merge") return;
	if (statementKind === "delete") {
		unsupportedApplyStatement("DELETE is blocked because it can remove business data.");
	}
	if (statementKind === "drop" || statementKind === "truncate") {
		unsupportedApplyStatement(`${statementKind.toUpperCase()} is blocked because it can remove schemas or data.`);
	}
	if (statementKind === "create") {
		if (isCreateDatabaseStatement(tokens) || isCreateTableStatement(tokens)) return;
		unsupportedApplyStatement("CREATE is allowed only for CREATE DATABASE and CREATE TABLE statements.");
	}
	if (statementKind === "alter") {
		const actions = alterTableActions(tokens);
		if (actions.some((action) => ["drop", "truncate", "delete", "update", "modify", "change", "rename", "clear", "replace", "freeze", "fetch", "move", "materialize", "remove"].includes(action))) {
			unsupportedApplyStatement("ALTER is allowed only for additive ALTER TABLE statements; destructive or rewrite-oriented ALTER forms are blocked.");
		}
		if (actions.length > 0 && actions.every((action) => action === "add")) return;
		unsupportedApplyStatement("ALTER is allowed only for ALTER TABLE ... ADD statements.");
	}
	if (statementKind === "select" || statementKind === "show" || statementKind === "describe" || statementKind === "desc" || statementKind === "explain") {
		unsupportedApplyStatement(`Received ${statementKind.toUpperCase()}. Use read-oriented sql_* tools for read queries.`);
	}
	unsupportedApplyStatement(`Received ${statementKind.toUpperCase()}.`);
}

const READ_ONLY_FORBIDDEN_REASON =
	"This query contains a write, DDL, administration, or execution keyword that is not allowed in read-only mode.";
const WRITE_FORBIDDEN_REASON =
	"This statement contains an administration, account, session, file, or high-risk operation that sql_apply does not allow.";
const MYSQL_FORBIDDEN_REASON = "This MySQL query uses a forbidden file, lock, or write-oriented operation.";
const CLICKHOUSE_FORBIDDEN_REASON = "This ClickHouse query uses a forbidden write or administration operation.";

type ForbiddenScope = "read" | "write" | "both";

type ForbiddenPattern = {
	pattern: RegExp;
	scope: ForbiddenScope;
	reason?: string;
};

// 通用禁止项：read path 拦任何写/admin 关键字；write path 只拦 admin/账户/文件/会话等高危操作。
// scope="read" 的条目仅在 read path 生效（写关键字在 write path 是允许的）；
// scope="write" 的条目仅在 write path 生效；
// scope="both" 的条目在两条路径都生效，reason 缺省时按路径取 READ_ONLY_FORBIDDEN_REASON 或 WRITE_FORBIDDEN_REASON。
const COMMON_FORBIDDEN: ForbiddenPattern[] = [
	{ pattern: /\bINSERT\b/, scope: "read" },
	{ pattern: /\bUPDATE\b/, scope: "read" },
	{ pattern: /\bDELETE\b/, scope: "read" },
	{ pattern: /\bMERGE\b/, scope: "read" },
	{ pattern: /\bREPLACE\b/, scope: "read" },
	{ pattern: /\bCREATE\b/, scope: "read" },
	{ pattern: /\bALTER\b/, scope: "read" },
	{ pattern: /\bDROP\b/, scope: "read" },
	{ pattern: /\bTRUNCATE\b/, scope: "read" },
	{ pattern: /\bRENAME\b/, scope: "read" },
	{ pattern: /\bANALYZE\s+(?!TABLE\b)/, scope: "read" },
	{ pattern: /\bEXPLAIN\s+ANALYZE\b/, scope: "read" },
	{ pattern: /\bCALL\b/, scope: "both" },
	{ pattern: /\bGRANT\b/, scope: "both" },
	{ pattern: /\bREVOKE\b/, scope: "both" },
	{ pattern: /\bSET\s+(?:GLOBAL|SESSION|ROLE|PASSWORD)\b/, scope: "both" },
	{ pattern: /\bUSE\b/, scope: "both" },
	{ pattern: /\bSYSTEM\b/, scope: "write" },
	{ pattern: /\bKILL\b/, scope: "write" },
	{ pattern: /\bATTACH\b/, scope: "write" },
	{ pattern: /\bDETACH\b/, scope: "write" },
	{ pattern: /\bBACKUP\b/, scope: "write" },
	{ pattern: /\bRESTORE\b/, scope: "write" },
	{ pattern: /\bOPTIMIZE\b/, scope: "write" },
	{ pattern: /\bLOAD_FILE\s*\(/, scope: "write" },
	{ pattern: /\bINTO\s+OUTFILE\b/, scope: "write" },
	{ pattern: /\bINTO\s+DUMPFILE\b/, scope: "write" },
	{ pattern: /\bLOAD\s+DATA\b/, scope: "write" },
	{ pattern: /\bLOCAL\s+INFILE\b/, scope: "write" },
	{ pattern: /\bCREATE\s+(?:USER|ROLE|QUOTA|ROW\s+POLICY|POLICY|SETTINGS\s+PROFILE)\b/, scope: "write" },
	{ pattern: /\bALTER\s+(?:USER|ROLE|QUOTA|ROW\s+POLICY|POLICY|SETTINGS\s+PROFILE)\b/, scope: "write" },
	{ pattern: /\bDROP\s+(?:USER|ROLE|QUOTA|ROW\s+POLICY|POLICY|SETTINGS\s+PROFILE)\b/, scope: "write" },
];

// 方言独有禁止项。LOAD_FILE/OUTFILE 等在通用 write path 已拦，这里只补 read path；
// FOR UPDATE/LOCK 是 MySQL 独有的锁模式，read+write 都拦；
// OPTIMIZE/ATTACH/DETACH/KILL 在通用 write path 已拦，这里只补 CH read path。
const DIALECT_FORBIDDEN: Record<SqlDialect, ForbiddenPattern[]> = {
	mysql: [
		{ pattern: /\bFOR\s+UPDATE\b/, scope: "both", reason: MYSQL_FORBIDDEN_REASON },
		{ pattern: /\bLOCK\s+IN\s+SHARE\s+MODE\b/, scope: "both", reason: MYSQL_FORBIDDEN_REASON },
		{ pattern: /\bLOAD_FILE\s*\(/, scope: "read", reason: MYSQL_FORBIDDEN_REASON },
		{ pattern: /\bINTO\s+OUTFILE\b/, scope: "read", reason: MYSQL_FORBIDDEN_REASON },
		{ pattern: /\bINTO\s+DUMPFILE\b/, scope: "read", reason: MYSQL_FORBIDDEN_REASON },
		{ pattern: /\bLOAD\s+DATA\b/, scope: "read", reason: MYSQL_FORBIDDEN_REASON },
		{ pattern: /\bLOCAL\s+INFILE\b/, scope: "read", reason: MYSQL_FORBIDDEN_REASON },
	],
	clickhouse: [
		{ pattern: /\bOPTIMIZE\b/, scope: "read", reason: CLICKHOUSE_FORBIDDEN_REASON },
		{ pattern: /\bATTACH\b/, scope: "read", reason: CLICKHOUSE_FORBIDDEN_REASON },
		{ pattern: /\bDETACH\b/, scope: "read", reason: CLICKHOUSE_FORBIDDEN_REASON },
		{ pattern: /\bKILL\b/, scope: "read", reason: CLICKHOUSE_FORBIDDEN_REASON },
	],
};

function enforceForbiddenPatterns(maskedSql: string, dialect: SqlDialect, scope: "read" | "write"): void {
	const stripped = maskedSql.toUpperCase();
	const patterns = [
		...COMMON_FORBIDDEN.filter((rule) => rule.scope === scope || rule.scope === "both"),
		...DIALECT_FORBIDDEN[dialect].filter((rule) => rule.scope === scope || rule.scope === "both"),
	];
	for (const rule of patterns) {
		if (rule.pattern.test(stripped)) {
			throw new Error(rule.reason ?? (scope === "read" ? READ_ONLY_FORBIDDEN_REASON : WRITE_FORBIDDEN_REASON));
		}
	}
}

export function guardReadOnlyQuery(query: string, dialect: SqlDialect): QueryGuardResult {
	const analysis = analyzeSql(query, dialect);
	if (!analysis.normalizedSql) {
		throw new Error("Query must not be empty.");
	}
	if (analysis.hasMultipleStatements) {
		throw new Error("Only a single SQL statement is allowed.");
	}

	const normalizedQuery = analysis.normalizedSql;
	const queryKind = analysis.statementKind;
	enforceAllowedQueryKind(queryKind);
	if (queryKind !== "show" && queryKind !== "describe" && queryKind !== "desc") {
		enforceForbiddenPatterns(analysis.maskedSql, dialect, "read");
	}
	return { normalizedQuery, queryKind, analysis };
}

export function guardExplainableQuery(query: string, dialect: SqlDialect): QueryGuardResult {
	const guarded = guardReadOnlyQuery(query, dialect);
	if (["show", "describe", "desc", "explain"].includes(guarded.queryKind)) {
		throw new Error("Dedicated explain/analyze tools require a SELECT or WITH SELECT query, not SHOW/DESCRIBE/EXPLAIN input.");
	}
	return guarded;
}

export function guardWriteStatement(statement: string, dialect: SqlDialect): QueryGuardResult {
	const analysis = analyzeSql(statement, dialect);
	if (!analysis.normalizedSql) {
		throw new Error("Statement must not be empty.");
	}
	if (analysis.hasMultipleStatements) {
		throw new Error("Only a single SQL statement is allowed.");
	}

	const normalizedQuery = analysis.normalizedSql;
	const queryKind = analysis.statementKind;
	enforceForbiddenPatterns(analysis.maskedSql, dialect, "write");
	enforceAllowedApplyStatement(analysis.tokens, queryKind);

	return { normalizedQuery, queryKind, analysis };
}
