import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildDatabaseContextPrompt,
  findProjectConfigPath,
  initializeProjectConfig,
  loadProjectConfig,
  migrateLegacyProjectConfig,
  selectSource
} from "../src/config.ts";
import { clickhouseAdapter } from "../src/clickhouse.ts";
import { mysqlAdapter } from "../src/mysql.ts";
import { boundItems, boundRows, boundTableNames, resultLimits, truncateText } from "../src/results.ts";
import { firstKeyword, hasMultipleStatements, hasTopLevelKeyword, normalizeSql } from "../src/sql.ts";

function writeConfig(dir: string, value: unknown): string {
  const configPath = path.join(dir, ".pi", "databases.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(value, null, 2), "utf-8");
  return configPath;
}

function testSqlScanner() {
  assert.equal(normalizeSql("SELECT 1; \n"), "SELECT 1");
  assert.equal(hasMultipleStatements("SELECT ';'"), false);
  assert.equal(hasMultipleStatements("SELECT 1; SELECT 2"), true);
  assert.equal(firstKeyword("UPDATE users SET name = 'a'"), "UPDATE");
  assert.equal(firstKeyword("WITH source AS (SELECT 1) DELETE FROM users"), "DELETE");
  assert.equal(firstKeyword("WITH source AS (SELECT 1) SELECT * FROM source"), "SELECT");
  assert.equal(hasTopLevelKeyword("UPDATE users SET note = 'WHERE' WHERE id = 1", "WHERE"), true);
  assert.equal(hasTopLevelKeyword("UPDATE users SET note = 'WHERE'", "WHERE"), false);
}

function testResultLimits() {
  const clipped = truncateText("x".repeat(resultLimits.maxCellChars + 1));
  assert.equal(clipped.truncated, true);
  assert.equal(clipped.value.endsWith("…"), true);
  const rows = boundRows([["x".repeat(resultLimits.maxCellChars + 1)], ["ok"]], 100);
  assert.equal(rows.rows.length, 2);
  assert.equal(rows.truncated, true);
  assert.equal(rows.warnings.some((warning) => warning.includes("cell")), true);
  assert.equal(boundTableNames(Array.from({ length: resultLimits.maxTables + 1 }, (_, index) => `t_${index}`)).truncated, true);
  assert.equal(boundItems(Array.from({ length: resultLimits.maxTables + 1 }, (_, index) => ({ index }))).truncated, true);
}

function testInitializeConfig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-database-init-"));
  const result = initializeProjectConfig(dir);
  assert.equal(result.created, true);
  const config = JSON.parse(fs.readFileSync(result.configPath, "utf-8"));
  assert.equal(config.version, 1);
  assert.equal(config.sources.length, 2);
  assert.equal(config.sources.every((source: { allow_write_access: boolean }) => source.allow_write_access === false), true);
  assert.equal(config.sources.every((source: { query_timeout_ms: number }) => source.query_timeout_ms === 30_000), true);
  assert.equal(config.sources.every((source: { max_rows: number }) => source.max_rows === 100), true);
  assert.equal(config.sources.every((source: { options: Record<string, unknown> }) => source.options.database === undefined), true);
  assert.equal(initializeProjectConfig(dir).created, false);

  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "pi-database-parent-"));
  const child = path.join(parent, "child");
  fs.mkdirSync(child);
  const parentConfig = writeConfig(parent, { version: 1, sources: [{ name: "only", dialect: "mysql", options: { host: "localhost", user: "u" } }] });
  const inherited = initializeProjectConfig(child);
  assert.equal(inherited.created, false);
  assert.equal(inherited.configPath, parentConfig);
  assert.equal(fs.existsSync(path.join(child, ".pi", "databases.json")), false);
}

function testSourceSelection() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-database-source-"));
  writeConfig(dir, {
    version: 1,
    default_source: "analytics",
    sources: [
      { name: "app", dialect: "mysql", allow_write_access: false, query_timeout_ms: 12_000, max_rows: 25, options: { host: "localhost", user: "app", database: "app_db" } },
      { name: "analytics", dialect: "clickhouse", allow_write_access: true, query_timeout_ms: 45_000, max_rows: 999, options: { url: "http://localhost:8123", username: "analytics", database: "analytics" } }
    ]
  });
  const config = loadProjectConfig(dir);
  assert.equal(config.sources.length, 2);
  assert.equal(selectSource(config).name, "analytics");
  assert.equal(selectSource(config, "app").dialect, "mysql");
  assert.equal(selectSource(config, "app").queryTimeoutMs, 12_000);
  assert.equal(selectSource(config, "app").maxRows, 25);
  assert.equal(selectSource(config, "analytics").queryTimeoutMs, 45_000);
  assert.equal(selectSource(config, "analytics").maxRows, 500);
  assert.throws(() => selectSource(config, "missing"), /Unknown database source/);

  const ambiguous = fs.mkdtempSync(path.join(os.tmpdir(), "pi-database-ambiguous-"));
  writeConfig(ambiguous, {
    version: 1,
    sources: [
      { name: "one", dialect: "mysql", options: { host: "localhost", user: "one" } },
      { name: "two", dialect: "clickhouse", options: { url: "http://localhost:8123", username: "two" } }
    ]
  });
  assert.throws(() => selectSource(loadProjectConfig(ambiguous)), /Multiple database sources/);
}

