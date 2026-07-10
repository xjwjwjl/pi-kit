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

function testInitializeConfig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-database-init-"));
  const result = initializeProjectConfig(dir);
  assert.equal(result.created, true);
  const config = JSON.parse(fs.readFileSync(result.configPath, "utf-8"));
  assert.equal(config.version, 1);
  assert.equal(config.sources.length, 2);
  assert.equal(config.sources.every((source: { allow_write_access: boolean }) => source.allow_write_access === false), true);
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
      { name: "app", dialect: "mysql", allow_write_access: false, options: { host: "localhost", user: "app", database: "app_db" } },
      { name: "analytics", dialect: "clickhouse", allow_write_access: true, options: { url: "http://localhost:8123", username: "analytics", database: "analytics" } }
    ]
  });
  const config = loadProjectConfig(dir);
  assert.equal(config.sources.length, 2);
  assert.equal(selectSource(config).name, "analytics");
  assert.equal(selectSource(config, "app").dialect, "mysql");
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
  assert.match(prompt, /instead of bash, mysql, clickhouse-client/);
  assert.match(prompt, /If database_write returns blocked or unsupported, stop/);
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
  assert.equal(__test__.writeResultColor({ blocked: true } as never, false), "warning");
  assert.equal(__test__.writeResultColor({ blocked: true } as never, true), "error");
  assert.equal(__test__.writeResultColor({} as never, false), "toolOutput");
  __test__.registerTools(api as never);
  const expected = [
    "database_list_sources",
    "database_ping",
    "database_list_databases",
    "database_list_tables",
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
    mysql: { host: "127.0.0.1", user: "root", database: "app_db", allow_write_access: true },
    clickhouse: { url: "http://localhost:8123", username: "default", database: "analytics", allow_write_access: false }
  });
  assert.equal(findProjectConfigPath(dir), configPath);
  const migrated = migrateLegacyProjectConfig(dir);
  assert.equal(migrated.migrated, true);
  const config = loadProjectConfig(dir);
  assert.deepEqual(config.sources.map((source) => source.name), ["mysql_default", "clickhouse_default"]);
  assert.equal(config.sources[0]?.allowWriteAccess, true);
  assert.equal(migrateLegacyProjectConfig(dir).migrated, false);
}

testSqlScanner();
testInitializeConfig();
testSourceSelection();
testDatabaseContextPrompt();
await testToolPromptMetadata();
testWriteBoundaries();
testMigration();
console.log("pi-database self-check OK");
