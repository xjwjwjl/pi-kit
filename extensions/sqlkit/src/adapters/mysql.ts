import mysql from "mysql2/promise";
import type { FieldPacket, Pool, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { analyzeMysqlCapabilities } from "./capabilities.js";
import { shapeQueryRows } from "../core/limits.js";
import type {
	AnalyzeQueryResult,
	CapabilityCheckResult,
	ColumnInfo,
	DescribeTableResult,
	DialectAdapter,
	ExplainQueryResult,
	IndexInfo,
	ListTablesResult,
	PingResult,
	ProfileQueryResult,
	QueryResult,
	RelationInfo,
	ResolvedDataSource,
	SearchTableColumnMatch,
	SearchTableMatch,
	SearchTablesResult,
	VerifiedExplainQuery,
	VerifiedQuery,
	VerifiedWriteStatement,
	WriteStatementResult,
} from "../types.js";
import { normalizeIdentifier } from "../core/access.js";
import { normalizeAccessPatterns, tableAccessPatternsForDatabase } from "../core/access.js";
import { asTrimmedString, isRecord, readPasswordOption, truncateText } from "../utils.js";
import { containsIgnoreCase, getNumberOption, getStringOption, pushMatch } from "./utils.js";

function logCapabilityIssue(sourceName: string, query: string, err: unknown): void {
	if (process.env.SQLKIT_DEBUG) {
		process.stderr.write(`[sqlkit] capability check "${query}" on source "${sourceName}" failed: ${err instanceof Error ? err.message : String(err)}
`);
	}
}

function checkAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new Error("Operation aborted.");
}

const poolCache = new Map<string, Pool>();
const poolCacheKeyBySourceIdentity = new Map<string, string>();

function getSourceIdentity(source: ResolvedDataSource): string {
	return JSON.stringify({ configPath: source.configPath, name: source.name, dialect: source.dialect });
}

function closeStalePoolForSource(source: ResolvedDataSource): void {
	const identity = getSourceIdentity(source);
	const previousCacheKey = poolCacheKeyBySourceIdentity.get(identity);
	if (previousCacheKey && previousCacheKey !== source.cacheKey) {
		const stalePool = poolCache.get(previousCacheKey);
		poolCache.delete(previousCacheKey);
		void stalePool?.end().catch(() => undefined);
	}
	poolCacheKeyBySourceIdentity.set(identity, source.cacheKey);
}

function getRowValue(row: RowDataPacket, key: string): unknown {
	if (key in row) return row[key];
	const foundKey = Object.keys(row).find((candidate) => candidate.toLowerCase() === key.toLowerCase());
	return foundKey ? row[foundKey] : undefined;
}


function readGrantStrings(rows: RowDataPacket[]): string[] {
	const grants: string[] = [];
	for (const row of rows) {
		for (const value of Object.values(row)) {
			if (typeof value === "string" && value.trim()) {
				grants.push(value.trim());
			}
		}
	}
	return grants;
}

export function quoteMysqlIdentifier(identifier: string): string {
	return `\`${identifier.replace(/`/g, "``")}\``;
}

function quoteMysqlQualifiedIdentifier(database: string, table: string): string {
	return `${quoteMysqlIdentifier(database)}.${quoteMysqlIdentifier(table)}`;
}

function getPool(source: ResolvedDataSource): Pool {
	const cached = poolCache.get(source.cacheKey);
	if (cached) {
		poolCacheKeyBySourceIdentity.set(getSourceIdentity(source), source.cacheKey);
		return cached;
	}

	closeStalePoolForSource(source);
	const ssl = source.options.ssl;
	const pool = mysql.createPool({
		host: getStringOption(source, "host"),
		port: getNumberOption(source, "port", 3306),
		user: getStringOption(source, "user"),
		password: readPasswordOption(source.options),
		database: getStringOption(source, "database"),
		socketPath: getStringOption(source, "socketPath"),
		charset: getStringOption(source, "charset"),
		connectTimeout: getNumberOption(source, "connect_timeout_ms", 10_000),
		waitForConnections: true,
		connectionLimit: getNumberOption(source, "pool_size", 10),
		queueLimit: 0,
		multipleStatements: false,
		dateStrings: true,
		ssl: ssl === true || isRecord(ssl) ? (ssl as mysql.SslOptions) : undefined,
	});

	poolCache.set(source.cacheKey, pool);
	return pool;
}

