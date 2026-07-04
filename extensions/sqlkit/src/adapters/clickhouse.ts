import { ClickHouseLogLevel, ResultSet, createClient, type ClickHouseClient } from "@clickhouse/client";
import { normalizeIdentifier } from "../core/access.js";
import { normalizeAccessPatterns, tableAccessPatternsForDatabase } from "../core/access.js";
import { analyzeClickHouseCapabilities } from "./capabilities.js";
import type {
	AnalyzeQueryResult,
	CapabilityCheckResult,
	DialectAdapter,
	DescribeTableResult,
	ExplainQueryResult,
	ListTablesResult,
	PingResult,
	ProfileQueryResult,
	QueryResult,
	ResolvedDataSource,
	SearchTableColumnMatch,
	SearchTableMatch,
	SearchTablesResult,
	TableEngineGroup,
	VerifiedExplainQuery,
	VerifiedQuery,
	VerifiedWriteStatement,
	WriteStatementResult,
} from "../types.js";
import { shapeQueryRows } from "../core/limits.js";
import { asBoolean, asTrimmedString, escapeSqlString, readPasswordOption } from "../utils.js";
import { containsIgnoreCase, getNumberOption, getStringOption, pushMatch } from "./utils.js";

const clientCache = new Map<string, ClickHouseClient>();
const clientCacheKeyBySourceIdentity = new Map<string, string>();
const systemMetadataColumnCache = new Map<string, Map<string, Set<string>>>();

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

function getSourceIdentity(source: ResolvedDataSource): string {
	return JSON.stringify({ configPath: source.configPath, name: source.name, dialect: source.dialect });
}

function closeStaleClientForSource(source: ResolvedDataSource): void {
	const identity = getSourceIdentity(source);
	const previousCacheKey = clientCacheKeyBySourceIdentity.get(identity);
	if (previousCacheKey && previousCacheKey !== source.cacheKey) {
		const staleClient = clientCache.get(previousCacheKey);
		clientCache.delete(previousCacheKey);
		systemMetadataColumnCache.delete(previousCacheKey);
		void staleClient?.close().catch(() => undefined);
	}
	clientCacheKeyBySourceIdentity.set(identity, source.cacheKey);
}

export function buildClickHouseUrl(source: ResolvedDataSource): string {
	const url = getStringOption(source, "url");
	if (url) return url;

	const host = getStringOption(source, "host") ?? "127.0.0.1";
	const protocol = getStringOption(source, "protocol") ?? (asBoolean(source.options.secure, false) ? "https" : "http");
	const defaultPort = protocol.toLowerCase() === "https" ? 8443 : 8123;
	const port = getNumberOption(source, "port", defaultPort);
	return `${protocol}://${host}:${port}`;
}

function getRequestTimeoutMs(source: ResolvedDataSource): number {
	if (source.options.request_timeout_ms != null) return getNumberOption(source, "request_timeout_ms", 30_000);
	return getNumberOption(source, "send_receive_timeout", 30) * 1000;
}

function getPathnameOption(source: ResolvedDataSource): string | undefined {
	return getStringOption(source, "pathname") ?? getStringOption(source, "proxy_path");
}

function getClient(source: ResolvedDataSource): ClickHouseClient {
	const cached = clientCache.get(source.cacheKey);
	if (cached) {
		clientCacheKeyBySourceIdentity.set(getSourceIdentity(source), source.cacheKey);
		return cached;
	}

	closeStaleClientForSource(source);
	const client = createClient({
		url: buildClickHouseUrl(source),
		username: getStringOption(source, "user") ?? getStringOption(source, "username") ?? "default",
		password: readPasswordOption(source.options),
		database: getStringOption(source, "database"),
		request_timeout: getRequestTimeoutMs(source),
		application: "pi-sqlkit",
		log: { level: ClickHouseLogLevel.OFF },
		keep_alive: { enabled: true },
		pathname: getPathnameOption(source),
		clickhouse_settings: {
			output_format_json_quote_64bit_integers: 0,
		},
	});

	clientCache.set(source.cacheKey, client);
	return client;
}

export async function closeClickHouseClients(): Promise<void> {
	const clients = Array.from(clientCache.values());
	clientCache.clear();
	clientCacheKeyBySourceIdentity.clear();
	systemMetadataColumnCache.clear();
	await Promise.all(clients.map((client) => client.close()));
}

async function executeSelectJson<T extends Record<string, unknown>>(
	source: ResolvedDataSource,
	query: string,
	signal?: AbortSignal,
): Promise<T[]> {
	const client = getClient(source);
	const result = await client.query({
		query,
		format: "JSONEachRow",
		abort_signal: signal,
		clickhouse_settings: {
			readonly: "1",
			output_format_json_quote_64bit_integers: 0,
		},
	});
	return result.json<T>();
}

async function resolveDatabase(source: ResolvedDataSource, requestedDatabase?: string): Promise<string> {
	const explicit = asTrimmedString(requestedDatabase);
	if (explicit) return explicit;
	const rows = await executeSelectJson<{ current_database?: string }>(
		source,
		"SELECT currentDatabase() AS current_database",
	);
	const currentDatabase = rows[0]?.current_database;
	if (typeof currentDatabase === "string" && currentDatabase) return currentDatabase;
	throw new Error(`Datasource "${source.name}" does not define options.database.`);
}