function testDatabaseContextPrompt() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-database-prompt-"));
  writeConfig(dir, {
    version: 1,
    default_source: "app",
    sources: [
      { name: "app", dialect: "mysql", options: { host: "localhost", user: "app" } },
      { name: "analytics", dialect: "clickhouse", options: { url: "http://localhost:8123", username: "analytics" } }
    ]
  });
  const prompt = buildDatabaseContextPrompt(dir) ?? "";
  assert.match(prompt, /app: mysql \(default\)/);
  assert.match(prompt, /analytics: clickhouse/);
  assert.match(prompt, /database_list_databases/);
  assert.match(prompt, /database_search_tables/);
  assert.match(prompt, /database_describe_table/);
  assert.match(prompt, /instead of bash, mysql, clickhouse-client/);
  assert.match(prompt, /If database_write returns blocked or unsupported, stop/);
  assert.match(prompt, /outcome is unknown/);
  const noConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-database-no-prompt-"));
  assert.equal(buildDatabaseContextPrompt(noConfigDir), undefined);
}

async function testToolPromptMetadata() {
  const tools: Array<{ name?: string; promptSnippet?: string; promptGuidelines?: string[]; execute?: (...args: unknown[]) => Promise<unknown> }> = [];
  const api = {
    registerTool(tool: { name?: string; promptSnippet?: string; promptGuidelines?: string[]; execute?: (...args: unknown[]) => Promise<unknown> }) {
      tools.push(tool);
    }
  };
  const { __test__ } = await import("../index.ts");
  assert.equal(__test__.formatSqlForUi("SELECT id, name FROM users WHERE active = 1 ORDER BY id LIMIT 10"), "SELECT\n  id,\n  name\nFROM users\nWHERE active = 1\nORDER BY id\nLIMIT 10");
  const plainQueryTheme = { output: (text: string) => text, muted: (text: string) => text, accent: (text: string) => text, border: (text: string) => text, error: (text: string) => text, number: (text: string) => text, nullValue: (text: string) => text, empty: (text: string) => text, sql: (text: string) => text.split("\n") };
  const tableList = __test__.tableListView({ source: "app", dialect: "mysql", database: "main", tables: ["users", "orders"], truncated: false });
  assert.match(__test__.renderMetadataResultLines(tableList, {}, false, false, 80, plainQueryTheme).join("\n"), /main · 2 tables[\s\S]*users[\s\S]*orders/);
  const tableSearch = __test__.tableSearchView({ source: "app", dialect: "mysql", matches: [{ database: "main", table: "users", engine: "InnoDB", comment: "accounts" }], truncated: false });
  assert.match(__test__.renderMetadataResultLines(tableSearch, {}, false, false, 80, plainQueryTheme).join("\n"), /1 matches[\s\S]*InnoDB[\s\S]*accounts/);
  const tableDescription = __test__.tableDescriptionView({ source: "app", dialect: "mysql", database: "main", table: "users", engine: "InnoDB", columns: [{ position: 1, name: "id", type: "bigint", nullable: false }], indexes: [{ name: "PRIMARY", columns: ["id"], unique: true }], create_statement: "CREATE TABLE users (id bigint)", truncated: false, warnings: [] });
  const descriptionLines = __test__.renderMetadataResultLines(tableDescription, {}, false, true, 80, plainQueryTheme).join("\n");
  assert.match(descriptionLines, /1 columns · 1 indexes[\s\S]*Indexes[\s\S]*PRIMARY[\s\S]*DDL[\s\S]*CREATE TABLE users/);
  const dbList = __test__.databaseListView(["app", "test"], "srv", "mysql");
  assert.match(__test__.renderMetadataResultLines(dbList, {}, false, false, 80, plainQueryTheme).join("\n"), /2 databases[\s\S]*app[\s\S]*test/);
  const sources = __test__.sourceListView({ config_path: ".pi/databases.json", sources: [{ name: "srv", dialect: "mysql", default: true, host: "127.0.0.1", database: "db", allow_write_access: false, query_timeout_ms: 30000, max_rows: 100 }] });
  assert.match(__test__.renderMetadataResultLines(sources, {}, false, false, 80, plainQueryTheme).join("\n"), /1 sources[\s\S]*srv[\s\S]*mysql[\s\S]*127/);
  const pingComp = new __test__.PingResultComponent({ source: "srv", dialect: "mysql", ok: true, server_version: "8.0" }, {}, false, plainQueryTheme);
  assert.match(pingComp.render(80).join("\n"), /connected[\s\S]*8\.0/);
  const queryDetails = { source: "app", dialect: "mysql", row_count: 2, truncated: false, warnings: [], elapsed_ms: 12.34, columns: ["id", "name"], rows: [[1, "Lin"], [2, "Pi"]] };
  const wideLines = __test__.renderQueryResultLines({ query: "SELECT id, name FROM users" }, { details: queryDetails }, false, false, 80);
  assert.equal(wideLines.join("\n"), "SELECT\n  id,\n  name\nFROM users\n\nmysql · app · 2 rows · 12.3 ms\n\nid │ name\n───┼─────\n 1 │ Lin \n 2 │ Pi  ");
  assert.equal(wideLines.every((line: string) => [...line].length <= 80), true);
  const narrowLines = __test__.renderQueryData(queryDetails, false, 30, plainQueryTheme);
  assert.match(narrowLines.join("\n"), /#1\nid\s+│ 1\nname\s+│ Lin/);
  assert.equal(narrowLines.every((line: string) => [...line].length <= 30), true);
  const manyRows = { ...queryDetails, columns: ["id"], rows: Array.from({ length: 11 }, (_, id) => [id]) };
  assert.match(__test__.renderQueryData(manyRows, false, 80, plainQueryTheme).join("\n"), /… 1 more rows/);
  assert.doesNotMatch(__test__.renderQueryData(manyRows, true, 80, plainQueryTheme).join("\n"), /more rows/);
  assert.equal(__test__.formatElapsed(1236), "1.24 s");
  assert.equal(__test__.isNumericValue("4460.94"), true);
  assert.equal(__test__.isNumericValue("not-a-number"), false);
  assert.match(__test__.renderQueryResultLines({}, { details: { ...queryDetails, elapsed_ms: 1236 } }, false, false, 80).join("\n"), /1\.24 s/);
  const styledRows = __test__.renderQueryData({ ...queryDetails, columns: ["number", "empty", "null"], rows: [[1, "", null]] }, false, 80, { ...plainQueryTheme, number: (text: string) => `[n:${text}]`, empty: (text: string) => `[e:${text}]`, nullValue: (text: string) => `[z:${text}]` });
  assert.match(styledRows.join("\n"), /\[n:\s*1\]/);
  assert.match(styledRows.join("\n"), /\[e:\""/);
  assert.match(styledRows.join("\n"), /\[z:NULL/);
  assert.equal(__test__.writeResultColor({ blocked: true } as never, false), "warning");
  assert.equal(__test__.writeResultColor({ outcome: "unknown" } as never, false), "warning");
  assert.equal(__test__.writeResultColor({ blocked: true } as never, true), "error");
  assert.equal(__test__.writeResultColor({} as never, false), "toolOutput");
  assert.equal(__test__.writeQueueKey({ configPath: "config", name: "one" } as never), "config:one");
  __test__.registerTools(api as never);
  const expected = [
    "database_list_sources",
    "database_ping",
    "database_list_databases",
    "database_list_tables",
    "database_search_tables",
    "database_describe_table",
    "database_query",
    "database_write"
  ];
  assert.deepEqual(tools.map((tool) => tool.name), expected);
  assert.equal(tools.every((tool) => typeof tool.promptSnippet === "string" && tool.promptSnippet.length > 0), true);
  assert.equal(tools.every((tool) => Array.isArray(tool.promptGuidelines) && tool.promptGuidelines.length > 0), true);

  const nextSessionTools: string[] = [];
  __test__.registerTools({
    registerTool(tool: { name?: string }) {
      if (tool.name) nextSessionTools.push(tool.name);
    }
  } as never);
  assert.deepEqual(nextSessionTools, expected, "a replacement session must receive the complete database tool set");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-database-blocked-write-"));
  writeConfig(dir, {
    version: 1,
    default_source: "readonly_mysql",
    sources: [
      { name: "readonly_mysql", dialect: "mysql", allow_write_access: false, options: { host: "localhost", user: "reader" } }
    ]
  });
  const writeTool = tools.find((tool) => tool.name === "database_write");
  assert.equal(typeof writeTool?.execute, "function");
  const result = await writeTool!.execute!("test", { statement: "CREATE DATABASE app_db" }, undefined, () => {}, { cwd: dir, hasUI: false });
  const details = (result as { details: Record<string, unknown> }).details;
  assert.equal(details.blocked, true);
  assert.equal(details.allow_write_access, false);
  assert.match(String(details.reason), /Writes are disabled/);
  assert.match(String(details.next_action), /Stop\. Explain this source policy/);

  const events: string[] = [];
  let releaseFirst: (() => void) | undefined;
  const first = __test__.serializeWrite({ configPath: "config", name: "one" } as never, async () => {
    events.push("first-start");
    await new Promise<void>((resolve) => { releaseFirst = resolve; });
    events.push("first-end");
  });
  const second = __test__.serializeWrite({ configPath: "config", name: "one" } as never, async () => {
    events.push("second");
  });
  const other = __test__.serializeWrite({ configPath: "config", name: "two" } as never, async () => {
    events.push("other");
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(events, ["first-start", "other"]);
  releaseFirst!();
  await Promise.all([first, second, other]);
  assert.deepEqual(events, ["first-start", "other", "first-end", "second"]);
}

function testWriteBoundaries() {
  const mysql = {
    name: "mysql",
    dialect: "mysql" as const,
    allowWriteAccess: true,
    options: {},
    configPath: "unit",
    cacheKey: "mysql"
  };
  assert.equal(mysqlAdapter.validateWrite(mysql, "INSERT INTO users (id) VALUES (1)").statementKind, "insert");
  assert.equal(mysqlAdapter.validateWrite(mysql, "UPDATE users SET name = 'a' WHERE id = 1").statementKind, "update");
  assert.equal(mysqlAdapter.validateWrite(mysql, "CREATE TABLE audit_log (id bigint)").statementKind, "create");
  assert.equal(mysqlAdapter.validateWrite(mysql, "ALTER TABLE users ADD COLUMN nickname varchar(32)").statementKind, "alter");
  assert.throws(() => mysqlAdapter.validateWrite(mysql, "UPDATE users SET name = 'a'"), /WHERE clause/);
  assert.throws(() => mysqlAdapter.validateWrite(mysql, "INSERT INTO users SELECT id FROM archived"), /support only/);
  assert.throws(() => mysqlAdapter.validateWrite(mysql, "DELETE FROM users WHERE id = 1"), /support only/);
  assert.throws(() => mysqlAdapter.validateWrite(mysql, "ALTER TABLE users ADD COLUMN nickname varchar(32), DROP COLUMN old_name"), /destructive ALTER/);

  const clickhouse = {
    name: "clickhouse",
    dialect: "clickhouse" as const,
    allowWriteAccess: true,
    options: {},
    configPath: "unit",
    cacheKey: "clickhouse"
  };
  assert.equal(clickhouseAdapter.validateWrite(clickhouse, "INSERT INTO events (id) VALUES (1)").statementKind, "insert");
  assert.equal(clickhouseAdapter.validateWrite(clickhouse, "ALTER TABLE events ADD COLUMN name String").statementKind, "alter");
  assert.throws(() => clickhouseAdapter.validateWrite(clickhouse, "INSERT INTO events SELECT id FROM other_events"), /support only/);
  assert.throws(() => clickhouseAdapter.validateWrite(clickhouse, "ALTER TABLE events DELETE WHERE id = 1"), /destructive or mutation/);
  assert.throws(() => clickhouseAdapter.validateWrite(clickhouse, "CREATE TABLE events ON CLUSTER c (id UInt64)"), /ON CLUSTER/);
}

function testMigration() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-database-migrate-"));
  const configPath = writeConfig(dir, {
    mysql: { host: "127.0.0.1", user: "root", database: "app_db", allow_write_access: true, query_timeout_ms: 12_000, max_rows: 25 },
    clickhouse: { url: "http://localhost:8123", username: "default", database: "analytics", allow_write_access: false, send_receive_timeout: 45 }
  });
  assert.equal(findProjectConfigPath(dir), configPath);
  const migrated = migrateLegacyProjectConfig(dir);
  assert.equal(migrated.migrated, true);
  const config = loadProjectConfig(dir);
  assert.deepEqual(config.sources.map((source) => source.name), ["mysql_default", "clickhouse_default"]);
  assert.equal(config.sources[0]?.allowWriteAccess, true);
  assert.equal(config.sources[0]?.queryTimeoutMs, 12_000);
  assert.equal(config.sources[0]?.maxRows, 25);
  assert.equal(config.sources[1]?.queryTimeoutMs, 45_000);
  assert.equal(config.sources[1]?.maxRows, 100);
  assert.equal(migrateLegacyProjectConfig(dir).migrated, false);
}

testSqlScanner();
testResultLimits();
testInitializeConfig();
testSourceSelection();
testDatabaseContextPrompt();
await testToolPromptMetadata();
testWriteBoundaries();
testMigration();
console.log("pi-database self-check OK");
