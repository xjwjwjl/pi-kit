import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyzeClickHouseCapabilities, analyzeMysqlCapabilities, extractMysqlPrivilegesFromGrantStrings } from "../src/adapters/capabilities.js";
import { assertQueryAccess, tableAccessPatternsForDatabase } from "../src/core/access.js";
import { buildClickHouseUrl, stripTrailingClickHouseFormatClause } from "../src/adapters/clickhouse.js";
import { quoteMysqlIdentifier } from "../src/adapters/mysql.js";
import { clearProjectConfigCache, loadProjectConfig } from "../src/config/loader.js";
import { formResultToSource } from "../src/config/tui.js";
import { setProjectAgentToolsEnabled } from "../src/config/store.js";
import { alterTableActions, alterTableTailStart, guardExplainableQuery, guardReadOnlyQuery, guardWriteStatement } from "../src/core/guards.js";
import { tokenizeSql } from "../src/sql/lexer.js";
import { verifyAnalyzeQuery, verifyExplainQuery, verifyProfileQuery, verifyRunQuery, verifyWriteStatement } from "../src/core/verification.js";
import { shapeQueryRows } from "../src/core/limits.js";
import { formatTables, formatValidateConfig } from "../src/core/formatters.js";
import { reshapeToolResultsForLlm } from "../src/extension/context.js";
import {
	executeAnalyzeQuery,
	executeDescribeTable,
	executeListSources,
	executeListTables,
	executeProfileQuery,
	executeRunQuery,
	executeSearchTables,
	executeUpsertSource,
	executeValidateConfig,
	executeWrite,
} from "../src/core/execution.js";
import type { QueryExecutionLimits } from "../src/types.js";

function assertThrowsMessage(name: string, fn: () => void, expected: RegExp): void {
	try {
		fn();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		assert.match(message, expected, name);
		return;
	}
	throw new Error(`${name}: expected function to throw.`);
}

