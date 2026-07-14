import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import mysql from "mysql2/promise";
import type { Pool, ResultSetHeader, RowDataPacket } from "mysql2/promise";

const CLIENT_APP_NAME = "pi-mysql";
const CONFIG_FILE_PATH = path.join(".pi", "databases.json");
const DATABASE_CONFIG_TEMPLATE = {
	mysql: {
		host: "127.0.0.1",
		port: 3306,
		user: "readonly_user",
		password: "",
		database: "app_db",
		allow_write_access: false,
	},
	clickhouse: {
		url: "http://localhost:8123",
		username: "default",
		password: "",
		database: "default",
		allow_write_access: false,
	},
};

type RawProjectConfig = {
	host?: unknown;
	port?: unknown;
	user?: unknown;
	username?: unknown;
	password?: unknown;
	database?: unknown;
	socketPath?: unknown;
	charset?: unknown;
	connect_timeout_ms?: unknown;
	query_timeout_ms?: unknown;
	pool_size?: unknown;
	ssl?: unknown;
	allow_write_access?: unknown;
};

type ResolvedProjectConfig = {
	cacheKey: string;
	sourcePath: string;
	host?: string;
	port: number;
	user: string;
	password: string;
	database?: string;
	socketPath?: string;
	charset?: string;
	connectTimeoutMs: number;
	queryTimeoutMs: number;
	poolSize: number;
	ssl?: mysql.SslOptions;
	allowWriteAccess: boolean;
};

type QueryResultShape = {
	query_id: string;
	columns: string[];
	rows: unknown[][];
};

type WriteResultShape = {
	executed: boolean;
	cancelled: boolean;
	statement_kind: "insert" | "update" | "create" | "alter";
	query_id?: string;
	affected_rows?: number;
	changed_rows?: number;
	insert_id?: number;
	warning_count?: number;
	reason?: string;
};

type TableInfo = {
	table_name: string;
	table_type: string | null;
	engine: string | null;
	table_comment: string | null;
	table_rows: number | null;
	total_bytes: number | null;
};

const poolCache = new Map<string, Pool>();
let registered = false;
let writeQueue: Promise<void> = Promise.resolve();

const PingParams = Type.Object({});

const RunQueryParams = Type.Object({
	query: Type.String({
		description:
			"Single read-only MySQL SQL statement to execute. Use SELECT, SHOW, DESCRIBE, or EXPLAIN. Use LIMIT for large result sets.",
	}),
});

const WriteStatementParams = Type.Object({
	statement: Type.String({
		description:
			"Single supported MySQL write statement. Execution always requires interactive user confirmation.",
	}),
});

const ListTablesParams = Type.Object({
	database: Type.String({ description: "Database to inspect" }),
	like: Type.Optional(Type.String({ description: "Optional LIKE filter for table names" })),
	not_like: Type.Optional(Type.String({ description: "Optional NOT LIKE filter for table names" })),
});

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		if (value.toLowerCase() === "true") return true;
		if (value.toLowerCase() === "false") return false;
	}
	return fallback;
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
	if (typeof value === "string") {
		const parsed = Number.parseInt(value, 10);
		if (Number.isFinite(parsed) && parsed > 0) return parsed;
	}
	return fallback;
}

function getContextCwd(ctx: unknown): string {
	if (isRecord(ctx) && typeof ctx.cwd === "string" && ctx.cwd) return ctx.cwd;
	return process.cwd();
}