async function detectFilePrivilege(source: ResolvedDataSource): Promise<string[]> {
	const warnings: string[] = [];
	try {
		const pool = getPool(source);
		const [rows] = await pool.query<RowDataPacket[]>("SHOW GRANTS FOR CURRENT_USER()");
		for (const grant of readGrantStrings(rows)) {
			if (/\bFILE\b/i.test(grant)) {
				warnings.push("Connected MySQL user appears to have FILE privilege. Use a more restricted account for production.");
				return warnings;
			}
		}
	} catch (err) {
		logCapabilityIssue(source.name, "SHOW GRANTS", err);
	}
	return warnings;
}

async function resolveDatabase(source: ResolvedDataSource, requestedDatabase?: string): Promise<string> {
	const explicit = asTrimmedString(requestedDatabase);
	if (explicit) return explicit;
	const pool = getPool(source);
	const [rows] = await pool.query<RowDataPacket[]>("SELECT DATABASE() AS current_database");
	const currentDatabase = rows[0]?.current_database;
	if (typeof currentDatabase === "string" && currentDatabase) return currentDatabase;
	throw new Error(`Datasource "${source.name}" does not define options.database. Pass database explicitly.`);
}

function mapColumns(rows: RowDataPacket[]): ColumnInfo[] {
	return rows.map((row) => ({
		name: String(getRowValue(row, "column_name") ?? ""),
		type: String(getRowValue(row, "column_type") ?? getRowValue(row, "data_type") ?? ""),
		nullable: String(getRowValue(row, "is_nullable") ?? "").toUpperCase() === "YES",
		default: getRowValue(row, "column_default") == null ? null : String(getRowValue(row, "column_default")),
		comment: getRowValue(row, "column_comment") == null ? null : String(getRowValue(row, "column_comment")),
		position: Number(getRowValue(row, "ordinal_position") ?? 0),
	}));
}

function mapIndexes(rows: RowDataPacket[]): IndexInfo[] {
	const grouped = new Map<string, IndexInfo>();
	for (const row of rows) {
		const name = String(getRowValue(row, "index_name") ?? "");
		if (!name) continue;
		const current = grouped.get(name) ?? {
			name,
			type: getRowValue(row, "index_type") == null ? undefined : String(getRowValue(row, "index_type")),
			columns: [],
			unique: Number(getRowValue(row, "non_unique") ?? 1) === 0,
		};
		current.columns.push(String(getRowValue(row, "column_name") ?? ""));
		grouped.set(name, current);
	}
	return Array.from(grouped.values());
}

function mapRelations(rows: RowDataPacket[]): RelationInfo[] {
	return rows.map((row) => ({
		name: getRowValue(row, "constraint_name") == null ? undefined : String(getRowValue(row, "constraint_name")),
		column: String(getRowValue(row, "column_name") ?? ""),
		referenced_database: getRowValue(row, "referenced_table_schema") == null ? undefined : String(getRowValue(row, "referenced_table_schema")),
		referenced_table: String(getRowValue(row, "referenced_table_name") ?? ""),
		referenced_column: String(getRowValue(row, "referenced_column_name") ?? ""),
	}));
}



function buildMysqlLike(value: string): string {
	return `%${value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_")}%`;
}