async function testGuards(): Promise<void> {
	assert.equal(guardReadOnlyQuery("SELECT 1", "mysql").queryKind, "select");
	assert.equal(guardReadOnlyQuery("/* hi */ WITH x AS (SELECT 1) SELECT * FROM x", "clickhouse").queryKind, "select");
	assert.equal(guardReadOnlyQuery("# hi\nSELECT 1", "mysql").queryKind, "select");
	assert.equal(guardReadOnlyQuery("SHOW TABLES", "mysql").queryKind, "show");
	assert.equal(guardReadOnlyQuery("SHOW CREATE TABLE events", "clickhouse").queryKind, "show");
	assert.equal(guardExplainableQuery("SELECT 1", "mysql").queryKind, "select");
	assert.equal(guardWriteStatement("UPDATE app.users SET name = 'a' WHERE id = 1", "mysql").queryKind, "update");
	assert.equal(guardWriteStatement("CREATE DATABASE test_db", "clickhouse").queryKind, "create");
	assert.equal(guardWriteStatement("CREATE DATABASE IF NOT EXISTS test_db", "clickhouse").queryKind, "create");
	assert.equal(guardWriteStatement("CREATE SCHEMA test_schema", "mysql").queryKind, "create");
	assert.equal(guardWriteStatement("CREATE TABLE app.users_archive (id UInt64)", "clickhouse").queryKind, "create");
	assert.equal(guardWriteStatement("CREATE TABLE `app`.`users_archive` (id int)", "mysql").queryKind, "create");
	assert.equal(guardWriteStatement("ALTER TABLE app.users_archive ADD COLUMN name String", "clickhouse").queryKind, "alter");
	assert.equal(guardWriteStatement("ALTER TABLE app.users_archive ADD COLUMN slug String DEFAULT replace(name, ' ', '-')", "clickhouse").queryKind, "alter");
	assert.deepEqual(alterTableActions(tokenizeSql("ALTER TABLE app.users_archive ADD COLUMN c String, ADD COLUMN d String")), ["add", "add"]);
	assert.deepEqual(alterTableActions(tokenizeSql("ALTER TABLE app.users_archive ADD COLUMN c String, DROP COLUMN d")), ["add", "drop"]);
	assert.equal(alterTableTailStart(tokenizeSql("ALTER TABLE app.users_archive ADD COLUMN c String")) != null, true);

	assertThrowsMessage("multi statement", () => guardReadOnlyQuery("SELECT 1; SELECT 2", "mysql"), /single SQL statement/);
	assertThrowsMessage("write multi statement", () => guardWriteStatement("UPDATE a SET b = 1; DELETE FROM a", "mysql"), /single SQL statement/);
	assertThrowsMessage("comment quote multi statement", () => guardWriteStatement("UPDATE a SET b = 1 -- '\n; DELETE FROM a", "mysql"), /single SQL statement/);
	assertThrowsMessage("block comment quote multi statement", () => guardWriteStatement("UPDATE a SET b = 1 /* ' */ ; DELETE FROM a", "mysql"), /single SQL statement/);
	assertThrowsMessage("double backslash multi statement", () => guardWriteStatement(String.raw`UPDATE a SET b='\\'; DELETE FROM a`, "mysql"), /single SQL statement/);
	assertThrowsMessage("write select", () => guardWriteStatement("SELECT 1", "mysql"), /allowed apply statements only/i);
	assertThrowsMessage("with delete", () => guardWriteStatement("WITH c AS (SELECT 1) DELETE FROM app.users_archive", "mysql"), /DELETE is blocked/i);
	assertThrowsMessage("write delete", () => guardWriteStatement("DELETE FROM app.users_archive WHERE id = 1", "clickhouse"), /DELETE is blocked/i);
	assertThrowsMessage("write drop", () => guardWriteStatement("DROP TABLE app.users_archive", "clickhouse"), /DROP is blocked/i);
	assertThrowsMessage("write truncate", () => guardWriteStatement("TRUNCATE TABLE app.users_archive", "clickhouse"), /TRUNCATE is blocked/i);
	assertThrowsMessage("write alter drop", () => guardWriteStatement("ALTER TABLE app.users_archive DROP COLUMN name", "clickhouse"), /destructive|blocked/i);
	assertThrowsMessage("write alter replace", () => guardWriteStatement("ALTER TABLE app.users_archive REPLACE PARTITION tuple()", "clickhouse"), /destructive|blocked/i);
	assertThrowsMessage("write alter add then drop", () => guardWriteStatement("ALTER TABLE app.users_archive ADD COLUMN c String, DROP COLUMN d", "clickhouse"), /destructive|blocked/i);
	assertThrowsMessage("write alter add then modify", () => guardWriteStatement("ALTER TABLE app.users_archive ADD COLUMN c String, MODIFY COLUMN d String", "clickhouse"), /destructive|blocked/i);
	assertThrowsMessage("write create view", () => guardWriteStatement("CREATE VIEW app.v AS SELECT 1", "mysql"), /CREATE is allowed only/i);
	assertThrowsMessage("write grant", () => guardWriteStatement("GRANT SELECT ON *.* TO u", "mysql"), /administration|account/i);
	assertThrowsMessage("write create user", () => guardWriteStatement("CREATE USER u IDENTIFIED BY 'x'", "mysql"), /administration|account/i);
	assertThrowsMessage("write load data", () => guardWriteStatement("LOAD DATA LOCAL INFILE '/tmp/a' INTO TABLE users", "mysql"), /administration|file/i);
	assertThrowsMessage("write mysql lock", () => guardWriteStatement("INSERT INTO app.users SELECT * FROM app.users FOR UPDATE", "mysql"), /forbidden|lock/i);
	assertThrowsMessage("cte insert", () => guardReadOnlyQuery("WITH x AS (INSERT INTO t VALUES (1)) SELECT 1", "mysql"), /write|DDL|administration/i);
	assertThrowsMessage("mysql outfile", () => guardReadOnlyQuery("SELECT 1 INTO OUTFILE '/tmp/a'", "mysql"), /forbidden/i);
	assertThrowsMessage("mysql lock", () => guardReadOnlyQuery("SELECT * FROM users FOR UPDATE", "mysql"), /write|DDL|administration/i);
	assertThrowsMessage("clickhouse system", () => guardReadOnlyQuery("SYSTEM FLUSH LOGS", "clickhouse"), /SELECT|SHOW|DESCRIBE|EXPLAIN/i);
	assertThrowsMessage("clickhouse optimize", () => guardReadOnlyQuery("OPTIMIZE TABLE events", "clickhouse"), /SELECT|SHOW|DESCRIBE|EXPLAIN/i);

	// S1: MySQL conditional comments /*! ... */ must not mask forbidden keywords.
	assertThrowsMessage("mysql cond comment outfile", () => guardReadOnlyQuery("SELECT 1 /*! INTO OUTFILE '/tmp/leak' */", "mysql"), /forbidden/i);
	assertThrowsMessage("mysql cond comment load_file", () => guardReadOnlyQuery("SELECT /*! LOAD_FILE('/etc/passwd') */ AS data", "mysql"), /forbidden/i);
	assertThrowsMessage("mysql cond comment lock", () => guardReadOnlyQuery("SELECT * FROM users /*! FOR UPDATE */", "mysql"), /forbidden|lock|write|DDL|administration/i);
	assertThrowsMessage("mysql cond comment versioned", () => guardReadOnlyQuery("/*!50100 SELECT 1 INTO OUTFILE '/tmp/x' */", "mysql"), /forbidden/i);
	// Conditional comment hiding a write inside a read-only query.
	assertThrowsMessage("mysql cond comment hidden write", () => guardReadOnlyQuery("SELECT 1 /*! ; DROP TABLE users */", "mysql"), /single SQL statement|forbidden|DROP/i);
	// Plain /* */ comments must still be masked (control case).
	assert.equal(guardReadOnlyQuery("/* INTO OUTFILE */ SELECT 1", "mysql").queryKind, "select");
	const blockedQueryDir = path.join(os.tmpdir(), `sqlkit-blocked-query-${Date.now()}`);
	mkdirSync(blockedQueryDir, { recursive: true });
	try {
		writeFileSync(
			path.join(blockedQueryDir, "sqlkit.json"),
			JSON.stringify(
				{
					sources: [
						{
							name: "unit",
							dialect: "clickhouse",
							read_only: true,
							options: { url: "http://127.0.0.1:8123", user: "default" },
						},
					],
				},
				null,
				2,
			),
		);
		const blocked = await executeRunQuery(blockedQueryDir, { query: "CREATE TABLE blocked (id UInt64)" });
		const message = blocked.content[0]?.text ?? "";
		assert.match(message, /SQLKIT QUERY BLOCKED - READ\/SAFETY POLICY/);
		assert.match(message, /Do not retry this write\/DDL\/admin operation/);
		assert.match(message, /Do not edit .*sqlkit\.json/);
	} finally {
		rmSync(blockedQueryDir, { recursive: true, force: true });
	}
	assertThrowsMessage("guard explain input explain", () => guardExplainableQuery("EXPLAIN SELECT 1", "mysql"), /require a SELECT or WITH SELECT query/i);
	assertThrowsMessage("guard explain input show", () => guardExplainableQuery("SHOW TABLES", "mysql"), /require a SELECT or WITH SELECT query/i);
}

function testMysqlIdentifierQuoting(): void {
	assert.equal(quoteMysqlIdentifier("plain"), "`plain`");
	assert.equal(quoteMysqlIdentifier("we`ird"), "`we``ird`");
	assert.equal(quoteMysqlIdentifier("db`; DROP TABLE x; --"), "`db``; DROP TABLE x; --`");
}

function testClickHouseConnectionOptions(): void {
	const baseSource = {
		name: "clickhouse_unit",
		dialect: "clickhouse",
		readOnly: true,
		allowApply: false,
		access: { databases: { allow: [], deny: [] }, tables: [] },
		configPath: "unit",
		cacheKey: "unit",
	};
	assert.equal(buildClickHouseUrl({ ...baseSource, options: { url: "https://clickhouse.example/proxy", host: "ignored", port: 8123 } } as any), "https://clickhouse.example/proxy");
	assert.equal(buildClickHouseUrl({ ...baseSource, options: { host: "clickhouse.example", secure: true } } as any), "https://clickhouse.example:8443");
	assert.equal(buildClickHouseUrl({ ...baseSource, options: { host: "clickhouse.example", secure: false, port: 8124 } } as any), "http://clickhouse.example:8124");
	assert.equal(buildClickHouseUrl({ ...baseSource, options: { host: "clickhouse.example", protocol: "https", port: 9440 } } as any), "https://clickhouse.example:9440");
}

