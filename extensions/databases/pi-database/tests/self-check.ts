import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildDatabaseContextPrompt,
  databaseStatusText,
  initializeProjectConfig,
  loadProjectConfig,
  selectSource,
  sourceWithDatabase
} from "../src/config.ts";
import { clickhouseAdapter } from "../src/clickhouse.ts";
import { mysqlAdapter } from "../src/mysql.ts";
import { createSourceTreeComponent } from "../src/source-tree.ts";
import type { SourceTreeNode } from "../src/source-tree.ts";
import { boundItems, boundRows, boundTableNames, resultLimits, truncateText } from "../src/results.ts";
import databaseExtension, { __test__ } from "../index.ts";
import { firstKeyword, hasMultipleStatements, hasTopLevelComma, hasTopLevelKeyword, normalizeSql } from "../src/sql.ts";

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
  assert.equal(hasTopLevelComma("ALTER TABLE events DELETE WHERE id = 1"), false);
  assert.equal(hasTopLevelComma("ALTER TABLE events DELETE WHERE id = 1, UPDATE flag = 1 WHERE id = 2"), true);
  assert.equal(hasTopLevelComma("ALTER TABLE events DELETE WHERE name = 'a,b'"), false);
  assert.equal(hasTopLevelComma("ALTER TABLE events DELETE WHERE id IN (1, 2)"), false);
  assert.equal(hasTopLevelComma("ALTER TABLE events DELETE WHERE id = 1 -- , UPDATE flag = 1"), false);
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
  assert.equal(config.sources.every((source: { allow_write: boolean }) => source.allow_write === true), true);
  assert.equal(config.sources.every((source: { write_confirm: boolean }) => source.write_confirm === false), true);
  assert.equal(config.sources.every((source: { query_timeout_ms: number }) => source.query_timeout_ms === 30_000), true);
  assert.equal(config.sources.every((source: { max_rows: number }) => source.max_rows === 100), true);
  assert.equal(config.sources.every((source: { options: Record<string, unknown> }) => source.options.database === ""), true);
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
      { name: "app", dialect: "mysql", allow_write: false, write_confirm: true, query_timeout_ms: 12_000, max_rows: 25, options: { host: "localhost", user: "app", database: "app_db" } },
      { name: "analytics", dialect: "clickhouse", allow_write: true, write_confirm: false, query_timeout_ms: 45_000, max_rows: 999, options: { url: "http://localhost:8123", username: "analytics", database: "analytics" } }
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
  assert.equal(selectSource(config, "app").allowWrite, false);
  assert.equal(selectSource(config, "app").writeConfirm, true);
  assert.equal(selectSource(config, "analytics").allowWrite, true);
  assert.equal(selectSource(config, "analytics").writeConfirm, false);
  const querySource = sourceWithDatabase(selectSource(config, "app"), "reporting");
  assert.equal(querySource.options.database, "reporting");
  assert.equal(selectSource(config, "app").options.database, "app_db");
  assert.notEqual(querySource.cacheKey, selectSource(config, "app").cacheKey);
  assert.throws(() => selectSource(config, "missing"), /Unknown database source/);

  const ambiguous = fs.mkdtempSync(path.join(os.tmpdir(), "pi-database-ambiguous-"));
  writeConfig(ambiguous, {
    version: 1,
    sources: [
      { name: "one", dialect: "mysql", options: { host: "localhost", user: "one" } },
      { name: "two", dialect: "clickhouse", options: { url: "http://localhost:8123", username: "two" } }
    ]
  });
  const ambiguousConfig = loadProjectConfig(ambiguous);
  assert.equal(ambiguousConfig.sources[0]?.allowWrite, true);
  assert.equal(ambiguousConfig.sources[0]?.writeConfirm, false);
  assert.throws(() => selectSource(ambiguousConfig), /Multiple database sources/);

  const dotted = fs.mkdtempSync(path.join(os.tmpdir(), "pi-database-dotted-"));
  writeConfig(dotted, { version: 1, sources: [{ name: "mysql-192.168.27.148", dialect: "mysql", options: { host: "localhost", user: "u" } }] });
  assert.equal(selectSource(loadProjectConfig(dotted)).name, "mysql-192.168.27.148");
}

async function testDynamicRegistration() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-database-dynamic-"));
  const handlers = new Map<string, Array<(event: any, ctx: any) => Promise<unknown> | unknown>>();
  const tools: string[] = [];
  const commands: string[] = [];
  const statuses: Array<string | undefined> = [];
  databaseExtension({
    on(event: string, handler: (event: any, ctx: any) => Promise<unknown> | unknown) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerTool(tool: { name?: string }) {
      if (tool.name) tools.push(tool.name);
    },
    registerCommand(name: string) {
      commands.push(name);
    }
  } as never);
  const ctx = { cwd: dir, ui: { setStatus(_name: string, value: string | undefined) { statuses.push(value); }, theme: { fg: (_color: string, text: string) => text } } };
  assert.deepEqual(commands, ["database-init", "database-status"]);
  await handlers.get("session_start")![0]!({}, ctx);
  assert.deepEqual(tools, []);
  assert.deepEqual(statuses, [undefined]);

  writeConfig(dir, { version: 1, sources: [{ name: "app", dialect: "mysql", options: { host: "localhost", user: "app" } }] });
  await handlers.get("before_agent_start")![0]!({ cwd: dir, systemPrompt: "base" }, ctx);
  assert.equal(tools.length, 8);
  assert.deepEqual(commands, ["database-init", "database-status"]);

  // A config file that fails to load keeps tools registered but surfaces the
  // config error in the status instead of claiming there is no config.
  writeConfig(dir, { version: 1, sources: [{ name: "bad", dialect: "unsupported", options: {} }] });
  await handlers.get("session_start")![0]!({}, ctx);
  assert.equal(tools.length, 8);
  assert.deepEqual(statuses, [undefined, "database: config error"]);
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
  assert.match(prompt, /use the database_\* tool family/);
  assert.doesNotMatch(prompt, /mysql, clickhouse-client/);
  assert.match(prompt, /If database_write returns blocked or unsupported, stop/);
  assert.match(prompt, /outcome is unknown/);
  assert.match(prompt, /default source selects only the connection, never a database/);
  assert.match(prompt, /database_query and database_list_tables, always pass database/);
  assert.match(prompt, /If the database is unknown, call database_list_databases first/);
  assert.match(prompt, /CREATE MATERIALIZED VIEW/);
  assert.match(prompt, /INSERT \.\.\. SELECT/);
  const noConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-database-no-prompt-"));
  assert.equal(buildDatabaseContextPrompt(noConfigDir), undefined);
}