async function getSystemTableColumns(
	source: ResolvedDataSource,
	systemTable: string,
	signal?: AbortSignal,
): Promise<Set<string>> {
	let sourceCache = systemMetadataColumnCache.get(source.cacheKey);
	if (!sourceCache) {
		sourceCache = new Map<string, Set<string>>();
		systemMetadataColumnCache.set(source.cacheKey, sourceCache);
	}
	const cached = sourceCache.get(systemTable);
	if (cached) return cached;

	const rows = await executeSelectJson<{ name?: string }>(
		source,
		`SELECT name
		 FROM system.columns
		 WHERE database = 'system'
		   AND table = ${escapeSqlString(systemTable)}`,
		signal,
	);
	const columns = new Set(rows.map((row) => row.name).filter((name): name is string => typeof name === "string" && name.length > 0));
	sourceCache.set(systemTable, columns);
	return columns;
}

type DynamicSelectColumn = {
	name: string;
	expression?: string;
	alias?: string;
	required?: boolean;
};

function buildDynamicSelectList(columns: Iterable<DynamicSelectColumn>, availableColumns: Set<string>, tableAlias?: string): string {
	const expressions: string[] = [];
	for (const column of columns) {
		if (!column.required && !availableColumns.has(column.name)) continue;
		const qualifiedName = tableAlias ? `${tableAlias}.${column.name}` : column.name;
		expressions.push(column.expression ?? (column.alias ? `${qualifiedName} AS ${column.alias}` : tableAlias ? `${qualifiedName} AS ${column.name}` : qualifiedName));
	}
	return expressions.join(",\n\t\t\t");
}

const CLICKHOUSE_DEFAULT_FORMAT = "JSONCompact";
const CLICKHOUSE_PROFILE_ATTEMPTS = 10;
const CLICKHOUSE_PROFILE_POLL_MS = 150;