function testConfigUiPlaceholderDefaults(): void {
	const source = formResultToSource(
		[
			{ key: "host", label: "Host", value: "", placeholder: "192.168.7.210", required: true },
			{ key: "port", label: "Port", value: "", placeholder: "8123", required: true },
			{ key: "user", label: "User", value: "", placeholder: "default", required: true },
			{ key: "password", label: "Password", value: "Ck@2o20...", required: false },
			{ key: "name", label: "Name", value: "", required: false },
			{ key: "database", label: "Database", value: "", required: false },
		],
		"clickhouse",
	) as any;
	assert.equal(source.name, "192.168.7.210:8123");
	assert.deepEqual(source.options, {
		host: "192.168.7.210",
		port: 8123,
		user: "default",
		password: "Ck@2o20...",
	});
}

function testClickHouseFormatCompatibility(): void {
	assert.equal(stripTrailingClickHouseFormatClause("SELECT 1 FORMAT JSONEachRow"), "SELECT 1");
	assert.equal(stripTrailingClickHouseFormatClause("SELECT 1 FORMAT JSONEachRow SETTINGS max_threads = 1"), "SELECT 1 SETTINGS max_threads = 1");
	assert.equal(stripTrailingClickHouseFormatClause("SELECT format('x') AS value FORMAT JSONCompact"), "SELECT format('x') AS value");
}

function testFormatTables(): void {
	const text = formatTables({
		source: "unit",
		dialect: "mysql",
		database: "app",
		tables: ["a", "b"],
		count: 2,
		total_count: 5,
		truncated: true,
		max_results: 2,
	});
	assert.match(text, /Tables: 2 of 5 \(truncated, max_results=2\)/);

	const groupedText = formatTables({
		source: "unit",
		dialect: "clickhouse",
		database: "default",
		tables: ["events", "events_mv", "users_dist"],
		engine_groups: [
			{ engine: "MergeTree", label: "MergeTree Tables", count: 1, tables: ["events"] },
			{ engine: "MaterializedView", label: "Materialized Views", count: 1, tables: ["events_mv"] },
			{ engine: "Distributed", label: "Distributed Tables", count: 1, tables: ["users_dist"] },
		],
		count: 3,
		truncated: false,
	});
	assert.match(groupedText, /Tables grouped by engine:/);
	assert.match(groupedText, /MergeTree Tables \(1\)/);
	assert.match(groupedText, /  - events/);
	assert.match(groupedText, /Materialized Views \(1\)/);
}

async function testLimits(): Promise<void> {
	const limits: QueryExecutionLimits = {
		maxRows: 2,
		fetchRows: 3,
		maxResultBytes: 10_000,
		maxCellChars: 5,
	};
	const shaped = shapeQueryRows({
		rows: [
			["short"],
			["very long value"],
			["third"],
		],
		limits,
	});
	assert.equal(shaped.rowCount, 2);
	assert.equal(shaped.truncated, true);
	assert.deepEqual(shaped.rows, [["short"], ["very ..."]]);
	assert.equal(shaped.warnings.some((warning) => warning.includes("2 rows")), true);
	assert.equal(shaped.warnings.some((warning) => warning.includes("5 characters")), true);

	const byteLimited = shapeQueryRows({
		rows: [["aaaa"], ["bbbb"], ["cccc"]],
		limits: {
			maxRows: 3,
			fetchRows: 4,
			maxResultBytes: 12,
			maxCellChars: 100,
		},
	});
	assert.equal(byteLimited.truncated, true);
	assert.equal(byteLimited.rows.length < 3, true);
	assert.equal(byteLimited.warnings.some((warning) => warning.includes("Result JSON exceeded")), true);

	const profiled = shapeQueryRows({
		columns: ["id", "name", "score", "flag", "maybe"],
		rows: [
			[1, "alice", 1.5, true, null],
			[2, "bob", 2.5, false, "x"],
			[3, "alice", null, true, "y"],
		],
		limits: {
			maxRows: 3,
			fetchRows: 4,
			maxResultBytes: 10_000,
			maxCellChars: 100,
		},
		includeProfile: true,
	});
	assert.equal(profiled.resultProfile?.profile_scope, "sampled_result_rows");
	assert.equal(profiled.resultProfile?.sampled_rows, 3);
	const idProfile = profiled.resultProfile?.columns.find((column) => column.name === "id");
	assert.equal(idProfile?.inferred_type, "integer");
	assert.equal(idProfile?.number?.min, 1);
	assert.equal(idProfile?.number?.max, 3);
	const nameProfile = profiled.resultProfile?.columns.find((column) => column.name === "name");
	assert.equal(nameProfile?.inferred_type, "string");
	assert.equal(nameProfile?.top_values[0]?.value, "alice");
	assert.equal(nameProfile?.top_values[0]?.count, 2);
	const scoreProfile = profiled.resultProfile?.columns.find((column) => column.name === "score");
	assert.equal(scoreProfile?.inferred_type, "float");
	assert.equal(scoreProfile?.null_count, 1);
	assert.equal(scoreProfile?.null_ratio, 0.333);
	assert.equal(scoreProfile?.number?.avg, 2);
	const flagProfile = profiled.resultProfile?.columns.find((column) => column.name === "flag");
	assert.equal(flagProfile?.inferred_type, "boolean");
}

