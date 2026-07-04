// Primary seam for sql_* tools.
// Add new tools here first: schema, execute binding, renderer binding, and contextShape.
// Avoid reintroducing hand-maintained tool-name lists elsewhere when this catalog can derive them.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
	executeAnalyzeQuery,
	executeDescribeTable,
	executeExplainQuery,
	executeListDatabases,
	executeListSources,
	executeListTables,
	executePing,
	executeProfileQuery,
	executeRunQuery,
	executeSearchTables,
	executeUpsertSource,
	executeValidateConfig,
	executeWrite,
} from "./execution.js";
import {
	analyzeQueryRender,
	describeTableRender,
	explainQueryRender,
	listDatabasesRender,
	listSourcesRender,
	listTablesRender,
	pingRender,
	profileQueryRender,
	runQueryRender,
	searchTablesRender,
	upsertSourceRender,
	validateConfigRender,
	writeRender,
	type RenderContext,
} from "./renderers.js";
import { getContextCwd } from "../utils.js";

export type SqlToolContextShape = "default" | "databases" | "tables" | "search" | "describe" | "tabular";

type ToolDefinition = Parameters<ExtensionAPI["registerTool"]>[0];
type ToolContextLike = {
	cwd?: string;
	ui?: {
		confirm?: (title: string, message: string) => Promise<boolean> | boolean;
	};
};
type ToolUpdate = (update: { content?: Array<{ type: "text"; text: string }> }) => void;

export type SqlToolCatalogEntry = {
	contextShape: SqlToolContextShape;
	definition: ToolDefinition;
};

const OptionalSource = Type.Optional(
	Type.String({ description: "Optional datasource name. May be omitted only when exactly one source is configured; otherwise call sql_list_sources and pass source explicitly." }),
);

const ExplainMode = Type.Optional(
	Type.Unsafe<string>({
		type: "string",
		enum: ["plan", "json", "ast", "syntax", "pipeline", "estimate"],
		description: 'Optional explain mode. MySQL: "plan" or "json". ClickHouse: "plan", "ast", "syntax", "pipeline", or "estimate".',
	}),
);

const AnalyzeMode = Type.Optional(
	Type.Unsafe<string>({
		type: "string",
		enum: ["analyze"],
		description: 'Optional runtime-analysis mode. Current MySQL support accepts only "analyze".',
	}),
);

