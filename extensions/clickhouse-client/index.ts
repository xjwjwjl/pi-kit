import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { createClient, ResultSet, ClickHouseLogLevel, type ClickHouseClient } from "@clickhouse/client";

const CLIENT_APP_NAME = "pi-clickhouse-client";
const ENGINE_DISPLAY_ORDER = [
	"MergeTree",
	"AggregatingMergeTree",
	"MaterializedView",
	"View",
	"Distributed",
] as const;
const ENGINE_DISPLAY_LABELS: Record<string, string> = {
	MergeTree: "MergeTree Tables",
	AggregatingMergeTree: "Aggregating MergeTree Tables",
	MaterializedView: "Materialized Views",
	View: "Views",
	Distributed: "Distributed Tables",
};
const CONFIG_FILE_CANDIDATES = [
	path.join(".pi", "clickhouse-client.json"),
	".clickhouse-client.json",
	"clickhouse-client.json",
];

type RawProjectConfig = {
	url?: unknown;
	host?: unknown;
	port?: unknown;
	secure?: unknown;
	user?: unknown;
	username?: unknown;
	password?: unknown;
	database?: unknown;
	proxy_path?: unknown;
	pathname?: unknown;
	send_receive_timeout?: unknown;
	request_timeout_ms?: unknown;
	allow_write_access?: unknown;
	allow_drop?: unknown;
};

type ResolvedProjectConfig = {
	cacheKey: string;
	sourcePath: string;
	url: string;
	username: string;
	password: string;
	database?: string;
	pathname?: string;
	requestTimeoutMs: number;
	allowWriteAccess: boolean;
	allowDrop: boolean;
};

type ColumnInfo = {
	database: string;
	table: string;
	name: string;
	column_type: string;
	default_kind: string | null;
	default_expression: string | null;
	comment: string | null;
};

type TableInfo = {
	database: string;
	name: string;
	engine: string;
	create_table_query: string;
	dependencies_database: string;
	dependencies_table: string;
	engine_full: string;
	sorting_key: string;
	primary_key: string;
	total_rows: number;
	total_bytes: number;
	total_bytes_uncompressed: number;
	parts: number;
	active_parts: number;
	total_marks: number;
	comment: string | null;
	columns: ColumnInfo[];
};

type QueryResultShape = {
	query_id: string;
	columns: string[];
	rows: unknown[][];
};

type EngineGroup = {
	engine: string;
	label: string;
	count: number;
	tables: string[];
};

const clientCache = new Map<string, ClickHouseClient>();
let registered = false;

const RunQueryParams = Type.Object({
	query: Type.String({
		description:
			"Single ClickHouse SQL statement to execute. Do not include an explicit FORMAT clause; the tool controls the response format automatically. Use LIMIT for large result sets.",
	}),
});

const PingParams = Type.Object({});

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
		for (const candidate of CONFIG_FILE_CANDIDATES) {
			const fullPath = path.join(current, candidate);
			if (existsSync(fullPath)) return fullPath;
		}
		const parent = path.dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

function buildUrl(config: RawProjectConfig, sourcePath: string): string {
	const url = normalizeString(config.url);
	if (url) return url;

	const host = normalizeString(config.host);
	if (!host) {
		throw new Error(`Invalid ${sourcePath}: expected either \"url\" or \"host\"`);
	}
	const secure = normalizeBoolean(config.secure, true);
	const port = normalizePositiveInteger(config.port, secure ? 8443 : 8123);
	const protocol = secure ? "https" : "http";
	return `${protocol}://${host}:${port}`;
}