function testLlmContextShaping(): void {
	type ToolResultMessage = {
		role: "toolResult";
		toolName: string;
		details: Record<string, unknown>;
		content?: Array<{ type: "text"; text: string }>;
	};

	const smallMessage = reshapeToolResultsForLlm<ToolResultMessage>([
		{
			role: "toolResult",
			toolName: "sql_run_query",
			details: {
				source: "unit",
				dialect: "mysql",
				query_kind: "select",
				columns: ["id"],
				rows: [[1]],
				row_count: 1,
				truncated: false,
				duration_ms: 1,
				warnings: [],
			},
		},
	])[0];
	const smallText = smallMessage?.content?.[0]?.text ?? "";
	assert.equal(smallText.includes("\n"), false, "LLM tool content should use compact JSON");
	assert.deepEqual(JSON.parse(smallText).rows, [[1]]);

	const largeRows = Array.from({ length: 25 }, (_, index) => [index, "x".repeat(4_000)]);
	const largeMessage = reshapeToolResultsForLlm<ToolResultMessage>([
		{
			role: "toolResult",
			toolName: "sql_run_query",
			details: {
				source: "unit",
				dialect: "mysql",
				query_kind: "select",
				columns: ["id", "payload"],
				rows: largeRows,
				row_count: largeRows.length,
				truncated: false,
				duration_ms: 1,
				warnings: [],
			},
		},
	])[0];
	const largeDetails = JSON.parse(largeMessage?.content?.[0]?.text ?? "{}");
	assert.equal(largeDetails.rows.length, 20);
	assert.equal(largeDetails.llm_context.rows_sampled_for_context, true);
	assert.equal(largeDetails.llm_context.rows_omitted_from_context, 5);

	const describeMessage = reshapeToolResultsForLlm<ToolResultMessage>([
		{
			role: "toolResult",
			toolName: "sql_describe_table",
			details: {
				source: "unit",
				dialect: "clickhouse",
				database: "db",
				table: "wide_table",
				columns: Array.from({ length: 100 }, (_, index) => ({ name: `c${index}`, type: "String" })),
				indexes: Array.from({ length: 45 }, (_, index) => ({ name: `i${index}`, columns: [`c${index}`] })),
				relations: Array.from({ length: 42 }, (_, index) => ({ column: `c${index}`, referenced_table: "r", referenced_column: "id" })),
				create_statement: "CREATE TABLE x (" + "c String, ".repeat(2_000) + ")",
			},
		},
	])[0];
	const describeDetails = JSON.parse(describeMessage?.content?.[0]?.text ?? "{}");
	assert.equal(describeDetails.columns.length, 80);
	assert.equal(describeDetails.indexes.length, 40);
	assert.equal(describeDetails.relations.length, 40);
	assert.equal(describeDetails.llm_context.columns_sampled_for_context, true);
	assert.equal(describeDetails.llm_context.create_statement_truncated_for_context, true);

	const searchMessage = reshapeToolResultsForLlm<ToolResultMessage>([
		{
			role: "toolResult",
			toolName: "sql_search_tables",
			details: {
				source: "unit",
				dialect: "mysql",
				filters: { max_results: 100 },
				matches: Array.from({ length: 35 }, (_, index) => ({
					qualified_name: `db.t${index}`,
					database: "db",
					table: `t${index}`,
					matched_on: ["keyword:table_name"],
					matched_columns: Array.from({ length: 7 }, (_, columnIndex) => ({
						name: `c${columnIndex}`,
						type: "varchar(255)",
						matched_on: ["keyword:column_name"],
					})),
				})),
				count: 35,
				truncated: false,
			},
		},
	])[0];
	const searchDetails = JSON.parse(searchMessage?.content?.[0]?.text ?? "{}");
	assert.equal(searchDetails.matches.length, 30);
	assert.equal(searchDetails.matches[0].matched_columns.length, 5);
	assert.equal(searchDetails.llm_context.matches_sampled_for_context, true);
	assert.equal(searchDetails.llm_context.matched_columns_sampled_for_context, true);
}