function buildMysqlSearchOrder(input: { keyword?: string; column?: string; comment?: string; engine?: string }): {
	sql: string;
	params: unknown[];
} {
	const order: string[] = [];
	const params: unknown[] = [];

	if (input.keyword) {
		const like = buildMysqlLike(input.keyword);
		order.push(`CASE
			WHEN LOWER(t.table_name) = LOWER(?) THEN 0
			WHEN t.table_name LIKE ? ESCAPE '\\\\' THEN 1
			WHEN t.table_comment LIKE ? ESCAPE '\\\\' THEN 3
			WHEN EXISTS (
				SELECT 1
				FROM information_schema.columns AS c
				WHERE c.table_schema = t.table_schema
				  AND c.table_name = t.table_name
				  AND c.column_name LIKE ? ESCAPE '\\\\'
			) THEN 4
			WHEN EXISTS (
				SELECT 1
				FROM information_schema.columns AS c
				WHERE c.table_schema = t.table_schema
				  AND c.table_name = t.table_name
				  AND c.column_comment LIKE ? ESCAPE '\\\\'
			) THEN 5
			ELSE 9
		END`);
		params.push(input.keyword, like, like, like, like);
	}
	if (input.column) {
		const like = buildMysqlLike(input.column);
		order.push(`CASE
			WHEN EXISTS (
				SELECT 1
				FROM information_schema.columns AS c
				WHERE c.table_schema = t.table_schema
				  AND c.table_name = t.table_name
				  AND LOWER(c.column_name) = LOWER(?)
			) THEN 0
			WHEN EXISTS (
				SELECT 1
				FROM information_schema.columns AS c
				WHERE c.table_schema = t.table_schema
				  AND c.table_name = t.table_name
				  AND c.column_name LIKE ? ESCAPE '\\\\'
			) THEN 1
			ELSE 9
		END`);
		params.push(input.column, like);
	}
	if (input.comment) {
		const like = buildMysqlLike(input.comment);
		order.push(`CASE
			WHEN t.table_comment LIKE ? ESCAPE '\\\\' THEN 0
			WHEN EXISTS (
				SELECT 1
				FROM information_schema.columns AS c
				WHERE c.table_schema = t.table_schema
				  AND c.table_name = t.table_name
				  AND c.column_comment LIKE ? ESCAPE '\\\\'
			) THEN 1
			ELSE 9
		END`);
		params.push(like, like);
	}
	if (input.engine) {
		order.push("CASE WHEN LOWER(t.engine) = LOWER(?) THEN 0 WHEN t.engine LIKE ? ESCAPE '\\\\' THEN 1 ELSE 9 END");
		params.push(input.engine, buildMysqlLike(input.engine));
	}

	return {
		sql: order.length > 0 ? `${order.join(", ")}, t.table_schema, t.table_name` : "t.table_schema, t.table_name",
		params,
	};
}

export async function closeMysqlPools(): Promise<void> {
	const pools = Array.from(poolCache.values());
	poolCache.clear();
	poolCacheKeyBySourceIdentity.clear();
	await Promise.all(pools.map((pool) => pool.end()));
}

function buildMysqlReadQuery(query: string, queryKind: string, fetchRows: number): string {
	if (queryKind === "select") {
		return `SELECT * FROM (${query}) AS pi_sql_mcp_limited LIMIT ${fetchRows}`;
	}
	return query;
}

