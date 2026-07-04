import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
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
	executeValidateConfig,
} from "../src/core/execution.js";
import { closeAllAdapters } from "../src/adapters/registry.js";
import type { QueryResult } from "../src/types.js";

const MYSQL_PASSWORD = process.env.SQLKIT_MYSQL_PASSWORD ?? process.env.SQL_MCP_MYSQL_PASSWORD;
const tmpDir = path.join(os.tmpdir(), `sqlkit-smoke-${Date.now()}`);

function logStep(name: string, detail: unknown) {
	const text = typeof detail === "string" ? detail : JSON.stringify(detail, null, 2);
	console.log(`\n[${name}]\n${text}`);
}

function assertResultProfile(name: string, details: QueryResult): void {
	assert.ok(details.result_profile, `${name}: expected result_profile.`);
	assert.equal(details.result_profile.profile_scope, "sampled_result_rows");
	assert.equal(details.result_profile.sampled_rows, details.row_count);
	assert.equal(details.result_profile.columns.some((column) => column.name === "one"), true);
}

const CLICKHOUSE_SYSTEM_DATABASES = new Set(["system", "default", "INFORMATION_SCHEMA", "information_schema"]);

async function run() {
	if (!MYSQL_PASSWORD) {
		throw new Error("Missing SQLKIT_MYSQL_PASSWORD environment variable.");
	}
	// Normalize so the generated config's password_env resolves regardless of
	// whether the caller set the legacy SQL_MCP_MYSQL_PASSWORD or the new name.
	process.env.SQLKIT_MYSQL_PASSWORD = MYSQL_PASSWORD;

	mkdirSync(tmpDir, { recursive: true });
	writeFileSync(
		path.join(tmpDir, "sqlkit.json"),
		JSON.stringify(
			{
				sources: [
					{
						name: "mysql_local",
						dialect: "mysql",
						read_only: true,
						options: {
							host: "127.0.0.1",
							port: 3306,
							user: "root",
							password_env: "SQLKIT_MYSQL_PASSWORD",
							database: "mysql",
						},
					},
					{
						name: "clickhouse_local",
						dialect: "clickhouse",
						read_only: true,
						options: {
							url: "http://127.0.0.1:8123",
							username: "default",
							password: "",
							database: "default",
						},
					},
				],
			},
			null,
			2,
		),
	);

	try {
		logStep("sources", (await executeListSources(tmpDir)).details);
		logStep("validate config", (await executeValidateConfig(tmpDir, { check_connections: true })).details);

		logStep("mysql ping", (await executePing(tmpDir, { source: "mysql_local" })).details);
		logStep("mysql databases", (await executeListDatabases(tmpDir, { source: "mysql_local" })).details);
		logStep("mysql tables", (await executeListTables(tmpDir, { source: "mysql_local", database: "mysql", like: "user" })).details);
		logStep(
			"mysql search tables",
			(await executeSearchTables(tmpDir, { source: "mysql_local", database: "mysql", keyword: "user", max_results: 5 })).details,
		);
		logStep(
			"mysql describe",
			(await executeDescribeTable(tmpDir, { source: "mysql_local", database: "mysql", table: "user", include_relations: true })).details,
		);
		const mysqlQuery = await executeRunQuery(tmpDir, { source: "mysql_local", query: "SELECT 1 AS one", max_rows: 5 });
		assertResultProfile("mysql query", mysqlQuery.details);
		logStep("mysql query", mysqlQuery.details);
		logStep("mysql explain", (await executeExplainQuery(tmpDir, { source: "mysql_local", query: "SELECT 1 AS one", mode: "json", max_rows: 5 })).details);
		logStep("mysql analyze", (await executeAnalyzeQuery(tmpDir, { source: "mysql_local", query: "SELECT 1 AS one", max_rows: 5 })).details);

		logStep("clickhouse ping", (await executePing(tmpDir, { source: "clickhouse_local" })).details);
		const clickhouseDatabases = await executeListDatabases(tmpDir, { source: "clickhouse_local" });
		logStep("clickhouse databases", clickhouseDatabases.details);
		logStep("clickhouse tables", (await executeListTables(tmpDir, { source: "clickhouse_local", database: "system", like: "tables" })).details);
		logStep(
			"clickhouse search tables",
			(await executeSearchTables(tmpDir, { source: "clickhouse_local", database: "system", keyword: "tables", engine: "System", max_results: 5 })).details,
		);
		logStep(
			"clickhouse describe",
			(await executeDescribeTable(tmpDir, { source: "clickhouse_local", database: "system", table: "tables" })).details,
		);
		const clickhouseQuery = await executeRunQuery(tmpDir, { source: "clickhouse_local", query: "SELECT 1 AS one", max_rows: 5 });
		assertResultProfile("clickhouse query", clickhouseQuery.details);
		logStep("clickhouse query", clickhouseQuery.details);
		logStep(
			"clickhouse profile",
			(await executeProfileQuery(tmpDir, { source: "clickhouse_local", query: "SELECT 1 AS one", max_rows: 5 })).details,
		);
		logStep(
			"clickhouse explain",
			(await executeExplainQuery(tmpDir, { source: "clickhouse_local", query: "SELECT 1 AS one", mode: "pipeline", max_rows: 10 })).details,
		);
		await assert.rejects(
			() => executeAnalyzeQuery(tmpDir, { source: "clickhouse_local", query: "SELECT 1 AS one", max_rows: 5 }),
			/not supported/i,
		);
		for (const database of clickhouseDatabases.details.databases) {
			if (CLICKHOUSE_SYSTEM_DATABASES.has(database)) continue;
			const tables = await executeListTables(tmpDir, { source: "clickhouse_local", database });
			if (tables.details.tables.length === 0) continue;
			const mvTable = tables.details.tables.find((table) => table.startsWith("mv_"));
			const nonMvTable = tables.details.tables.find((table) => !table.startsWith("mv_"));
			if (nonMvTable) {
				logStep(
					"clickhouse describe user table",
					(await executeDescribeTable(tmpDir, { source: "clickhouse_local", database, table: nonMvTable })).details,
				);
			}
			if (mvTable) {
				logStep(
					"clickhouse describe materialized view",
					(await executeDescribeTable(tmpDir, { source: "clickhouse_local", database, table: mvTable })).details,
				);
			}
			break;
		}
	} finally {
		await closeAllAdapters();
		rmSync(tmpDir, { recursive: true, force: true });
	}
}

run().catch((error) => {
	console.error(error instanceof Error ? error.stack ?? error.message : error);
	process.exitCode = 1;
});