async function testValidateConfig(): Promise<void> {
	const missing = await executeValidateConfig(path.join(os.tmpdir(), `sqlkit-missing-${Date.now()}`), {});
	assert.equal(missing.details.ok, false);
	assert.equal(missing.details.issues[0]?.severity, "error");
	assert.match(missing.details.issues[0]?.fix ?? "", /Create .*sqlkit\.json/);
	assert.match(
		formatValidateConfig({
			ok: true,
			sources: [
				{
					name: "unit",
					dialect: "mysql",
					read_only: true,
					allow_apply: false,
					access: { database_allow: [], database_deny: [], table_rules: 0 },
					connection: { checked: true, ok: true },
					capability_check_error: "SHOW GRANTS is not available",
				},
			],
			issues: [{ severity: "warning", message: "Unit warning.", fix: "Do the unit fix." }],
		}),
		/connection ok capability check failed/,
	);
	assert.match(
		formatValidateConfig({
			ok: true,
			sources: [],
			issues: [{ severity: "warning", message: "Unit warning.", fix: "Do the unit fix." }],
		}),
		/fix: Do the unit fix\./,
	);

	const tmpDir = path.join(os.tmpdir(), `sqlkit-v1-${Date.now()}`);
	mkdirSync(tmpDir, { recursive: true });
	try {
		writeFileSync(
			path.join(tmpDir, "sqlkit.json"),
			JSON.stringify(
				{
					sources: [
						{
							name: "mysql_risky",
							dialect: "mysql",
							read_only: false,
							allow_apply: true,
							access: {
								databases: {
									allow: ["mysql", "app_*"],
									deny: ["secret_db"],
								},
								tables: [
									{
										database: "mysql",
										allow: ["user", "db"],
										deny: ["procs_priv"],
									},
								],
							},
							options: {
								password_env: "SQLKIT_TEST_PASSWORD_MISSING",
							},
						},
						{
							name: "clickhouse_default_url",
							dialect: "clickhouse",
							read_only: true,
							options: {
								database: "default",
							},
						},
						{
							name: "clickhouse_url",
							dialect: "clickhouse",
							read_only: true,
							options: {
								url: "http://clickhouse.example:8123",
								username: "default",
								database: "default",
							},
						},
					],
				},
				null,
				2,
			),
		);

		const result = await executeValidateConfig(tmpDir, { check_connections: false });
		assert.equal(result.details.ok, true);
		assert.equal(result.details.sources.length, 3);
		assert.deepEqual(result.details.sources[0]?.access.database_allow, ["mysql", "app_*"]);
		assert.equal(result.details.sources[0]?.access.table_rules, 1);
		assert.equal(result.details.issues.some((issue) => issue.message.includes("read_only is disabled")), true);
		assert.equal(result.details.issues.some((issue) => issue.message.includes("allow_apply")), true);
		assert.equal(result.details.issues.some((issue) => issue.message.includes("allow_apply") && issue.fix?.includes("sql_apply")), true);
		assert.equal(result.details.issues.some((issue) => issue.message.includes("Environment variable SQLKIT_TEST_PASSWORD_MISSING")), true);
		assert.equal(result.details.issues.some((issue) => issue.source === "clickhouse_default_url" && issue.message.includes("default 127.0.0.1")), true);
		assert.equal(result.details.issues.some((issue) => issue.source === "clickhouse_url" && issue.message.includes("default 127.0.0.1")), false);
		assert.equal(result.details.issues.some((issue) => issue.message.includes("Access policy enabled")), true);
		assert.equal(result.details.issues.some((issue) => issue.source === "clickhouse_default_url" && issue.message.includes("No access policy is configured")), true);
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
}

async function testAgentToolsConfigPersistence(): Promise<void> {
	const tmpDir = path.join(os.tmpdir(), `sqlkit-agent-tools-${Date.now()}`);
	const configPath = path.join(tmpDir, ".pi", "sqlkit.json");
	mkdirSync(tmpDir, { recursive: true });
	try {
		setProjectAgentToolsEnabled(tmpDir, true);
		const emptyPersisted = JSON.parse(readFileSync(configPath, "utf-8"));
		assert.equal(emptyPersisted.agent_tools.enabled, true);
		assert.deepEqual(emptyPersisted.sources, []);
		assert.equal(loadProjectConfig(tmpDir).agentTools.enabled, true);
		assert.equal(loadProjectConfig(tmpDir).sources.length, 0);
		const emptySources = await executeListSources(tmpDir);
		assert.equal(emptySources.details.sources.length, 0);
		const emptyValidation = await executeValidateConfig(tmpDir, {});
		assert.equal(emptyValidation.details.ok, true);
		assert.equal(emptyValidation.details.sources.length, 0);
		await assert.rejects(() => executeRunQuery(tmpDir, { query: "SELECT 1" }), /No SQL sources are configured/);

		const upsertedMysql = await executeUpsertSource(tmpDir, {
			name: "tool_mysql",
			dialect: "mysql",
			url: "mysql://tool_user:tool_pass@127.0.0.1:3307/tool_db",
			allow_apply: true,
		});
		assert.equal(upsertedMysql.details.created, true);
		assert.equal(upsertedMysql.details.source, "tool_mysql");
		assert.equal(upsertedMysql.details.dialect, "mysql");
		assert.equal(upsertedMysql.details.allow_apply, true);
		assert.equal(upsertedMysql.details.read_only, false);
		assert.equal(upsertedMysql.details.option_keys.includes("password"), false);
		const toolMysqlConfig = loadProjectConfig(tmpDir).sources.find((source) => source.name === "tool_mysql");
		assert.equal(toolMysqlConfig?.options.host, "127.0.0.1");
		assert.equal(toolMysqlConfig?.options.port, 3307);
		assert.equal(toolMysqlConfig?.options.user, "tool_user");
		assert.equal(toolMysqlConfig?.options.password, "tool_pass");
		assert.equal(toolMysqlConfig?.options.database, "tool_db");

		const upsertedClickHouse = await executeUpsertSource(tmpDir, {
			name: "tool_clickhouse",
			dialect: "clickhouse",
			url: "http://default:secret@127.0.0.1:8123",
			read_only: true,
			allow_apply: true,
		});
		assert.equal(upsertedClickHouse.details.created, true);
		assert.equal(upsertedClickHouse.details.dialect, "clickhouse");
		assert.equal(loadProjectConfig(tmpDir).sources.find((source) => source.name === "tool_clickhouse")?.options.url, "http://default:secret@127.0.0.1:8123");

		writeFileSync(
			configPath,
			JSON.stringify(
				{
					sources: [
						{
							name: "type_is_not_dialect",
							type: "mysql",
							options: { host: "127.0.0.1" },
							allow_apply: true,
						},
					],
				},
				null,
				2,
			),
		);
		clearProjectConfigCache();
		assert.throws(() => loadProjectConfig(tmpDir), /Invalid dialect/);

		writeFileSync(
			configPath,
			JSON.stringify(
				{
					agent_tools: { enabled: false },
					sources: [
						{
							name: "unit",
							dialect: "clickhouse",
							read_only: true,
							options: { url: "http://127.0.0.1:8123", user: "default" },
						},
					],
				},
				null,
				2,
			),
		);
		clearProjectConfigCache();
		assert.equal(loadProjectConfig(tmpDir).agentTools.enabled, false);
		setProjectAgentToolsEnabled(tmpDir, true);
		assert.equal(loadProjectConfig(tmpDir).agentTools.enabled, true);
		const persisted = JSON.parse(readFileSync(configPath, "utf-8"));
		assert.equal(persisted.agent_tools.enabled, true);
	} finally {
		clearProjectConfigCache();
		rmSync(tmpDir, { recursive: true, force: true });
	}
}

async function testConfigCaching(): Promise<void> {
	const tmpDir = path.join(os.tmpdir(), `sqlkit-cache-${Date.now()}`);
	const configPath = path.join(tmpDir, "sqlkit.json");
	mkdirSync(tmpDir, { recursive: true });
	const writeConfig = (sourceName: string): void => {
		writeFileSync(
			configPath,
			JSON.stringify(
				{
					sources: [
						{
							name: sourceName,
							dialect: "mysql",
							read_only: true,
							options: {
								host: "127.0.0.1",
								user: "readonly",
								password_env: "SQLKIT_CACHE_PASSWORD",
								password: "literal-secret-should-not-leak",
							},
						},
					],
				},
				null,
				2,
			),
		);
	};

	try {
		process.env.SQLKIT_CACHE_PASSWORD = "first-secret";
		writeConfig("first_source");
		clearProjectConfigCache();

		const firstConfig = loadProjectConfig(tmpDir);
		const firstCacheKey = firstConfig.sources[0]?.cacheKey ?? "";
		assert.equal(loadProjectConfig(tmpDir), firstConfig, "unchanged config should be served from cache");
		assert.equal(firstCacheKey.includes("first-secret"), false);
		assert.equal(firstCacheKey.includes("literal-secret-should-not-leak"), false);

		process.env.SQLKIT_CACHE_PASSWORD = "second-secret";
		const secondCacheKey = loadProjectConfig(tmpDir).sources[0]?.cacheKey ?? "";
		assert.notEqual(secondCacheKey, firstCacheKey, "password_env value changes should change connection cache key");
		assert.equal(secondCacheKey.includes("second-secret"), false);
		assert.equal(secondCacheKey.includes("literal-secret-should-not-leak"), false);

		writeConfig("second_source");
		const future = new Date(Date.now() + 10_000);
		utimesSync(configPath, future, future);
		const reloadedConfig = loadProjectConfig(tmpDir);
		assert.notEqual(reloadedConfig, firstConfig, "changed config file should be reparsed");
		assert.equal(reloadedConfig.sources[0]?.name, "second_source");
	} finally {
		delete process.env.SQLKIT_CACHE_PASSWORD;
		clearProjectConfigCache();
		rmSync(tmpDir, { recursive: true, force: true });
	}
}

async function testCapabilityAnalysis(): Promise<void> {
	const mysqlPrivileges = extractMysqlPrivilegesFromGrantStrings([
		"GRANT SELECT, INSERT, FILE ON *.* TO `root`@`%` WITH GRANT OPTION",
		"GRANT CREATE USER ON *.* TO `root`@`%`",
	]);
	assert.equal(mysqlPrivileges.includes("SELECT"), true);
	assert.equal(mysqlPrivileges.includes("FILE"), true);
	assert.equal(mysqlPrivileges.includes("GRANT OPTION"), true);

	const mysqlCapability = analyzeMysqlCapabilities(
		{
			name: "mysql_local",
			dialect: "mysql",
			readOnly: true,
			allowApply: false,
			access: { databases: { allow: [], deny: [] }, tables: [] },
			options: { database: "mysql" },
			configPath: "test",
			cacheKey: "test",
		},
		{
			currentUser: "root@%",
			grants: [
				"GRANT SELECT, INSERT, FILE ON *.* TO `root`@`%` WITH GRANT OPTION",
				"GRANT CREATE USER ON *.* TO `root`@`%`",
			],
		},
	);
	assert.equal(mysqlCapability.grants_inspected, true);
	assert.equal(mysqlCapability.findings.some((finding) => finding.code === "mysql_risky_privileges"), true);

	const clickhouseCapability = analyzeClickHouseCapabilities(
		{
			name: "clickhouse_local",
			dialect: "clickhouse",
			readOnly: true,
			allowApply: false,
			access: { databases: { allow: [], deny: [] }, tables: [] },
			options: { database: "default" },
			configPath: "test",
			cacheKey: "test",
		},
		{
			currentUser: "default",
			grants: ["GRANT SELECT, INSERT, SYSTEM ON *.* TO default"],
			privileges: ["SELECT", "INSERT", "SYSTEM"],
			readonlySetting: 0,
			allowDdlSetting: 1,
		},
	);
	assert.equal(clickhouseCapability.findings.some((finding) => finding.code === "clickhouse_readonly_off"), true);
	assert.equal(clickhouseCapability.findings.some((finding) => finding.code === "clickhouse_allow_ddl_on"), true);
	assert.equal(clickhouseCapability.findings.some((finding) => finding.code === "clickhouse_risky_privileges"), true);
}

async function testAccessPolicyParser(): Promise<void> {
	const source = {
		name: "mysql_guarded",
		dialect: "mysql" as const,
		readOnly: true,
		allowApply: false,
		access: {
			databases: {
				allow: ["mysql"],
				deny: ["sys"],
			},
			tables: [
				{
					database: "mysql",
					allow: ["user", "db", "columns_priv"],
					deny: ["procs_priv"],
				},
			],
		},
		options: { database: "mysql" },
		configPath: "test",
		cacheKey: "test",
	};

	const cteRefs = assertQueryAccess(
		source,
		"WITH recent_users AS (SELECT User FROM mysql.user) SELECT * FROM recent_users",
	).references;
	assert.deepEqual(cteRefs, [{ database: "mysql", table: "user" }]);

	const subqueryRefs = assertQueryAccess(
		source,
		"SELECT * FROM (SELECT User FROM mysql.user) AS derived JOIN mysql.db d ON 1=1",
	).references;
	assert.equal(subqueryRefs.some((ref) => ref.table === "user"), true);
	assert.equal(subqueryRefs.some((ref) => ref.table === "db"), true);

	const commaJoinRefs = assertQueryAccess(
		source,
		"SELECT * FROM mysql.user u, mysql.db d WHERE u.User = d.User",
	).references;
	assert.equal(commaJoinRefs.length, 2);

	const quotedRefs = assertQueryAccess(
		source,
		"SELECT * FROM `mysql`.`user` u JOIN [mysql].[db] d ON 1=1",
	).references;
	assert.equal(quotedRefs.length, 2);

	assertThrowsMessage(
		"cte deny table",
		() => assertQueryAccess(source, "WITH p AS (SELECT * FROM mysql.procs_priv) SELECT * FROM p"),
		/not allowed/,
	);
	assertThrowsMessage(
		"unsafe function source",
		() => assertQueryAccess(source, "SELECT * FROM mysql('127.0.0.1', 'mysql', 'user', 'root', 'x')"),
		/cannot safely validate source expressions/i,
	);

	const clickhouseSource = {
		...source,
		name: "clickhouse_guarded",
		dialect: "clickhouse" as const,
		options: { database: "analytics" },
		access: {
			databases: {
				allow: ["analytics"],
				deny: [],
			},
			tables: [
				{
					database: "analytics",
					allow: ["events", "dim_users"],
					deny: [],
				},
			],
		},
	};

	const clickhouseRefs = assertQueryAccess(
		clickhouseSource,
		"WITH base AS (SELECT * FROM analytics.events) SELECT * FROM base ARRAY JOIN tags JOIN analytics.dim_users du ON 1=1",
	).references;
	assert.equal(clickhouseRefs.length, 2);
	assert.equal(clickhouseRefs.some((ref) => ref.table === "events"), true);
	assert.equal(clickhouseRefs.some((ref) => ref.table === "dim_users"), true);
}

async function testAccessPolicyEnforcement(): Promise<void> {
	const tmpDir = path.join(os.tmpdir(), `sqlkit-access-${Date.now()}`);
	mkdirSync(tmpDir, { recursive: true });
	try {
		writeFileSync(
			path.join(tmpDir, "sqlkit.json"),
			JSON.stringify(
				{
					sources: [
						{
							name: "mysql_guarded",
							dialect: "mysql",
							read_only: true,
							access: {
								databases: {
									allow: ["mysql"],
									deny: ["sys"],
								},
								tables: [
									{
										database: "mysql",
										allow: ["user", "db"],
										deny: ["procs_priv"],
									},
								],
							},
							options: {
								host: "127.0.0.1",
								user: "root",
								password: "ignored-for-unit-tests",
								database: "mysql",
							},
						},
					],
				},
				null,
				2,
			),
		);

		const sources = await executeListSources(tmpDir);
		assert.equal(sources.details.sources[0]?.access.table_rules, 1);

		await assert.rejects(() => executeListTables(tmpDir, { database: "sys" }), /not allowed/);
		await assert.rejects(() => executeSearchTables(tmpDir, { database: "sys", keyword: "user" }), /not allowed/);

		await assert.rejects(() => executeDescribeTable(tmpDir, { table: "procs_priv" }), /not allowed/);
		const deniedTable = await executeRunQuery(tmpDir, { query: "SELECT * FROM procs_priv", max_rows: 5 });
		assert.match(deniedTable.content[0]?.text ?? "", /not allowed/);

		const deniedCte = await executeRunQuery(
			tmpDir,
			{
				query: "WITH p AS (SELECT * FROM mysql.procs_priv) SELECT * FROM p",
				max_rows: 5,
			},
		);
		assert.match(deniedCte.content[0]?.text ?? "", /not allowed/);

		const unsafeSource = await executeRunQuery(
			tmpDir,
			{
				query: "SELECT * FROM mysql('127.0.0.1', 'mysql', 'user', 'root', 'x')",
				max_rows: 5,
			},
		);
		assert.match(unsafeSource.content[0]?.text ?? "", /cannot safely validate source expressions/i);

		const ambiguousShow = await executeRunQuery(tmpDir, { query: "SHOW TABLES", max_rows: 5 });
		assert.match(ambiguousShow.content[0]?.text ?? "", /does not allow SHOW statements/i);

		await assert.rejects(
			() => executeProfileQuery(tmpDir, { query: "SHOW TABLES", max_rows: 5 }),
			/require a SELECT or WITH SELECT query/i,
		);
		await assert.rejects(
			() => executeAnalyzeQuery(tmpDir, { query: "SHOW TABLES", max_rows: 5 }),
			/require a SELECT or WITH SELECT query/i,
		);
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
}

async function testWriteConfirmation(): Promise<void> {
	const tmpDir = path.join(os.tmpdir(), `sqlkit-write-${Date.now()}`);
	mkdirSync(tmpDir, { recursive: true });
	try {
		writeFileSync(
			path.join(tmpDir, "sqlkit.json"),
			JSON.stringify(
				{
					sources: [
						{
							name: "write_enabled",
							dialect: "clickhouse",
							read_only: true,
							allow_apply: true,
							access: {
								databases: { allow: ["analytics"], deny: [] },
								tables: [{ database: "analytics", allow: ["events"], deny: [] }],
							},
							options: {
								url: "http://127.0.0.1:8123",
								user: "default",
								database: "analytics",
							},
						},
						{
							name: "write_disabled",
							dialect: "clickhouse",
							read_only: true,
							allow_apply: false,
							options: {
								url: "http://127.0.0.1:8123",
								user: "default",
								database: "analytics",
							},
						},
					],
				},
				null,
				2,
			),
		);

		const noConfirm = await executeWrite(
			tmpDir,
			{ source: "write_enabled", statement: "INSERT INTO analytics.events VALUES (1)" },
			undefined,
			undefined,
			{ ui: {} },
		);
		assert.equal(noConfirm.details.executed, false);
		assert.equal(noConfirm.details.cancelled, false);
		assert.match(noConfirm.content[0]?.text ?? "", /requires interactive user confirmation/i);

		let confirmMessage = "";
		const cancelled = await executeWrite(
			tmpDir,
			{ source: "write_enabled", statement: "UPDATE analytics.events SET id = id WHERE id = 1" },
			undefined,
			undefined,
			{
				ui: {
					confirm(_title: string, message: string) {
						confirmMessage = message;
						return false;
					},
				},
			},
		);
		assert.equal(cancelled.details.executed, false);
		assert.equal(cancelled.details.cancelled, true);
		assert.match(confirmMessage, /Source: write_enabled \(clickhouse\)/);
		assert.match(confirmMessage, /Kind: UPDATE/);
		assert.match(confirmMessage, /Target: analytics\.events/);

		const disabled = await executeWrite(
			tmpDir,
			{ source: "write_disabled", statement: "INSERT INTO analytics.events VALUES (1)" },
		);
		assert.match(disabled.content[0]?.text ?? "", /allow_apply/);
		assert.equal(disabled.details.executed, false);
		assert.equal(disabled.details.blocked, true);
		assert.equal(disabled.details.requires_config_change?.field, "allow_apply");
		assert.equal(disabled.details.requires_config_change?.required_value, true);
		assert.equal(disabled.details.requires_config_change?.source, "write_disabled");

		const disabledTableDdl = await executeWrite(
			tmpDir,
			{ source: "write_disabled", statement: "CREATE TABLE analytics.events_copy (id UInt64)" },
		);
		assert.match(disabledTableDdl.content[0]?.text ?? "", /allow_apply/);
		assert.equal(disabledTableDdl.details.executed, false);
		assert.equal(disabledTableDdl.details.blocked, true);
		assert.equal(disabledTableDdl.details.requires_config_change?.field, "allow_apply");
		assert.equal(disabledTableDdl.details.unsupported_statement, undefined);

		const disabledDatabaseDdl = await executeWrite(
			tmpDir,
			{ source: "write_disabled", statement: "CREATE DATABASE test_db" },
		);
		assert.match(disabledDatabaseDdl.content[0]?.text ?? "", /allow_apply/);
		assert.equal(disabledDatabaseDdl.details.executed, false);
		assert.equal(disabledDatabaseDdl.details.blocked, true);
		assert.equal(disabledDatabaseDdl.details.statement_kind, "create");
		assert.equal(disabledDatabaseDdl.details.requires_config_change?.field, "allow_apply");
		assert.equal(disabledDatabaseDdl.details.unsupported_statement, undefined);

		const createDatabaseNeedsConfirmation = await executeWrite(
			tmpDir,
			{ source: "write_enabled", statement: "CREATE DATABASE analytics" },
			undefined,
			undefined,
			{ ui: {} },
		);
		assert.equal(createDatabaseNeedsConfirmation.details.executed, false);
		assert.equal(createDatabaseNeedsConfirmation.details.cancelled, false);
		assert.equal(createDatabaseNeedsConfirmation.details.blocked, undefined);
		assert.match(createDatabaseNeedsConfirmation.content[0]?.text ?? "", /requires interactive user confirmation/i);

		const deniedDatabasePolicy = await executeWrite(
			tmpDir,
			{ source: "write_enabled", statement: "CREATE DATABASE another_test_db" },
		);
		assert.match(deniedDatabasePolicy.content[0]?.text ?? "", /not allowed/);

		const deleteBlocked = await executeWrite(
			tmpDir,
			{ source: "write_enabled", statement: "DELETE FROM analytics.secret_events WHERE id = 1" },
		);
		assert.match(deleteBlocked.content[0]?.text ?? "", /DELETE is blocked/);
		assert.equal(deleteBlocked.details.blocked, true);
		assert.equal(deleteBlocked.details.unsupported_statement?.statement_kind, "delete");

		const deniedPolicy = await executeWrite(
			tmpDir,
			{ source: "write_enabled", statement: "UPDATE analytics.secret_events SET id = id WHERE id = 1" },
		);
		assert.match(deniedPolicy.content[0]?.text ?? "", /not allowed/);

		const fakeConfirmParam = await executeWrite(
			tmpDir,
			{ source: "write_enabled", statement: "INSERT INTO analytics.events VALUES (1)", confirm: true } as any,
		);
		assert.equal(fakeConfirmParam.details.executed, false);
		assert.match(fakeConfirmParam.content[0]?.text ?? "", /requires interactive user confirmation/i);
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
}

async function testVerifiedQueries(): Promise<void> {
	const source = {
		name: "mysql_guarded",
		dialect: "mysql" as const,
		readOnly: true,
		allowApply: false,
		access: {
			databases: {
				allow: ["mysql"],
				deny: ["sys"],
			},
			tables: [
				{
					database: "mysql",
					allow: ["user", "db"],
					deny: ["procs_priv"],
				},
			],
		},
		options: { database: "mysql" },
		configPath: "test",
		cacheKey: "test",
	};

	const verifiedRun = verifyRunQuery(source, {
		query: "SELECT * FROM mysql.user",
		maxRows: 5,
	});
	assert.equal(verifiedRun.mode, "run");
	assert.equal(verifiedRun.queryKind, "select");
	assert.equal(verifiedRun.normalizedQuery, "SELECT * FROM mysql.user");
	assert.deepEqual(verifiedRun.references, [{ database: "mysql", table: "user" }]);
	assert.equal(verifiedRun.limits.maxRows, 5);
	assert.equal(verifiedRun.sourcePolicy.hasAccessPolicy, true);
	assert.equal(verifiedRun.sourcePolicy.readOnly, true);

	const verifiedProfile = verifyProfileQuery(source, {
		query: "SELECT * FROM mysql.user",
		maxRows: 6,
	});
	assert.equal(verifiedProfile.mode, "run");
	assert.equal(verifiedProfile.queryKind, "select");
	assert.equal(verifiedProfile.limits.maxRows, 6);
	assert.deepEqual(verifiedProfile.references, [{ database: "mysql", table: "user" }]);
	assertThrowsMessage(
		"verified profile show",
		() => verifyProfileQuery(source, { query: "SHOW TABLES", maxRows: 6 }),
		/require a SELECT or WITH SELECT query/i,
	);

	const verifiedExplain = verifyExplainQuery(source, {
		query: "SELECT * FROM mysql.user",
		mode: "json",
		maxRows: 7,
	});
	assert.equal(verifiedExplain.mode, "explain");
	assert.equal(verifiedExplain.explainMode, "json");
	assert.equal(verifiedExplain.queryKind, "select");
	assert.equal(verifiedExplain.limits.maxRows, 7);
	assert.deepEqual(verifiedExplain.references, [{ database: "mysql", table: "user" }]);

	const verifiedAnalyze = verifyAnalyzeQuery(source, {
		query: "SELECT * FROM mysql.user",
		mode: "analyze",
		maxRows: 8,
	});
	assert.equal(verifiedAnalyze.mode, "explain");
	assert.equal(verifiedAnalyze.explainMode, "analyze");
	assert.equal(verifiedAnalyze.queryKind, "select");
	assert.equal(verifiedAnalyze.limits.maxRows, 8);

	assertThrowsMessage(
		"verified run show policy",
		() => verifyRunQuery(source, { query: "SHOW TABLES", maxRows: 5 }),
		/does not allow SHOW statements/i,
	);
	assertThrowsMessage(
		"verified run unsafe source",
		() => verifyRunQuery(source, { query: "SELECT * FROM mysql('127.0.0.1', 'mysql', 'user', 'root', 'x')", maxRows: 5 }),
		/cannot safely validate source expressions/i,
	);
	assert.deepEqual(verifyRunQuery(source, { query: "SELECT 1", maxRows: 5 }).references, []);
	assert.deepEqual(verifyRunQuery(source, { query: "SELECT 1 INTO @sqlkit_var", maxRows: 5 }).references, []);
	assert.deepEqual(verifyRunQuery(source, { query: "SELECT * FROM mysql.user, LATERAL (SELECT 1) AS x", maxRows: 5 }).references, [
		{ database: "mysql", table: "user" },
	]);
	assert.deepEqual(tableAccessPatternsForDatabase(source, "MYSQL"), {
		allow: ["user", "db"],
		deny: ["procs_priv"],
	});

	const writeSource = {
		...source,
		readOnly: true,
		allowApply: true,
	};
	const verifiedWrite = verifyWriteStatement(writeSource, {
		statement: "UPDATE mysql.user SET User = User WHERE User = 'root'",
	});
	assert.equal(verifiedWrite.mode, "write");
	assert.equal(verifiedWrite.statementKind, "update");
	assert.deepEqual(verifiedWrite.references, [{ database: "mysql", table: "user" }]);
	const verifiedCreateTable = verifyWriteStatement(writeSource, {
		statement: "CREATE TABLE mysql.user (id int)",
	});
	assert.equal(verifiedCreateTable.statementKind, "create");
	assert.deepEqual(verifiedCreateTable.references, [{ database: "mysql", table: "user" }]);
	const verifiedCreateDatabase = verifyWriteStatement(writeSource, {
		statement: "CREATE DATABASE mysql",
	});
	assert.equal(verifiedCreateDatabase.statementKind, "create");
	assert.deepEqual(verifiedCreateDatabase.references, []);
	assertThrowsMessage(
		"write requires allow_apply",
		() => verifyWriteStatement(source, { statement: "UPDATE mysql.user SET User = User WHERE User = 'root'" }),
		/allow_apply/,
	);
	assertThrowsMessage(
		"create database denied by policy",
		() => verifyWriteStatement(writeSource, { statement: "CREATE DATABASE sys" }),
		/not allowed/,
	);
	assertThrowsMessage(
		"write denied table policy",
		() => verifyWriteStatement(writeSource, { statement: "UPDATE mysql.procs_priv SET User = User WHERE User = 'root'" }),
		/not allowed/,
	);
	assertThrowsMessage(
		"write denied multi table policy",
		() => verifyWriteStatement(writeSource, { statement: "UPDATE mysql.user, mysql.procs_priv SET mysql.user.User = mysql.user.User" }),
		/not allowed/,
	);
	assertThrowsMessage(
		"delete blocked by sql_apply",
		() => verifyWriteStatement(writeSource, { statement: "DELETE FROM mysql.user WHERE User = 'root'" }),
		/DELETE is blocked/,
	);
}

await testGuards();
testMysqlIdentifierQuoting();
testClickHouseConnectionOptions();
testConfigUiPlaceholderDefaults();
testClickHouseFormatCompatibility();
testFormatTables();
await testLimits();
testLlmContextShaping();
await testVerifiedQueries();
await testAccessPolicyParser();
await testValidateConfig();
await testAgentToolsConfigPersistence();
await testConfigCaching();
await testAccessPolicyEnforcement();
await testWriteConfirmation();

console.log("OK v1 guard, limit, and config validation tests passed.");