export function normalizeClickHouseQueryForClient(query: string): string {
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

export function stripTrailingClickHouseFormatClause(query: string): string {
	const settingsMatch = query.match(/\s+SETTINGS\s+[\s\S]+$/i);
	const settingsIndex = settingsMatch?.index;
	const mainQuery = settingsIndex === undefined ? query : query.slice(0, settingsIndex).trimEnd();
	const settingsClause = settingsIndex === undefined ? "" : query.slice(settingsIndex);
	const mainQueryWithoutFormat = mainQuery.replace(/\s+FORMAT\s+[A-Za-z0-9_]+\s*$/i, "").trimEnd();
	return `${mainQueryWithoutFormat}${settingsClause}`.trim();
}

function normalizeClickHouseOutputQuery(query: string): string {
	return stripTrailingClickHouseFormatClause(normalizeClickHouseQueryForClient(query));
}

function asNullableString(value: unknown): string | undefined {
	return value == null ? undefined : String(value);
}

function asNullableNumber(value: unknown): number | undefined {
	if (value == null) return undefined;
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

function getEngineDisplayLabel(engine: string): string {
	return ENGINE_DISPLAY_LABELS[engine] ?? `${engine} Tables`;
}

function groupTableNamesByEngine(tables: Array<{ name: string; engine?: string }>): TableEngineGroup[] {
	const groups = new Map<string, string[]>();
	for (const table of tables) {
		const engine = table.engine || "(unknown)";
		const list = groups.get(engine);
		if (list) list.push(table.name);
		else groups.set(engine, [table.name]);
	}

	const engineOrderIndex = new Map<string, number>(ENGINE_DISPLAY_ORDER.map((engine, index) => [engine, index]));
	return Array.from(groups.entries())
		.sort(([left], [right]) => {
			const leftIndex = engineOrderIndex.get(left);
			const rightIndex = engineOrderIndex.get(right);
			if (leftIndex !== undefined && rightIndex !== undefined) return leftIndex - rightIndex;
			if (leftIndex !== undefined) return -1;
			if (rightIndex !== undefined) return 1;
			return left.localeCompare(right);
		})
		.map(([engine, names]) => {
			const sorted = [...names].sort((left, right) => left.localeCompare(right));
			return {
				engine,
				label: getEngineDisplayLabel(engine),
				count: sorted.length,
				tables: sorted,
			};
		});
}

function clickHouseContainsExpression(expression: string, value: string): string {
	return `positionCaseInsensitiveUTF8(${expression}, ${escapeSqlString(value)}) > 0`;
}

type ClickHouseSqlCondition = {
	sql: string;
};

function combineClickHouseConditions(operator: "AND" | "OR", conditions: ClickHouseSqlCondition[]): ClickHouseSqlCondition | undefined {
	if (conditions.length === 0) return undefined;
	if (conditions.length === 1) return conditions[0];
	return {
		sql: conditions.map((condition) => `(${condition.sql})`).join(` ${operator} `),
	};
}

function buildClickHouseAccessRegex(pattern: string): string {
	// Safe glob-to-regex: escape regex metacharacters, replace * with safe wildcard.
	// Uses non-backtracking pattern to avoid ReDoS.
	const escaped = pattern.replace(/[|\{}()\[\]^$+?.]/g, "\$&");
	return "^" + escaped.split("*").map(s => s ? s.replace(/[|\{}()\[\]^$+?.]/g, "\$&") : "").join(".*") + "$";
}

function buildClickHouseAccessPatternCondition(expression: string, patterns: string[]): ClickHouseSqlCondition | undefined {
	const conditions = normalizeAccessPatterns(patterns).map((pattern) => {
		if (pattern.includes("*")) {
			return {
				sql: `match(lowerUTF8(${expression}), ${escapeSqlString(buildClickHouseAccessRegex(pattern))})`,
			};
		}
		return {
			sql: `lowerUTF8(${expression}) = ${escapeSqlString(pattern)}`,
		};
	});
	return combineClickHouseConditions("OR", conditions);
}

function appendClickHouseAccessPatternFilter(
	where: string[],
	expression: string,
	filter: { allow: string[]; deny: string[] },
): void {
	const deny = buildClickHouseAccessPatternCondition(expression, filter.deny);
	if (deny) {
		where.push(`NOT (${deny.sql})`);
	}
	const allow = buildClickHouseAccessPatternCondition(expression, filter.allow);
	if (allow) {
		where.push(allow.sql);
	}
}

function buildClickHouseRuleDatabaseCondition(databaseExpression: string, database: string | undefined): ClickHouseSqlCondition {
	if (!database) return { sql: "1 = 1" };
	return {
		sql: `lowerUTF8(${databaseExpression}) = ${escapeSqlString(normalizeIdentifier(database))}`,
	};
}

function buildClickHouseTableAccessPolicyCondition(
	source: ResolvedDataSource,
	databaseExpression: string,
	tableExpression: string,
): ClickHouseSqlCondition | undefined {
	if (source.access.tables.length === 0) return undefined;
	const anyRuleConditions: ClickHouseSqlCondition[] = [];
	const denyMatchConditions: ClickHouseSqlCondition[] = [];
	const anyAllowRuleConditions: ClickHouseSqlCondition[] = [];
	const allowMatchConditions: ClickHouseSqlCondition[] = [];

	for (const rule of source.access.tables) {
		const databaseCondition = buildClickHouseRuleDatabaseCondition(databaseExpression, rule.database);
		anyRuleConditions.push(databaseCondition);

		const deny = buildClickHouseAccessPatternCondition(tableExpression, rule.deny);
		if (deny) {
			const condition = combineClickHouseConditions("AND", [databaseCondition, deny]);
			if (condition) denyMatchConditions.push(condition);
		}

		if (normalizeAccessPatterns(rule.allow).length > 0) {
			anyAllowRuleConditions.push(databaseCondition);
			const allow = buildClickHouseAccessPatternCondition(tableExpression, rule.allow);
			if (allow) {
				const condition = combineClickHouseConditions("AND", [databaseCondition, allow]);
				if (condition) allowMatchConditions.push(condition);
			}
		}
	}

	const anyRule = combineClickHouseConditions("OR", anyRuleConditions);
	if (!anyRule) return undefined;
	const denyMatch = combineClickHouseConditions("OR", denyMatchConditions);
	const anyAllowRule = combineClickHouseConditions("OR", anyAllowRuleConditions);
	const allowMatch = combineClickHouseConditions("OR", allowMatchConditions);

	const allowedByRuleParts: ClickHouseSqlCondition[] = [];
	if (denyMatch) {
		allowedByRuleParts.push({ sql: `NOT (${denyMatch.sql})` });
	}
	if (anyAllowRule) {
		allowedByRuleParts.push({
			sql: `(NOT (${anyAllowRule.sql}) OR (${allowMatch?.sql ?? "0 = 1"}))`,
		});
	}

	const noApplicableRule = { sql: `NOT (${anyRule.sql})` };
	const allowedByRules = combineClickHouseConditions("AND", allowedByRuleParts) ?? { sql: "1 = 1" };
	return combineClickHouseConditions("OR", [noApplicableRule, allowedByRules]);
}

function clickHouseExactExpression(expression: string, value: string): string {
	return `lowerUTF8(${expression}) = lowerUTF8(${escapeSqlString(value)})`;
}

function buildClickHouseSearchOrder(
	input: { keyword?: string; column?: string; comment?: string; engine?: string },
	available: { tableComment?: boolean; engine?: boolean } = {},
): string {
	const order: string[] = [];
	if (input.keyword) {
		const keywordBranches = [
			`${clickHouseExactExpression("t.name", input.keyword)}, 0`,
			`${clickHouseContainsExpression("t.name", input.keyword)}, 1`,
		];
		if (available.tableComment) keywordBranches.push(`${clickHouseContainsExpression("t.comment", input.keyword)}, 3`);
		order.push(`multiIf(
			${keywordBranches.join(",\n\t\t\t")},
			9
		)`);
	}
	if (input.comment && available.tableComment) {
		order.push(`multiIf(${clickHouseContainsExpression("t.comment", input.comment)}, 0, 9)`);
	}
	if (input.engine && available.engine) {
		order.push(`multiIf(
			${clickHouseExactExpression("t.engine", input.engine)}, 0,
			${clickHouseContainsExpression("t.engine", input.engine)}, 1,
			9
		)`);
	}
	return order.length > 0 ? `${order.join(", ")}, t.database, t.name` : "t.database, t.name";
}

function scoreSearchTableMatch(match: SearchTableMatch, input: { keyword?: string; column?: string; comment?: string; engine?: string }): number {
	let score = 100;
	const tableName = match.table.toLowerCase();
	if (input.keyword) {
		const keyword = input.keyword.toLowerCase();
		if (tableName === keyword) score = Math.min(score, 0);
		else if (tableName.includes(keyword)) score = Math.min(score, 10);
		if (match.matched_on.includes("keyword:table_comment")) score = Math.min(score, 30);
		if (match.matched_on.includes("keyword:column_name")) score = Math.min(score, 40);
		if (match.matched_on.includes("keyword:column_comment")) score = Math.min(score, 50);
	}
	if (input.column) {
		const column = input.column.toLowerCase();
		for (const matchedColumn of match.matched_columns) {
			const columnName = matchedColumn.name.toLowerCase();
			if (columnName === column) score = Math.min(score, 5);
			else if (columnName.includes(column)) score = Math.min(score, 15);
		}
	}
	if (input.comment && (match.matched_on.includes("keyword:table_comment") || match.matched_on.includes("column:column_comment"))) {
		score = Math.min(score, 25);
	}
	if (input.engine && match.matched_on.includes("engine")) {
		score = Math.min(score, 20);
	}
	return score;
}

function shapeClickHouseExecResult(
	payload: { meta?: Array<{ name: string }>; data?: unknown[] },
	limits: { maxRows: number; fetchRows: number; maxResultBytes: number; maxCellChars: number },
	source: ResolvedDataSource,
	queryKind: string,
	durationMs: number,
	includeProfile = false,
): QueryResult {
	const columns = Array.isArray(payload.meta) ? payload.meta.map((item) => item.name) : [];
	const rows = Array.isArray(payload.data)
		? payload.data.map((row) => (Array.isArray(row) ? row : columns.map((column) => (row as Record<string, unknown>)[column])))
		: [];
	const shaped = shapeQueryRows({
		columns,
		rows,
		limits,
		includeProfile,
	});
	return {
		source: source.name,
		dialect: "clickhouse",
		query_kind: queryKind,
		columns,
		rows: shaped.rows,
		row_count: shaped.rowCount,
		truncated: shaped.truncated,
		result_profile: shaped.resultProfile,
		duration_ms: durationMs,
		warnings: shaped.warnings,
	};
}

async function executeClickHouseJsonCompact(
	source: ResolvedDataSource,
	query: string,
	clickhouseSettings: Record<string, string | number>,
	signal?: AbortSignal,
	queryId?: string,
): Promise<{ payload: { meta?: Array<{ name: string }>; data?: unknown[] }; queryId: string; durationMs: number }> {
	const client = getClient(source);
	const start = Date.now();
	const response = await client.exec({
		query,
		query_id: queryId,
		abort_signal: signal,
		clickhouse_settings: {
			readonly: "1",
			default_format: CLICKHOUSE_DEFAULT_FORMAT,
			output_format_json_quote_64bit_integers: 0,
			...clickhouseSettings,
		},
	});
	const resultSet = new ResultSet(response.stream, CLICKHOUSE_DEFAULT_FORMAT, response.query_id);
	let payload: { meta?: Array<{ name: string }>; data?: unknown[] };
	try {
		payload = (await resultSet.json()) as {
			meta?: Array<{ name: string }>;
			data?: unknown[];
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(
			`Failed to parse ClickHouse response as ${CLICKHOUSE_DEFAULT_FORMAT}. sqlkit expects one result set; avoid multiple SQL statements. Trailing FORMAT clauses are stripped automatically. Original error: ${message}`,
		);
	}
	return { payload, queryId: response.query_id, durationMs: Date.now() - start };
}

function buildUnavailableRuntimeProfile(queryId: string): ProfileQueryResult["runtime_profile"] {
	return {
		status: "unavailable",
		query_id: queryId,
		note: "system.query_log row was not available before timeout or is not accessible to the current account.",
	};
}

function buildProfileEvents(profileEventsRaw: unknown): NonNullable<ProfileQueryResult["runtime_profile"]["profile_events"]> {
	if (!profileEventsRaw || typeof profileEventsRaw !== "object") return [];
	return Object.entries(profileEventsRaw as Record<string, unknown>)
		.map(([name, value]) => ({ name, value: typeof value === "number" ? value : Number(value ?? 0) }))
		.filter((entry) => Number.isFinite(entry.value) && entry.value > 0)
		.sort((left, right) => right.value - left.value)
		.slice(0, 10);
}

async function pollClickHouseRuntimeProfile(
	source: ResolvedDataSource,
	queryId: string,
	signal?: AbortSignal,
): Promise<ProfileQueryResult["runtime_profile"]> {
	try {
		for (let attempt = 0; attempt < CLICKHOUSE_PROFILE_ATTEMPTS; attempt += 1) {
			const rows = await executeSelectJson<Record<string, unknown>>(
				source,
				`SELECT
					query_duration_ms,
					read_rows,
					read_bytes,
					result_rows,
					result_bytes,
					memory_usage,
					databases,
					tables,
					columns,
					used_functions,
					used_storages,
					ProfileEvents
				 FROM system.query_log
				 WHERE type = 'QueryFinish'
				   AND query_id = ${escapeSqlString(queryId)}
				 ORDER BY event_time_microseconds DESC
				 LIMIT 1`,
				signal,
			);
			if (rows.length > 0) {
				const row = rows[0] ?? {};
				return {
					status: "available",
					query_id: queryId,
					duration_ms: asNullableNumber(row.query_duration_ms),
					read_rows: asNullableNumber(row.read_rows),
					read_bytes: asNullableNumber(row.read_bytes),
					result_rows: asNullableNumber(row.result_rows),
					result_bytes: asNullableNumber(row.result_bytes),
					memory_usage: asNullableNumber(row.memory_usage),
					databases: Array.isArray(row.databases) ? row.databases.map(String) : undefined,
					tables: Array.isArray(row.tables) ? row.tables.map(String) : undefined,
					columns: Array.isArray(row.columns) ? row.columns.map(String) : undefined,
					used_functions: Array.isArray(row.used_functions) ? row.used_functions.map(String) : undefined,
					used_storages: Array.isArray(row.used_storages) ? row.used_storages.map(String) : undefined,
					profile_events: buildProfileEvents(row.ProfileEvents),
				};
			}
			await new Promise((resolve) => setTimeout(resolve, CLICKHOUSE_PROFILE_POLL_MS));
		}
		return buildUnavailableRuntimeProfile(queryId);
	} catch (err) {
		const profile = buildUnavailableRuntimeProfile(queryId);
		profile.note = `system.query_log poll failed: ${err instanceof Error ? err.message : String(err)}`;
		return profile;
	}
}

export const clickhouseAdapter: DialectAdapter = {
	dialect: "clickhouse",
	async ping(source, signal): Promise<PingResult> {
		const client = getClient(source);
		const ping = await client.ping({ select: true, abort_signal: signal });
		if (!ping.success) {
			throw new Error(ping.error.message);
		}
		const rows = await executeSelectJson<{ server_version?: string; current_database?: string }>(
			source,
			"SELECT version() AS server_version, currentDatabase() AS current_database",
			signal,
		);
		return {
			source: source.name,
			dialect: "clickhouse",
			ok: true,
			server_version: rows[0]?.server_version,
			current_database: rows[0]?.current_database,
			warnings: [],
		};
	},

	async listDatabases(source, signal): Promise<string[]> {
		const rows = await executeSelectJson<{ name?: string }>(
			source,
			"SELECT name FROM system.databases ORDER BY name",
			signal,
		);
		return rows.map((row) => String(row.name ?? "")).filter(Boolean);
	},

	async inspectCapabilities(source, signal): Promise<CapabilityCheckResult> {
		let currentUser: string | undefined;
		let readonlySetting: number | undefined;
		let allowDdlSetting: number | undefined;
		let grantStrings: string[] = [];
		let privilegeNames: string[] = [];

		try {
			const rows = await executeSelectJson<{ current_user?: string; readonly?: number | string }>(
				source,
				"SELECT currentUser() AS current_user, getSetting('readonly') AS readonly",
				signal,
			);
			currentUser = rows[0]?.current_user;
			readonlySetting = asNullableNumber(rows[0]?.readonly);
		} catch {
			// Best-effort only.
		}

		try {
			const rows = await executeSelectJson<{ name?: string; value?: string | number }>(
				source,
				"SELECT name, value FROM system.settings WHERE name IN ('readonly', 'allow_ddl')",
				signal,
			);
			for (const row of rows) {
				if (row.name === "readonly") readonlySetting = asNullableNumber(row.value);
				if (row.name === "allow_ddl") allowDdlSetting = asNullableNumber(row.value);
			}
		} catch {
			// Ignore settings-inspection failures.
		}

		try {
			const rows = await executeSelectJson<Record<string, unknown>>(source, "SHOW GRANTS", signal);
			grantStrings = rows
				.flatMap((row) => Object.values(row))
				.filter((value): value is string => typeof value === "string" && value.trim() !== "")
				.map((value) => value.trim());
		} catch {
			grantStrings = [];
		}

		try {
			const rows = await executeSelectJson<{ access_type?: string }>(
				source,
				"SELECT access_type FROM system.grants",
				signal,
			);
			privilegeNames = rows
				.map((row) => row.access_type)
				.filter((value): value is string => typeof value === "string" && value.trim() !== "")
				.map((value) => value.trim());
		} catch {
			privilegeNames = [];
		}

		return analyzeClickHouseCapabilities(source, {
			currentUser,
			grants: grantStrings,
			privileges: privilegeNames,
			readonlySetting,
			allowDdlSetting,
		});
	},

	async listTables(source, input, signal): Promise<ListTablesResult> {
		const database = await resolveDatabase(source, input.database);
		const tableColumns = await getSystemTableColumns(source, "tables", signal);
		const selectColumns = buildDynamicSelectList(
			[
				{ name: "name", required: true },
				{ name: "engine" },
			],
			tableColumns,
		);
		let query = `SELECT ${selectColumns} FROM system.tables WHERE database = ${escapeSqlString(database)}`;
		if (input.like) query += ` AND name LIKE ${escapeSqlString(input.like)}`;
		const tableAccess = tableAccessPatternsForDatabase(source, database);
		if (tableAccess) {
			const accessWhere: string[] = [];
			appendClickHouseAccessPatternFilter(accessWhere, "name", tableAccess);
			if (accessWhere.length > 0) query += ` AND ${accessWhere.join(" AND ")}`;
		}
		query += " ORDER BY name";
		const queryLimit = input.maxResults == null ? undefined : Math.max(1, input.maxResults) + 1;
		if (queryLimit != null) query += ` LIMIT ${queryLimit}`;
		const rows = await executeSelectJson<{ name?: string; engine?: string }>(source, query, signal);
		const tablesWithEngine = rows
			.map((row) => ({ name: String(row.name ?? ""), engine: row.engine == null ? undefined : String(row.engine) }))
			.filter((table) => table.name.length > 0);
		const maxResults = input.maxResults;
		const truncated = maxResults != null && tablesWithEngine.length > maxResults;
		const returnedTablesWithEngine = truncated ? tablesWithEngine.slice(0, maxResults) : tablesWithEngine;
		const returnedTables = returnedTablesWithEngine.map((table) => table.name);
		return {
			source: source.name,
			dialect: "clickhouse",
			database,
			tables: returnedTables,
			engine_groups: groupTableNamesByEngine(returnedTablesWithEngine),
			count: returnedTables.length,
			total_count: truncated ? undefined : tablesWithEngine.length,
			truncated,
			max_results: maxResults,
		};
	},

	async searchTables(source, input, signal): Promise<SearchTablesResult> {
		const keyword = asTrimmedString(input.keyword);
		const column = asTrimmedString(input.column);
		const comment = asTrimmedString(input.comment);
		const engine = asTrimmedString(input.engine);
		const where: string[] = ["1 = 1"];
		const tableColumns = await getSystemTableColumns(source, "tables", signal);
		const systemColumnsColumns = await getSystemTableColumns(source, "columns", signal);
		const hasTableComment = tableColumns.has("comment");
		const hasColumnComment = systemColumnsColumns.has("comment");
		const hasTableEngine = tableColumns.has("engine");
		const hasTotalRows = tableColumns.has("total_rows");

		if (input.database) {
			where.push(`t.database = ${escapeSqlString(input.database)}`);
		}
		appendClickHouseAccessPatternFilter(where, "t.database", source.access.databases);
		const tableAccess = buildClickHouseTableAccessPolicyCondition(source, "t.database", "t.name");
		if (tableAccess) {
			where.push(tableAccess.sql);
		}
		if (engine) {
			where.push(hasTableEngine ? clickHouseContainsExpression("t.engine", engine) : "0 = 1");
		}
		if (input.minRows != null) {
			where.push(hasTotalRows ? `coalesce(t.total_rows, 0) >= ${input.minRows}` : "0 = 1");
		}
		if (keyword) {
			const keywordConditions = [clickHouseContainsExpression("t.name", keyword)];
			if (hasTableComment) keywordConditions.push(clickHouseContainsExpression("t.comment", keyword));
			keywordConditions.push(`EXISTS (
				SELECT 1
				FROM system.columns AS c
				WHERE c.database = t.database
				  AND c.table = t.name
				  AND (${[
					clickHouseContainsExpression("c.name", keyword),
					hasColumnComment ? clickHouseContainsExpression("c.comment", keyword) : undefined,
				].filter(Boolean).join(" OR ")})
			)`);
			where.push(`(${keywordConditions.join(" OR ")})`);
		}
		if (column) {
			where.push(`EXISTS (
				SELECT 1
				FROM system.columns AS c
				WHERE c.database = t.database
				  AND c.table = t.name
				  AND ${clickHouseContainsExpression("c.name", column)}
			)`);
		}
		if (comment) {
			const commentConditions: string[] = [];
			if (hasTableComment) commentConditions.push(clickHouseContainsExpression("t.comment", comment));
			if (hasColumnComment) {
				commentConditions.push(`EXISTS (
					SELECT 1
					FROM system.columns AS c
					WHERE c.database = t.database
					  AND c.table = t.name
					  AND ${clickHouseContainsExpression("c.comment", comment)}
				)`);
			}
			where.push(commentConditions.length > 0 ? `(${commentConditions.join(" OR ")})` : "0 = 1");
		}

		const queryLimit = Math.min(500, Math.max(input.maxResults + 1, input.maxResults * 5, 20));
		const order = buildClickHouseSearchOrder({ keyword, column, comment, engine }, { tableComment: hasTableComment, engine: hasTableEngine });
		const tableSelectList = buildDynamicSelectList(
			[
				{ name: "database", required: true },
				{ name: "name", required: true },
				{ name: "engine" },
				{ name: "comment" },
				{ name: "total_rows" },
				{ name: "total_bytes" },
			],
			tableColumns,
			"t",
		);
		const tableRows = await executeSelectJson<Record<string, unknown>>(
			source,
			`SELECT
				${tableSelectList}
			 FROM system.tables AS t
			 WHERE ${where.join(" AND ")}
			 ORDER BY ${order}
			 LIMIT ${queryLimit}`,
			signal,
		);

		const pairs = tableRows
			.map((row) => ({
				database: String(row.database ?? ""),
				table: String(row.name ?? ""),
			}))
			.filter((item) => item.database && item.table);

		const columnsByTable = new Map<string, SearchTableColumnMatch[]>();
		if (pairs.length > 0) {
			const pairWhere = pairs
				.map((pair) => `(database = ${escapeSqlString(pair.database)} AND table = ${escapeSqlString(pair.table)})`)
				.join(" OR ");
			const columnSelectList = buildDynamicSelectList(
				[
					{ name: "database", required: true },
					{ name: "table", required: true },
					{ name: "name", required: true },
					{ name: "type" },
					{ name: "comment" },
				],
				systemColumnsColumns,
			);
			const columnOrderColumns = ["database", "table", systemColumnsColumns.has("position") ? "position" : "name"];
			const columnRows = await executeSelectJson<Record<string, unknown>>(
				source,
				`SELECT
					${columnSelectList}
				 FROM system.columns
				 WHERE ${pairWhere}
				 ORDER BY ${columnOrderColumns.join(", ")}`,
				signal,
			);
			for (const row of columnRows) {
				const database = String(row.database ?? "");
				const table = String(row.table ?? "");
				const name = String(row.name ?? "");
				if (!database || !table || !name) continue;
				const matchedOn: string[] = [];
				if (containsIgnoreCase(name, keyword)) pushMatch(matchedOn, "keyword:column_name");
				if (hasColumnComment && containsIgnoreCase(row.comment, keyword)) pushMatch(matchedOn, "keyword:column_comment");
				if (containsIgnoreCase(name, column)) pushMatch(matchedOn, "column_name");
				if (hasColumnComment && containsIgnoreCase(row.comment, comment)) pushMatch(matchedOn, "column_comment");
				if (matchedOn.length === 0) continue;
				const key = `${database}.${table}`;
				const columns = columnsByTable.get(key) ?? [];
				if (columns.length < 8) {
					columns.push({
						name,
						type: row.type == null ? undefined : String(row.type),
						comment: hasColumnComment ? row.comment == null ? null : String(row.comment) : undefined,
						matched_on: matchedOn,
					});
				}
				columnsByTable.set(key, columns);
			}
		}

		const matches: SearchTableMatch[] = tableRows.map((row) => {
			const database = String(row.database ?? "");
			const table = String(row.name ?? "");
			const matchedOn: string[] = [];
			if (containsIgnoreCase(table, keyword)) pushMatch(matchedOn, "keyword:table_name");
			if (hasTableComment && containsIgnoreCase(row.comment, keyword)) pushMatch(matchedOn, "keyword:table_comment");
			if (hasTableEngine && containsIgnoreCase(row.engine, engine)) pushMatch(matchedOn, "engine");
			if (input.minRows != null && hasTotalRows) pushMatch(matchedOn, "row_count");
			for (const columnMatch of columnsByTable.get(`${database}.${table}`) ?? []) {
				for (const item of columnMatch.matched_on) pushMatch(matchedOn, item.startsWith("keyword") ? item : `column:${item}`);
			}
			return {
				qualified_name: `${database}.${table}`,
				database,
				table,
				engine: asNullableString(row.engine),
				// table_type intentionally omitted: ClickHouse has no equivalent
				// of information_schema.tables.table_type (BASE TABLE / VIEW).
				// Consumers should infer view status from `engine` if needed.
				comment: hasTableComment ? row.comment == null ? null : String(row.comment) : undefined,
				total_rows: tableColumns.has("total_rows") ? asNullableNumber(row.total_rows) ?? null : undefined,
				total_bytes: tableColumns.has("total_bytes") ? asNullableNumber(row.total_bytes) ?? null : undefined,
				matched_on: matchedOn,
				matched_columns: columnsByTable.get(`${database}.${table}`) ?? [],
			};
		});
		matches.sort((left, right) => {
			const scoreDelta =
				scoreSearchTableMatch(left, { keyword, column, comment, engine }) -
				scoreSearchTableMatch(right, { keyword, column, comment, engine });
			if (scoreDelta !== 0) return scoreDelta;
			const databaseDelta = left.database.localeCompare(right.database);
			if (databaseDelta !== 0) return databaseDelta;
			return left.table.localeCompare(right.table);
		});
		const limitedMatches = matches.slice(0, input.maxResults);

		return {
			source: source.name,
			dialect: "clickhouse",
			filters: {
				database: input.database,
				keyword,
				column,
				comment,
				engine,
				min_rows: input.minRows,
				max_results: input.maxResults,
			},
			matches: limitedMatches,
			count: limitedMatches.length,
			truncated: tableRows.length > input.maxResults,
		};
	},

	async describeTable(source, input, signal): Promise<DescribeTableResult> {
		const database = await resolveDatabase(source, input.database);
		const tableColumns = await getSystemTableColumns(source, "tables", signal);
		const tableSelectList = buildDynamicSelectList(
			[
				{ name: "engine" },
				{ name: "create_table_query" },
			],
			tableColumns,
		);
		const tableQuery = `
			SELECT
				${tableSelectList || "name"}
			FROM system.tables
			WHERE database = ${escapeSqlString(database)}
			  AND name = ${escapeSqlString(input.table)}
			LIMIT 1
		`;
		const tableRows = await executeSelectJson<Record<string, unknown>>(source, tableQuery, signal);
		if (tableRows.length === 0) {
			throw new Error(`Table "${database}.${input.table}" was not found.`);
		}
		const tableRow = tableRows[0] ?? {};
		const systemColumnsColumns = await getSystemTableColumns(source, "columns", signal);
		const columnSelectList = buildDynamicSelectList(
			[
				{ name: "name", required: true },
				{ name: "type" },
				{ name: "default_kind" },
				{ name: "default_expression" },
				{ name: "comment" },
				{ name: "position" },
			],
			systemColumnsColumns,
		);
		const columnQuery = `
			SELECT
				${columnSelectList}
			FROM system.columns
			WHERE database = ${escapeSqlString(database)}
			  AND table = ${escapeSqlString(input.table)}
			ORDER BY ${systemColumnsColumns.has("position") ? "position" : "name"}
		`;
		const columnRows = await executeSelectJson<Record<string, unknown>>(source, columnQuery, signal);

		return {
			source: source.name,
			dialect: "clickhouse",
			database,
			table: input.table,
			engine: asNullableString(tableRow.engine),
			columns: columnRows.map((row) => ({
				name: String(row.name ?? ""),
				type: String(row.type ?? ""),
				default:
					row.default_expression == null
						? row.default_kind == null
							? null
							: String(row.default_kind)
						: String(row.default_expression),
				comment: row.comment == null ? null : String(row.comment),
				position: Number(row.position ?? 0),
			})),
			indexes: [],
			relations: [],
			create_statement: asNullableString(tableRow.create_table_query),
		};
	},

	async runQuery(source, input: VerifiedQuery, signal): Promise<QueryResult> {
		const { payload, durationMs } = await executeClickHouseJsonCompact(
			source,
			normalizeClickHouseOutputQuery(input.normalizedQuery),
			{
				max_result_rows: String(input.limits.fetchRows),
				result_overflow_mode: "break",
			},
			signal,
		);
		return shapeClickHouseExecResult(payload, input.limits, source, input.queryKind, durationMs, true);
	},

	async profileQuery(source, input: VerifiedQuery, signal): Promise<ProfileQueryResult> {
		const queryId = `pi-sqlkit-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
		const { payload, durationMs, queryId: executedQueryId } = await executeClickHouseJsonCompact(
			source,
			normalizeClickHouseOutputQuery(input.normalizedQuery),
			{
				max_result_rows: String(input.limits.fetchRows),
				result_overflow_mode: "break",
				log_queries: 1,
			},
			signal,
			queryId,
		);
		const shaped = shapeClickHouseExecResult(payload, input.limits, source, input.queryKind, durationMs, true);
		const runtimeProfile = await pollClickHouseRuntimeProfile(source, executedQueryId, signal);
		return {
			...shaped,
			query_id: executedQueryId,
			runtime_profile: runtimeProfile,
		};
	},

	async explainQuery(source, input: VerifiedExplainQuery, signal): Promise<ExplainQueryResult> {
		const mode = (input.explainMode ?? "plan").toLowerCase();
		const allowedModes = new Set(["plan", "ast", "syntax", "pipeline", "estimate"]);
		if (!allowedModes.has(mode)) {
			throw new Error(`ClickHouse explain mode "${input.explainMode}" is not supported. Use plan, ast, syntax, pipeline, or estimate.`);
		}
		const explainKeyword = mode === "plan" ? "PLAN" : mode.toUpperCase();
		const { payload, durationMs } = await executeClickHouseJsonCompact(
			source,
			`EXPLAIN ${explainKeyword} ${normalizeClickHouseOutputQuery(input.normalizedQuery)}`,
			{},
			signal,
		);
		const shaped = shapeClickHouseExecResult(payload, input.limits, source, input.queryKind, durationMs);
		return {
			...shaped,
			explain_mode: mode,
		};
	},

	async analyzeQuery(source, input: VerifiedExplainQuery): Promise<AnalyzeQueryResult> {
		throw new Error(`sql_mysql_analyze_query is not supported for ${source.dialect} on the tested server build. Use sql_explain_query or sql_clickhouse_profile_query instead.`);
	},

	async executeStatement(source, input: VerifiedWriteStatement, signal): Promise<WriteStatementResult> {
		const client = getClient(source);
		const start = Date.now();
		const response = await client.command({
			query: normalizeClickHouseQueryForClient(input.normalizedStatement),
			abort_signal: signal,
		});
		return {
			source: source.name,
			dialect: "clickhouse",
			statement_kind: input.statementKind,
			executed: true,
			cancelled: false,
			query_id: response.query_id,
			duration_ms: Date.now() - start,
			warnings: [],
		};
	},
};