async function testToolPromptMetadata() {
  const tools: Array<{ name?: string; promptSnippet?: string; promptGuidelines?: string[]; parameters?: Record<string, unknown>; renderCall?: (...args: unknown[]) => { render(width: number): string[] }; execute?: (...args: unknown[]) => Promise<unknown> }> = [];
  const api = {
    registerTool(tool: { name?: string; promptSnippet?: string; promptGuidelines?: string[]; parameters?: Record<string, unknown>; renderCall?: (...args: unknown[]) => { render(width: number): string[] }; execute?: (...args: unknown[]) => Promise<unknown> }) {
      tools.push(tool);
    }
  };
  const { __test__ } = await import("../index.ts");
  assert.equal(__test__.formatSqlForUi("SELECT id, name FROM users WHERE active = 1 ORDER BY id LIMIT 10"), "SELECT\n  id,\n  name\nFROM users\nWHERE active = 1\nORDER BY id\nLIMIT 10");
  assert.equal(
    __test__.formatSqlForUi("SELECT database, table, formatReadableSize(total_bytes) AS size, total_rows, formatReadableSize(total_bytes_uncompressed) AS uncompressed FROM ( SELECT database, table, sum(bytes_on_disk) AS total_bytes, sum(rows) AS total_rows, sum(data_uncompressed_bytes) AS total_bytes_uncompressed FROM system.parts WHERE active GROUP BY database, table ) ORDER BY total_bytes DESC LIMIT 15"),
    "SELECT\n  database,\n  table,\n  formatReadableSize(total_bytes) AS size,\n  total_rows,\n  formatReadableSize(total_bytes_uncompressed) AS uncompressed\nFROM (\n  SELECT\n    database,\n    table,\n    sum(bytes_on_disk) AS total_bytes,\n    sum(rows) AS total_rows,\n    sum(data_uncompressed_bytes) AS total_bytes_uncompressed\n  FROM system.parts\n  WHERE active\n  GROUP BY database, table\n)\nORDER BY total_bytes DESC\nLIMIT 15"
  );
  assert.equal(
    __test__.formatSqlForUi("WITH dept_avg AS ( SELECT department, avg(salary) AS avg_sal FROM test_demo WHERE department != '' GROUP BY department ), top_rows AS ( SELECT * FROM dept_avg WHERE avg_sal > 0 ) SELECT * FROM top_rows ORDER BY department"),
    "WITH\n  dept_avg AS (\n    SELECT\n      department,\n      avg(salary) AS avg_sal\n    FROM test_demo\n    WHERE department != ''\n    GROUP BY department\n  ),\n  top_rows AS (\n    SELECT *\n    FROM dept_avg\n    WHERE avg_sal > 0\n  )\nSELECT *\nFROM top_rows\nORDER BY department"
  );
  assert.equal(
    __test__.formatSqlForUi("SELECT id, (SELECT max(score) FROM scores WHERE scores.user_id = users.id) AS max_score FROM users WHERE id IN (SELECT user_id FROM orders WHERE total > 100)"),
    "SELECT\n  id,\n  (\n    SELECT max(score)\n    FROM scores\n    WHERE scores.user_id = users.id\n  ) AS max_score\nFROM users\nWHERE id IN (\n  SELECT user_id\n  FROM orders\n  WHERE total > 100\n)"
  );
  assert.equal(
    __test__.formatSqlForUi("SELECT department, avg(salary) AS avg_sal FROM employees GROUP BY department HAVING avg(salary) > 10000 UNION ALL SELECT department, avg(salary) AS avg_sal FROM contractors GROUP BY department"),
    "SELECT\n  department,\n  avg(salary) AS avg_sal\nFROM employees\nGROUP BY department\nHAVING avg(salary) > 10000\nUNION ALL\nSELECT\n  department,\n  avg(salary) AS avg_sal\nFROM contractors\nGROUP BY department"
  );
  assert.equal(__test__.formatSqlForUi("SELECT * FROM events PREWHERE date >= today() - 7 WHERE active QUALIFY score > 0 LIMIT BY user_id LIMIT 10 OFFSET 5"), "SELECT *\nFROM events\nPREWHERE date >= today() - 7\nWHERE active\nQUALIFY score > 0\nLIMIT BY user_id\nLIMIT 10\nOFFSET 5");
  assert.equal(__test__.formatWriteSqlForUi("UPDATE users SET enabled = 0 WHERE id = 42"), "UPDATE users\nSET enabled = 0\nWHERE id = 42");
  assert.equal(__test__.formatWriteSqlForUi("INSERT INTO users (id, name) VALUES (1, 'Lin'), (2, 'Pi')"), "INSERT INTO users (id, name)\nVALUES\n  (1, 'Lin'),\n  (2, 'Pi')");
  assert.equal(__test__.formatWriteSqlForUi("CREATE TABLE audit_log (id bigint, created_at timestamp)"), "CREATE TABLE audit_log (\n  id bigint,\n  created_at timestamp\n)");
  const confirmationSource = { name: "app_mysql", dialect: "mysql" } as never;
  for (const statementKind of ["insert", "update", "delete", "create", "alter"] as const) {
    const confirmation = __test__.buildWriteConfirmation(confirmationSource, { statement: "UPDATE users SET enabled = 0 WHERE id = 42", statementKind, databaseRequired: true });
    assert.equal(confirmation.title, `Database Write · ${statementKind.toUpperCase()} · MySQL`);
    assert.match(confirmation.message, new RegExp(`Action: ${statementKind.toUpperCase()}`));
    assert.match(confirmation.message, /SQL:\nUPDATE users\nSET enabled = 0\nWHERE id = 42/);
    assert.doesNotMatch(confirmation.message, /Risk:/);
    assert.match(confirmation.message, /Enter confirms execution · Esc cancels/);
  }
  const updateConfirmation = __test__.buildWriteConfirmation(confirmationSource, { statement: "UPDATE users SET enabled = 0 WHERE id = 42", statementKind: "update", databaseRequired: true }, "app_db");
  const confirmationTheme = {
    fg: (color: string, text: string) => `[${color}:${text}]`,
    bold: (text: string) => `*${text}*`
  };
  let confirmationDecision: boolean | undefined;
  const confirmationComponent = __test__.createWriteConfirmationComponent(updateConfirmation, confirmationTheme, (confirmed: boolean) => { confirmationDecision = confirmed; });
  const confirmationLines = confirmationComponent.render(80);
  assert.match(confirmationLines.join("\n"), /\[warning:\*Database Write · UPDATE · MySQL\*\]/);
  assert.match(confirmationLines.join("\n"), /\[accent:app_mysql\]/);
  assert.match(confirmationLines.join("\n"), /\[warning:UPDATE\]/);
  assert.match(confirmationLines.join("\n"), /\[success:Enter\]/);
  const plainConfirmationComponent = __test__.createWriteConfirmationComponent(updateConfirmation, { fg: (_color: string, text: string) => text, bold: (text: string) => text }, () => {});
  assert.equal(plainConfirmationComponent.render(80).every((line: string) => [...line].length <= 80), true);
  confirmationComponent.handleInput("enter");
  assert.equal(confirmationDecision, true);
  const cancelComponent = __test__.createWriteConfirmationComponent(updateConfirmation, confirmationTheme, (confirmed: boolean) => { confirmationDecision = confirmed; });
  cancelComponent.handleInput("escape");
  assert.equal(confirmationDecision, false);
  const resultDetails = { source: "app_mysql", dialect: "mysql" as const, database: "app_db", executed: true, cancelled: false, statement_kind: "update" as const, affected_rows: 2, changed_rows: 1, warning_count: 1, query_id: "mysql-query-1", requested_statement: "UPDATE users SET status = 'disabled' WHERE id = 42" };
  assert.equal(
    __test__.formatWrite(resultDetails),
    "UPDATE users\nSET status = 'disabled'\nWHERE id = 42\n\nSuccess · affected 2 · changed 1\nTarget: mysql · app_mysql · app_db\nWarnings: 1\nQuery ID: mysql-query-1"
  );
  assert.match(__test__.formatWrite({ ...resultDetails, blocked: true, executed: false, cancelled: false, reason: "Writes are disabled.", next_action: "Stop." }), /UPDATE users\nSET status = 'disabled'\nWHERE id = 42\n\nWrite blocked: Writes are disabled\./);
  assert.match(__test__.formatWrite({ ...resultDetails, outcome: "unknown", executed: false, cancelled: false, reason: "Connection lost.", next_action: "Verify first." }), /Target: mysql · app_mysql · app_db\nWrite outcome unknown: Connection lost\./);
  const cardTheme = {
    fg: (color: string, text: string) => `[${color}:${text}]`,
    bold: (text: string) => `*${text}*`
  };
  const compactCard = __test__.createWriteResultComponent(resultDetails, false, cardTheme);
  const compactCardText = compactCard.render(120).join("\n");
  assert.match(compactCardText, /UPDATE users\nSET status = 'disabled'\nWHERE id = 42\n\n\[accent:Success\]\[muted: · affected 2 · changed 1\]/);
  assert.doesNotMatch(compactCard.render(120).join("\n"), /Query ID|Warnings/);
  const expandedCard = __test__.createWriteResultComponent(resultDetails, true, cardTheme);
  assert.match(expandedCard.render(120).join("\n"), /Warnings: 1[\s\S]*Query ID: mysql-query-1/);
  const skippedConfirmationDetails = { ...resultDetails, write_confirm: false };
  assert.match(__test__.formatWrite(skippedConfirmationDetails), /Confirmation: skipped by source policy/);
  assert.match(__test__.createWriteResultComponent(skippedConfirmationDetails, true, cardTheme).render(120).join("\n"), /Confirmation: skipped by source policy/);
  const cancelledResultDetails = { ...resultDetails, executed: false, cancelled: true };
  assert.equal(
    __test__.formatWrite(cancelledResultDetails),
    "UPDATE users\nSET status = 'disabled'\nWHERE id = 42\n\nCancelled"
  );
  const cancelledCard = __test__.createWriteResultComponent(cancelledResultDetails, false, cardTheme);
  const cancelledCardText = cancelledCard.render(120).join("\n");
  assert.match(cancelledCardText, /UPDATE users\nSET status = 'disabled'\nWHERE id = 42\n\n\[warning:Cancelled\]/);
  assert.doesNotMatch(cancelledCardText, /app_mysql|mysql/);
  const plainQueryTheme = { output: (text: string) => text, muted: (text: string) => text, accent: (text: string) => text, success: (text: string) => text, border: (text: string) => text, error: (text: string) => text, number: (text: string) => text, nullValue: (text: string) => text, empty: (text: string) => text, sql: (text: string) => text.split("\n") };
  const tableList = __test__.tableListView({ source: "app", dialect: "mysql", database: "main", tables: ["users", "orders"], truncated: false });
  assert.match(__test__.renderMetadataResultLines(tableList, {}, false, false, 80, plainQueryTheme).join("\n"), /2 tables[\s\S]*users[\s\S]*orders/);
  const tableSearch = __test__.tableSearchView({ source: "app", dialect: "mysql", matches: [{ database: "main", table: "users", engine: "InnoDB", comment: "accounts" }], truncated: false });
  assert.match(__test__.renderMetadataResultLines(tableSearch, {}, false, false, 80, plainQueryTheme).join("\n"), /1 matches[\s\S]*InnoDB[\s\S]*accounts/);
  const tableDescription = __test__.tableDescriptionView({ source: "app", dialect: "mysql", database: "main", table: "users", engine: "InnoDB", columns: [{ position: 1, name: "id", type: "bigint", nullable: false }], indexes: [{ name: "PRIMARY", columns: ["id"], unique: true }], create_statement: "CREATE TABLE users (id bigint)", truncated: false, warnings: [] });
  const descriptionLines = __test__.renderMetadataResultLines(tableDescription, {}, false, true, 80, plainQueryTheme).join("\n");
  assert.match(descriptionLines, /InnoDB · 1 columns · 1 indexes[\s\S]*Indexes[\s\S]*PRIMARY[\s\S]*DDL[\s\S]*CREATE TABLE users/);
  const dbList = __test__.databaseListView(["app", "test"], "srv", "mysql");
  assert.match(__test__.renderMetadataResultLines(dbList, {}, false, false, 80, plainQueryTheme).join("\n"), /2 databases[\s\S]*app[\s\S]*test/);
  const truncatedDbList = __test__.databaseListView(["app", "test"], "srv", "mysql", true);
  assert.match(__test__.renderMetadataResultLines(truncatedDbList, {}, false, false, 80, plainQueryTheme).join("\n"), /truncated/);
  const sources = __test__.sourceListView({ config_path: ".pi/databases.json", sources: [{ name: "srv", dialect: "mysql", default: true, host: "127.0.0.1", database: "db", allow_write: false, write_confirm: true, query_timeout_ms: 30000, max_rows: 100 }] });
  assert.match(__test__.renderMetadataResultLines(sources, {}, false, false, 80, plainQueryTheme).join("\n"), /1 sources[\s\S]*srv[\s\S]*mysql[\s\S]*127/);
  const styledSourceTheme = { ...plainQueryTheme, success: (text: string) => `[success:${text}]`, muted: (text: string) => `[muted:${text}]` };
  const sourceStates = __test__.sourceListView({ config_path: ".pi/databases.json", sources: [
    { name: "default_srv", dialect: "mysql", default: true, host: "localhost", database: undefined, allow_write: false, write_confirm: true, query_timeout_ms: 30000, max_rows: 100 },
    { name: "other_srv", dialect: "mysql", default: false, host: "localhost", database: undefined, allow_write: false, write_confirm: true, query_timeout_ms: 30000, max_rows: 100 }
  ] });
  const sourceStateText = __test__.renderMetadataResultLines(sourceStates, {}, false, false, 120, styledSourceTheme).join("\n");
  assert.match(sourceStateText, /\[success:default\]/);
  assert.match(sourceStateText, /\[muted:—/);
  const pingComp = new __test__.PingResultComponent({ source: "srv", dialect: "mysql", ok: true, server_version: "8.0", latency_ms: 12.4 }, {}, false, plainQueryTheme);
  assert.match(pingComp.render(80).join("\n"), /connected · 8\.0 · 12\.4 ms/);
  const slowPingComp = new __test__.PingResultComponent({ source: "srv", dialect: "mysql", ok: true, latency_ms: 1236 }, {}, false, plainQueryTheme);
  assert.match(slowPingComp.render(80).join("\n"), /connected · 1\.24 s/);
  const queryDetails = { source: "app", dialect: "mysql", database: "app_db", row_count: 2, truncated: false, warnings: [], elapsed_ms: 12.34, columns: ["id", "name"], rows: [[1, "Lin"], [2, "Pi"]] };
  const wideLines = __test__.renderQueryResultLines({ query: "SELECT id, name FROM users" }, { details: queryDetails }, false, false, 80);
  assert.equal(wideLines.join("\n"), "SELECT\n  id,\n  name\nFROM users\n\nid │ name\n───┼─────\n 1 │ Lin \n 2 │ Pi  \n\n2 rows · 12.3 ms");
  assert.equal(wideLines.every((line: string) => [...line].length <= 80), true);
  assert.match(__test__.renderQueryResultLines({ query: "SELECT id, name FROM users" }, { details: { ...queryDetails, query_id: "mysql-query-1" } }, false, true, 80).join("\n"), /Query ID: mysql-query-1/);
  const narrowLines = __test__.renderQueryData(queryDetails, false, 30, plainQueryTheme);
  assert.match(narrowLines.join("\n"), /id │ name/);
  assert.equal(narrowLines.every((line: string) => [...line].length <= 30), true);
  const packedColumns = Array.from({ length: 10 }, (_, index) => `c${index}`);
  assert.match(__test__.renderQueryData({ ...queryDetails, columns: packedColumns, rows: [packedColumns.map(() => "v")] }, false, 30, plainQueryTheme).join("\n"), /#1\nc0\s+│ v/);
  assert.doesNotMatch(__test__.renderQueryData({ ...queryDetails, columns: ["name"], rows: [["x".repeat(100)]] }, false, 80, plainQueryTheme).join("\n"), /\x1b\[0m/);
  const manyRows = { ...queryDetails, columns: ["id"], rows: Array.from({ length: 11 }, (_, id) => [id]) };
  const collapsedRows = __test__.renderQueryData(manyRows, false, 80, plainQueryTheme).join("\n");
  assert.match(collapsedRows, /\.\.\.\n1 more rows/);
  assert.match(collapsedRows, /app\.tools\.expand/);
  const collapsedQuery = __test__.renderQueryResultLines({ query: "SELECT id FROM users" }, { details: { ...manyRows, row_count: 11 } }, false, false, 80).join("\n");
  assert.match(collapsedQuery, /\.\.\.\n1 more rows \(\[app\.tools\.expand:to expand\]\)\n\n11 rows/);
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
  assert.equal(tools.find((tool) => tool.name === "database_ping")?.promptGuidelines, undefined);
  assert.equal(tools.filter((tool) => tool.name !== "database_ping").every((tool) => Array.isArray(tool.promptGuidelines) && tool.promptGuidelines.length > 0), true);
  assert.deepEqual(
    tools.find((tool) => tool.name === "database_query")?.promptGuidelines,
    ["Use database_query only for a single read-only SQL query and always pass database."]
  );
  assert.equal(
    (tools.find((tool) => tool.name === "database_query")?.parameters?.database as { description?: unknown } | undefined)?.description,
    "Database to use for this query; required on every call"
  );
  assert.deepEqual(
    tools.find((tool) => tool.name === "database_list_databases")?.promptGuidelines,
    ["Use database_list_databases to list database/catalog namespaces visible to a configured source."]
  );
  assert.match(
    tools.find((tool) => tool.name === "database_write")?.promptGuidelines?.join(" ") ?? "",
    /requires database for table-scoped writes/
  );
  assert.match(
    tools.find((tool) => tool.name === "database_write")?.promptGuidelines?.join(" ") ?? "",
    /CREATE MATERIALIZED VIEW/
  );
  assert.match(
    tools.find((tool) => tool.name === "database_write")?.promptGuidelines?.join(" ") ?? "",
    /INSERT \.\.\. SELECT/
  );
  assert.equal(
    (tools.find((tool) => tool.name === "database_write")?.parameters?.database as { description?: unknown } | undefined)?.description,
    "Database for table-scoped writes; omit only for CREATE DATABASE and DROP DATABASE"
  );

  const callTitleDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-database-call-title-"));
  writeConfig(callTitleDir, {
    version: 1,
    default_source: "mysql_localhost",
    sources: [{ name: "mysql_localhost", dialect: "mysql", options: { host: "localhost", user: "reader" } }]
  });
  const callTheme = {
    fg: (color: string, text: string) => `[${color}:${text}]`,
    bold: (text: string) => `*${text}*`
  };
  const renderCall = (name: string, args: Record<string, unknown>) => {
    const tool = tools.find((item) => item.name === name);
    assert.equal(typeof tool?.renderCall, "function");
    return tool!.renderCall!(args, callTheme, { cwd: callTitleDir, lastComponent: undefined }).render(160).join("\n");
  };
  assert.match(renderCall("database_list_sources", {}), /^\[toolTitle:\*Database Sources\*\]$/);
  assert.match(renderCall("database_ping", { source: "mysql_localhost" }), /Ping.*\[muted: · MySQL\].*\[accent: · mysql_localhost\]/);
  assert.match(renderCall("database_list_databases", { source: "mysql_localhost" }), /Databases.*mysql_localhost/);
  assert.match(renderCall("database_list_tables", { source: "mysql_localhost", database: "app_db" }), /Tables.*mysql_localhost.*app_db/);
  assert.match(renderCall("database_search_tables", { source: "mysql_localhost", term: "users" }), /Find tables.*mysql_localhost.*users/);
  assert.match(renderCall("database_describe_table", { source: "mysql_localhost", database: "app_db", table: "users" }), /Describe.*mysql_localhost.*app_db\.users/);
  assert.match(renderCall("database_query", { source: "mysql_localhost", database: "app_db", query: "SELECT 1" }), /Query.*\[muted: · MySQL\].*\[accent: · mysql_localhost\].*app_db/);
  assert.match(renderCall("database_write", { source: "mysql_localhost", database: "app_db", statement: "INSERT INTO users (id) VALUES (1)" }), /Write.*mysql_localhost.*app_db.*INSERT/);

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
      { name: "readonly_mysql", dialect: "mysql", allow_write: false, options: { host: "localhost", user: "reader" } }
    ]
  });
  const queryTool = tools.find((tool) => tool.name === "database_query");
  assert.equal(typeof queryTool?.execute, "function");
  await assert.rejects(
    () => queryTool!.execute!("test", { query: "SELECT 1" }, undefined, () => {}, { cwd: dir, hasUI: false }),
    /database_query requires a database argument/
  );
  const writeTool = tools.find((tool) => tool.name === "database_write");
  assert.equal(typeof writeTool?.execute, "function");
  const result = await writeTool!.execute!("test", { statement: "CREATE DATABASE app_db" }, undefined, () => {}, { cwd: dir, hasUI: false });
  const details = (result as { details: Record<string, unknown>; content: Array<{ text?: string }> }).details;
  assert.equal(details.blocked, true);
  assert.match(String((result as { content: Array<{ text?: string }> }).content[0]?.text), /CREATE DATABASE app_db/);
  assert.equal(details.allow_write, false);
  assert.equal(details.write_confirm, false);
  assert.match(String(details.reason), /Writes are disabled/);
  assert.match(String(details.next_action), /Stop\. Explain this source policy/);

  const confirmationDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-database-confirmed-write-"));
  writeConfig(confirmationDir, {
    version: 1,
    default_source: "writer_mysql",
    sources: [
      { name: "writer_mysql", dialect: "mysql", allow_write: true, write_confirm: true, options: { host: "localhost", user: "writer" } }
    ]
  });
  let confirmation: { title?: string; message?: string } = {};
  const missingDatabaseWrite = await writeTool!.execute!("test", { statement: "UPDATE users SET enabled = 0 WHERE id = 42" }, undefined, () => {}, { cwd: confirmationDir, hasUI: false });
  const missingDatabaseDetails = (missingDatabaseWrite as { details: Record<string, unknown> }).details;
  assert.equal(missingDatabaseDetails.blocked, true);
  assert.match(String(missingDatabaseDetails.reason), /requires a database argument/);
  const cancelledWrite = await writeTool!.execute!("test", { database: "app_db", statement: "UPDATE users SET enabled = 0 WHERE id = 42" }, undefined, () => {}, {
    cwd: confirmationDir,
    hasUI: true,
    ui: {
      confirm(title: string, message: string) {
        confirmation = { title, message };
        return false;
      }
    }
  });
  const cancelledDetails = (cancelledWrite as { details: Record<string, unknown> }).details;
  assert.equal(cancelledDetails.cancelled, true);
  assert.equal(cancelledDetails.write_confirm, true);
  assert.equal(cancelledDetails.requested_statement, "UPDATE users SET enabled = 0 WHERE id = 42");
  assert.equal(confirmation.title, "Database Write · UPDATE · MySQL");
  assert.match(confirmation.message ?? "", /Database: app_db/);
  assert.match(confirmation.message ?? "", /SQL:\nUPDATE users\nSET enabled = 0\nWHERE id = 42/);
  assert.doesNotMatch(confirmation.message ?? "", /Risk:/);

  const noConfirmationDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-database-no-confirmation-write-"));
  writeConfig(noConfirmationDir, {
    version: 1,
    default_source: "local_mysql",
    sources: [
      { name: "local_mysql", dialect: "mysql", allow_write: true, write_confirm: false, options: { host: "localhost", user: "writer" } }
    ]
  });
  const originalWrite = mysqlAdapter.write;
  let writes = 0;
  const writeDatabases: Array<string | undefined> = [];
  mysqlAdapter.write = async (source, database, write) => {
    writes += 1;
    writeDatabases.push(database);
    return {
      source: source.name,
      dialect: source.dialect,
      database,
      executed: true,
      cancelled: false,
      statement_kind: write.statementKind,
      affected_rows: 1
    };
  };
  try {
    const skippedConfirmationWrite = await writeTool!.execute!("test", { database: "app_db", statement: "INSERT INTO users (id) VALUES (1)" }, undefined, () => {}, { cwd: noConfirmationDir, hasUI: false });
    const skippedConfirmationDetails = (skippedConfirmationWrite as { details: Record<string, unknown>; content: Array<{ text?: string }> }).details;
    assert.equal(writes, 1);
    assert.deepEqual(writeDatabases, ["app_db"]);
    assert.equal(skippedConfirmationDetails.executed, true);
    assert.equal(skippedConfirmationDetails.database, "app_db");
    assert.equal(skippedConfirmationDetails.write_confirm, false);
    assert.match(String((skippedConfirmationWrite as { content: Array<{ text?: string }> }).content[0]?.text), /Confirmation: skipped by source policy/);
    const createDatabaseWrite = await writeTool!.execute!("test", { statement: "CREATE DATABASE smoke_test" }, undefined, () => {}, { cwd: noConfirmationDir, hasUI: false });
    assert.equal((createDatabaseWrite as { details: Record<string, unknown> }).details.executed, true);
    assert.deepEqual(writeDatabases, ["app_db", undefined]);

    const unconfirmedInsertSelect = await writeTool!.execute!("test", { database: "app_db", statement: "INSERT INTO users (id) SELECT id FROM archived_users" }, undefined, () => {}, { cwd: noConfirmationDir, hasUI: false });
    const unconfirmedInsertSelectDetails = (unconfirmedInsertSelect as { details: Record<string, unknown> }).details;
    assert.equal(writes, 2);
    assert.equal(unconfirmedInsertSelectDetails.executed, false);
    assert.equal(unconfirmedInsertSelectDetails.forced_confirm, true);
    assert.match(String(unconfirmedInsertSelectDetails.reason), /Interactive confirmation is required/);

    let insertSelectConfirmation: { title?: string; message?: string } = {};
    const confirmedInsertSelect = await writeTool!.execute!("test", { database: "app_db", statement: "INSERT INTO users (id) SELECT id FROM archived_users" }, undefined, () => {}, {
      cwd: noConfirmationDir,
      hasUI: true,
      ui: {
        confirm(title: string, message: string) {
          insertSelectConfirmation = { title, message };
          return true;
        }
      }
    });
    const confirmedInsertSelectDetails = (confirmedInsertSelect as { details: Record<string, unknown> }).details;
    assert.equal(writes, 3);
    assert.equal(confirmedInsertSelectDetails.executed, true);
    assert.equal(confirmedInsertSelectDetails.forced_confirm, true);
    assert.equal(insertSelectConfirmation.title, "Database Write · INSERT · MySQL");
  } finally {
    mysqlAdapter.write = originalWrite;
  }

  const materializedViewDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-database-materialized-view-"));
  writeConfig(materializedViewDir, {
    version: 1,
    default_source: "analytics",
    sources: [
      { name: "analytics", dialect: "clickhouse", allow_write: true, write_confirm: false, options: { url: "http://localhost:8123", username: "writer" } }
    ]
  });
  const originalClickHouseWrite = clickhouseAdapter.write;
  let materializedViewWrites = 0;
  clickhouseAdapter.write = async (source, database, write) => {
    materializedViewWrites += 1;
    return {
      source: source.name,
      dialect: source.dialect,
      database,
      executed: true,
      cancelled: false,
      statement_kind: write.statementKind
    };
  };
  try {
    const materializedViewWrite = await writeTool!.execute!("test", {
      database: "analytics",
      statement: "CREATE MATERIALIZED VIEW event_counts TO event_counts_target AS SELECT event_type, count() AS total FROM events GROUP BY event_type"
    }, undefined, () => {}, { cwd: materializedViewDir, hasUI: false });
    const materializedViewDetails = (materializedViewWrite as { details: Record<string, unknown> }).details;
    assert.equal(materializedViewWrites, 1);
    assert.equal(materializedViewDetails.executed, true);
    assert.equal(materializedViewDetails.statement_kind, "create");
    assert.equal(materializedViewDetails.write_confirm, false);
    assert.equal(materializedViewDetails.forced_confirm, undefined);

    const clusteredMaterializedView = await writeTool!.execute!("test", {
      database: "analytics",
      statement: "CREATE MATERIALIZED VIEW event_counts_cluster ON CLUSTER analytics_cluster TO event_counts_target AS SELECT event_type FROM events"
    }, undefined, () => {}, { cwd: materializedViewDir, hasUI: false });
    const clusteredMaterializedViewDetails = (clusteredMaterializedView as { details: Record<string, unknown> }).details;
    assert.equal(materializedViewWrites, 2);
    assert.equal(clusteredMaterializedViewDetails.executed, true);
    assert.equal(clusteredMaterializedViewDetails.write_confirm, false);
    assert.equal(clusteredMaterializedViewDetails.forced_confirm, undefined);

    const unconfirmedClickHouseInsertSelect = await writeTool!.execute!("test", {
      database: "analytics",
      statement: "INSERT INTO event_counts_target SELECT event_type FROM events"
    }, undefined, () => {}, { cwd: materializedViewDir, hasUI: false });
    const unconfirmedClickHouseInsertSelectDetails = (unconfirmedClickHouseInsertSelect as { details: Record<string, unknown> }).details;
    assert.equal(materializedViewWrites, 2);
    assert.equal(unconfirmedClickHouseInsertSelectDetails.executed, false);
    assert.equal(unconfirmedClickHouseInsertSelectDetails.forced_confirm, true);
    assert.match(String(unconfirmedClickHouseInsertSelectDetails.reason), /Interactive confirmation is required/);

    let replacementConfirmation: { title?: string; message?: string } = {};
    const replacementMaterializedView = await writeTool!.execute!("test", {
      database: "analytics",
      statement: "CREATE OR REPLACE MATERIALIZED VIEW event_counts TO event_counts_target AS SELECT event_type FROM events"
    }, undefined, () => {}, {
      cwd: materializedViewDir,
      hasUI: true,
      ui: {
        confirm(title: string, message: string) {
          replacementConfirmation = { title, message };
          return true;
        }
      }
    });
    const replacementMaterializedViewDetails = (replacementMaterializedView as { details: Record<string, unknown> }).details;
    assert.equal(materializedViewWrites, 3);
    assert.equal(replacementMaterializedViewDetails.executed, true);
    assert.equal(replacementMaterializedViewDetails.forced_confirm, true);
    assert.equal(replacementConfirmation.title, "Database Write · CREATE · ClickHouse");
  } finally {
    clickhouseAdapter.write = originalClickHouseWrite;
  }

  const deletePolicyDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-database-delete-confirmation-"));
  writeConfig(deletePolicyDir, {
    version: 1,
    default_source: "cleanup_mysql",
    sources: [
      { name: "cleanup_mysql", dialect: "mysql", allow_write: true, write_confirm: false, options: { host: "localhost", user: "writer" } }
    ]
  });
  const originalDeleteWrite = mysqlAdapter.write;
  let deleteWrites = 0;
  mysqlAdapter.write = async (source, database, write) => {
    deleteWrites += 1;
    return {
      source: source.name,
      dialect: source.dialect,
      database,
      executed: true,
      cancelled: false,
      statement_kind: write.statementKind,
      affected_rows: 3
    };
  };
  try {
    // DELETE always requires interactive confirmation even when write_confirm is off.
    const unconfirmedDelete = await writeTool!.execute!("test", { database: "app_db", statement: "DELETE FROM users WHERE id = 42" }, undefined, () => {}, { cwd: deletePolicyDir, hasUI: false });
    const unconfirmedDeleteDetails = (unconfirmedDelete as { details: Record<string, unknown> }).details;
    assert.equal(deleteWrites, 0);
    assert.equal(unconfirmedDeleteDetails.executed, false);
    assert.equal(unconfirmedDeleteDetails.cancelled, false);
    assert.equal(unconfirmedDeleteDetails.statement_kind, "delete");
    assert.equal(unconfirmedDeleteDetails.forced_confirm, true);
    assert.match(String(unconfirmedDeleteDetails.reason), /Interactive confirmation is required/);
    // Confirmed DELETE executes and reports the destructive policy confirmation.
    let deleteConfirmation: { title?: string; message?: string } = {};
    const confirmedDelete = await writeTool!.execute!("test", { database: "app_db", statement: "DELETE FROM users WHERE id = 42" }, undefined, () => {}, {
      cwd: deletePolicyDir,
      hasUI: true,
      ui: {
        confirm(title: string, message: string) {
          deleteConfirmation = { title, message };
          return true;
        }
      }
    });
    const confirmedDeleteDetails = (confirmedDelete as { details: Record<string, unknown>; content: Array<{ text?: string }> }).details;
    assert.equal(deleteWrites, 1);
    assert.equal(confirmedDeleteDetails.executed, true);
    assert.equal(confirmedDeleteDetails.statement_kind, "delete");
    assert.equal(confirmedDeleteDetails.write_confirm, false);
    assert.equal(confirmedDeleteDetails.forced_confirm, true);
    assert.equal(deleteConfirmation.title, "Database Write · DELETE · MySQL");
    assert.match(String((confirmedDelete as { content: Array<{ text?: string }> }).content[0]?.text), /Confirmation: required by operation safety policy/);
    // Other destructive kinds (TRUNCATE) follow the same forced-confirmation policy.
    let truncateConfirmation: { title?: string; message?: string } = {};
    const confirmedTruncate = await writeTool!.execute!("test", { database: "app_db", statement: "TRUNCATE TABLE users" }, undefined, () => {}, {
      cwd: deletePolicyDir,
      hasUI: true,
      ui: {
        confirm(title: string, message: string) {
          truncateConfirmation = { title, message };
          return true;
        }
      }
    });
    const confirmedTruncateDetails = (confirmedTruncate as { details: Record<string, unknown> }).details;
    assert.equal(deleteWrites, 2);
    assert.equal(confirmedTruncateDetails.executed, true);
    assert.equal(confirmedTruncateDetails.statement_kind, "truncate");
    assert.equal(confirmedTruncateDetails.forced_confirm, true);
    assert.equal(truncateConfirmation.title, "Database Write · TRUNCATE · MySQL");
    // Destructive statements are blocked entirely when allow_write is false.
    const readonlyDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-database-destructive-readonly-"));
    writeConfig(readonlyDir, {
      version: 1,
      default_source: "readonly_mysql",
      sources: [
        { name: "readonly_mysql", dialect: "mysql", allow_write: false, options: { host: "localhost", user: "reader" } }
      ]
    });
    const blockedDelete = await writeTool!.execute!("test", { database: "app_db", statement: "DELETE FROM users WHERE id = 42" }, undefined, () => {}, { cwd: readonlyDir, hasUI: false });
    const blockedDeleteDetails = (blockedDelete as { details: Record<string, unknown> }).details;
    assert.equal(blockedDeleteDetails.blocked, true);
    assert.equal(blockedDeleteDetails.statement_kind, "unknown");
    assert.equal(blockedDeleteDetails.allow_write, false);
    assert.match(String(blockedDeleteDetails.reason), /Writes are disabled/);
  } finally {
    mysqlAdapter.write = originalDeleteWrite;
  }

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

function testDatabaseStatusText() {
  const single = { defaultSource: "", sources: [{ name: "mysql-192.168.27.148" }] };
  assert.equal(databaseStatusText(single), "database: mysql-192.168.27.148");
  assert.equal(databaseStatusText({ defaultSource: "app", sources: [{ name: "app" }, { name: "analytics" }] }), "database: app +1");
  assert.equal(databaseStatusText({ defaultSource: "", sources: [{ name: "app" }, { name: "analytics" }, { name: "logs" }] }), "database: 3 sources");
}

function testSourceTree() {
  const nodes: SourceTreeNode[] = [
    { name: "mysql-a", dialect: "mysql", default: true, host: "127.0.0.1:3306", database: "app", allow_write: true, write_confirm: false, query_timeout_ms: 30_000, max_rows: 100 },
    { name: "ch-b", dialect: "clickhouse", default: false, host: "http://127.0.0.1:8123", database: "analytics", allow_write: false, write_confirm: true, query_timeout_ms: 30_000, max_rows: 100 }
  ];
  const validColors = new Set(["border", "accent", "dim", "muted", "success", "text"]);
  const usedColors = new Set<string>();
  const theme = {
    fg: (color: string, text: string) => {
      usedColors.add(color);
      return text;
    },
    bold: (text: string) => text
  };
  let renders = 0;
  let closed = false;
  const tui = { requestRender() { renders++; } };
  const component = createSourceTreeComponent(tui, "cfg.json", nodes, theme, () => { closed = true; });

  const collapsed = component.render(80).join("\n");
  assert.match(collapsed, /Database Sources · 2/);
  assert.match(collapsed, /mysql-a \(mysql\) · default/);
  assert.match(collapsed, /host\s+127\.0\.0\.1:3306/);
  assert.match(collapsed, /▼ mysql-a/);
  assert.match(collapsed, /▶ ch-b/);
  assert.doesNotMatch(collapsed, /http:\/\/127\.0\.0\.1:8123/);
  assert.equal([...usedColors].every((color) => validColors.has(color)), true);
  assert.equal(usedColors.has("text"), true);

  component.handleInput("down");
  component.handleInput("enter");
  assert.ok(renders >= 2);
  const expanded = component.render(80).join("\n");
  assert.match(expanded, /▼ ch-b/);
  assert.match(expanded, /http:\/\/127\.0\.0\.1:8123/);
  assert.match(expanded, /confirm on/);

  component.handleInput("up");
  component.handleInput("enter");
  assert.doesNotMatch(component.render(80).join("\n"), /127\.0\.0\.1:3306/);

  component.handleInput("escape");
  assert.equal(closed, true);
}

function testWriteBoundaries() {
  const mysql = {
    name: "mysql",
    dialect: "mysql" as const,
    allowWrite: true,
    writeConfirm: true,
    options: {},
    configPath: "unit",
    cacheKey: "mysql"
  };
  assert.equal(mysqlAdapter.validateWrite(mysql, "INSERT INTO users (id) VALUES (1)").statementKind, "insert");
  assert.equal(mysqlAdapter.validateWrite(mysql, "UPDATE users SET name = 'a' WHERE id = 1").statementKind, "update");
  assert.equal(mysqlAdapter.validateWrite(mysql, "CREATE DATABASE IF NOT EXISTS app_db").databaseRequired, false);
  assert.equal(mysqlAdapter.validateWrite(mysql, "CREATE TABLE audit_log (id bigint)").statementKind, "create");
  assert.equal(mysqlAdapter.validateWrite(mysql, "CREATE TABLE audit_log (id bigint)").databaseRequired, true);
  assert.equal(mysqlAdapter.validateWrite(mysql, "ALTER TABLE users ADD COLUMN nickname varchar(32)").statementKind, "alter");
  assert.throws(() => mysqlAdapter.validateWrite(mysql, "UPDATE users SET name = 'a'"), /WHERE clause/);
  assert.equal(mysqlAdapter.validateWrite(mysql, "INSERT INTO users SELECT id FROM archived").statementKind, "insert");
  assert.equal(mysqlAdapter.validateWrite(mysql, "INSERT INTO users (id) SELECT id FROM archived").forceConfirm, true);
  assert.throws(() => mysqlAdapter.validateWrite(mysql, "INSERT INTO users SET id = 1"), /support only/);
  assert.throws(() => mysqlAdapter.validateWrite(mysql, "ALTER TABLE users ADD COLUMN nickname varchar(32), DROP COLUMN old_name"), /destructive ALTER/);
  assert.equal(mysqlAdapter.validateWrite(mysql, "DELETE FROM users WHERE id = 1").statementKind, "delete");
  assert.equal(mysqlAdapter.validateWrite(mysql, "DELETE FROM users WHERE id = 1").databaseRequired, true);
  assert.equal(mysqlAdapter.validateWrite(mysql, "DELETE FROM audit_log WHERE created_at < '2024-01-01' ORDER BY id LIMIT 10").statementKind, "delete");
  assert.equal(mysqlAdapter.validateWrite(mysql, "DELETE FROM users WHERE id = 1 LIMIT 1").statementKind, "delete");
  assert.throws(() => mysqlAdapter.validateWrite(mysql, "DELETE FROM users"), /WHERE clause/);
  assert.throws(() => mysqlAdapter.validateWrite(mysql, "DELETE FROM users ORDER BY id"), /WHERE clause/);
  assert.throws(() => mysqlAdapter.validateWrite(mysql, "DELETE u FROM users u JOIN orders o ON o.user_id = u.id WHERE u.name = 'a'"), /single-table/);
  assert.throws(() => mysqlAdapter.validateWrite(mysql, "DELETE FROM users, orders USING users JOIN orders WHERE users.id = orders.user_id"), /single-table/);
  assert.equal(mysqlAdapter.validateWrite(mysql, "TRUNCATE users").statementKind, "truncate");
  assert.equal(mysqlAdapter.validateWrite(mysql, "TRUNCATE TABLE users").statementKind, "truncate");
  assert.equal(mysqlAdapter.validateWrite(mysql, "TRUNCATE TABLE users").databaseRequired, true);
  assert.throws(() => mysqlAdapter.validateWrite(mysql, "TRUNCATE TABLE users, orders"), /single-table/);
  assert.equal(mysqlAdapter.validateWrite(mysql, "DROP TABLE IF EXISTS users").statementKind, "drop");
  assert.equal(mysqlAdapter.validateWrite(mysql, "DROP TABLE IF EXISTS users").databaseRequired, true);
  assert.equal(mysqlAdapter.validateWrite(mysql, "DROP DATABASE IF EXISTS app_db").statementKind, "drop");
  assert.equal(mysqlAdapter.validateWrite(mysql, "DROP DATABASE IF EXISTS app_db").databaseRequired, false);
  assert.throws(() => mysqlAdapter.validateWrite(mysql, "DROP TABLE users, orders"), /single-object/);
  assert.throws(() => mysqlAdapter.validateWrite(mysql, "DROP VIEW IF EXISTS v"), /single-object/);
  assert.equal(mysqlAdapter.validateWrite(mysql, "RENAME TABLE users TO users_archive").statementKind, "rename");
  assert.equal(mysqlAdapter.validateWrite(mysql, "RENAME TABLE app_db.users TO archive.users").databaseRequired, true);
  assert.throws(() => mysqlAdapter.validateWrite(mysql, "RENAME TABLE a TO b, c TO d"), /single-pair/);
  assert.equal(mysqlAdapter.validateWrite(mysql, "REPLACE INTO users (id) VALUES (1)").statementKind, "replace");
  assert.throws(() => mysqlAdapter.validateWrite(mysql, "REPLACE INTO users SELECT id FROM archived"), /support only/);

  const clickhouse = {
    name: "clickhouse",
    dialect: "clickhouse" as const,
    allowWrite: true,
    writeConfirm: true,
    options: {},
    configPath: "unit",
    cacheKey: "clickhouse"
  };
  assert.equal(clickhouseAdapter.validateWrite(clickhouse, "INSERT INTO events (id) VALUES (1)").statementKind, "insert");
  assert.equal(clickhouseAdapter.validateWrite(clickhouse, "CREATE DATABASE IF NOT EXISTS analytics").databaseRequired, false);
  assert.equal(clickhouseAdapter.validateWrite(clickhouse, "CREATE MATERIALIZED VIEW event_counts TO event_counts_target AS SELECT event_type, count() AS total FROM events GROUP BY event_type").statementKind, "create");
  assert.equal(clickhouseAdapter.validateWrite(clickhouse, "CREATE MATERIALIZED VIEW event_counts TO event_counts_target AS SELECT event_type FROM events").databaseRequired, true);
  assert.equal(clickhouseAdapter.validateWrite(clickhouse, "CREATE MATERIALIZED VIEW IF NOT EXISTS event_rollup ENGINE = SummingMergeTree() ORDER BY event_type AS SELECT event_type, count() AS total FROM events GROUP BY event_type").statementKind, "create");
  assert.equal(clickhouseAdapter.validateWrite(clickhouse, "CREATE MATERIALIZED VIEW event_counts_cluster ON CLUSTER analytics_cluster TO event_counts_target AS SELECT event_type FROM events").forceConfirm, undefined);
  assert.equal(clickhouseAdapter.validateWrite(clickhouse, "CREATE OR REPLACE MATERIALIZED VIEW event_counts TO event_counts_target AS SELECT event_type FROM events").forceConfirm, true);
  assert.throws(() => clickhouseAdapter.validateWrite(clickhouse, "CREATE OR REPLACE MATERIALIZED VIEW IF NOT EXISTS event_counts TO event_counts_target AS SELECT event_type FROM events"), /cannot combine OR REPLACE/);
  assert.throws(() => clickhouseAdapter.validateWrite(clickhouse, "CREATE MATERIALIZED VIEW event_counts POPULATE TO event_counts_target AS SELECT event_type FROM events"), /materialized view writes support only/);
  assert.throws(() => clickhouseAdapter.validateWrite(clickhouse, "CREATE MATERIALIZED VIEW event_counts REFRESH EVERY 1 HOUR TO event_counts_target AS SELECT event_type FROM events"), /materialized view writes support only/);
  assert.throws(() => clickhouseAdapter.validateWrite(clickhouse, "CREATE MATERIALIZED VIEW event_rollup ENGINE = MergeTree() ORDER BY event_type POPULATE AS SELECT event_type FROM events"), /do not support POPULATE/);
  assert.equal(clickhouseAdapter.validateWrite(clickhouse, "CREATE MATERIALIZED VIEW event_counts ON CLUSTER c TO event_counts_target AS SELECT event_type FROM events").forceConfirm, undefined);
  assert.equal(clickhouseAdapter.validateWrite(clickhouse, "CREATE OR REPLACE MATERIALIZED VIEW event_counts ON CLUSTER c TO event_counts_target AS SELECT event_type FROM events").forceConfirm, true);
  assert.equal(clickhouseAdapter.validateWrite(clickhouse, "ALTER TABLE events ADD COLUMN name String").statementKind, "alter");
  assert.equal(clickhouseAdapter.validateWrite(clickhouse, "INSERT INTO events SELECT id FROM other_events").statementKind, "insert");
  assert.equal(clickhouseAdapter.validateWrite(clickhouse, "INSERT INTO events (id) SELECT id FROM other_events").forceConfirm, true);
  assert.throws(() => clickhouseAdapter.validateWrite(clickhouse, "INSERT INTO events FORMAT JSONEachRow"), /support only/);
  assert.throws(() => clickhouseAdapter.validateWrite(clickhouse, "CREATE TABLE events ON CLUSTER c (id UInt64)"), /ON CLUSTER/);
  assert.equal(clickhouseAdapter.validateWrite(clickhouse, "DELETE FROM events WHERE id = 1").statementKind, "delete");
  assert.equal(clickhouseAdapter.validateWrite(clickhouse, "DELETE FROM analytics.events WHERE created_at < now() - INTERVAL 30 DAY").statementKind, "delete");
  assert.throws(() => clickhouseAdapter.validateWrite(clickhouse, "DELETE FROM events"), /support only/);
  assert.throws(() => clickhouseAdapter.validateWrite(clickhouse, "DELETE FROM events ON CLUSTER c WHERE id = 1"), /ON CLUSTER/);
  assert.equal(clickhouseAdapter.validateWrite(clickhouse, "ALTER TABLE events DELETE WHERE id = 1").statementKind, "delete");
  assert.equal(clickhouseAdapter.validateWrite(clickhouse, "ALTER TABLE events DELETE WHERE id = 1").databaseRequired, true);
  assert.equal(clickhouseAdapter.validateWrite(clickhouse, "ALTER TABLE events DELETE WHERE name = 'a,b'").statementKind, "delete");
  assert.equal(clickhouseAdapter.validateWrite(clickhouse, "ALTER TABLE events DELETE WHERE id IN (1, 2)").statementKind, "delete");
  assert.throws(() => clickhouseAdapter.validateWrite(clickhouse, "ALTER TABLE events DELETE WHERE id = 1, UPDATE flag = 1 WHERE id = 2"), /single command/);
  assert.throws(() => clickhouseAdapter.validateWrite(clickhouse, "ALTER TABLE events DELETE WHERE id = 1, DROP COLUMN name"), /destructive or mutation/);
  assert.equal(clickhouseAdapter.validateWrite(clickhouse, "TRUNCATE TABLE IF EXISTS events").statementKind, "truncate");
  assert.throws(() => clickhouseAdapter.validateWrite(clickhouse, "TRUNCATE events"), /support only/);
  assert.equal(clickhouseAdapter.validateWrite(clickhouse, "DROP TABLE IF EXISTS events").statementKind, "drop");
  assert.equal(clickhouseAdapter.validateWrite(clickhouse, "DROP DATABASE IF EXISTS analytics").databaseRequired, false);
  assert.throws(() => clickhouseAdapter.validateWrite(clickhouse, "DROP TABLE events, other"), /single-object/);
  assert.equal(clickhouseAdapter.validateWrite(clickhouse, "RENAME TABLE events TO events_archive").statementKind, "rename");
  assert.throws(() => clickhouseAdapter.validateWrite(clickhouse, "RENAME TABLE a TO b, c TO d"), /single-pair/);
  assert.throws(() => clickhouseAdapter.validateWrite(clickhouse, "ALTER TABLE events DROP COLUMN name"), /destructive or mutation/);
  const readonlyMysql = { ...mysql, name: "readonly-mysql", allowWrite: false };
  assert.throws(() => mysqlAdapter.validateWrite(readonlyMysql, "INSERT INTO users (id) VALUES (1)"), /Writes are disabled/);
  assert.throws(() => mysqlAdapter.validateWrite(readonlyMysql, "INSERT INTO users (id) SELECT id FROM archived"), /Writes are disabled/);
  assert.throws(() => mysqlAdapter.validateWrite(readonlyMysql, "DELETE FROM users WHERE id = 1"), /Writes are disabled/);
  const readonlyClickHouse = { ...clickhouse, name: "readonly-clickhouse", allowWrite: false };
  assert.throws(() => clickhouseAdapter.validateWrite(readonlyClickHouse, "INSERT INTO events (id) SELECT id FROM archived_events"), /Writes are disabled/);
  assert.throws(() => mysqlAdapter.validateWrite(readonlyMysql, "TRUNCATE TABLE users"), /Writes are disabled/);
}

testSqlScanner();
testResultLimits();
testInitializeConfig();
testSourceSelection();
await testDynamicRegistration();
testDatabaseContextPrompt();
await testToolPromptMetadata();
testWriteBoundaries();
testDatabaseStatusText();
testSourceTree();
console.log("pi-database self-check OK");