function findProjectConfigPath(startDir: string): string | undefined {
	let current = path.resolve(startDir);
	while (true) {
		const configPath = path.join(current, CONFIG_FILE_PATH);
		if (existsSync(configPath)) return configPath;
		const parent = path.dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

function initializeDatabaseConfig(cwd: string): { created: boolean; configPath: string; reason?: string } {
	const targetPath = path.join(path.resolve(cwd), CONFIG_FILE_PATH);
	const existingPath = findProjectConfigPath(cwd);
	if (existingPath) {
		return {
			created: false,
			configPath: existingPath,
			reason: path.resolve(existingPath) === targetPath ? "A project database config already exists." : "A database config is already inherited from a parent directory.",
		};
	}

	mkdirSync(path.dirname(targetPath), { recursive: true });
	writeFileSync(targetPath, `${JSON.stringify(DATABASE_CONFIG_TEMPLATE, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
	return { created: true, configPath: targetPath };
}

function resolveSslOption(value: unknown): mysql.SslOptions | undefined {
	if (value === true) return {};
	if (isRecord(value)) return value as mysql.SslOptions;
	return undefined;
}

function resolveProjectConfig(cwd: string): ResolvedProjectConfig {
	const configPath = findProjectConfigPath(cwd);
	if (!configPath) {
		throw new Error(`No MySQL config found for ${cwd}. Create .pi/databases.json with a "mysql" object.`);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(configPath, "utf-8"));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to read ${configPath}: ${message}`);
	}

	if (!isRecord(parsed)) {
		throw new Error(`Invalid ${configPath}: expected a JSON object`);
	}

	const config = parsed.mysql;
	if (!isRecord(config)) {
		throw new Error(`Invalid ${configPath}: missing "mysql" object`);
	}

	const user = normalizeString(config.user ?? config.username);
	if (!user) {
		throw new Error(`Invalid ${configPath}: missing \"user\" (or \"username\")`);
	}

	const host = normalizeString(config.host);
	const socketPath = normalizeString(config.socketPath);
	if (!host && !socketPath) {
		throw new Error(`Invalid ${configPath}: expected either \"host\" or \"socketPath\"`);
	}

	const password = typeof config.password === "string" ? config.password : "";
	const database = normalizeString(config.database);
	const charset = normalizeString(config.charset);
	const port = normalizePositiveInteger(config.port, 3306);
	const connectTimeoutMs = normalizePositiveInteger(config.connect_timeout_ms, 10_000);
	const queryTimeoutMs = normalizePositiveInteger(config.query_timeout_ms, 30_000);
	const poolSize = normalizePositiveInteger(config.pool_size, 10);
	const ssl = resolveSslOption(config.ssl);
	const allowWriteAccess = normalizeBoolean(config.allow_write_access, false);

	const cacheKeyPayload = {
		host,
		port,
		user,
		password,
		database,
		socketPath,
		charset,
		connectTimeoutMs,
		queryTimeoutMs,
		poolSize,
		ssl,
	};

	return {
		cacheKey: JSON.stringify(cacheKeyPayload),
		sourcePath: configPath,
		host,
		port,
		user,
		password,
		database,
		socketPath,
		charset,
		connectTimeoutMs,
		queryTimeoutMs,
		poolSize,
		ssl,
		allowWriteAccess,
	};
}

function getPool(config: ResolvedProjectConfig): Pool {
	const cached = poolCache.get(config.cacheKey);
	if (cached) return cached;

	const pool = mysql.createPool({
		host: config.host,
		port: config.port,
		user: config.user,
		password: config.password,
		database: config.database,
		socketPath: config.socketPath,
		charset: config.charset,
		connectTimeout: config.connectTimeoutMs,
		waitForConnections: true,
		connectionLimit: config.poolSize,
		queueLimit: 0,
		multipleStatements: false,
		dateStrings: true,
		ssl: config.ssl,
	});

	poolCache.set(config.cacheKey, pool);
	return pool;
}

function escapeMysqlString(value: string): string {
	return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

function quoteMysqlIdentifier(value: string): string {
	return `\`${value.replace(/`/g, "``")}\``;
}