function resolveProjectConfig(cwd: string): ResolvedProjectConfig {
	const configPath = findProjectConfigPath(cwd);
	if (!configPath) {
		throw new Error(
			`No clickhouse-client config found for ${cwd}. Create one at .pi/clickhouse-client.json or .clickhouse-client.json.`,
		);
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

	const config = parsed as RawProjectConfig;
	const username = normalizeString(config.username ?? config.user);
	if (!username) {
		throw new Error(`Invalid ${configPath}: missing \"username\" (or \"user\")`);
	}

	const password = typeof config.password === "string" ? config.password : "";
	const database = normalizeString(config.database);
	const pathname = normalizeString(config.pathname ?? config.proxy_path);
	const requestTimeoutMs = config.request_timeout_ms !== undefined
		? normalizePositiveInteger(config.request_timeout_ms, 300_000)
		: normalizePositiveInteger(config.send_receive_timeout, 300) * 1000;
	const allowWriteAccess = normalizeBoolean(config.allow_write_access, false);
	const allowDrop = normalizeBoolean(config.allow_drop, false);
	const url = buildUrl(config, configPath);

	const cacheKeyPayload = {
		url,
		username,
		password,
		database,
		pathname,
		requestTimeoutMs,
		allowWriteAccess,
		allowDrop,
	};

	return {
		cacheKey: JSON.stringify(cacheKeyPayload),
		sourcePath: configPath,
		url,
		username,
		password,
		database,
		pathname,
		requestTimeoutMs,
		allowWriteAccess,
		allowDrop,
	};
}

function getClient(config: ResolvedProjectConfig): ClickHouseClient {
	const cached = clientCache.get(config.cacheKey);
	if (cached) return cached;

	const client = createClient({
		url: config.url,
		username: config.username,
		password: config.password,
		database: config.database,
		pathname: config.pathname,
		request_timeout: config.requestTimeoutMs,
		application: CLIENT_APP_NAME,
		log: { level: ClickHouseLogLevel.OFF },
		keep_alive: { enabled: true },
		clickhouse_settings: {
			output_format_json_quote_64bit_integers: 0,
		},
	});

	clientCache.set(config.cacheKey, client);
	return client;
}

function escapeSqlString(value: string): string {
	return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

function getReadonlySetting(config: ResolvedProjectConfig): "0" | "1" {
	return config.allowWriteAccess ? "0" : "1";
}

function validateDestructiveOperations(config: ResolvedProjectConfig, query: string): void {
	if (!config.allowWriteAccess) return;
	if (config.allowDrop) return;
	const destructivePattern = /\b(DROP\s+(\S+\s+)*(TABLE|DATABASE|VIEW|DICTIONARY)|TRUNCATE\s+TABLE)\b/i;
	if (destructivePattern.test(query)) {
		throw new Error(
			"Destructive operations (DROP, TRUNCATE) are not allowed. Set allow_drop=true in your project config to enable them.",
		);
	}
}

async function executeSelectJson<T extends Record<string, unknown>>(
	config: ResolvedProjectConfig,
	query: string,
	abortSignal?: AbortSignal,
): Promise<T[]> {
	const client = getClient(config);
	const result = await client.query({
		query,
		format: "JSONEachRow",
		abort_signal: abortSignal,
		clickhouse_settings: {
			readonly: getReadonlySetting(config),
			output_format_json_quote_64bit_integers: 0,
		},
	});
	return result.json<T>();
}

function normalizeQueryForClickHouseClient(query: string): string {
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

function stripTrailingFormatClause(query: string): string {
	const settingsMatch = query.match(/\s+SETTINGS\s+[\s\S]+$/i);
	const settingsIndex = settingsMatch?.index;
	const mainQuery = settingsIndex === undefined ? query : query.slice(0, settingsIndex).trimEnd();
	const settingsClause = settingsIndex === undefined ? "" : query.slice(settingsIndex);
	const mainQueryWithoutFormat = mainQuery.replace(/\s+FORMAT\s+[A-Za-z0-9_]+\s*$/i, "").trimEnd();
	return `${mainQueryWithoutFormat}${settingsClause}`.trim();
}

function isQueryWithOutput(query: string): boolean {
	return /^(SELECT|WITH|SHOW|DESCRIBE|EXISTS|DESC|EXPLAIN)\b/i.test(query);
}

async function runQuery(
	config: ResolvedProjectConfig,
	query: string,
	abortSignal?: AbortSignal,
): Promise<QueryResultShape> {
	validateDestructiveOperations(config, query);
	const client = getClient(config);
	const normalized = stripTrailingFormatClause(normalizeQueryForClickHouseClient(query));
	const isSelectLike = isQueryWithOutput(normalized);

	if (isSelectLike) {
		const result = await client.exec({
			query: normalized,
			abort_signal: abortSignal,
			clickhouse_settings: {
				readonly: getReadonlySetting(config),
				default_format: "JSONCompact",
				output_format_json_quote_64bit_integers: 0,
			},
		});
		const resultSet = new ResultSet(result.stream, "JSONCompact", result.query_id);
		let json: { meta?: Array<{ name: string }>; data?: unknown[] };
		try {
			json = (await resultSet.json()) as { meta?: Array<{ name: string }>; data?: unknown[] };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(
				`Failed to parse ClickHouse response as JSONCompact. clickhouse_run_query expects a single result set; avoid multiple SQL statements and explicit FORMAT clauses. Original error: ${message}`,
			);
		}
		const columns = Array.isArray(json.meta) ? json.meta.map((col) => col.name) : [];
		const rows = Array.isArray(json.data)
			? json.data.map((row) =>
					Array.isArray(row)
						? row
						: columns.map((column) => (row as Record<string, unknown>)[column]),
				)
			: [];
		return { query_id: result.query_id, columns, rows };
	}

	const result = await client.command({
		query: normalized,
		abort_signal: abortSignal,
		clickhouse_settings: {
			readonly: getReadonlySetting(config),
		},
	});
	return { query_id: result.query_id, columns: [], rows: [] };
}

async function pingClickHouse(
	config: ResolvedProjectConfig,
	abortSignal?: AbortSignal,
): Promise<{ ok: boolean; message: string }> {
	const client = getClient(config);
	const result = await client.ping({ select: true, abort_signal: abortSignal });
	if (result.success) {
		return { ok: true, message: "Connected to ClickHouse" };
	}
	return { ok: false, message: result.error.message };
}

async function listDatabases(
	config: ResolvedProjectConfig,
	abortSignal?: AbortSignal,
): Promise<string[]> {
	const rows = await executeSelectJson<{ name?: string }>(
		config,
		"SELECT name FROM system.databases ORDER BY name",
		abortSignal,
	);
	return rows.map((row) => String(row.name ?? "")).filter(Boolean);
}

async function fetchTableNamesFromSystem(
	config: ResolvedProjectConfig,
	database: string,
	like?: string,
	notLike?: string,
	abortSignal?: AbortSignal,
): Promise<string[]> {
	let query = `SELECT name FROM system.tables WHERE database = ${escapeSqlString(database)}`;
	if (like) query += ` AND name LIKE ${escapeSqlString(like)}`;
	if (notLike) query += ` AND name NOT LIKE ${escapeSqlString(notLike)}`;
	query += " ORDER BY name";
	const rows = await executeSelectJson<{ name?: string }>(config, query, abortSignal);
	return rows.map((row) => String(row.name ?? "")).filter(Boolean);
}

async function fetchColumnsForTable(
	config: ResolvedProjectConfig,
	database: string,
	table: string,
	abortSignal?: AbortSignal,
): Promise<ColumnInfo[]> {
	const query = `
		SELECT
			database,
			table,
			name,
			type AS column_type,
			default_kind,
			default_expression,
			comment
		FROM system.columns
		WHERE database = ${escapeSqlString(database)}
		  AND table = ${escapeSqlString(table)}
		ORDER BY position
	`;
	const rows = await executeSelectJson<Record<string, unknown>>(config, query, abortSignal);
	return rows.map((row) => ({
		database: String(row.database ?? database),
		table: String(row.table ?? table),
		name: String(row.name ?? ""),
		column_type: String(row.column_type ?? ""),
		default_kind: row.default_kind == null ? null : String(row.default_kind),
		default_expression: row.default_expression == null ? null : String(row.default_expression),
		comment: row.comment == null ? null : String(row.comment),
	}));
}

async function fetchTableDetails(
	config: ResolvedProjectConfig,
	database: string,
	tableNames: string[],
	includeDetailedColumns: boolean,
	abortSignal?: AbortSignal,
): Promise<TableInfo[]> {
	if (tableNames.length === 0) return [];
	const inClause = tableNames.map(escapeSqlString).join(", ");
	const query = `
		SELECT
			database,
			name,
			engine,
			create_table_query,
			ifNull(dependencies_database, '') AS dependencies_database,
			ifNull(dependencies_table, '') AS dependencies_table,
			engine_full,
			sorting_key,
			primary_key,
			total_rows,
			total_bytes,
			total_bytes_uncompressed,
			parts,
			active_parts,
			total_marks,
			comment
		FROM system.tables
		WHERE database = ${escapeSqlString(database)}
		  AND name IN (${inClause})
		ORDER BY name
	`;
	const rows = await executeSelectJson<Record<string, unknown>>(config, query, abortSignal);
	const tables: TableInfo[] = rows.map((row) => ({
		database: String(row.database ?? database),
		name: String(row.name ?? ""),
		engine: String(row.engine ?? ""),
		create_table_query: String(row.create_table_query ?? ""),
		dependencies_database: String(row.dependencies_database ?? ""),
		dependencies_table: String(row.dependencies_table ?? ""),
		engine_full: String(row.engine_full ?? ""),
		sorting_key: String(row.sorting_key ?? ""),
		primary_key: String(row.primary_key ?? ""),
		total_rows: Number(row.total_rows ?? 0),
		total_bytes: Number(row.total_bytes ?? 0),
		total_bytes_uncompressed: Number(row.total_bytes_uncompressed ?? 0),
		parts: Number(row.parts ?? 0),
		active_parts: Number(row.active_parts ?? 0),
		total_marks: Number(row.total_marks ?? 0),
		comment: row.comment == null ? null : String(row.comment),
		columns: [],
	}));

	if (includeDetailedColumns) {
		await Promise.all(
			tables.map(async (table) => {
				table.columns = await fetchColumnsForTable(config, database, table.name, abortSignal);
			}),
		);
	}

	return tables;
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
	engine_groups: EngineGroup[];
	total_tables: number;
}> {
	const database = params.database;
	const like = normalizeString(params.like);
	const notLike = normalizeString(params.not_like);

	const tableNames = await fetchTableNamesFromSystem(config, database, like, notLike, abortSignal);
	const tables = await fetchTableDetails(config, database, tableNames, false, abortSignal);
	const grouped = groupTablesByEngine(tables);

	return {
		engine_groups: grouped.engine_groups,
		total_tables: tableNames.length,
	};
}

function getEngineDisplayLabel(engine: string): string {
	return ENGINE_DISPLAY_LABELS[engine] ?? `${engine} Tables`;
}

function groupTablesByEngine(tables: TableInfo[]): {
	engine_groups: EngineGroup[];
} {
	const groups = new Map<string, TableInfo[]>();
	for (const table of tables) {
		const engine = table.engine || "(unknown)";
		const list = groups.get(engine);
		if (list) list.push(table);
		else groups.set(engine, [table]);
	}

	const engineOrderIndex = new Map<string, number>(ENGINE_DISPLAY_ORDER.map((engine, index) => [engine, index]));
	const engineGroups = Array.from(groups.entries())
		.sort(([a], [b]) => {
			const aIndex = engineOrderIndex.get(a);
			const bIndex = engineOrderIndex.get(b);
			if (aIndex !== undefined && bIndex !== undefined) return aIndex - bIndex;
			if (aIndex !== undefined) return -1;
			if (bIndex !== undefined) return 1;
			return a.localeCompare(b);
		})
		.map(([engine, groupTables]) => {
			const sortedTableNames = groupTables.map((table) => table.name).sort((a, b) => a.localeCompare(b));
			return {
				engine,
				label: getEngineDisplayLabel(engine),
				count: sortedTableNames.length,
				tables: sortedTableNames,
			};
		});

	return {
		engine_groups: engineGroups,
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

function formatListTablesContent(result: {
	database: string;
	engine_groups: EngineGroup[];
	total_tables: number;
}): string {
	const lines: string[] = [];
	lines.push(`Database: ${result.database}`);
	lines.push(`Total matching tables: ${result.total_tables}`);

	if (result.engine_groups.length === 0) {
		lines.push("No tables found.");
	} else {
		lines.push("Tables grouped by engine:");
		for (const group of result.engine_groups) {
			lines.push(`- ${group.label} (${group.count})`);
		}
	}

	return lines.join("\n");
}

function isListTablesDetails(details: unknown): details is {
	config: string;
	database: string;
	engine_groups: EngineGroup[];
	total_tables: number;
} {
	if (!isRecord(details)) return false;
	if (typeof details.config !== "string") return false;
	if (typeof details.database !== "string") return false;
	if (typeof details.total_tables !== "number") return false;
	if (!Array.isArray(details.engine_groups)) return false;
	return details.engine_groups.every(
		(group) =>
			isRecord(group) &&
			typeof group.engine === "string" &&
			typeof group.label === "string" &&
			typeof group.count === "number" &&
			Array.isArray(group.tables) &&
			group.tables.every((table) => typeof table === "string"),
	);
}

function replaceListTablesToolResultContentForLlm<T>(messages: T[]): T[] {
	return messages.map((message) => {
		if (!isRecord(message)) return message;
		if (message.role !== "toolResult") return message;
		if (message.toolName !== "clickhouse_list_tables") return message;
		if (!isListTablesDetails(message.details)) return message;

		return {
			...message,
			content: [{ type: "text", text: formatJson(message.details) }],
		} as T;
	});
}

function formatListDatabasesContent(result: { databases: string[] }): string {
	const lines: string[] = [];
	lines.push(`Databases: ${result.databases.length}`);
	for (const database of result.databases) {
		lines.push(`- ${database}`);
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
		return errorText ? `ClickHouse ping failed: ${errorText}` : "ClickHouse ping failed";
	}

	if (isRecord(result.details)) {
		const ok = result.details.ok === true;
		const message = typeof result.details.message === "string" ? result.details.message : ok ? "Connected" : "Connection failed";
		return ok ? `✓ ${message}` : `✗ ${message}`;
	}

	const text = getResultText(result).trim();
	return text || "ClickHouse ping completed";
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
	let formatted = normalizeQueryForClickHouseClient(query)
		.replace(/\s+/g, " ")
		.replace(/\b(FROM)\b/gi, "\n$1")
		.replace(/\b(WHERE)\b/gi, "\n$1")
		.replace(/\b((?:LEFT|RIGHT|INNER|FULL|CROSS)\s+JOIN)\b/gi, "\n$1")
		.replace(/\b(ON)\b/gi, "\n  $1")
		.replace(/\b(AND)\b/gi, "\n  $1")
		.replace(/\b(OR)\b/gi, "\n  $1")
		.replace(/\b(GROUP\s+BY)\b/gi, "\n$1")
		.replace(/\b(ORDER\s+BY)\b/gi, "\n$1")
		.replace(/\b(LIMIT)\b/gi, "\n$1")
		.replace(/\b(SETTINGS)\b/gi, "\n$1");

	formatted = formatted.replace(/^SELECT\s+([\s\S]*?)\nFROM\b/i, (_match, selectList: string) => {
		const columns = splitTopLevelCommaList(selectList);
		if (columns.length <= 1) return `SELECT ${selectList}\nFROM`;
		return `SELECT\n  ${columns.join(",\n  ")}\nFROM`;
	});

	return formatted.trim();
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

function registerTools(pi: ExtensionAPI): void {
	if (registered) return;
	registered = true;

	pi.registerTool({
		name: "clickhouse_ping",
		label: "ClickHouse Ping",
		description: "Verify that the current project's ClickHouse config is reachable",
		parameters: PingParams,
		async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
			const config = resolveProjectConfig(getContextCwd(ctx));
			const result = await pingClickHouse(config, signal);
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
		name: "clickhouse_list_databases",
		label: "ClickHouse List Databases",
		description: "List available databases in the configured ClickHouse instance",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, signal, _onUpdate, ctx) {
			const config = resolveProjectConfig(getContextCwd(ctx));
			const databases = await listDatabases(config, signal);
			const details = { config: config.sourcePath, databases };
			return makeTextResult(details, formatListDatabasesContent(details));
		},
	});

	pi.registerTool({
		name: "clickhouse_list_tables",
		label: "ClickHouse List Tables",
		description: "List tables in a database with optional filtering, grouped by engine type",
		parameters: ListTablesParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const config = resolveProjectConfig(getContextCwd(ctx));
			const result = await listTables(config, params as typeof params & { database: string }, signal);
			const details = { config: config.sourcePath, database: String((params as { database: string }).database), ...result };
			return makeTextResult(details, formatListTablesContent(details));
		},
	});

	pi.registerTool({
		name: "clickhouse_run_query",
		label: "ClickHouse Run Query",
		description:
			"Execute a single ClickHouse SQL statement using the current project's config. Result-producing statements return structured details as { columns, rows } using JSONCompact; avoid multiple statements and explicit FORMAT clauses.",
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
}

export default function clickhouseClientExtension(pi: ExtensionAPI) {
	registerTools(pi);

	pi.on("context", async (event) => {
		return { messages: replaceListTablesToolResultContentForLlm(event.messages) };
	});

	pi.on("session_start", async (_event, ctx) => {
		const cwd = getContextCwd(ctx);
		const configPath = findProjectConfigPath(cwd);
		ctx.ui.setStatus(
			"clickhouse-client",
			configPath ? `clickhouse config: ${path.relative(cwd, configPath) || configPath}` : "clickhouse: no project config",
		);
	});
}