function shapeMysqlTabularRows(
	rows: unknown,
	fields: FieldPacket[] | undefined,
	limits: { maxRows: number; fetchRows: number; maxResultBytes: number; maxCellChars: number },
	source: ResolvedDataSource,
	queryKind: string,
	durationMs: number,
	includeProfile = false,
): QueryResult {
	const columns = Array.isArray(fields) ? fields.map((field) => field.name) : [];
	const arrayRows = Array.isArray(rows) ? (rows as unknown[][]) : [];
	const shaped = shapeQueryRows({
		columns,
		rows: arrayRows,
		limits,
		includeProfile,
	});
	return {
		source: source.name,
		dialect: "mysql",
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

async function executeMysqlTabularQuery(
	source: ResolvedDataSource,
	sql: string,
	limits: VerifiedQuery["limits"] | VerifiedExplainQuery["limits"],
	queryKind: string,
	includeProfile = false,
): Promise<QueryResult> {
	const pool = getPool(source);
	const start = Date.now();
	const [rows, fields] = await pool.query({
		sql,
		rowsAsArray: true,
		timeout: getNumberOption(source, "query_timeout_ms", 30_000),
	});
	const durationMs = Date.now() - start;
	return shapeMysqlTabularRows(rows, Array.isArray(fields) ? (fields as FieldPacket[]) : undefined, limits, source, queryKind, durationMs, includeProfile);
}

export const mysqlAdapter: DialectAdapter = {
	dialect: "mysql",
	async ping(source, signal): Promise<PingResult> {
		const pool = getPool(source);
		const [rows] = await pool.query<RowDataPacket[]>({
			sql: "SELECT VERSION() AS server_version, DATABASE() AS current_database",
			timeout: getNumberOption(source, "query_timeout_ms", 30_000),
		});
		if (signal?.aborted) throw new Error("Operation aborted.");
		const warnings = await detectFilePrivilege(source);
		return {
			source: source.name,
			dialect: "mysql",
			ok: true,
			server_version: getRowValue(rows[0], "server_version") == null ? undefined : String(getRowValue(rows[0], "server_version")),
			current_database: getRowValue(rows[0], "current_database") == null ? undefined : String(getRowValue(rows[0], "current_database")),
			warnings,
		};
	},

	async listDatabases(source, signal): Promise<string[]> {
		const pool = getPool(source);
		const [rows] = await pool.query<RowDataPacket[]>("SHOW DATABASES");
		return rows
			.map((row) => row.Database)
			.filter((value): value is string => typeof value === "string" && value.length > 0);
	},

	async inspectCapabilities(source, signal): Promise<CapabilityCheckResult> {
		const pool = getPool(source);
		let currentUser: string | undefined;
		let grants: string[] = [];
		try {
			const [userRows] = await pool.query<RowDataPacket[]>("SELECT CURRENT_USER() AS current_user");
			const value = getRowValue(userRows[0], "current_user");
			if (typeof value === "string" && value) currentUser = value;
		} catch (err) {
			logCapabilityIssue(source.name, "SHOW GRANTS / CURRENT_USER", err);
		}
		try {
			const [grantRows] = await pool.query<RowDataPacket[]>("SHOW GRANTS FOR CURRENT_USER()");
			grants = readGrantStrings(grantRows);
		} catch (err) {
			logCapabilityIssue(source.name, "SHOW GRANTS", err);
			grants = [];
		}
		return analyzeMysqlCapabilities(source, {
			currentUser,
			grants,
		});
	},

	async listTables(source, input, signal): Promise<ListTablesResult> {
		const database = await resolveDatabase(source, input.database);
		const pool = getPool(source);
		const where = ["table_schema = ?"];
		const params: unknown[] = [database];
		if (input.like) {
			where.push("table_name LIKE ?");
			params.push(input.like);
		}
		const queryLimit = input.maxResults == null ? undefined : Math.max(1, input.maxResults) + 1;
		const [rows] = await pool.query<RowDataPacket[]>(
			`SELECT table_name AS table_name
			 FROM information_schema.tables
			 WHERE ${where.join(" AND ")}
			 ORDER BY table_name${queryLimit == null ? "" : "\n\t\t\t LIMIT ?"}`,
			queryLimit == null ? params : [...params, queryLimit],
		);
		const tables = rows
			.map((row) => getRowValue(row, "table_name"))
			.filter((value): value is string => typeof value === "string" && value.length > 0);
		const maxResults = input.maxResults;
		const truncated = maxResults != null && tables.length > maxResults;
		const returnedTables = truncated ? tables.slice(0, maxResults) : tables;
		return {
			source: source.name,
			dialect: "mysql",
			database,
			tables: returnedTables,
			count: returnedTables.length,
			total_count: truncated ? undefined : tables.length,
			truncated,
			max_results: maxResults,
		};
	},

	async searchTables(source, input, signal): Promise<SearchTablesResult> {
		const pool = getPool(source);
		const where: string[] = ["1 = 1"];
		const params: unknown[] = [];
		const keyword = asTrimmedString(input.keyword);
		const column = asTrimmedString(input.column);
		const comment = asTrimmedString(input.comment);
		const engine = asTrimmedString(input.engine);

		if (input.database) {
			where.push("t.table_schema = ?");
			params.push(input.database);
		}
		if (engine) {
			where.push("t.engine LIKE ? ESCAPE '\\\\'");
			params.push(buildMysqlLike(engine));
		}
		if (input.minRows != null) {
			where.push("COALESCE(t.table_rows, 0) >= ?");
			params.push(input.minRows);
		}
		if (keyword) {
			where.push(`(
				t.table_name LIKE ? ESCAPE '\\\\'
				OR t.table_comment LIKE ? ESCAPE '\\\\'
				OR EXISTS (
					SELECT 1
					FROM information_schema.columns AS c
					WHERE c.table_schema = t.table_schema
					  AND c.table_name = t.table_name
					  AND (
						c.column_name LIKE ? ESCAPE '\\\\'
						OR c.column_comment LIKE ? ESCAPE '\\\\'
					  )
				)
			)`);
			const like = buildMysqlLike(keyword);
			params.push(like, like, like, like);
		}
		if (column) {
			where.push(`EXISTS (
				SELECT 1
				FROM information_schema.columns AS c
				WHERE c.table_schema = t.table_schema
				  AND c.table_name = t.table_name
				  AND c.column_name LIKE ? ESCAPE '\\\\'
			)`);
			params.push(buildMysqlLike(column));
		}
		if (comment) {
			where.push(`(
				t.table_comment LIKE ? ESCAPE '\\\\'
				OR EXISTS (
					SELECT 1
					FROM information_schema.columns AS c
					WHERE c.table_schema = t.table_schema
					  AND c.table_name = t.table_name
					  AND c.column_comment LIKE ? ESCAPE '\\\\'
				)
			)`);
			const like = buildMysqlLike(comment);
			params.push(like, like);
		}

		const queryLimit = Math.max(1, input.maxResults) + 1;
		const order = buildMysqlSearchOrder({ keyword, column, comment, engine });
		const [tableRows] = await pool.query<RowDataPacket[]>(
			`SELECT
				t.table_schema AS database_name,
				t.table_name AS table_name,
				t.engine AS engine,
				t.table_type AS table_type,
				t.table_comment AS table_comment,
				t.table_rows AS total_rows,
				(COALESCE(t.data_length, 0) + COALESCE(t.index_length, 0)) AS total_bytes
			 FROM information_schema.tables AS t
			 WHERE ${where.join(" AND ")}
			 ORDER BY ${order.sql}
			 LIMIT ${queryLimit}`,
			[...params, ...order.params],
		);

		const limitedTableRows = tableRows.slice(0, input.maxResults);
		const pairs = limitedTableRows
			.map((row) => ({
				database: String(getRowValue(row, "database_name") ?? ""),
				table: String(getRowValue(row, "table_name") ?? ""),
			}))
			.filter((item) => item.database && item.table);

		const columnsByTable = new Map<string, SearchTableColumnMatch[]>();
		if (pairs.length > 0) {
			const pairWhere = pairs.map(() => "(table_schema = ? AND table_name = ?)").join(" OR ");
			const pairParams = pairs.flatMap((pair) => [pair.database, pair.table]);
			const [columnRows] = await pool.query<RowDataPacket[]>(
				`SELECT
					table_schema AS database_name,
					table_name AS table_name,
					column_name AS column_name,
					column_type AS column_type,
					column_comment AS column_comment
				 FROM information_schema.columns
				 WHERE ${pairWhere}
				 ORDER BY table_schema, table_name, ordinal_position`,
				pairParams,
			);
			for (const row of columnRows) {
				const database = String(getRowValue(row, "database_name") ?? "");
				const table = String(getRowValue(row, "table_name") ?? "");
				const name = String(getRowValue(row, "column_name") ?? "");
				if (!database || !table || !name) continue;
				const matchedOn: string[] = [];
				if (containsIgnoreCase(name, keyword)) pushMatch(matchedOn, "keyword:column_name");
				if (containsIgnoreCase(getRowValue(row, "column_comment"), keyword)) pushMatch(matchedOn, "keyword:column_comment");
				if (containsIgnoreCase(name, column)) pushMatch(matchedOn, "column_name");
				if (containsIgnoreCase(getRowValue(row, "column_comment"), comment)) pushMatch(matchedOn, "column_comment");
				if (matchedOn.length === 0) continue;
				const key = `${database}.${table}`;
				const columns = columnsByTable.get(key) ?? [];
				if (columns.length < 8) {
					columns.push({
						name,
						type: getRowValue(row, "column_type") == null ? undefined : String(getRowValue(row, "column_type")),
						comment: getRowValue(row, "column_comment") == null ? null : String(getRowValue(row, "column_comment")),
						matched_on: matchedOn,
					});
				}
				columnsByTable.set(key, columns);
			}
		}

		const matches: SearchTableMatch[] = limitedTableRows.map((row) => {
			const database = String(getRowValue(row, "database_name") ?? "");
			const table = String(getRowValue(row, "table_name") ?? "");
			const matchedOn: string[] = [];
			if (containsIgnoreCase(table, keyword)) pushMatch(matchedOn, "keyword:table_name");
			if (containsIgnoreCase(getRowValue(row, "table_comment"), keyword)) pushMatch(matchedOn, "keyword:table_comment");
			if (containsIgnoreCase(getRowValue(row, "engine"), engine)) pushMatch(matchedOn, "engine");
			if (input.minRows != null) pushMatch(matchedOn, "row_count");
			for (const columnMatch of columnsByTable.get(`${database}.${table}`) ?? []) {
				for (const item of columnMatch.matched_on) pushMatch(matchedOn, item.startsWith("keyword") ? item : `column:${item}`);
			}
			return {
				qualified_name: `${database}.${table}`,
				database,
				table,
				engine: getRowValue(row, "engine") == null ? undefined : String(getRowValue(row, "engine")),
				table_type: getRowValue(row, "table_type") == null ? undefined : String(getRowValue(row, "table_type")),
				comment: getRowValue(row, "table_comment") == null ? null : String(getRowValue(row, "table_comment")),
				total_rows: getRowValue(row, "total_rows") == null ? null : Number(getRowValue(row, "total_rows")),
				total_bytes: getRowValue(row, "total_bytes") == null ? null : Number(getRowValue(row, "total_bytes")),
				matched_on: matchedOn,
				matched_columns: columnsByTable.get(`${database}.${table}`) ?? [],
			};
		});

		return {
			source: source.name,
			dialect: "mysql",
			filters: {
				database: input.database,
				keyword,
				column,
				comment,
				engine,
				min_rows: input.minRows,
				max_results: input.maxResults,
			},
			matches,
			count: matches.length,
			truncated: tableRows.length > input.maxResults,
		};
	},

	async describeTable(source, input, signal): Promise<DescribeTableResult> {
		const database = await resolveDatabase(source, input.database);
		const pool = getPool(source);

		const [tableRows] = await pool.query<RowDataPacket[]>(
			`SELECT engine AS engine
			 FROM information_schema.tables
			 WHERE table_schema = ? AND table_name = ?`,
			[database, input.table],
		);
		if (tableRows.length === 0) {
			throw new Error(`Table "${database}.${input.table}" was not found.`);
		}

		const [columnRows] = await pool.query<RowDataPacket[]>(
			`SELECT
				column_name AS column_name,
				data_type AS data_type,
				column_type AS column_type,
				is_nullable AS is_nullable,
				column_default AS column_default,
				column_comment AS column_comment,
				ordinal_position AS ordinal_position
			 FROM information_schema.columns
			 WHERE table_schema = ? AND table_name = ?
			 ORDER BY ordinal_position`,
			[database, input.table],
		);

		const [indexRows] = await pool.query<RowDataPacket[]>(
			`SELECT
				index_name AS index_name,
				column_name AS column_name,
				non_unique AS non_unique,
				index_type AS index_type,
				seq_in_index AS seq_in_index
			 FROM information_schema.statistics
			 WHERE table_schema = ? AND table_name = ?
			 ORDER BY index_name, seq_in_index`,
			[database, input.table],
		);

		let relations: RelationInfo[] = [];
		if (input.includeRelations) {
			const [relationRows] = await pool.query<RowDataPacket[]>(
				`SELECT
					kcu.constraint_name AS constraint_name,
					kcu.column_name AS column_name,
					kcu.referenced_table_schema AS referenced_table_schema,
					kcu.referenced_table_name AS referenced_table_name,
					kcu.referenced_column_name AS referenced_column_name
				 FROM information_schema.key_column_usage AS kcu
				 INNER JOIN information_schema.table_constraints AS tc
				   ON tc.constraint_name = kcu.constraint_name
				  AND tc.table_schema = kcu.table_schema
				  AND tc.table_name = kcu.table_name
				 WHERE kcu.table_schema = ?
				   AND kcu.table_name = ?
				   AND tc.constraint_type = 'FOREIGN KEY'
				 ORDER BY kcu.ordinal_position`,
				[database, input.table],
			);
			relations = mapRelations(relationRows);
		}

		const [createRows] = await pool.query<RowDataPacket[]>(
			`SHOW CREATE TABLE ${quoteMysqlQualifiedIdentifier(database, input.table)}`,
		);
		const firstCreateRow = createRows[0];
		let createStatement: string | undefined;
		if (firstCreateRow) {
			for (const [key, value] of Object.entries(firstCreateRow)) {
				if (typeof value === "string" && /create table/i.test(key)) {
					createStatement = value;
					break;
				}
			}
		}

		return {
			source: source.name,
			dialect: "mysql",
			database,
			table: input.table,
			engine: getRowValue(tableRows[0], "engine") == null ? undefined : String(getRowValue(tableRows[0], "engine")),
			columns: mapColumns(columnRows),
			indexes: mapIndexes(indexRows),
			relations,
			create_statement: createStatement,
		};
	},

	async runQuery(source, input: VerifiedQuery, signal): Promise<QueryResult> {
		return executeMysqlTabularQuery(
			source,
			buildMysqlReadQuery(input.normalizedQuery, input.queryKind, input.limits.fetchRows),
			input.limits,
			input.queryKind,
			true,
		);
	},

	async profileQuery(source, input: VerifiedQuery, signal): Promise<ProfileQueryResult> {
		throw new Error(`sql_profile_query is not supported for ${source.dialect}. Use sql_run_query or sql_analyze_query instead.`);
	},

	async explainQuery(source, input: VerifiedExplainQuery, signal): Promise<ExplainQueryResult> {
		const mode = (input.explainMode ?? "plan").toLowerCase();
		let explainSql: string;
		if (mode === "plan") {
			explainSql = `EXPLAIN ${input.normalizedQuery}`;
		} else if (mode === "json") {
			explainSql = `EXPLAIN FORMAT=JSON ${input.normalizedQuery}`;
		} else {
			throw new Error(`MySQL explain mode "${input.explainMode}" is not supported. Use "plan" or "json".`);
		}
		const shaped = await executeMysqlTabularQuery(source, explainSql, input.limits, input.queryKind);
		return {
			...shaped,
			explain_mode: mode,
		};
	},

	async analyzeQuery(source, input: VerifiedExplainQuery, signal): Promise<AnalyzeQueryResult> {
		const shaped = await executeMysqlTabularQuery(source, `EXPLAIN ANALYZE ${input.normalizedQuery}`, input.limits, input.queryKind);
		return {
			source: shaped.source,
			dialect: shaped.dialect,
			query_kind: shaped.query_kind,
			analyze_mode: (input.explainMode ?? "analyze").toLowerCase(),
			columns: shaped.columns,
			rows: shaped.rows,
			row_count: shaped.row_count,
			truncated: shaped.truncated,
			duration_ms: shaped.duration_ms,
			warnings: shaped.warnings,
		};
	},

		async executeStatement(source, input: VerifiedWriteStatement, signal): Promise<WriteStatementResult> {
			if (signal?.aborted) throw new Error("Operation aborted.");
			const pool = getPool(source);
			const [result] = await pool.query({ sql: input.normalizedStatement });
			const header = result as ResultSetHeader;
			return {
				source: source.name,
				dialect: source.dialect,
				statement_kind: input.statementKind,
				executed: true,
				cancelled: false,
				affected_rows: header.affectedRows,
				changed_rows: header.changedRows,
				warning_count: header.warningStatus,
				duration_ms: 0,
				warnings: [],
			};
		},
};