function normalizeQueryForMysqlClient(query: string): string {
	let normalized = query.trim();
	while (true) {
		const previous = normalized;
		normalized = normalized
			.replace(/\s+$/g, "")
			.replace(/(?:--|#)[^\r\n]*$/g, "")
			.replace(/\/\*[\s\S]*?\*\/\s*$/g, "")
			.replace(/;+\s*$/g, "")
			.trim();
		if (normalized === previous) return normalized;
	}
}

function hasMultipleStatements(query: string): boolean {
	let quote: "'" | '"' | "`" | null = null;
	let blockComment = false;
	let lineComment = false;

	for (let index = 0; index < query.length; index++) {
		const char = query[index];
		const next = query[index + 1];
		const previous = query[index - 1];

		if (lineComment) {
			if (char === "\n" || char === "\r") lineComment = false;
			continue;
		}

		if (blockComment) {
			if (char === "*" && next === "/") {
				blockComment = false;
				index += 1;
			}
			continue;
		}

		if (quote) {
			if (char === quote && previous !== "\\") quote = null;
			continue;
		}

		if (char === "-" && next === "-") {
			lineComment = true;
			index += 1;
			continue;
		}
		if (char === "#") {
			lineComment = true;
			continue;
		}
		if (char === "/" && next === "*") {
			blockComment = true;
			index += 1;
			continue;
		}
		if (char === "'" || char === '"' || char === "`") {
			quote = char;
			continue;
		}
		if (char === ";") {
			const tail = query.slice(index + 1);
			if (tail.trim() !== "") return true;
		}
	}

	return false;
}

function containsMysqlExecutableComment(query: string): boolean {
	let quote: "'" | '"' | "`" | null = null;
	let blockComment = false;
	let lineComment = false;

	for (let index = 0; index < query.length; index++) {
		const char = query[index];
		const next = query[index + 1];
		const third = query[index + 2];
		const previous = query[index - 1];

		if (lineComment) {
			if (char === "\n" || char === "\r") lineComment = false;
			continue;
		}

		if (blockComment) {
			if (char === "*" && next === "/") {
				blockComment = false;
				index += 1;
			}
			continue;
		}

		if (quote) {
			if (char === quote && previous !== "\\") quote = null;
			continue;
		}

		if (char === "-" && next === "-") {
			lineComment = true;
			index += 1;
			continue;
		}
		if (char === "#") {
			lineComment = true;
			continue;
		}
		if (char === "/" && next === "*" && third === "!") {
			return true;
		}
		if (char === "/" && next === "*") {
			blockComment = true;
			index += 1;
			continue;
		}
		if (char === "'" || char === '"' || char === "`") {
			quote = char;
		}
	}

	return false;
}

function getStatementKeyword(query: string): string | undefined {
	const statementKeywords = new Set([
		"WITH",
		"SELECT",
		"SHOW",
		"DESCRIBE",
		"DESC",
		"EXPLAIN",
		"INSERT",
		"UPDATE",
		"DELETE",
		"REPLACE",
		"MERGE",
		"ALTER",
		"CREATE",
		"DROP",
		"TRUNCATE",
		"RENAME",
		"CALL",
		"DO",
		"SET",
		"USE",
		"GRANT",
		"REVOKE",
		"LOCK",
		"UNLOCK",
	]);
	let quote: "'" | '"' | "`" | null = null;
	let blockComment = false;
	let lineComment = false;
	let depth = 0;

	for (let index = 0; index < query.length; index++) {
		const char = query[index];
		const next = query[index + 1];
		const previous = query[index - 1];

		if (lineComment) {
			if (char === "\n" || char === "\r") lineComment = false;
			continue;
		}
		if (blockComment) {
			if (char === "*" && next === "/") {
				blockComment = false;
				index += 1;
			}
			continue;
		}
		if (quote) {
			if (char === quote && previous !== "\\") quote = null;
			continue;
		}
		if (char === "-" && next === "-") {
			lineComment = true;
			index += 1;
			continue;
		}
		if (char === "#") {
			lineComment = true;
			continue;
		}
		if (char === "/" && next === "*") {
			blockComment = true;
			index += 1;
			continue;
		}
		if (char === "'" || char === '"' || char === "`") {
			quote = char;
			continue;
		}
		if (char === "(") {
			depth += 1;
			continue;
		}
		if (char === ")") {
			if (depth > 0) depth -= 1;
			continue;
		}
		if (depth > 0) continue;
		if (!/[A-Za-z_]/.test(char)) continue;

		let end = index + 1;
		while (end < query.length && /[A-Za-z0-9_$]/.test(query[end])) end += 1;
		const token = query.slice(index, end).toUpperCase();
		index = end - 1;

		if (!statementKeywords.has(token)) continue;
		if (token === "WITH") continue;
		return token;
	}

	return undefined;
}

function isQueryWithOutput(query: string): boolean {
	const keyword = getStatementKeyword(query);
	return keyword === "SELECT" || keyword === "SHOW" || keyword === "DESCRIBE" || keyword === "DESC" || keyword === "EXPLAIN";
}

const MYSQL_IDENTIFIER = "(?:`(?:``|[^`])+`|[A-Za-z_][A-Za-z0-9_$]*)";
const MYSQL_TABLE_IDENTIFIER = `${MYSQL_IDENTIFIER}(?:\\.${MYSQL_IDENTIFIER})?`;
const MYSQL_INSERT_PATTERN = new RegExp(
	`^INSERT\\s+INTO\\s+${MYSQL_TABLE_IDENTIFIER}(?:\\s*\\([^)]*\\))?\\s+VALUES\\s*\\(`,
	"i",
);
const MYSQL_UPDATE_PATTERN = new RegExp(`^UPDATE\\s+${MYSQL_TABLE_IDENTIFIER}\\s+SET\\s+`, "i");
const MYSQL_CREATE_TABLE_PATTERN = new RegExp(
	`^CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${MYSQL_TABLE_IDENTIFIER}\\s*\\(`,
	"i",
);
const MYSQL_ALTER_ADD_PATTERN = new RegExp(
	`^ALTER\\s+TABLE\\s+${MYSQL_TABLE_IDENTIFIER}\\s+ADD\\s+(?:COLUMN|INDEX)\\b`,
	"i",
);

type ValidatedMysqlWrite = {
	statement: string;
	statementKind: WriteResultShape["statement_kind"];
};

type WriteConfirmationContext = {
	hasUI?: boolean;
	ui?: {
		confirm?: (title: string, message: string) => Promise<boolean> | boolean;
	};
};

function hasTopLevelKeyword(query: string, keyword: string): boolean {
	let quote: "'" | '"' | "`" | null = null;
	let blockComment = false;
	let lineComment = false;
	let depth = 0;

	for (let index = 0; index < query.length; index++) {
		const char = query[index];
		const next = query[index + 1];
		const previous = query[index - 1];

		if (lineComment) {
			if (char === "\n" || char === "\r") lineComment = false;
			continue;
		}
		if (blockComment) {
			if (char === "*" && next === "/") {
				blockComment = false;
				index += 1;
			}
			continue;
		}
		if (quote) {
			if (char === quote && previous !== "\\") quote = null;
			continue;
		}
		if (char === "-" && next === "-") {
			lineComment = true;
			index += 1;
			continue;
		}
		if (char === "#") {
			lineComment = true;
			continue;
		}
		if (char === "/" && next === "*") {
			blockComment = true;
			index += 1;
			continue;
		}
		if (char === "'" || char === '"' || char === "`") {
			quote = char;
			continue;
		}
		if (char === "(") {
			depth += 1;
			continue;
		}
		if (char === ")") {
			if (depth > 0) depth -= 1;
			continue;
		}
		if (depth > 0 || !/[A-Za-z_]/.test(char)) continue;

		let end = index + 1;
		while (end < query.length && /[A-Za-z0-9_$]/.test(query[end])) end += 1;
		if (query.slice(index, end).toUpperCase() === keyword) return true;
		index = end - 1;
	}

	return false;
}

function validateReadQuerySafety(query: string): void {
	const normalized = normalizeQueryForMysqlClient(query);
	if (!normalized) throw new Error("Query is empty.");
	if (hasMultipleStatements(query)) throw new Error("mysql_run_query expects a single SQL statement.");
	if (containsMysqlExecutableComment(query)) {
		throw new Error("MySQL executable comments (/*! ... */) are not allowed.");
	}
	if (!isQueryWithOutput(normalized)) {
		throw new Error("mysql_run_query supports only SELECT, SHOW, DESCRIBE, DESC, or EXPLAIN statements.");
	}
	if (/\b(FOR\s+UPDATE|LOCK\s+IN\s+SHARE\s+MODE|INTO\s+OUTFILE|INTO\s+DUMPFILE|LOAD_FILE\s*\()\b/i.test(normalized)) {
		throw new Error("This read query uses a blocked MySQL clause or file operation.");
	}
}

function validateWriteStatement(config: ResolvedProjectConfig, statement: string): ValidatedMysqlWrite {
	const normalized = normalizeQueryForMysqlClient(statement);
	if (!normalized) throw new Error("Statement is empty.");
	if (!config.allowWriteAccess) {
		throw new Error("MySQL writes are disabled. Set allow_write_access=true in your project config to enable mysql_write.");
	}
	if (hasMultipleStatements(statement)) throw new Error("mysql_write expects a single SQL statement.");
	if (containsMysqlExecutableComment(statement)) {
		throw new Error("MySQL executable comments (/*! ... */) are not allowed.");
	}

	const keyword = getStatementKeyword(normalized);
	if (keyword === "INSERT" && MYSQL_INSERT_PATTERN.test(normalized)) {
		return { statement: normalized, statementKind: "insert" };
	}
	if (keyword === "UPDATE" && MYSQL_UPDATE_PATTERN.test(normalized)) {
		if (!hasTopLevelKeyword(normalized, "WHERE")) {
			throw new Error("mysql_write requires a top-level WHERE clause for UPDATE statements.");
		}
		return { statement: normalized, statementKind: "update" };
	}
	if (keyword === "CREATE" && MYSQL_CREATE_TABLE_PATTERN.test(normalized)) {
		if (hasTopLevelKeyword(normalized, "AS") || hasTopLevelKeyword(normalized, "LIKE")) {
			throw new Error("mysql_write does not support derived CREATE TABLE statements.");
		}
		return { statement: normalized, statementKind: "create" };
	}
	if (keyword === "ALTER" && MYSQL_ALTER_ADD_PATTERN.test(normalized)) {
		return { statement: normalized, statementKind: "alter" };
	}
	if (["DELETE", "REPLACE", "DROP", "TRUNCATE", "RENAME"].includes(keyword ?? "")) {
		throw new Error(`mysql_write does not support ${keyword} statements.`);
	}
	throw new Error("mysql_write supports only INSERT ... VALUES, UPDATE ... WHERE, CREATE TABLE, and ALTER TABLE ... ADD COLUMN/INDEX statements.");
}

function serializeWrite<T>(task: () => Promise<T>): Promise<T> {
	const next = writeQueue.then(task, task);
	writeQueue = next.then(
		() => undefined,
		() => undefined,
	);
	return next;
}

async function confirmWrite(ctx: unknown, title: string, message: string): Promise<boolean | undefined> {
	if (!isRecord(ctx) || ctx.hasUI !== true || !isRecord(ctx.ui) || typeof ctx.ui.confirm !== "function") {
		return undefined;
	}
	return (ctx as WriteConfirmationContext).ui!.confirm!(title, message);
}

function rowToArray(row: unknown, columns: string[]): unknown[] {
	if (Array.isArray(row)) return row;
	if (!isRecord(row)) return columns.map(() => undefined);
	return columns.map((column) => row[column]);
}

async function runQuery(
	config: ResolvedProjectConfig,
	query: string,
	abortSignal?: AbortSignal,
): Promise<QueryResultShape> {
	validateReadQuerySafety(query);
	if (abortSignal?.aborted) throw new Error("Operation aborted.");

	const normalized = normalizeQueryForMysqlClient(query);
	const pool = getPool(config);
	const queryId = `mysql-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;

	if (isQueryWithOutput(normalized)) {
		const [rows, fields] = await pool.query({
			sql: normalized,
			timeout: config.queryTimeoutMs,
			rowsAsArray: false,
		});
		const columns = Array.isArray(fields) ? fields.map((field) => field.name) : [];
		const arrayRows = Array.isArray(rows)
			? rows.map((row) => rowToArray(row, columns))
			: [];
		return {
			query_id: queryId,
			columns,
			rows: arrayRows,
		};
	}

	const [result] = await pool.query({
		sql: normalized,
		timeout: config.queryTimeoutMs,
	});
	const header = result as ResultSetHeader;
	return {
		query_id: queryId,
		columns: [],
		rows: header.affectedRows > 0 ? [[header.affectedRows]] : [],
	};
}

async function runWrite(
	config: ResolvedProjectConfig,
	write: ValidatedMysqlWrite,
	abortSignal?: AbortSignal,
): Promise<WriteResultShape> {
	if (abortSignal?.aborted) throw new Error("Operation aborted.");
	const pool = getPool(config);
	const [result] = await pool.query({
		sql: write.statement,
		timeout: config.queryTimeoutMs,
	});
	const header = result as ResultSetHeader;
	return {
		executed: true,
		cancelled: false,
		statement_kind: write.statementKind,
		query_id: `mysql-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`,
		affected_rows: header.affectedRows,
		changed_rows: header.changedRows,
		insert_id: header.insertId,
		warning_count: header.warningStatus,
	};
}

async function pingMysql(
	config: ResolvedProjectConfig,
	abortSignal?: AbortSignal,
): Promise<{ ok: boolean; message: string; server_version?: string; current_database?: string | null }> {
	if (abortSignal?.aborted) throw new Error("Operation aborted.");
	const pool = getPool(config);
	const [rows] = await pool.query<RowDataPacket[]>({
		sql: "SELECT VERSION() AS server_version, DATABASE() AS current_database",
		timeout: config.queryTimeoutMs,
	});
	const row = rows[0];
	return {
		ok: true,
		message: "Connected to MySQL",
		server_version: typeof row?.server_version === "string" ? row.server_version : undefined,
		current_database: row?.current_database == null ? null : String(row.current_database),
	};
}

async function listDatabases(
	config: ResolvedProjectConfig,
	abortSignal?: AbortSignal,
): Promise<string[]> {
	if (abortSignal?.aborted) throw new Error("Operation aborted.");
	const pool = getPool(config);
	const [rows] = await pool.query<RowDataPacket[]>({
		sql: "SHOW DATABASES",
		timeout: config.queryTimeoutMs,
	});
	return rows.map((row) => String(row.Database ?? "")).filter(Boolean);
}

async function listTables(
	config: ResolvedProjectConfig,
	params: {
		database: string;
		like?: string;
		not_like?: string;
	},
	abortSignal?: AbortSignal,
): Promise<{
	tables: TableInfo[];
	total_tables: number;
}> {
	if (abortSignal?.aborted) throw new Error("Operation aborted.");
	const database = params.database.trim();
	if (!database) throw new Error("Database is required.");

	const pool = getPool(config);
	let sql = `
		SELECT
			table_name,
			table_type,
			engine,
			table_comment,
			table_rows,
			(COALESCE(data_length, 0) + COALESCE(index_length, 0)) AS total_bytes
		FROM information_schema.tables
		WHERE table_schema = ?
	`;
	const queryParams: unknown[] = [database];
	const like = normalizeString(params.like);
	const notLike = normalizeString(params.not_like);
	if (like) {
		sql += " AND table_name LIKE ?";
		queryParams.push(like);
	}
	if (notLike) {
		sql += " AND table_name NOT LIKE ?";
		queryParams.push(notLike);
	}
	sql += " ORDER BY table_name";

	const [rows] = await pool.query<RowDataPacket[]>({
		sql,
		values: queryParams,
		timeout: config.queryTimeoutMs,
	});

	const tables = rows.map((row) => ({
		table_name: String(row.table_name ?? ""),
		table_type: row.table_type == null ? null : String(row.table_type),
		engine: row.engine == null ? null : String(row.engine),
		table_comment: row.table_comment == null ? null : String(row.table_comment),
		table_rows: row.table_rows == null ? null : Number(row.table_rows),
		total_bytes: row.total_bytes == null ? null : Number(row.total_bytes),
	})).filter((table) => table.table_name);

	return {
		tables,
		total_tables: tables.length,
	};
}

function formatJson(details: unknown): string {
	return JSON.stringify(details, null, 2);
}

function makeTextResult(details: unknown, text = formatJson(details)) {
	return {
		content: [{ type: "text" as const, text }],
		details,
	};
}

function formatListDatabasesContent(result: { databases: string[] }): string {
	const lines: string[] = [];
	lines.push(`Databases: ${result.databases.length}`);
	for (const database of result.databases) {
		lines.push(`- ${database}`);
	}
	return lines.join("\n");
}

function formatListTablesContent(result: {
	database: string;
	tables: TableInfo[];
	total_tables: number;
}): string {
	const lines: string[] = [];
	lines.push(`Database: ${result.database}`);
	lines.push(`Total matching tables: ${result.total_tables}`);
	if (result.tables.length === 0) {
		lines.push("No tables found.");
		return lines.join("\n");
	}
	for (const table of result.tables) {
		const bits = [table.table_name];
		if (table.table_type) bits.push(table.table_type);
		if (table.engine) bits.push(table.engine);
		lines.push(`- ${bits.join(" | ")}`);
	}
	return lines.join("\n");
}

function getResultText(result: { content?: unknown }): string {
	if (!Array.isArray(result.content)) return "";
	return result.content
		.map((item) => (isRecord(item) && item.type === "text" && typeof item.text === "string" ? item.text : ""))
		.filter(Boolean)
		.join("\n");
}

function formatPingResultForUi(result: { content?: unknown; details?: unknown }, isError = false): string {
	if (isError) {
		const errorText = getResultText(result).trim();
		return errorText ? `MySQL ping failed: ${errorText}` : "MySQL ping failed";
	}

	if (isRecord(result.details)) {
		const ok = result.details.ok === true;
		const message = typeof result.details.message === "string" ? result.details.message : ok ? "Connected" : "Connection failed";
		return ok ? `✓ ${message}` : `✗ ${message}`;
	}

	const text = getResultText(result).trim();
	return text || "MySQL ping completed";
}

function splitTopLevelCommaList(value: string): string[] {
	const items: string[] = [];
	let current = "";
	let depth = 0;
	let quote: "'" | '"' | "`" | null = null;

	for (let index = 0; index < value.length; index++) {
		const char = value[index];
		const previous = value[index - 1];

		if (quote) {
			current += char;
			if (char === quote && previous !== "\\") quote = null;
			continue;
		}

		if (char === "'" || char === '"' || char === "`") {
			quote = char;
			current += char;
			continue;
		}

		if (char === "(") depth++;
		else if (char === ")" && depth > 0) depth--;

		if (char === "," && depth === 0) {
			items.push(current.trim());
			current = "";
			continue;
		}

		current += char;
	}

	if (current.trim()) items.push(current.trim());
	return items;
}

function formatSqlForUi(query: string): string {
	let formatted = normalizeQueryForMysqlClient(query)
		.replace(/\s+/g, " ")
		.replace(/\b(FROM)\b/gi, "\n$1")
		.replace(/\b(WHERE)\b/gi, "\n$1")
		.replace(/\b((?:LEFT|RIGHT|INNER|FULL|CROSS)\s+JOIN)\b/gi, "\n$1")
		.replace(/\b(JOIN)\b/gi, "\n$1")
		.replace(/\b(ON)\b/gi, "\n  $1")
		.replace(/\b(AND)\b/gi, "\n  $1")
		.replace(/\b(OR)\b/gi, "\n  $1")
		.replace(/\b(GROUP\s+BY)\b/gi, "\n$1")
		.replace(/\b(ORDER\s+BY)\b/gi, "\n$1")
		.replace(/\b(LIMIT)\b/gi, "\n$1");

	formatted = formatted.replace(/^SELECT\s+([\s\S]*?)\nFROM\b/i, (_match, selectList: string) => {
		const columns = splitTopLevelCommaList(selectList);
		if (columns.length <= 1) return `SELECT ${selectList}\nFROM`;
		return `SELECT\n  ${columns.join(",\n  ")}\nFROM`;
	});

	return formatted
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n")
		.trim();
}

function formatRunQueryResultForUi(args: unknown, result: { content?: unknown; details?: unknown }, isError = false): string {
	const query = isRecord(args) && typeof args.query === "string" ? args.query.trim() : "";
	const lines: string[] = [];
	if (query) {
		lines.push(formatSqlForUi(query));
	}

	if (isError) {
		const errorText = getResultText(result).trim();
		if (lines.length > 0) lines.push("");
		lines.push(`Error: ${errorText || "Query failed"}`);
		return lines.join("\n");
	}

	if (isRecord(result.details)) {
		const queryId = typeof result.details.query_id === "string" ? result.details.query_id : "";
		const hasRows = Array.isArray(result.details.rows);
		if (lines.length > 0) lines.push("");
		lines.push(hasRows && Array.isArray(result.details.columns) ? `Rows: ${result.details.rows.length}` : "Query executed");
		if (queryId) lines.push(`Query ID: ${queryId}`);
		return lines.join("\n");
	}

	return lines.length > 0 ? lines.join("\n") : "Query executed";
}

function formatWriteResultForUi(args: unknown, result: { content?: unknown; details?: unknown }, isError = false): string {
	const statement = isRecord(args) && typeof args.statement === "string" ? args.statement.trim() : "";
	const lines: string[] = [];
	if (statement) lines.push(formatSqlForUi(statement));

	if (isError) {
		const errorText = getResultText(result).trim();
		if (lines.length > 0) lines.push("");
		lines.push(`Error: ${errorText || "Write failed"}`);
		return lines.join("\n");
	}

	if (!isRecord(result.details)) return lines.length > 0 ? lines.join("\n") : "Write completed";
	if (lines.length > 0) lines.push("");
	if (result.details.cancelled === true) {
		lines.push("Write cancelled");
		return lines.join("\n");
	}
	if (result.details.executed !== true) {
		lines.push(typeof result.details.reason === "string" ? result.details.reason : "Write not executed");
		return lines.join("\n");
	}

	const statementKind = typeof result.details.statement_kind === "string" ? result.details.statement_kind.toUpperCase() : "WRITE";
	lines.push(`${statementKind} executed`);
	if (typeof result.details.affected_rows === "number") lines.push(`Affected rows: ${result.details.affected_rows}`);
	if (typeof result.details.changed_rows === "number") lines.push(`Changed rows: ${result.details.changed_rows}`);
	if (typeof result.details.insert_id === "number" && result.details.insert_id !== 0) lines.push(`Insert ID: ${result.details.insert_id}`);
	if (typeof result.details.warning_count === "number" && result.details.warning_count > 0) lines.push(`Warnings: ${result.details.warning_count}`);
	if (typeof result.details.query_id === "string") lines.push(`Query ID: ${result.details.query_id}`);
	return lines.join("\n");
}

function registerCommands(pi: ExtensionAPI): void {
	pi.registerCommand("database-init", {
		description: "Create the shared .pi/databases.json template for the current project",
		handler: async (_args, ctx) => {
			const result = initializeDatabaseConfig(getContextCwd(ctx));
			if (result.created) {
				ctx.ui.notify(`Created ${result.configPath}`, "info");
				return;
			}
			ctx.ui.notify(`${result.reason} Using ${result.configPath}`, "warning");
		},
	});
}

function registerTools(pi: ExtensionAPI): void {
	if (registered) return;
	registered = true;

	pi.registerTool({
		name: "mysql_ping",
		label: "MySQL Ping",
		description: "Verify that the current project's MySQL config is reachable",
		parameters: PingParams,
		async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
			const config = resolveProjectConfig(getContextCwd(ctx));
			const result = await pingMysql(config, signal);
			return makeTextResult({ config: config.sourcePath, ...result });
		},
		renderResult(result, _options, theme, context) {
			const details = isRecord(result.details) ? result.details : undefined;
			const ok = details?.ok === true;
			const color = context.isError || !ok ? "error" : "success";
			return new Text(theme.fg(color, formatPingResultForUi(result, context.isError)), 0, 0);
		},
	});

	pi.registerTool({
		name: "mysql_list_databases",
		label: "MySQL List Databases",
		description: "List available databases in the configured MySQL instance",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
			const config = resolveProjectConfig(getContextCwd(ctx));
			const databases = await listDatabases(config, signal);
			const details = { config: config.sourcePath, databases };
			return makeTextResult(details, formatListDatabasesContent(details));
		},
	});

	pi.registerTool({
		name: "mysql_list_tables",
		label: "MySQL List Tables",
		description: "List tables in a database with optional filtering",
		parameters: ListTablesParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const config = resolveProjectConfig(getContextCwd(ctx));
			const result = await listTables(config, params as typeof params & { database: string }, signal);
			const details = { config: config.sourcePath, database: String((params as { database: string }).database), ...result };
			return makeTextResult(details, formatListTablesContent(details));
		},
	});

	pi.registerTool({
		name: "mysql_run_query",
		label: "MySQL Run Query",
		description:
			"Execute a single read-only MySQL SQL statement using the current project's config. Result-producing statements return structured details as { columns, rows }.",
		parameters: RunQueryParams,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const query = String((params as { query: string }).query);
			onUpdate({ content: [{ type: "text", text: `${formatSqlForUi(query)}\n\nRunning...` }] });
			const config = resolveProjectConfig(getContextCwd(ctx));
			const result = await runQuery(config, query, signal);
			return makeTextResult({ config: config.sourcePath, ...result });
		},
		renderResult(result, options, theme, context) {
			if (options.isPartial) {
				const query = isRecord(context.args) && typeof context.args.query === "string" ? context.args.query.trim() : "";
				const text = query ? `${formatSqlForUi(query)}\n\nRunning...` : "Running...";
				return new Text(theme.fg("toolOutput", text), 0, 0);
			}
			return new Text(theme.fg(context.isError ? "error" : "toolOutput", formatRunQueryResultForUi(context.args, result, context.isError)), 0, 0);
		},
	});

	pi.registerTool({
		name: "mysql_write",
		label: "MySQL Write",
		description: "Execute one confirmed MySQL data or additive schema change using the current project's config.",
		promptSnippet: "Execute one confirmed MySQL INSERT, guarded UPDATE, CREATE TABLE, or ALTER TABLE ADD statement",
		promptGuidelines: [
			"Use mysql_write only for an explicit user-requested database change, never as a fallback for mysql_run_query.",
			"mysql_write supports INSERT ... VALUES, UPDATE ... WHERE, CREATE TABLE, and ALTER TABLE ... ADD COLUMN/INDEX only.",
			"mysql_write always prompts the user to confirm. Do not retry after a timeout or lost connection without first checking the database.",
		],
		parameters: WriteStatementParams,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const statement = String((params as { statement: string }).statement);
			return serializeWrite(async () => {
				const config = resolveProjectConfig(getContextCwd(ctx));
				const write = validateWriteStatement(config, statement);
				const confirmed = await confirmWrite(
					ctx,
					`Confirm MySQL ${write.statementKind}`,
					`MySQL ${write.statementKind.toUpperCase()}\n\n${formatSqlForUi(write.statement)}\n\nExecute this statement?`,
				);
				if (confirmed === undefined) {
					const details: WriteResultShape = {
						executed: false,
						cancelled: false,
						statement_kind: write.statementKind,
						reason: "Interactive confirmation is required; no write was executed.",
					};
					return makeTextResult({ config: config.sourcePath, ...details });
				}
				if (!confirmed) {
					const details: WriteResultShape = {
						executed: false,
						cancelled: true,
						statement_kind: write.statementKind,
					};
					return makeTextResult({ config: config.sourcePath, ...details });
				}
				onUpdate({ content: [{ type: "text", text: `${formatSqlForUi(write.statement)}\n\nWriting...` }] });
				const result = await runWrite(config, write, signal);
				return makeTextResult({ config: config.sourcePath, ...result });
			});
		},
		renderResult(result, options, theme, context) {
			if (options.isPartial) {
				const statement = isRecord(context.args) && typeof context.args.statement === "string" ? context.args.statement.trim() : "";
				const text = statement ? `${formatSqlForUi(statement)}\n\nWriting...` : "Writing...";
				return new Text(theme.fg("toolOutput", text), 0, 0);
			}
			return new Text(theme.fg(context.isError ? "error" : "toolOutput", formatWriteResultForUi(context.args, result, context.isError)), 0, 0);
		},
	});
}

export default function mysqlClientExtension(pi: ExtensionAPI) {
	registerCommands(pi);
	registerTools(pi);

	pi.on("session_start", async (_event, ctx) => {
		const cwd = getContextCwd(ctx);
		const configPath = findProjectConfigPath(cwd);
		ctx.ui.setStatus(
			"pi-mysql",
			configPath ? `mysql config: ${path.relative(cwd, configPath) || configPath}` : "mysql: no project config",
		);
	});
}

export const __test__ = {
	normalizeQueryForMysqlClient,
	hasMultipleStatements,
	containsMysqlExecutableComment,
	getStatementKeyword,
	isQueryWithOutput,
	hasTopLevelKeyword,
	validateReadQuerySafety,
	validateWriteStatement,
	formatSqlForUi,
	resolveProjectConfig,
	escapeMysqlString,
	quoteMysqlIdentifier,
	initializeDatabaseConfig,
	registerCommands,
	registerTools,
};