export const sqlToolCatalog = [
	{
		contextShape: "default",
		definition: {
			name: "sql_upsert_source",
			label: "SQL Upsert Source",
			description: "Create or update one SQLKit datasource in sqlkit.json using SQLKit's canonical config schema.",
			promptSnippet: "Create or update a SQLKit datasource, then validate the SQLKit config",
			promptGuidelines: [
				"Use sql_upsert_source when the user asks to add, create, update, or configure a SQLKit MySQL or ClickHouse source.",
				"Prefer sql_upsert_source over direct file edits for sqlkit.json source changes; it writes the canonical dialect + options schema.",
				"Pass url or options plus policy fields explicitly.",
				"Set allow_apply=true only when the user explicitly asks to allow apply/change capability.",
				"If the user supplies a MySQL URL, pass it as url; SQLKit will parse host, port, user, password, and database into canonical options.",
				"If the user supplies a ClickHouse URL, pass it as url; SQLKit will store it as options.url.",
				"Use options.database only when the user explicitly specifies a connection database.",
				"After sql_upsert_source, call sql_validate_config without check_connections to run the default config, connectivity, and capability validation.",
				"Set check_connections=false only when the user explicitly wants a lightweight structural check without database connections.",
			],
			parameters: Type.Object({
				name: Type.Optional(Type.String({ description: "Stable datasource name. Defaults to the dialect name when omitted." })),
				dialect: Type.Unsafe<string>({
					type: "string",
					enum: ["mysql", "clickhouse"],
					description: 'Datasource dialect: "mysql" or "clickhouse".',
				}),
				url: Type.Optional(Type.String({ description: "Optional connection URL. MySQL URLs are parsed into options; ClickHouse URLs are stored as options.url." })),
				read_only: Type.Optional(Type.Boolean({ description: "Whether the datasource is marked read-only. Defaults to true unless allow_apply=true." })),
				allow_apply: Type.Optional(Type.Boolean({ description: "Whether sql_apply may run supported change statements after user confirmation. Default: false." })),
				options: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Optional canonical connection options such as host, port, user, password, database, url, request_timeout_ms, or pool_size." })),
				access: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Optional access policy object with databases and tables rules." })),
			}),
			async execute(_toolCallId: string, params: unknown, _signal?: AbortSignal, _onUpdate?: unknown, ctx?: ToolContextLike) {
				return executeUpsertSource(getContextCwd(ctx), params as Parameters<typeof executeUpsertSource>[1]);
			},
			renderCall(args, theme, context) {
				return upsertSourceRender.call(args, theme, context);
			},
			renderResult(result, options, theme, context) {
				return upsertSourceRender.result(result, options, theme, context);
			},
		},
	},
	{
		contextShape: "default",
		definition: {
			name: "sql_list_sources",
			label: "SQL List Sources",
			description: "List configured SQL datasources for the current project.",
			promptSnippet: "List configured SQL datasources and source names",
			promptGuidelines: [
				"Use sql_list_sources before other sql_* tools when the project may define multiple datasources.",
				"Use sql_list_sources for database-analysis tasks to identify the intended datasource first; do not assume MySQL vs ClickHouse from the user wording alone.",
				"When more than one source is returned, pass the intended source explicitly to follow-up sql_* tools.",
			],
			parameters: Type.Object({}),
			async execute(_toolCallId: string, _params: unknown, _signal?: AbortSignal, _onUpdate?: unknown, ctx?: ToolContextLike) {
				return executeListSources(getContextCwd(ctx));
			},
			renderCall(args, theme, context) {
				return listSourcesRender.call(args, theme, context);
			},
			renderResult(result, options, theme, context) {
				return listSourcesRender.result(result, options, theme, context);
			},
		},
	},
	{
		contextShape: "default",
		definition: {
			name: "sql_ping",
			label: "SQL Ping",
			description: "Verify connectivity for a configured SQL datasource.",
			promptSnippet: "Ping a configured SQL datasource and report basic connection info",
			promptGuidelines: ["Use sql_ping to verify the target datasource before diagnosing SQL connection issues."],
			parameters: Type.Object({
				source: OptionalSource,
			}),
			async execute(_toolCallId: string, params: unknown, signal?: AbortSignal, _onUpdate?: unknown, ctx?: ToolContextLike) {
				return executePing(getContextCwd(ctx), params as { source?: string }, signal);
			},
			renderCall(args, theme, context) {
				return pingRender.call(args, theme, context);
			},
			renderResult(result, options, theme, context) {
				return pingRender.result(result, options, theme, context);
			},
		},
	},
	{
		contextShape: "default",
		definition: {
			name: "sql_validate_config",
			label: "SQL Validate Config",
			description: "Validate sqlkit project configuration, checking datasource connectivity and basic permissions by default.",
			promptSnippet: "Validate SQLKit config after source edits, including connectivity by default",
			promptGuidelines: [
				"Use sql_validate_config after sql_upsert_source or focused sqlkit.json edits to verify structure, policy fields, connectivity, capability warnings, and fix suggestions.",
				"Use sql_validate_config when sql_* tools fail due to missing config, invalid datasource names, credentials, connection, or permission issues.",
				"By default, omit check_connections or leave it true so SQLKit pings each configured datasource and inspects basic privileges.",
				"Set check_connections=false only when the user explicitly wants a lightweight structural check without database connections.",
				"For a quick single-source online/offline probe, prefer sql_ping instead of a full config validation with connection checks.",
				"When validation returns issues with fix fields, use those fix suggestions as the preferred next edit for sqlkit.json.",
			],
			parameters: Type.Object({
				check_connections: Type.Optional(Type.Boolean({ description: "When true or omitted, ping each configured datasource and inspect basic privileges. Set false only for a lightweight structural check without database connections." })),
			}),
			async execute(_toolCallId: string, params: unknown, signal?: AbortSignal, _onUpdate?: unknown, ctx?: ToolContextLike) {
				return executeValidateConfig(getContextCwd(ctx), params as { check_connections?: boolean }, signal);
			},
			renderCall(args, theme, context) {
				return validateConfigRender.call(args, theme, context);
			},
			renderResult(result, options, theme, context) {
				return validateConfigRender.result(result, options, theme, context);
			},
		},
	},
	{
		contextShape: "databases",
		definition: {
			name: "sql_list_databases",
			label: "SQL List Databases",
			description: "List database/catalog namespaces available in a configured SQL datasource.",
			promptSnippet: "List database/catalog namespaces for a configured SQL datasource",
			promptGuidelines: [
				"Use sql_list_databases early when the datasource is unfamiliar and database/catalog names may help orient exploration.",
				"Use sql_list_databases with sql_search_tables for table discovery: call sql_search_tables with no filters for a broad sample, or pass database once a namespace looks relevant.",
			],
			parameters: Type.Object({
				source: OptionalSource,
			}),
			async execute(_toolCallId: string, params: unknown, signal?: AbortSignal, _onUpdate?: unknown, ctx?: ToolContextLike) {
				return executeListDatabases(getContextCwd(ctx), params as { source?: string }, signal);
			},
			renderCall(args, theme, context) {
				return listDatabasesRender.call(args, theme, context);
			},
			renderResult(result, options, theme, context) {
				return listDatabasesRender.result(result, options, theme, context);
			},
		},
	},
	{
		contextShape: "tables",
		definition: {
			name: "sql_list_tables",
			label: "SQL List Tables",
			description: "List tables in a known database for a configured SQL datasource.",
			promptSnippet: "List tables in a known database for a configured SQL datasource",
			promptGuidelines: [
				"Use sql_list_tables when the target database is known or after sql_list_databases identifies likely namespaces.",
				"If the database is unknown or the user gives business terms, column names, or vague table hints, use sql_search_tables; it can start without filters.",
			],
			parameters: Type.Object({
				source: OptionalSource,
				database: Type.Optional(Type.String({ description: "Optional database name. Uses the datasource default when omitted." })),
				like: Type.Optional(Type.String({ description: "Optional pattern filter for table names." })),
				max_results: Type.Optional(Type.Number({ description: "Maximum table names to return after access filtering. Default: 100, max: 1000.", minimum: 1, maximum: 1000 })),
			}),
			async execute(_toolCallId: string, params: unknown, signal?: AbortSignal, _onUpdate?: unknown, ctx?: ToolContextLike) {
				return executeListTables(
					getContextCwd(ctx),
					params as { source?: string; database?: string; like?: string; max_results?: number },
					signal,
				);
			},
			renderCall(args, theme, context) {
				return listTablesRender.call(args, theme, context);
			},
			renderResult(result, options, theme, context) {
				return listTablesRender.result(result, options, theme, context);
			},
		},
	},
	{
		contextShape: "search",
		definition: {
			name: "sql_search_tables",
			label: "SQL Search Tables",
			description: "Find candidate SQL tables by optional database, table keyword, column keyword, comments, engine, or row count.",
			promptSnippet: "Find candidate tables; use keyword/column filters when table names are unknown",
			promptGuidelines: [
				"Use sql_search_tables when the target table is unknown or the user gives business terms, field names, or partial table names.",
				"If the database is known, pass it to narrow the search; if not, consider sql_list_databases first for namespace orientation.",
				"Use sql_describe_table on promising matches before writing queries that depend on exact column names.",
			],
			parameters: Type.Object({
				source: OptionalSource,
				database: Type.Optional(Type.String({ description: "Optional database name. Omit to search across visible databases or to get a broad visible-table sample." })),
				keyword: Type.Optional(Type.String({ description: "Optional keyword matched against table names, table comments, column names, and column comments. Omit when exploring from scratch." })),
				column: Type.Optional(Type.String({ description: "Optional column-name keyword, such as user_id or start_time." })),
				comment: Type.Optional(Type.String({ description: "Optional comment keyword, useful for business terms in table or column comments." })),
				engine: Type.Optional(Type.String({ description: "Optional engine keyword, such as MergeTree, MaterializedView, Distributed, or InnoDB." })),
				min_rows: Type.Optional(Type.Number({ description: "Optional minimum estimated row count.", minimum: 0 })),
				max_results: Type.Optional(Type.Number({ description: "Maximum number of table matches to return. Default: 20.", minimum: 1, maximum: 100 })),
			}),
			async execute(_toolCallId: string, params: unknown, signal?: AbortSignal, _onUpdate?: unknown, ctx?: ToolContextLike) {
				return executeSearchTables(
					getContextCwd(ctx),
					params as {
						source?: string;
						database?: string;
						keyword?: string;
						column?: string;
						comment?: string;
						engine?: string;
						min_rows?: number;
						max_results?: number;
					},
					signal,
				);
			},
			renderCall(args, theme, context) {
				return searchTablesRender.call(args, theme, context);
			},
			renderResult(result, options, theme, context) {
				return searchTablesRender.result(result, options, theme, context);
			},
		},
	},
	{
		contextShape: "describe",
		definition: {
			name: "sql_describe_table",
			label: "SQL Describe Table",
			description: "Describe a table's basic schema for a configured SQL datasource.",
			promptSnippet: "Describe basic table schema: columns, types, defaults, comments, and supported indexes/relations",
			promptGuidelines: [
				"Use sql_describe_table before sql_run_query when exact column names, types, or table structure are not already known.",
				"Treat indexes and relations as dialect-supported metadata; they may be empty for some datasources.",
			],
			parameters: Type.Object({
				source: OptionalSource,
				database: Type.Optional(Type.String({ description: "Optional database name. Uses the datasource default when omitted." })),
				table: Type.String({ description: "Table name to inspect." }),
				include_relations: Type.Optional(Type.Boolean({ description: "Include relation metadata when supported by the dialect." })),
			}),
			async execute(_toolCallId: string, params: unknown, signal?: AbortSignal, _onUpdate?: unknown, ctx?: ToolContextLike) {
				return executeDescribeTable(
					getContextCwd(ctx),
					params as {
						source?: string;
						database?: string;
						table: string;
						include_relations?: boolean;
					},
					signal,
				);
			},
			renderCall(args, theme, context) {
				return describeTableRender.call(args, theme, context);
			},
			renderResult(result, options, theme, context) {
				return describeTableRender.result(result, options, theme, context);
			},
		},
	},
	{
		contextShape: "tabular",
		definition: {
			name: "sql_run_query",
			label: "SQL Run Query",
			description: "Run a guarded read-only SQL query against a configured datasource.",
			promptSnippet: "Run a guarded read-only SQL query against a configured datasource",
			promptGuidelines: [
				"SQLKit query tools are read-oriented; do not edit sqlkit.json merely to bypass sql_run_query write/DDL/admin blocks unless the user explicitly requests a SQLKit configuration change.",
				"Use sql_run_query only for read-oriented SQL such as SELECT, SHOW, DESCRIBE, DESC, EXPLAIN, or WITH SELECT queries.",
				"If sql_run_query reports SQLKIT QUERY BLOCKED - READ/SAFETY POLICY, stop: do not retry write/DDL/admin SQL and do not edit sqlkit.json merely to bypass policy unless the user explicitly asks to change configuration.",
				"Use sql_describe_table before sql_run_query if you are unsure about column names or table structure.",
				"Use small max_rows for exploratory analysis; result_profile describes returned sample rows only and can help refine follow-up queries.",
			],
			parameters: Type.Object({
				source: OptionalSource,
				query: Type.String({ description: "Single read-only SQL statement to execute." }),
				max_rows: Type.Optional(Type.Number({ description: "Maximum number of rows to return. Default: 50.", minimum: 1, maximum: 500 })),
			}),
			async execute(
				_toolCallId: string,
				params: unknown,
				signal?: AbortSignal,
				onUpdate?: ToolUpdate,
				ctx?: ToolContextLike,
			) {
				return executeRunQuery(
					getContextCwd(ctx),
					params as { source?: string; query: string; max_rows?: number },
					signal,
					onUpdate,
				);
			},
			renderCall(args, theme, context) {
				return runQueryRender.call(args, theme, context);
			},
			renderResult(result, options, theme, context) {
				return runQueryRender.result(result, options, theme, context as RenderContext);
			},
		},
	},
	{
		contextShape: "tabular",
		definition: {
			name: "sql_clickhouse_profile_query",
			label: "SQL ClickHouse Profile Query",
			description: "Run a guarded ClickHouse query and collect runtime profile details from system.query_log.",
			promptSnippet: "Run a guarded ClickHouse SELECT/WITH query and capture runtime profile details",
			promptGuidelines: [
				"Use sql_clickhouse_profile_query only for ClickHouse runtime-cost diagnosis; for MySQL, use sql_mysql_analyze_query or sql_run_query instead.",
				"If datasource dialect is uncertain, call sql_list_sources and use the returned dialect before choosing profile/analyze tools.",
				"Use sql_clickhouse_profile_query with a plain read-only SELECT or WITH SELECT query; do not prefix the query with EXPLAIN yourself.",
				"If sql_clickhouse_profile_query reports SQLKIT QUERY BLOCKED - READ/SAFETY POLICY, stop and explain the policy block instead of retrying writes or changing sqlkit.json merely to bypass policy.",
				"Prefer small max_rows for exploratory profiling because sampled rows and runtime profile are both returned.",
			],
			parameters: Type.Object({
				source: OptionalSource,
				query: Type.String({ description: "Plain read-only SELECT query to run and profile on ClickHouse." }),
				max_rows: Type.Optional(Type.Number({ description: "Maximum number of rows to return. Default: 50.", minimum: 1, maximum: 500 })),
			}),
			async execute(
				_toolCallId: string,
				params: unknown,
				signal?: AbortSignal,
				onUpdate?: ToolUpdate,
				ctx?: ToolContextLike,
			) {
				return executeProfileQuery(
					getContextCwd(ctx),
					params as { source?: string; query: string; max_rows?: number },
					signal,
					onUpdate,
				);
			},
			renderCall(args, theme, context) {
				return profileQueryRender.call(args, theme, context);
			},
			renderResult(result, options, theme, context) {
				return profileQueryRender.result(result, options, theme, context as RenderContext);
			},
		},
	},
	{
		contextShape: "tabular",
		definition: {
			name: "sql_explain_query",
			label: "SQL Explain Query",
			description: "Explain a read-only SELECT query with an adapter-specific execution plan mode.",
			promptSnippet: "Explain a read-only SQL query using a stable, dialect-aware explain mode",
			promptGuidelines: [
				"Use sql_explain_query for plan inspection instead of manually writing EXPLAIN syntax.",
				"Use sql_explain_query with a plain SELECT or WITH SELECT query; do not prefix the query with EXPLAIN yourself.",
				"If sql_explain_query reports SQLKIT QUERY BLOCKED - READ/SAFETY POLICY, stop and explain the policy block instead of retrying writes or changing sqlkit.json merely to bypass policy.",
				"Use sql_explain_query before running expensive joins or aggregations to inspect query shape and catch obvious full scans or fan-out.",
			],
			parameters: Type.Object({
				source: OptionalSource,
				query: Type.String({ description: "Plain read-only SELECT query to explain." }),
				mode: ExplainMode,
				max_rows: Type.Optional(Type.Number({ description: "Maximum number of rows to return. Default: 50.", minimum: 1, maximum: 500 })),
			}),
			async execute(
				_toolCallId: string,
				params: unknown,
				signal?: AbortSignal,
				onUpdate?: ToolUpdate,
				ctx?: ToolContextLike,
			) {
				return executeExplainQuery(
					getContextCwd(ctx),
					params as { source?: string; query: string; mode?: string; max_rows?: number },
					signal,
					onUpdate,
				);
			},
			renderCall(args, theme, context) {
				return explainQueryRender.call(args, theme, context);
			},
			renderResult(result, options, theme, context) {
				return explainQueryRender.result(result, options, theme, context as RenderContext);
			},
		},
	},
	{
		contextShape: "tabular",
		definition: {
			name: "sql_mysql_analyze_query",
			label: "SQL MySQL Analyze Query",
			description: "Run MySQL runtime execution analysis for a read-only SELECT query via EXPLAIN ANALYZE.",
			promptSnippet: "Run MySQL EXPLAIN ANALYZE for a plain read-only SELECT/WITH query",
			promptGuidelines: [
				"Use sql_mysql_analyze_query only for MySQL runtime execution evidence; for ClickHouse, use sql_clickhouse_profile_query or sql_explain_query instead.",
				"If datasource dialect is uncertain, call sql_list_sources and use the returned dialect before choosing profile/analyze tools.",
				"Use sql_mysql_analyze_query only for plain SELECT or WITH SELECT queries; do not prefix the query with EXPLAIN yourself.",
				"If sql_mysql_analyze_query reports SQLKIT QUERY BLOCKED - READ/SAFETY POLICY, stop and explain the policy block instead of retrying writes or changing sqlkit.json merely to bypass policy.",
				"Use sql_mysql_analyze_query when you need runtime execution evidence beyond static explain output.",
			],
			parameters: Type.Object({
				source: OptionalSource,
				query: Type.String({ description: "Plain read-only SELECT query to analyze on MySQL." }),
				mode: AnalyzeMode,
				max_rows: Type.Optional(Type.Number({ description: "Maximum number of rows to return. Default: 50.", minimum: 1, maximum: 500 })),
			}),
			async execute(
				_toolCallId: string,
				params: unknown,
				signal?: AbortSignal,
				onUpdate?: ToolUpdate,
				ctx?: ToolContextLike,
			) {
				return executeAnalyzeQuery(
					getContextCwd(ctx),
					params as { source?: string; query: string; mode?: string; max_rows?: number },
					signal,
					onUpdate,
				);
			},
			renderCall(args, theme, context) {
				return analyzeQueryRender.call(args, theme, context);
			},
			renderResult(result, options, theme, context) {
				return analyzeQueryRender.result(result, options, theme, context as RenderContext);
			},
		},
	},
	{
		contextShape: "default",
		definition: {
			name: "sql_apply",
			label: "SQL Apply",
			description: "Apply a guarded single SQL change statement after explicit user confirmation.",
			promptSnippet: "Apply an allowed SQL change statement only when the user requested it and confirmation is available",
			promptGuidelines: [
				"Use sql_apply only for user-requested allowed changes: INSERT, UPDATE, REPLACE, MERGE, CREATE DATABASE, CREATE TABLE, or additive ALTER TABLE ... ADD statements.",
				"Do not use sql_apply for SELECT/SHOW/DESCRIBE/EXPLAIN; use read-oriented sql_* tools instead.",
				"Do not use sql_apply for blocked destructive/admin operations such as DELETE, DROP, TRUNCATE, ALTER TABLE DROP/MODIFY/CHANGE/RENAME, GRANT, REVOKE, SET, SYSTEM, KILL, or account/file operations.",
				"Before calling sql_apply, call sql_list_sources first unless the current datasource policy is already known in this turn; inspect allow_apply.",
				"If allow_apply is disabled, do not call sql_apply just to discover the block; tell the user which config field must change and ask whether to update SQLKit configuration.",
				"sql_apply always asks the user to confirm before executing; do not add a confirm parameter or claim execution occurred before the tool result says executed=true.",
				"The target datasource must explicitly enable allow_apply for every allowed apply statement, including CREATE DATABASE and CREATE TABLE.",
				"If sql_apply returns requires_config_change, stop and tell the user which SQLKit config field must be enabled before retrying.",
			],
			parameters: Type.Object({
				source: OptionalSource,
				statement: Type.String({ description: "Single allowed SQL change statement to execute after user confirmation." }),
			}),
			async execute(
				_toolCallId: string,
				params: unknown,
				signal?: AbortSignal,
				onUpdate?: ToolUpdate,
				ctx?: ToolContextLike,
			) {
				return executeWrite(
					getContextCwd(ctx),
					params as { source?: string; statement: string },
					signal,
					onUpdate,
					ctx,
				);
			},
			renderCall(args, theme, context) {
				return writeRender.call(args, theme, context);
			},
			renderResult(result, options, theme, context) {
				return writeRender.result(result, options, theme, context as RenderContext);
			},
		},
	},
] satisfies SqlToolCatalogEntry[];

export const SQL_TOOL_NAMES = sqlToolCatalog.map((e) => e.definition.name);
export const SQL_CONFIG_TOOL_NAMES = ["sql_upsert_source", "sql_validate_config"];
export const SQL_RUNTIME_TOOL_NAMES = SQL_TOOL_NAMES.filter((name) => !SQL_CONFIG_TOOL_NAMES.includes(name));

export const SQL_TOOL_CONTEXT_SHAPE_BY_NAME: Record<string, SqlToolContextShape | undefined> =
	Object.fromEntries(sqlToolCatalog.map((e) => [e.definition.name, e.contextShape]));

export const SQL_TABULAR_TOOL_NAMES = SQL_TOOL_NAMES.filter(
	(name) => SQL_TOOL_CONTEXT_SHAPE_BY_NAME[name] === "tabular",
);
