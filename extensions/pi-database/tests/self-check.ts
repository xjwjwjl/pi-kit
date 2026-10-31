import assert from "node:assert/strict";
import { createCipheriv } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  buildDatabaseContextPrompt,
  databaseStatusText,
  initializeProjectConfig,
  loadProjectConfig,
  selectSource,
  setDbxConnectionsEnabled,
  setProjectConfigEnabled,
  sourceWithDatabase
} from "../src/config.ts";
import { clickhouseAdapter } from "../src/clickhouse.ts";
import { clearDbxSecretCache, loadDbxSources, readDbxPassword } from "../src/dbx.ts";
import { mysqlAdapter } from "../src/mysql.ts";
import { createSourceTreeComponent, formatSourceTreeText } from "../src/source-tree.ts";
import type { SourceTreeNode } from "../src/source-tree.ts";
import { boundItems, boundRows, boundTableNames, resultLimits, truncateText } from "../src/results.ts";
import databaseExtension, { __test__ } from "../index.ts";
import { firstKeyword, hasMultipleStatements, hasTopLevelComma, hasTopLevelKeyword, normalizeSql, splitTopLevelParts } from "../src/sql.ts";
import {
  USQL_TOOL_NAME,
  connectionScheme,
  parseUsqlOutput,
  redactConnection,
  resetUsqlBinaryCache,
  statementKind,
  usqlAvailable,
  usqlScriptContents
} from "../src/usql.ts";

const REAL_USQL_ENV = process.env.PI_DATABASE_USQL_BIN;

/** Points the usql lookup at a command that does not exist so activation is deterministic. */
function disableUsql(): void {
  process.env.PI_DATABASE_USQL_BIN = path.join(os.tmpdir(), "pi-database-missing-usql");
  resetUsqlBinaryCache();
}

/** Points the usql lookup at an existing file so the fallback tool activates. */
function enableUsql(): void {
  const marker = path.join(os.tmpdir(), "pi-database-usql-binary-marker");
  fs.writeFileSync(marker, "", "utf-8");
  process.env.PI_DATABASE_USQL_BIN = marker;
  resetUsqlBinaryCache();
}

function restoreUsqlEnv(): void {
  if (REAL_USQL_ENV === undefined) delete process.env.PI_DATABASE_USQL_BIN;
  else process.env.PI_DATABASE_USQL_BIN = REAL_USQL_ENV;
  resetUsqlBinaryCache();
}

function writeConfig(dir: string, value: unknown): string {
  const configPath = path.join(dir, ".pi", "databases.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const projectConfig = value && typeof value === "object" && !Array.isArray(value) && !Object.hasOwn(value, "enabled")
    ? { enabled: true, dbx_connections: false, ...value }
    : value;
  fs.writeFileSync(configPath, JSON.stringify(projectConfig, null, 2), "utf-8");
  return configPath;
}

function encryptedDbxSecret(key: Buffer, connectionId: string, secret: string): string {
  const nonce = Buffer.alloc(12, 7);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(`dbx-secret-v1\0${connectionId}\0password`, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return `dbxenc1.${nonce.toString("base64url")}.${ciphertext.toString("base64url")}`;
}

function restoreEnvironmentValue(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function testDbxConnectionImportAndSecrets() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-database-dbx-"));
  const databasePath = path.join(dir, "dbx.db");
  const connectionId = "dbx-test-connection";
  const passphrase = "pi-database-dbx-test-passphrase";
  const cryptoModule = process.getBuiltinModule("node:crypto") as {
    argon2Sync: (algorithm: string, parameters: {
      message: string;
      nonce: Buffer;
      parallelism: number;
      tagLength: number;
      memory: number;
      passes: number;
    }) => Buffer;
  };
  const key = cryptoModule.argon2Sync("argon2id", {
    message: passphrase,
    nonce: Buffer.from("dbx-local-secret-store-v1", "utf8"),
    parallelism: 1,
    tagLength: 32,
    memory: 19 * 1024,
    passes: 2
  });
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE connections (id TEXT PRIMARY KEY, config_json TEXT NOT NULL);
    CREATE TABLE connection_secrets (
      connection_id TEXT NOT NULL,
      key TEXT NOT NULL,
      secret TEXT NOT NULL DEFAULT '',
      secret_enc TEXT,
      PRIMARY KEY (connection_id, key)
    );
  `);
  const insertConnection = database.prepare("INSERT INTO connections (id, config_json) VALUES (?, ?)");
  insertConnection.run(connectionId, JSON.stringify({
    db_type: "mysql",
    name: "Test MySQL",
    host: "127.0.0.1",
    port: 3306,
    username: "test-user",
    database: "test-db",
    read_only: true
  }));
  insertConnection.run("clickhouse-test", JSON.stringify({
    db_type: "clickhouse",
    name: "Test ClickHouse",
    host: "127.0.0.1",
    username: "default"
  }));
  insertConnection.run("unsupported-test", JSON.stringify({ db_type: "postgres", name: "Unsupported" }));
  insertConnection.run("nameless-test", JSON.stringify({ db_type: "mysql", host: "127.0.0.1", username: "nameless-user" }));
  database.prepare("INSERT INTO connection_secrets (connection_id, key, secret, secret_enc) VALUES (?, 'password', '', ?)")
    .run(connectionId, encryptedDbxSecret(key, connectionId, " dbx-test-password "));
  database.close();

  const previousEnv = {
    databasePath: process.env.PI_DATABASE_DBX_DB_PATH,
    dataDir: process.env.DBX_DATA_DIR,
    secretKey: process.env.DBX_SECRET_KEY,
    secretKeyFile: process.env.DBX_SECRET_KEY_FILE
  };
  try {
    process.env.PI_DATABASE_DBX_DB_PATH = databasePath;
    delete process.env.DBX_DATA_DIR;
    process.env.DBX_SECRET_KEY = passphrase;
    delete process.env.DBX_SECRET_KEY_FILE;
    clearDbxSecretCache();

    const discovery = loadDbxSources();
    assert.deepEqual(discovery.sources.map((source) => source.dialect).sort(), ["clickhouse", "mysql", "mysql"]);
    assert.match(discovery.warning ?? "", /Skipped 1 DBX connections/);
    const mysqlSource = discovery.sources.find((source) => source.dbxConnectionId === connectionId)!;
    assert.equal(mysqlSource.name, "dbx-test_mysql", "source name is derived from the DBX connection name");
    assert.equal(mysqlSource.label, "Test MySQL");
    assert.equal(discovery.sources.find((source) => source.dbxConnectionId === "clickhouse-test")?.name, "dbx-test_clickhouse");
    assert.equal(discovery.sources.find((source) => source.dbxConnectionId === "nameless-test")?.name, "dbx-nameless-test", "a connection without a name falls back to dbx-<id>");
    assert.deepEqual(loadDbxSources(["dbx-test_mysql", "dbx-test_clickhouse"]).sources.map((source) => source.name).sort(), ["dbx-nameless-test", "dbx-test_clickhouse-2", "dbx-test_mysql-2"], "names that collide with existing sources get a numeric suffix");
    assert.equal(mysqlSource.allowWrite, false, "DBX read-only connections cannot write");
    assert.equal(Object.hasOwn(mysqlSource.options, "password"), false, "passwords are not copied into source options");
    assert.doesNotMatch(mysqlSource.cacheKey, /dbx-test-password/);
    assert.equal(readDbxPassword(connectionId, databasePath), " dbx-test-password ", "encrypted passwords preserve whitespace");

    const projectDir = path.join(dir, "project");
    writeConfig(projectDir, {
      version: 2,
      enabled: true,
      dbx_connections: false,
      default_sources: {},
      sources: [{ name: "project-source", dialect: "mysql", options: { host: "localhost", user: "local" } }]
    });
    assert.equal(loadProjectConfig(projectDir).sources.length, 1);
    assert.equal(setDbxConnectionsEnabled(projectDir, true).changed, true);
    const mergedConfig = loadProjectConfig(projectDir);
    assert.equal(mergedConfig.dbxImportEnabled, true);
    assert.equal(mergedConfig.sources.length, 4, "DBX sources merge with project-configured sources");
  } finally {
    clearDbxSecretCache();
    restoreEnvironmentValue("PI_DATABASE_DBX_DB_PATH", previousEnv.databasePath);
    restoreEnvironmentValue("DBX_DATA_DIR", previousEnv.dataDir);
    restoreEnvironmentValue("DBX_SECRET_KEY", previousEnv.secretKey);
    restoreEnvironmentValue("DBX_SECRET_KEY_FILE", previousEnv.secretKeyFile);
  }

  const legacyPath = path.join(dir, "legacy.db");
  const legacyDatabase = new DatabaseSync(legacyPath);
  legacyDatabase.exec(`
    CREATE TABLE connections (id TEXT PRIMARY KEY, config_json TEXT NOT NULL);
    CREATE TABLE connection_secrets (connection_id TEXT NOT NULL, key TEXT NOT NULL, secret TEXT NOT NULL);
  `);
  legacyDatabase.prepare("INSERT INTO connections (id, config_json) VALUES (?, ?)")
    .run("legacy-connection", JSON.stringify({ db_type: "clickhouse", host: "localhost", username: "default" }));
  legacyDatabase.prepare("INSERT INTO connection_secrets (connection_id, key, secret) VALUES (?, 'password', ?)")
    .run("legacy-connection", " legacy-db-password ");
  legacyDatabase.close();
  const legacyDatabasePath = process.env.PI_DATABASE_DBX_DB_PATH;
  try {
    process.env.PI_DATABASE_DBX_DB_PATH = legacyPath;
    clearDbxSecretCache();
    assert.equal(loadDbxSources().sources.length, 1, "legacy DBX profile schema remains readable");
    assert.equal(readDbxPassword("legacy-connection", legacyPath), " legacy-db-password ", "legacy passwords preserve whitespace");
  } finally {
    clearDbxSecretCache();
    restoreEnvironmentValue("PI_DATABASE_DBX_DB_PATH", legacyDatabasePath);
  }
}

function testSqlScanner() {
  assert.equal(normalizeSql("SELECT 1; \n"), "SELECT 1");
  assert.equal(hasMultipleStatements("SELECT ';'"), false);
  assert.equal(hasMultipleStatements("SELECT 1; SELECT 2"), true);
  assert.equal(hasMultipleStatements("SELECT 1; -- trailing note"), false);
  assert.equal(hasMultipleStatements("SELECT 1; /* trailing note */"), false);
  assert.equal(hasMultipleStatements("SELECT 1; /* note */ SELECT 2"), true);
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
  assert.deepEqual(splitTopLevelParts("ADD COLUMN a int, DROP COLUMN b"), ["ADD COLUMN a int", "DROP COLUMN b"]);
  assert.deepEqual(splitTopLevelParts("ADD COLUMN note varchar(20) DEFAULT 'a,b', ADD COLUMN c int"), ["ADD COLUMN note varchar(20) DEFAULT 'a,b'", "ADD COLUMN c int"]);
  assert.deepEqual(splitTopLevelParts("DROP COLUMN a, DROP COLUMN b -- , DROP COLUMN c"), ["DROP COLUMN a", "DROP COLUMN b -- , DROP COLUMN c"]);
  assert.deepEqual(splitTopLevelParts("ADD COLUMN c int /* x, y */, DROP COLUMN d"), ["ADD COLUMN c int /* x, y */", "DROP COLUMN d"]);
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
  assert.equal(config.version, 2);
  assert.equal(Object.hasOwn(config, "enabled"), false, "init leaves the project disabled by default");
  assert.equal(loadProjectConfig(dir).enabled, false);
  assert.equal(config.dbx_connections, true);
  assert.deepEqual(config.default_sources, {});
  assert.equal(config.sources.length, 0, "init leaves custom sources empty and relies on DBX by default");
  assert.equal(initializeProjectConfig(dir).created, false);
  const disabled = setProjectConfigEnabled(dir, false);
  assert.equal(disabled.changed, true);
  assert.equal(loadProjectConfig(dir).enabled, false);
  const enabled = setProjectConfigEnabled(dir, true);
  assert.equal(enabled.changed, true);
  assert.equal(loadProjectConfig(dir).enabled, true);

  const noConfigDisableDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-database-disable-empty-"));
  const noConfigDisable = setProjectConfigEnabled(noConfigDisableDir, false);
  assert.equal(noConfigDisable.changed, true);
  assert.equal(noConfigDisable.created, true);
  assert.equal(fs.existsSync(path.join(noConfigDisableDir, ".pi", "databases.json")), false);
  assert.equal(JSON.parse(fs.readFileSync(noConfigDisable.settingsPath, "utf-8")).piDatabase.toolsEnabled, false);

  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "pi-database-parent-"));
  const child = path.join(parent, "child");
  fs.mkdirSync(child);
  const parentConfig = writeConfig(parent, { version: 2, default_sources: {}, sources: [{ name: "only", dialect: "mysql", options: { host: "localhost", user: "u" } }] });
  const inherited = initializeProjectConfig(child);
  assert.equal(inherited.created, false);
  assert.equal(inherited.configPath, parentConfig);
  assert.equal(fs.existsSync(path.join(child, ".pi", "databases.json")), false);
  const childEnabled = setProjectConfigEnabled(child, true);
  assert.equal(childEnabled.created, true, "project enablement creates local settings without copying the source config");
  assert.equal(childEnabled.settingsPath, path.join(child, ".pi", "settings.json"));
  assert.equal(fs.existsSync(path.join(child, ".pi", "databases.json")), false);
  assert.equal(loadProjectConfig(child).enabled, true);
  assert.equal(loadProjectConfig(parent).enabled, true, "project enablement leaves the parent config unchanged");
}

function testProjectOptIn() {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-database-project-opt-in-"));
  const enabled = setProjectConfigEnabled(projectDir, true);
  assert.equal(enabled.created, true);
  assert.equal(enabled.changed, true);
  assert.equal(enabled.settingsPath, path.join(projectDir, ".pi", "settings.json"));
  assert.equal(fs.existsSync(path.join(projectDir, ".pi", "databases.json")), false, "project opt-in does not create a database config file");
  assert.equal(loadProjectConfig(projectDir).enabled, true, "project enablement is persisted in its local config");

  const projectSettings = JSON.parse(fs.readFileSync(enabled.settingsPath, "utf-8"));
  assert.equal(projectSettings.piDatabase.toolsEnabled, true);
  const disabled = setProjectConfigEnabled(projectDir, false);
  assert.equal(disabled.changed, true);
  assert.equal(loadProjectConfig(projectDir).enabled, false);

  const inheritedDefaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-database-project-default-off-"));
  const configPath = path.join(inheritedDefaultDir, ".pi", "databases.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({
    version: 2,
    default_sources: {},
    sources: [{ name: "app", dialect: "mysql", options: { host: "localhost", user: "app" } }]
  }, null, 2), "utf-8");
  assert.equal(loadProjectConfig(inheritedDefaultDir).enabled, false, "an omitted project enabled value defaults off");

  const dbxOnlyDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-database-dbx-import-only-"));
  const dbxImport = setDbxConnectionsEnabled(dbxOnlyDir, true);
  assert.equal(dbxImport.created, true);
  const dbxOnlySettings = JSON.parse(fs.readFileSync(dbxImport.settingsPath, "utf-8"));
  assert.equal(dbxOnlySettings.piDatabase.dbxImportEnabled, true);
  assert.equal(Object.hasOwn(dbxOnlySettings.piDatabase, "toolsEnabled"), false, "DBX import configuration does not activate tools");

  const oldSettingsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-database-old-settings-"));
  const oldSettingsPath = path.join(oldSettingsDir, ".pi", "settings.json");
  fs.mkdirSync(path.dirname(oldSettingsPath), { recursive: true });
  fs.writeFileSync(oldSettingsPath, JSON.stringify({ piDatabase: { enabled: true, dbxConnectionsEnabled: false } }), "utf-8");
  const oldSettingsConfig = loadProjectConfig(oldSettingsDir);
  assert.equal(oldSettingsConfig.enabled, false, "old project setting names are not read");
  assert.equal(oldSettingsConfig.dbxImportEnabled, true, "old DBX import setting name is not read");
}

function testSourceSelection() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-database-source-"));
  writeConfig(dir, {
    version: 2,
    default_sources: { mysql: "app", clickhouse: "analytics" },
    sources: [
      { name: "app", dialect: "mysql", allow_write: false, write_confirm: true, query_timeout_ms: 12_000, max_rows: 25, options: { host: "localhost", user: "app", database: "app_db" } },
      { name: "analytics", dialect: "clickhouse", allow_write: true, write_confirm: false, query_timeout_ms: 45_000, max_rows: 999, options: { url: "http://localhost:8123", username: "analytics", database: "analytics" } }
    ]
  });
  const config = loadProjectConfig(dir);
  assert.equal(config.sources.length, 2);
  assert.deepEqual(config.defaultSources, { mysql: "app", clickhouse: "analytics" });
  assert.equal(selectSource(config, undefined, "mysql").name, "app");
  assert.equal(selectSource(config, undefined, "clickhouse").name, "analytics");
  assert.throws(() => selectSource(config), /Multiple database sources/);
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
  assert.throws(() => selectSource(config, "app", "clickhouse"), /uses mysql/);

  const dbxSource = { ...config.sources[0]!, name: "dbx-analytics", label: "Analytics", provider: "dbx" as const, dbxConnectionName: "Analytics" };
  const dbxAliasConfig = { ...config, sources: [dbxSource] };
  assert.equal(selectSource(dbxAliasConfig, "Analytics").name, "dbx-analytics", "DBX connection names resolve to the readable source name");
  assert.throws(() => selectSource(dbxAliasConfig, "dbx-legacy-42"), /Unknown database source/, "the legacy dbx-<id> form is no longer an alias");
  const duplicatedDbxAliases = { ...dbxAliasConfig, sources: [dbxSource, { ...dbxSource, name: "dbx-analytics-2" }] };
  assert.throws(() => selectSource(duplicatedDbxAliases, "Analytics"), /is ambiguous.*dbx-analytics, dbx-analytics-2/);
  const conflictingDbxAlias = { ...config, sources: [{ ...config.sources[0]!, name: "Analytics" }, dbxSource] };
  assert.throws(() => selectSource(conflictingDbxAlias, "Analytics"), /conflicts with a DBX connection name/);

  const ambiguous = fs.mkdtempSync(path.join(os.tmpdir(), "pi-database-ambiguous-"));
  writeConfig(ambiguous, {
    version: 2,
    default_sources: {},
    sources: [
      { name: "one", dialect: "mysql", options: { host: "localhost", user: "one" } },
      { name: "two", dialect: "clickhouse", options: { url: "http://localhost:8123", username: "two" } }
    ]
  });
  const ambiguousConfig = loadProjectConfig(ambiguous);
  assert.equal(ambiguousConfig.sources[0]?.allowWrite, true);
  assert.equal(ambiguousConfig.sources[0]?.writeConfirm, false);
  assert.throws(() => selectSource(ambiguousConfig), /Multiple database sources/);
  assert.throws(() => selectSource(ambiguousConfig, undefined, "mysql"), /No default mysql source/);

  const dotted = fs.mkdtempSync(path.join(os.tmpdir(), "pi-database-dotted-"));
  writeConfig(dotted, { version: 2, default_sources: {}, sources: [{ name: "mysql-192.168.27.148", dialect: "mysql", options: { host: "localhost", user: "u" } }] });
  assert.equal(selectSource(loadProjectConfig(dotted)).name, "mysql-192.168.27.148");

  const legacy = fs.mkdtempSync(path.join(os.tmpdir(), "pi-database-legacy-"));
  writeConfig(legacy, { version: 1, default_source: "app", sources: [{ name: "app", dialect: "mysql", options: { host: "localhost", user: "u" } }] });
  assert.throws(() => loadProjectConfig(legacy), /version 2 config/);

  const legacyField = fs.mkdtempSync(path.join(os.tmpdir(), "pi-database-legacy-field-"));
  writeConfig(legacyField, { version: 2, default_sources: { mysql: "app" }, default_source: "app", sources: [{ name: "app", dialect: "mysql", options: { host: "localhost", user: "u" } }] });
  assert.throws(() => loadProjectConfig(legacyField), /default_source is no longer supported/);

  const mismatchedDefault = fs.mkdtempSync(path.join(os.tmpdir(), "pi-database-mismatched-default-"));
  writeConfig(mismatchedDefault, { version: 2, default_sources: { mysql: "analytics" }, sources: [{ name: "analytics", dialect: "clickhouse", options: { url: "http://localhost:8123", username: "u" } }] });
  assert.throws(() => loadProjectConfig(mismatchedDefault), /must reference a mysql source/);
}

function testSourceNameValidation() {
  // A name may start with a digit; digits are allowed anywhere in the name.
  const digitLed = fs.mkdtempSync(path.join(os.tmpdir(), "pi-database-digit-name-"));
  writeConfig(digitLed, {
    version: 2,
    default_sources: { mysql: "2024_prod" },
    sources: [
      { name: "2024_prod", dialect: "mysql", options: { host: "localhost", user: "u" } },
      { name: "1db", dialect: "clickhouse", options: { url: "http://localhost:8123", username: "u" } }
    ]
  });
  const digitConfig = loadProjectConfig(digitLed);
  assert.equal(digitConfig.sources.length, 2);
  assert.deepEqual(digitConfig.defaultSources, { mysql: "2024_prod" });
  assert.equal(selectSource(digitConfig, undefined, "mysql").name, "2024_prod");
  assert.equal(selectSource(digitConfig, "1db").dialect, "clickhouse");

  // Names that do not start with a letter/digit or that use unsupported characters are rejected.
  const invalidNames = ["_private", ".hidden", "-starts-with-dash", "has space", "bad*name", "2024/01", ""];
  for (const name of invalidNames) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-database-bad-name-"));
    writeConfig(dir, { version: 2, default_sources: {}, sources: [{ name, dialect: "mysql", options: { host: "localhost", user: "u" } }] });
    assert.throws(() => loadProjectConfig(dir), /source names must start with a letter or digit/);
  }
}

async function testDynamicRegistration() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-database-dynamic-"));
  const handlers = new Map<string, Array<(event: any, ctx: any) => Promise<unknown> | unknown>>();
  const tools: string[] = [];
  const commands: string[] = [];
  const statuses: Array<string | undefined> = [];
  const notifications: Array<{ message: string; type?: string }> = [];
  const commandDefinitions = new Map<string, { handler?: (args: string, ctx: any) => Promise<void> | void; getArgumentCompletions?: (prefix: string) => unknown }>();
  const databaseTools = [
    "database_list_sources",
    "database_ping",
    "database_list_databases",
    "database_list_tables",
    "database_search_tables",
    "database_describe_table",
    "database_query",
    "database_write"
  ];
  let activeTools = ["read", "bash", "edit", "write", ...databaseTools];
  disableUsql();
  databaseExtension({
    on(event: string, handler: (event: any, ctx: any) => Promise<unknown> | unknown) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerTool(tool: { name?: string }) {
      if (tool.name) tools.push(tool.name);
    },
    registerCommand(name: string, definition: { handler?: (args: string, ctx: any) => Promise<void> | void; getArgumentCompletions?: (prefix: string) => unknown }) {
      commands.push(name);
      commandDefinitions.set(name, definition);
    },
    getActiveTools() {
      return [...activeTools];
    },
    setActiveTools(nextTools: string[]) {
      activeTools = [...nextTools];
    }
  } as never);
  const ctx = { cwd: dir, ui: { setStatus(_name: string, value: string | undefined) { statuses.push(value); }, notify(message: string, type?: string) { notifications.push({ message, type }); }, theme: { fg: (_color: string, text: string) => String(text) } } };
  assert.deepEqual(commands, ["database"]);
  const databaseCommand = commandDefinitions.get("database");
  assert.equal(typeof databaseCommand?.handler, "function");
  assert.deepEqual(databaseCommand?.getArgumentCompletions?.("of"), [{ value: "off", label: "off" }]);
  assert.deepEqual(databaseCommand?.getArgumentCompletions?.("config"), [{ value: "config init", label: "config init" }]);
  assert.deepEqual(databaseCommand?.getArgumentCompletions?.("tru"), [{ value: "trust", label: "trust" }, { value: "trust off", label: "trust off" }]);
  assert.equal(tools.length, 9, "tool definitions are registered before session_start for restored TUI rows");
  await handlers.get("session_start")![0]!({}, ctx);
  assert.deepEqual(activeTools, ["read", "bash", "edit", "write"]);
  assert.deepEqual(statuses, [undefined]);
  const trustProbeSource = { name: "trust-probe", dialect: "mysql", configPath: path.join(dir, ".pi", "databases.json"), allowWrite: true } as never;
  __test__.trustWriteSource(trustProbeSource);
  assert.equal(__test__.isWriteSourceTrusted(trustProbeSource), true);
  await handlers.get("session_start")![0]!({}, ctx);
  assert.equal(__test__.isWriteSourceTrusted(trustProbeSource), false, "session_start clears session trust");
  __test__.trustWriteSource(trustProbeSource, "app_db");
  assert.deepEqual(__test__.listTrustedWriteSources(), [{ name: "trust-probe", dialect: "mysql", database: "app_db" }]);
  await databaseCommand!.handler!("trust", ctx);
  assert.match(notifications.at(-1)?.message ?? "", /trust-probe\/app_db/);
  await databaseCommand!.handler!("trust off", ctx);
  assert.equal(__test__.isWriteSourceTrusted(trustProbeSource, "app_db"), false);
  assert.match(notifications.at(-1)?.message ?? "", /Cleared session trust/);
  const bootstrapPrompt = await handlers.get("before_agent_start")![0]!({ cwd: dir, systemPrompt: "base" }, ctx);
  assert.equal(typeof bootstrapPrompt, "object");
  assert.match(String((bootstrapPrompt as { systemPrompt?: string }).systemPrompt), /Database tools are off for this project/);
  assert.match(String((bootstrapPrompt as { systemPrompt?: string }).systemPrompt), /\/database on/);
  assert.deepEqual(activeTools, ["read", "bash", "edit", "write"]);

  const initDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-database-command-init-"));
  const initCtx = { ...ctx, cwd: initDir, ui: { ...ctx.ui, setStatus() {} } };
  await databaseCommand!.handler!("config init", initCtx);
  assert.equal(loadProjectConfig(initDir).enabled, false);
  assert.match(notifications.at(-1)?.message ?? "", /Created project database config/);
  assert.deepEqual(activeTools, ["read", "bash", "edit", "write"], "init does not enable tools");
  await databaseCommand!.handler!("on", initCtx);
  assert.equal(loadProjectConfig(initDir).enabled, true);
  assert.deepEqual(activeTools, ["read", "bash", "edit", "write", ...databaseTools]);
  await databaseCommand!.handler!("off", initCtx);
  assert.deepEqual(activeTools, ["read", "bash", "edit", "write"]);

  await databaseCommand!.handler!("on", ctx);
  assert.equal(loadProjectConfig(dir).enabled, true);
  assert.match(notifications.at(-1)?.message ?? "", /Database tools are enabled for this project/);
  assert.deepEqual(activeTools, ["read", "bash", "edit", "write", ...databaseTools]);
  await databaseCommand!.handler!("off", ctx);
  assert.equal(loadProjectConfig(dir).enabled, false);
  assert.match(notifications.at(-1)?.message ?? "", /Database tools are disabled for this project/);
  assert.deepEqual(activeTools, ["read", "bash", "edit", "write"]);

  writeConfig(dir, { version: 2, enabled: true, default_sources: { mysql: "app" }, sources: [{ name: "app", dialect: "mysql", options: { host: "localhost", user: "app" } }] });
  setProjectConfigEnabled(dir, true);
  const enabledPrompt = await handlers.get("before_agent_start")![0]!({ cwd: dir, systemPrompt: "base" }, ctx);
  assert.equal(typeof enabledPrompt, "object");
  assert.equal(tools.length, 9);
  assert.deepEqual(activeTools, ["read", "bash", "edit", "write", ...databaseTools]);
  assert.deepEqual(commands, ["database"]);

  writeConfig(dir, { version: 2, enabled: false, default_sources: { mysql: "app" }, sources: [{ name: "app", dialect: "mysql", options: { host: "localhost", user: "app" } }] });
  setProjectConfigEnabled(dir, false);
  const disabledPrompt = await handlers.get("before_agent_start")![0]!({ cwd: dir, systemPrompt: "base" }, ctx);
  assert.equal(disabledPrompt, undefined);
  assert.deepEqual(activeTools, ["read", "bash", "edit", "write"]);

  // A config file that fails to load keeps tools registered but surfaces the
  // config error in the status instead of claiming there is no config.
  writeConfig(dir, { version: 2, default_sources: {}, sources: [{ name: "bad", dialect: "unsupported", options: {} }] });
  await handlers.get("session_start")![0]!({}, ctx);
  assert.equal(tools.length, 9);
  assert.equal(statuses[0], undefined);
  assert.equal(statuses.at(-1), "database: config error");

}

function testDatabaseContextPrompt() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-database-prompt-"));
  writeConfig(dir, {
    version: 2,
    default_sources: { mysql: "app", clickhouse: "analytics" },
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
  assert.match(prompt, /blocked_reason "source_read_only"/);
  assert.match(prompt, /blocked_reason is "unsupported_statement"/);
  assert.match(prompt, /database_usql with confirmation/);
  assert.match(prompt, /outcome is unknown/);
  assert.match(prompt, /Default sources select only connections, never databases/);
  assert.match(prompt, /pass dialect to select that dialect's configured default/);
  assert.match(prompt, /database_query and database_list_tables, always pass database/);
  assert.match(prompt, /If the database is unknown, call database_list_databases first/);
  assert.match(prompt, /CREATE MATERIALIZED VIEW/);
  assert.match(prompt, /INSERT \.\.\. SELECT/);
  assert.match(prompt, /exactly one supported SQL statement per call/);
  assert.match(prompt, /multi-step operations/);
  assert.match(prompt, /do not submit scripts/);
  const disabledDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-database-disabled-prompt-"));
  writeConfig(disabledDir, {
    version: 2,
    enabled: false,
    default_sources: { mysql: "app" },
    sources: [{ name: "app", dialect: "mysql", options: { host: "localhost", user: "app" } }]
  });
  assert.equal(buildDatabaseContextPrompt(disabledDir), undefined);
  const noConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-database-no-prompt-"));
  const bootstrapPrompt = buildDatabaseContextPrompt(noConfigDir) ?? "";
  assert.match(bootstrapPrompt, /No project database configuration/);
  assert.match(bootstrapPrompt, /\/database on/);
  assert.doesNotMatch(bootstrapPrompt, /README\.md|SKILL\.md/);
  assert.match(bootstrapPrompt, /Database tools are off for this project/);
}

async function testToolPromptMetadata() {
  const tools: Array<{ name?: string; promptSnippet?: string; promptGuidelines?: string[]; parameters?: Record<string, unknown>; outputSchema?: unknown; renderCall?: (...args: unknown[]) => { render(width: number): string[] }; execute?: (...args: unknown[]) => Promise<unknown> }> = [];
  const api = {
    registerTool(tool: { name?: string; promptSnippet?: string; promptGuidelines?: string[]; parameters?: Record<string, unknown>; outputSchema?: unknown; renderCall?: (...args: unknown[]) => { render(width: number): string[] }; execute?: (...args: unknown[]) => Promise<unknown> }) {
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
  assert.equal(__test__.formatWriteSqlForUi("INSERT INTO users (id, name) VALUES (1, 'Lin'), (2, 'Pi')"), "INSERT INTO users (\n  id,\n  name\n)\nVALUES\n  (1, 'Lin'),\n  (2, 'Pi')");
  assert.equal(__test__.formatWriteSqlForUi("INSERT INTO cmcc_network_manage.ods_snmp_samples_rebuild (insert_time, event_time, vendor_id) SELECT insert_time, event_time, vendor_id FROM cmcc_network_manage.ods_snmp_samples WHERE event_time > '2026-08-25 16:21:00.155'"), "INSERT INTO cmcc_network_manage.ods_snmp_samples_rebuild (\n  insert_time,\n  event_time,\n  vendor_id\n)\nSELECT\n  insert_time,\n  event_time,\n  vendor_id\nFROM cmcc_network_manage.ods_snmp_samples\nWHERE event_time > '2026-08-25 16:21:00.155'");
  assert.equal(__test__.formatWriteSqlForUi("INSERT INTO cmcc_network_manage.ods_snmp_samples_rebuild_ordered_20260825 (insert_time, event_time, vendor_id, device_id, device_ip, mib_type, component, metric, value_float, value_text, value_status) SELECT insert_time, event_time, vendor_id, device_id, device_ip, mib_type, component, metric, value_float, value_text, value_status FROM cmcc_network_manage.ods_snmp_samples"), "INSERT INTO cmcc_network_manage.ods_snmp_samples_rebuild_ordered_20260825 (\n  insert_time,\n  event_time,\n  vendor_id,\n  device_id,\n  device_ip,\n  mib_type,\n  component,\n  metric,\n  value_float,\n  value_text,\n  value_status\n)\nSELECT\n  insert_time,\n  event_time,\n  vendor_id,\n  device_id,\n  device_ip,\n  mib_type,\n  component,\n  metric,\n  value_float,\n  value_text,\n  value_status\nFROM cmcc_network_manage.ods_snmp_samples");
  assert.equal(__test__.formatWriteSqlForUi("RENAME TABLE cmcc_network_manage.ods_snmp_samples_rebuild_ordered_20260825 TO cmcc_network_manage.ods_snmp_samples"), "RENAME TABLE cmcc_network_manage.ods_snmp_samples_rebuild_ordered_20260825\nTO cmcc_network_manage.ods_snmp_samples");
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

  const sqlConfirmation = {
    title: "Database Write · UPDATE · MySQL",
    fields: [{ label: "Source", value: "app_mysql", color: "accent" }],
    sql: "UPDATE users SET enabled = 0 WHERE id = 42",
    message: "Database write requires your confirmation."
  };
  let sqlDecision: string | undefined;
  const sqlConfirmationComponent = __test__.createSqlConfirmationComponent(sqlConfirmation, confirmationTheme, (decision) => { sqlDecision = decision; }, { allowSessionTrust: true });
  const sqlConfirmationText = sqlConfirmationComponent.render(120).join("\n");
  assert.match(sqlConfirmationText, /\[success:Trust\]/);
  assert.match(sqlConfirmationText, /\(t\) this source for this session/);
  assert.match(sqlConfirmationText, /including destructive statements/);
  sqlConfirmationComponent.handleInput("t");
  assert.equal(sqlDecision, "session");
  let enterDecision: string | undefined;
  const enterComponent = __test__.createSqlConfirmationComponent(sqlConfirmation, confirmationTheme, (decision) => { enterDecision = decision; }, { allowSessionTrust: true });
  enterComponent.handleInput("enter");
  assert.equal(enterDecision, "once");
  let cancelDecision: string | undefined;
  const sqlCancelComponent = __test__.createSqlConfirmationComponent(sqlConfirmation, confirmationTheme, (decision) => { cancelDecision = decision; });
  sqlCancelComponent.handleInput("escape");
  assert.equal(cancelDecision, "cancel");
  let ignoredDecision: string | undefined;
  const noTrustComponent = __test__.createSqlConfirmationComponent(sqlConfirmation, confirmationTheme, (decision) => { ignoredDecision = decision; });
  noTrustComponent.handleInput("t");
  assert.equal(ignoredDecision, undefined);
  noTrustComponent.handleInput("enter");
  assert.equal(ignoredDecision, "once");
  const resultDetails = { source: "app_mysql", dialect: "mysql" as const, database: "app_db", executed: true, cancelled: false, statement_kind: "update" as const, affected_rows: 2, changed_rows: 1, warning_count: 1, query_id: "mysql-query-1", requested_statement: "UPDATE users SET status = 'disabled' WHERE id = 42" };
  assert.equal(
    __test__.formatWrite(resultDetails),
    "UPDATE users\nSET status = 'disabled'\nWHERE id = 42\n\nSuccess · affected 2 · changed 1\nTarget: mysql · app_mysql · app_db\nWarnings: 1\nQuery ID: mysql-query-1"
  );
  assert.match(__test__.formatWrite({ ...resultDetails, blocked: true, executed: false, cancelled: false, reason: "Writes are disabled.", next_action: "Stop." }), /UPDATE users\nSET status = 'disabled'\nWHERE id = 42\n\nWrite blocked: Writes are disabled\./);
  assert.match(__test__.formatWrite({ ...resultDetails, trusted_for_session: true }), /Confirmation: skipped by session trust/);
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
  const blockedCard = __test__.createWriteResultComponent({ ...resultDetails, executed: false, blocked: true, blocked_reason: "unsupported_statement", reason: "Unsupported." }, false, cardTheme);
  assert.match(blockedCard.render(120).join("\n"), /\[warning:Blocked\]/);
  const confirmationCard = __test__.createWriteResultComponent({ ...resultDetails, executed: false, blocked_reason: "confirmation_required", reason: "Confirmation required." }, false, cardTheme);
  assert.match(confirmationCard.render(120).join("\n"), /\[warning:Confirmation required\]/);
  assert.equal(__test__.writeResultColor({ blocked_reason: "confirmation_required" } as never, false), "warning");
  const plainQueryTheme = { output: (text: string) => text, muted: (text: string) => text, accent: (text: string) => text, success: (text: string) => text, border: (text: string) => text, error: (text: string) => text, number: (text: string) => text, nullValue: (text: string) => text, empty: (text: string) => text, sql: (text: string) => text.split("\n") };
  const tableList = __test__.tableListView({ source: "app", dialect: "mysql", database: "main", tables: ["users", "orders"], truncated: false });
  assert.equal(__test__.renderMetadataResultLines(tableList, {}, false, false, 80, plainQueryTheme).join("\n"), "");
  assert.match(__test__.renderMetadataResultLines(tableList, {}, false, true, 80, plainQueryTheme).join("\n"), /2 tables[\s\S]*users[\s\S]*orders/);
  const tableSearch = __test__.tableSearchView({ source: "app", dialect: "mysql", matches: [{ database: "main", table: "users", engine: "InnoDB", comment: "accounts" }], truncated: false });
  assert.equal(__test__.renderMetadataResultLines(tableSearch, {}, false, false, 80, plainQueryTheme).join("\n"), "");
  const searchLines = __test__.renderMetadataResultLines(tableSearch, {}, false, true, 80, plainQueryTheme).join("\n");
  assert.match(searchLines, /^1 match$/m);
  assert.match(searchLines, /main\s+│ users\s+│ —\s+│ InnoDB\s+│ accounts/);
  const tableDescription = __test__.tableDescriptionView({ source: "app", dialect: "mysql", database: "main", table: "users", engine: "InnoDB", columns: [{ position: 1, name: "id", type: "bigint", nullable: false }], indexes: [{ name: "PRIMARY", columns: ["id"], unique: true }], create_statement: "CREATE TABLE users (id bigint)", truncated: false, warnings: [] });
  const descriptionLines = __test__.renderMetadataResultLines(tableDescription, {}, false, true, 80, plainQueryTheme).join("\n");
  assert.match(descriptionLines, /InnoDB · 1 column · 1 index[\s\S]*Indexes[\s\S]*PRIMARY[\s\S]*DDL[\s\S]*CREATE TABLE users/);
  assert.match(descriptionLines, /id\s+│ bigint\s+│ no\s+│ —\s+│ —/);
  assert.equal(__test__.renderMetadataResultLines(tableDescription, {}, false, false, 80, plainQueryTheme).join("\n"), "");
  assert.equal(__test__.renderMetadataResultLines({ ...tableDescription, truncated: true, warnings: ["ignored"] }, {}, false, false, 80, plainQueryTheme).join("\n"), "");
  const dbList = __test__.databaseListView(["app", "test"], "srv", "mysql");
  assert.equal(__test__.renderMetadataResultLines(dbList, {}, false, false, 80, plainQueryTheme).join("\n"), "");
  assert.match(__test__.renderMetadataResultLines(dbList, {}, false, true, 80, plainQueryTheme).join("\n"), /2 databases[\s\S]*app[\s\S]*test/);
  const truncatedDbList = __test__.databaseListView(["app", "test"], "srv", "mysql", true);
  assert.equal(__test__.renderMetadataResultLines(truncatedDbList, {}, false, false, 80, plainQueryTheme).join("\n"), "");
  assert.match(__test__.renderMetadataResultLines(truncatedDbList, {}, false, true, 80, plainQueryTheme).join("\n"), /truncated/);
  const sources = __test__.sourceListView({ config_path: ".pi/databases.json", sources: [{ name: "srv", label: "MySQL Dev", dialect: "mysql", default: true, host: "127.0.0.1", database: "db", allow_write: false, write_confirm: true, query_timeout_ms: 30000, max_rows: 100 }] });
  assert.equal(__test__.renderMetadataResultLines(sources, {}, false, false, 80, plainQueryTheme).join("\n"), "");
  assert.match(__test__.renderMetadataResultLines(sources, {}, false, true, 100, plainQueryTheme).join("\n"), /1 source[\s\S]*MySQL Dev[\s\S]*srv[\s\S]*mysql[\s\S]*127/);
  const styledSourceTheme = { ...plainQueryTheme, success: (text: string) => `[success:${text}]`, muted: (text: string) => `[muted:${text}]` };
  const sourceStates = __test__.sourceListView({ config_path: ".pi/databases.json", sources: [
    { name: "default_srv", label: "MySQL Dev", dialect: "mysql", default: true, host: "localhost", database: undefined, allow_write: false, write_confirm: true, query_timeout_ms: 30000, max_rows: 100 },
    { name: "other_srv", label: "MySQL Diagnostic", dialect: "mysql", default: false, host: "localhost", database: undefined, allow_write: false, write_confirm: true, query_timeout_ms: 30000, max_rows: 100 }
  ] });
  const sourceStateText = __test__.renderMetadataResultLines(sourceStates, {}, false, true, 120, styledSourceTheme).join("\n");
  assert.match(sourceStateText, /\[success:default\]/);
  assert.match(sourceStateText, /\[muted:—/);
  const pingComp = new __test__.PingResultComponent({ source: "srv", dialect: "mysql", ok: true, server_version: "8.0", latency_ms: 12.4 }, {}, false, plainQueryTheme);
  assert.match(pingComp.render(80).join("\n"), /connected · 8\.0 · 12\.4 ms/);
  const slowPingComp = new __test__.PingResultComponent({ source: "srv", dialect: "mysql", ok: true, latency_ms: 1236 }, {}, false, plainQueryTheme);
  assert.match(slowPingComp.render(80).join("\n"), /connected · 1\.24 s/);
  const queryDetails = { source: "app", dialect: "mysql", database: "app_db", row_count: 2, truncated: false, warnings: [], elapsed_ms: 12.34, columns: ["id", "name"], rows: [[1, "Lin"], [2, "Pi"]] };
  const wideLines = __test__.renderQueryResultLines({ query: "SELECT id, name FROM users" }, { details: queryDetails }, false, false, 80);
  assert.equal(wideLines.join("\n"), "SELECT\n  id,\n  name\nFROM users\n\n2 rows · 12.3 ms");
  assert.doesNotMatch(wideLines.join("\n"), /Lin/);
  assert.match(__test__.renderQueryResultLines({ query: "SELECT id, name FROM users" }, { details: queryDetails }, false, true, 80).join("\n"), /id │ name[\s\S]*Lin/);
  const expandedQuery = __test__.renderQueryResultLines({ query: "SELECT id, name FROM users" }, { details: queryDetails }, false, true, 80).join("\n");
  assert.match(expandedQuery, /FROM users\n\n2 rows · 12\.3 ms\n\nid │ name/, "expanded keeps the summary line before the table");
  assert.equal(wideLines.every((line: string) => [...line].length <= 80), true);
  assert.match(__test__.renderQueryResultLines({ query: "SELECT id, name FROM users" }, { details: { ...queryDetails, query_id: "mysql-query-1" } }, false, false, 80).join("\n"), /2 rows · 12\.3 ms\nQuery ID: mysql-query-1/);
  assert.match(__test__.renderQueryResultLines({ query: "SELECT id, name FROM users" }, { details: { ...queryDetails, query_id: "mysql-query-1" } }, false, true, 80).join("\n"), /Query ID: mysql-query-1/);
  const narrowLines = __test__.renderQueryData(queryDetails, false, 30, plainQueryTheme);
  assert.match(narrowLines.join("\n"), /id │ name/);
  assert.equal(narrowLines.every((line: string) => [...line].length <= 30), true);
  const packedColumns = Array.from({ length: 10 }, (_, index) => `c${index}`);
  const packedDetails = { ...queryDetails, columns: packedColumns, rows: [packedColumns.map(() => "v")] };
  const packedLines = __test__.renderQueryData(packedDetails, false, 30, plainQueryTheme).join("\n");
  assert.match(packedLines, /c0 │ c1/);
  assert.match(packedLines, /… \+4 columns/);
  assert.doesNotMatch(packedLines, /#1/);
  assert.equal(packedLines.split("\n").every((line: string) => [...line].length <= 30), true);
  assert.match(__test__.renderQueryData(packedDetails, true, 30, plainQueryTheme).join("\n"), /#1\nc0\s+│ v/);
  const wideColumns = ["id", "order_no", "customer_id", "customer_name", "status", "payment_status", "shipping_status", "total_amount", "currency", "created_at", "updated_at", "warehouse"];
  const wideDetails = { ...queryDetails, columns: wideColumns, rows: [wideColumns.map((column, index) => (column === "total_amount" ? 199.5 : `v${index}`))] };
  const collapsedWide = __test__.renderQueryData(wideDetails, false, 96, plainQueryTheme).join("\n");
  assert.match(collapsedWide, /customer_id\s+│\s+customer_na…/);
  assert.match(collapsedWide, /… \+4 columns/);
  const expandedWide = __test__.renderQueryData(wideDetails, true, 96, plainQueryTheme).join("\n");
  assert.match(expandedWide, /#1\nid\s+│ v0[\s\S]*warehouse\s+│ v11/);
  assert.doesNotMatch(expandedWide, /\+4 columns/);
  assert.doesNotMatch(__test__.renderQueryData({ ...queryDetails, columns: ["name"], rows: [["x".repeat(100)]] }, false, 80, plainQueryTheme).join("\n"), /\x1b\[0m/);
  const manyRows = { ...queryDetails, columns: ["id"], rows: Array.from({ length: 11 }, (_, id) => [id]) };
  const collapsedRows = __test__.renderQueryData(manyRows, false, 80, plainQueryTheme).join("\n");
  assert.match(collapsedRows, /… 1 more row/);
  assert.match(collapsedRows, /app\.tools\.expand/);
  const collapsedQuery = __test__.renderQueryResultLines({ query: "SELECT id FROM users" }, { details: { ...manyRows, row_count: 11 } }, false, false, 80).join("\n");
  assert.equal(collapsedQuery, "SELECT id\nFROM users\n\n11 rows · 12.3 ms");
  assert.doesNotMatch(__test__.renderQueryResultLines({ query: "SELECT 1" }, { details: { row_count: 0, columns: ["x"], rows: [] } }, false, false, 80).join("\n"), /No rows returned/);
  assert.equal(__test__.renderQueryResultLines({ query: "SELECT 1" }, { details: { row_count: 0, columns: ["x"], rows: [] } }, false, false, 80).join("\n"), "SELECT 1\n\n0 rows");
  const restoredQuery = __test__.renderQueryResultLines(
    { query: "SELECT id, name FROM users" },
    { content: [{ type: "text", text: JSON.stringify(queryDetails) }] },
    false,
    false,
    80,
    plainQueryTheme
  );
  assert.equal(restoredQuery.join("\n"), wideLines.join("\n"));
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
    "database_write",
    "database_usql"
  ];
  assert.deepEqual(tools.map((tool) => tool.name), expected);
  assert.equal(tools.every((tool) => typeof tool.outputSchema === "object" && tool.outputSchema !== null), true, "every database tool declares an output schema");
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
  assert.match(
    tools.find((tool) => tool.name === "database_write")?.promptGuidelines?.join(" ") ?? "",
    /exactly one supported SQL statement per call/
  );
  assert.match(
    tools.find((tool) => tool.name === "database_write")?.promptGuidelines?.join(" ") ?? "",
    /multi-step operations/
  );
  assert.equal(
    (tools.find((tool) => tool.name === "database_write")?.parameters?.database as { description?: unknown } | undefined)?.description,
    "Database for table-scoped writes; omit only for CREATE DATABASE and DROP DATABASE"
  );
  const sourceSelectingTools = tools.filter((tool) => tool.name !== "database_list_sources" && tool.name !== USQL_TOOL_NAME);
  assert.equal(sourceSelectingTools.every((tool) => typeof tool.parameters?.dialect === "object"), true);
  assert.equal(
    (tools.find((tool) => tool.name === "database_query")?.parameters?.dialect as { description?: unknown; pattern?: unknown } | undefined)?.description,
    "MySQL or ClickHouse; selects that dialect's default source when source is omitted"
  );
  assert.equal(
    (tools.find((tool) => tool.name === "database_query")?.parameters?.dialect as { pattern?: unknown } | undefined)?.pattern,
    "^(mysql|clickhouse)$"
  );

  const callTitleDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-database-call-title-"));
  writeConfig(callTitleDir, {
    version: 2,
    default_sources: { mysql: "mysql_localhost", clickhouse: "clickhouse_localhost" },
    sources: [
      { name: "mysql_localhost", dialect: "mysql", options: { host: "localhost", user: "reader" } },
      { name: "clickhouse_localhost", dialect: "clickhouse", options: { url: "http://localhost:8123", username: "reader" } }
    ]
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
  assert.match(renderCall("database_ping", { source: "mysql_localhost" }), /Ping.*\[muted: · mysql_localhost\].*\[muted: · MySQL\]/);
  assert.match(renderCall("database_ping", { dialect: "clickhouse" }), /Ping.*\[muted: · clickhouse_localhost\].*\[muted: · ClickHouse\]/);
  assert.match(renderCall("database_list_databases", { source: "mysql_localhost" }), /Databases.*mysql_localhost/);
  assert.match(renderCall("database_list_tables", { source: "mysql_localhost", database: "app_db" }), /Tables.*app_db.*mysql_localhost/);
  assert.match(renderCall("database_search_tables", { source: "mysql_localhost", term: "users" }), /Find tables.*users.*mysql_localhost/);
  assert.match(renderCall("database_describe_table", { source: "mysql_localhost", database: "app_db", table: "users" }), /Describe.*app_db\.users.*mysql_localhost/);
  assert.match(renderCall("database_query", { source: "mysql_localhost", database: "app_db", query: "SELECT 1" }), /Query.*app_db.*\[muted: · mysql_localhost\].*\[muted: · MySQL\]/);
  assert.match(renderCall("database_write", { source: "mysql_localhost", database: "app_db", statement: "INSERT INTO users (id) VALUES (1)" }), /Write.*app_db.*INSERT.*mysql_localhost.*MySQL/);

  const sourceListTool = tools.find((tool) => tool.name === "database_list_sources");
  assert.equal(typeof sourceListTool?.execute, "function");
  const sourceListResult = await sourceListTool!.execute!("test", {}, undefined, () => {}, { cwd: callTitleDir, hasUI: false });
  const sourceListPayload = sourceListResult as { details: Record<string, unknown>; structuredContent: Record<string, unknown>; content: Array<{ text?: string }> };
  assert.deepEqual(sourceListPayload.details.default_sources, { mysql: "mysql_localhost", clickhouse: "clickhouse_localhost" });
  assert.deepEqual(sourceListPayload.structuredContent, JSON.parse(sourceListPayload.content[0]!.text!));
  assert.equal(sourceListPayload.content[0]?.text, JSON.stringify(sourceListPayload.details));

  const usqlTool = tools.find((tool) => tool.name === USQL_TOOL_NAME);
  assert.equal(typeof usqlTool?.execute, "function");
  const previousUsqlBinary = process.env.PI_DATABASE_USQL_BIN;
  process.env.PI_DATABASE_USQL_BIN = process.execPath;
  resetUsqlBinaryCache();
  try {
    const usqlResult = await usqlTool!.execute!("test", {
      connection: "postgres://app@localhost/app",
      statement: "SELECT 1",
      timeout_ms: 900_000
    }, undefined, () => {}, {
      cwd: callTitleDir,
      hasUI: true,
      ui: { confirm: () => true }
    });
    const usqlDetails = (usqlResult as { details: Record<string, unknown> }).details;
    assert.equal(usqlDetails.confirmed, true);
    assert.equal(typeof usqlDetails.error, "string", "the test executable exits unsuccessfully, but usql execution must return a result");
    assert.doesNotMatch(String(usqlDetails.error), /USQL_MAX_TIMEOUT_MS is not defined/);
  } finally {
    restoreEnvironmentValue("PI_DATABASE_USQL_BIN", previousUsqlBinary);
    resetUsqlBinaryCache();
  }

  const usqlPolicyDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-database-usql-policy-"));
  writeConfig(usqlPolicyDir, {
    version: 2,
    default_sources: { mysql: "readonly_mysql" },
    sources: [{ name: "readonly_mysql", dialect: "mysql", allow_write: false, options: { host: "localhost", user: "reader" } }]
  });
  setProjectConfigEnabled(usqlPolicyDir, true);
  const blockedUsql = await usqlTool!.execute!("test", {
    source: "readonly_mysql",
    connection: "mysql://reader@localhost/app",
    statement: "CREATE TABLE blocked_write (id int)"
  }, undefined, () => {}, { cwd: usqlPolicyDir, hasUI: false });
  const blockedUsqlDetails = (blockedUsql as { details: Record<string, unknown> }).details;
  assert.equal(blockedUsqlDetails.blocked, true);
  assert.equal(blockedUsqlDetails.blocked_reason, "source_read_only");
  assert.equal(blockedUsqlDetails.source, "readonly_mysql");
  assert.equal(blockedUsqlDetails.allow_write, false);
  assert.match(String(blockedUsqlDetails.error), /Writes are disabled/);

  const blockedCopy = await usqlTool!.execute!("test", {
    source: "readonly_mysql",
    connection: "mysql://reader@localhost/app",
    statement: "\copy src dst"
  }, undefined, () => {}, { cwd: usqlPolicyDir, hasUI: false });
  assert.equal((blockedCopy as { details: Record<string, unknown> }).details.blocked_reason, "source_read_only");

  const blockedOutfile = await usqlTool!.execute!("test", {
    source: "readonly_mysql",
    connection: "mysql://reader@localhost/app",
    statement: "SELECT 1 INTO OUTFILE '/tmp/blocked'"
  }, undefined, () => {}, { cwd: usqlPolicyDir, hasUI: false });
  assert.equal((blockedOutfile as { details: Record<string, unknown> }).details.blocked_reason, "source_read_only");

  const previousUsqlPolicyBinary = process.env.PI_DATABASE_USQL_BIN;
  process.env.PI_DATABASE_USQL_BIN = path.join(os.tmpdir(), "pi-database-missing-usql-policy");
  resetUsqlBinaryCache();
  try {
    const readOnlyMeta = await usqlTool!.execute!("test", {
      source: "readonly_mysql",
      connection: "mysql://reader@localhost/app",
      statement: String.fromCharCode(92) + "dt"
    }, undefined, () => {}, { cwd: usqlPolicyDir, hasUI: false });
    const readOnlyMetaDetails = (readOnlyMeta as { details: Record<string, unknown> }).details;
    assert.equal(readOnlyMetaDetails.blocked, undefined);
    assert.match(String(readOnlyMetaDetails.error), /usql binary was not found/);
  } finally {
    restoreEnvironmentValue("PI_DATABASE_USQL_BIN", previousUsqlPolicyBinary);
    resetUsqlBinaryCache();
  }

  const pingTool = tools.find((tool) => tool.name === "database_ping");
  assert.equal(typeof pingTool?.execute, "function");
  const originalClickHousePing = clickhouseAdapter.ping;
  clickhouseAdapter.ping = async (source) => ({ source: source.name, dialect: source.dialect, ok: true });
  try {
    const pingResult = await pingTool!.execute!("test", { dialect: "clickhouse" }, undefined, () => {}, { cwd: callTitleDir, hasUI: false });
    const pingPayload = pingResult as { details: Record<string, unknown>; structuredContent: Record<string, unknown> };
    assert.equal(pingPayload.details.source, "clickhouse_localhost");
    assert.deepEqual(pingPayload.structuredContent, pingPayload.details);
    await assert.rejects(
      () => pingTool!.execute!("test", { source: "mysql_localhost", dialect: "clickhouse" }, undefined, () => {}, { cwd: callTitleDir, hasUI: false }),
      /uses mysql/
    );
  } finally {
    clickhouseAdapter.ping = originalClickHousePing;
  }

  const nextSessionTools: string[] = [];
  __test__.registerTools({
    registerTool(tool: { name?: string }) {
      if (tool.name) nextSessionTools.push(tool.name);
    }
  } as never);
  assert.deepEqual(nextSessionTools, expected, "a replacement session must receive the complete database tool set");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-database-blocked-write-"));
  writeConfig(dir, {
    version: 2,
    default_sources: { mysql: "readonly_mysql" },
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
  const disabledDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-database-disabled-execute-"));
  writeConfig(disabledDir, {
    version: 2,
    enabled: false,
    default_sources: { mysql: "readonly_mysql" },
    sources: [{ name: "readonly_mysql", dialect: "mysql", allow_write: false, options: { host: "localhost", user: "reader" } }]
  });
  await assert.rejects(
    () => queryTool!.execute!("test", { database: "app_db", query: "SELECT 1" }, undefined, () => {}, { cwd: disabledDir, hasUI: false }),
    /Database tools are disabled for this project/
  );
  const result = await writeTool!.execute!("test", { statement: "CREATE DATABASE app_db" }, undefined, () => {}, { cwd: dir, hasUI: false });
  const writePayload = result as { details: Record<string, unknown>; structuredContent: Record<string, unknown>; content: Array<{ text?: string }> };
  const details = writePayload.details;
  assert.equal(details.blocked, true);
  assert.equal(details.blocked_reason, "source_read_only");
  assert.deepEqual(writePayload.structuredContent, JSON.parse(JSON.stringify(details)));
  assert.match(String(writePayload.content[0]?.text), /CREATE DATABASE app_db/);
  assert.notEqual(writePayload.content[0]?.text, JSON.stringify(writePayload.structuredContent), "custom human-readable write text is preserved");
  assert.equal(details.allow_write, false);
  assert.equal(details.write_confirm, false);
  assert.match(String(details.reason), /Writes are disabled/);
  assert.match(String(details.next_action), /Stop this write attempt\. Explain this source policy/);

  const confirmationDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-database-confirmed-write-"));
  writeConfig(confirmationDir, {
    version: 2,
    default_sources: { mysql: "writer_mysql" },
    sources: [
      { name: "writer_mysql", dialect: "mysql", allow_write: true, write_confirm: true, options: { host: "localhost", user: "writer" } }
    ]
  });
  let confirmation: { title?: string; message?: string } = {};
  const missingDatabaseWrite = await writeTool!.execute!("test", { statement: "UPDATE users SET enabled = 0 WHERE id = 42" }, undefined, () => {}, { cwd: confirmationDir, hasUI: false });
  const missingDatabaseDetails = (missingDatabaseWrite as { details: Record<string, unknown> }).details;
  assert.equal(missingDatabaseDetails.blocked, true);
  assert.equal(missingDatabaseDetails.blocked_reason, "missing_database");
  assert.match(String(missingDatabaseDetails.reason), /requires a database argument/);

  const unconfirmedWrite = await writeTool!.execute!("test", { database: "app_db", statement: "UPDATE users SET enabled = 0 WHERE id = 42" }, undefined, () => {}, { cwd: confirmationDir, hasUI: false });
  const unconfirmedDetails = (unconfirmedWrite as { details: Record<string, unknown> }).details;
  assert.equal(unconfirmedDetails.executed, false);
  assert.equal(unconfirmedDetails.blocked, undefined);
  assert.equal(unconfirmedDetails.blocked_reason, "confirmation_required");
  assert.match(String(unconfirmedDetails.reason), /Interactive confirmation is required/);

  const unsupportedWrite = await writeTool!.execute!("test", { database: "app_db", statement: "CREATE FUNCTION f() RETURNS INT RETURN 1" }, undefined, () => {}, { cwd: confirmationDir, hasUI: false });
  const unsupportedDetails = (unsupportedWrite as { details: Record<string, unknown> }).details;
  assert.equal(unsupportedDetails.blocked, true);
  assert.equal(unsupportedDetails.blocked_reason, "unsupported_statement");
  assert.match(String(unsupportedDetails.next_action), /database_usql with confirmation/);
  assert.doesNotMatch(String(unsupportedDetails.next_action), /bypass a read-only/);

  const invalidWrite = await writeTool!.execute!("test", { database: "app_db", statement: "SELECT 1; SELECT 2" }, undefined, () => {}, { cwd: confirmationDir, hasUI: false });
  const invalidDetails = (invalidWrite as { details: Record<string, unknown> }).details;
  assert.equal(invalidDetails.blocked, true);
  assert.equal(invalidDetails.blocked_reason, "invalid_statement");
  assert.doesNotMatch(String(invalidDetails.next_action), /ask the user whether to run the statement through database_usql/);
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
  assert.equal(cancelledDetails.blocked_reason, "cancelled");
  assert.equal(cancelledDetails.write_confirm, true);
  assert.equal(cancelledDetails.requested_statement, "UPDATE users SET enabled = 0 WHERE id = 42");
  assert.equal(confirmation.title, "Database Write · UPDATE · MySQL");
  assert.match(confirmation.message ?? "", /Database: app_db/);
  assert.match(confirmation.message ?? "", /SQL:\nUPDATE users\nSET enabled = 0\nWHERE id = 42/);
  assert.doesNotMatch(confirmation.message ?? "", /Risk:/);

  const readonlySource = { name: "readonly", configPath: "unit", allowWrite: false } as never;
  __test__.trustWriteSource(readonlySource);
  assert.equal(__test__.isWriteSourceTrusted(readonlySource), false);

  const originalTrustWrite = mysqlAdapter.write;
  const trustWrites: string[] = [];
  mysqlAdapter.write = async (source, database, write) => {
    trustWrites.push(write.statement);
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
    __test__.clearTrustedWriteSources();
    let tuiPrompts = 0;
    const trustStatuses: Array<string | undefined> = [];
    const tuiCtx = {
      cwd: confirmationDir,
      hasUI: true,
      mode: "tui",
      ui: {
        setStatus(_name: string, value: string | undefined) {
          trustStatuses.push(value);
        },
        theme: { fg: (_color: string, text: string) => text },
        custom(factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (decision: string) => void) => { handleInput(data: string): void }) {
          tuiPrompts += 1;
          return new Promise((resolve) => {
            const component = factory({}, confirmationTheme, {}, resolve);
            component.handleInput("t");
          });
        }
      }
    };
    const trustedWrite = await writeTool!.execute!("test", { database: "app_db", statement: "DELETE FROM users WHERE id = 1" }, undefined, () => {}, tuiCtx);
    const trustedDetails = (trustedWrite as { details: Record<string, unknown> }).details;
    assert.equal(tuiPrompts, 1);
    assert.equal(trustedDetails.executed, true);
    assert.equal(trustedDetails.trusted_for_session, true);
    assert.equal(trustWrites.length, 1);
    assert.match(String(trustStatuses.at(-1)), /trusted: writer_mysql\/app_db/);

    const secondTrustedWrite = await writeTool!.execute!("test", { database: "app_db", statement: "DELETE FROM users WHERE id = 2" }, undefined, () => {}, { cwd: confirmationDir, hasUI: false });
    const secondTrustedDetails = (secondTrustedWrite as { details: Record<string, unknown> }).details;
    assert.equal(secondTrustedDetails.executed, true);
    assert.equal(secondTrustedDetails.trusted_for_session, true);
    assert.equal(trustWrites.length, 2);
    assert.deepEqual(__test__.listTrustedWriteSources(), [{ name: "writer_mysql", dialect: "mysql", database: "app_db" }]);

    const otherDatabaseWrite = await writeTool!.execute!("test", { database: "other_db", statement: "DELETE FROM users WHERE id = 3" }, undefined, () => {}, { cwd: confirmationDir, hasUI: false });
    assert.equal((otherDatabaseWrite as { details: Record<string, unknown> }).details.blocked_reason, "confirmation_required");

    __test__.clearTrustedWriteSources();
    const resetWrite = await writeTool!.execute!("test", { database: "app_db", statement: "DELETE FROM users WHERE id = 3" }, undefined, () => {}, { cwd: confirmationDir, hasUI: false });
    const resetDetails = (resetWrite as { details: Record<string, unknown> }).details;
    assert.equal(resetDetails.blocked_reason, "confirmation_required");
    assert.equal(trustWrites.length, 2);
  } finally {
    mysqlAdapter.write = originalTrustWrite;
    __test__.clearTrustedWriteSources();
  }

  const noConfirmationDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-database-no-confirmation-write-"));
  writeConfig(noConfirmationDir, {
    version: 2,
    default_sources: { mysql: "local_mysql" },
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

    const unconfirmedViewReplacement = await writeTool!.execute!("test", {
      database: "app_db",
      statement: "CREATE OR REPLACE VIEW app_db.v_catalog AS SELECT id FROM users"
    }, undefined, () => {}, { cwd: noConfirmationDir, hasUI: false });
    const unconfirmedViewReplacementDetails = (unconfirmedViewReplacement as { details: Record<string, unknown> }).details;
    assert.equal(writes, 3);
    assert.equal(unconfirmedViewReplacementDetails.executed, false);
    assert.equal(unconfirmedViewReplacementDetails.forced_confirm, true);
    assert.match(String(unconfirmedViewReplacementDetails.reason), /Interactive confirmation is required/);

    let viewReplacementConfirmation: { title?: string; message?: string } = {};
    const confirmedViewReplacement = await writeTool!.execute!("test", {
      database: "app_db",
      statement: "CREATE OR REPLACE VIEW app_db.v_catalog AS SELECT id FROM users"
    }, undefined, () => {}, {
      cwd: noConfirmationDir,
      hasUI: true,
      ui: {
        confirm(title: string, message: string) {
          viewReplacementConfirmation = { title, message };
          return true;
        }
      }
    });
    const confirmedViewReplacementDetails = (confirmedViewReplacement as { details: Record<string, unknown> }).details;
    assert.equal(writes, 4);
    assert.equal(confirmedViewReplacementDetails.executed, true);
    assert.equal(confirmedViewReplacementDetails.forced_confirm, true);
    assert.equal(viewReplacementConfirmation.title, "Database Write · CREATE · MySQL");
  } finally {
    mysqlAdapter.write = originalWrite;
  }

  const materializedViewDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-database-materialized-view-"));
  writeConfig(materializedViewDir, {
    version: 2,
    default_sources: { clickhouse: "analytics" },
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
    version: 2,
    default_sources: { mysql: "cleanup_mysql" },
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
      version: 2,
      default_sources: { mysql: "readonly_mysql" },
      sources: [
        { name: "readonly_mysql", dialect: "mysql", allow_write: false, options: { host: "localhost", user: "reader" } }
      ]
    });
    const blockedDelete = await writeTool!.execute!("test", { database: "app_db", statement: "DELETE FROM users WHERE id = 42" }, undefined, () => {}, { cwd: readonlyDir, hasUI: false });
    const blockedDeleteDetails = (blockedDelete as { details: Record<string, unknown> }).details;
    assert.equal(blockedDeleteDetails.blocked, true);
    assert.equal(blockedDeleteDetails.blocked_reason, "source_read_only");
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
  assert.equal(databaseStatusText({ enabled: true }), "database: on");
  assert.equal(databaseStatusText({ enabled: false }), undefined);
}

function testSourceTree() {
  const nodes: SourceTreeNode[] = [
    { name: "mysql-a", label: "MySQL Dev", dialect: "mysql", default: true, host: "127.0.0.1:3306", database: "app", allow_write: true, write_confirm: false, query_timeout_ms: 30_000, max_rows: 100 },
    { name: "ch-b", label: "ClickHouse Diagnostic", dialect: "clickhouse", default: false, host: "http://127.0.0.1:8123", database: "analytics", allow_write: false, write_confirm: true, query_timeout_ms: 30_000, max_rows: 100 }
  ];
  const validColors = new Set(["border", "accent", "dim", "muted", "success", "warning", "text"]);
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
  const sourceTreeText = formatSourceTreeText(nodes).join("\n");
  assert.match(sourceTreeText, /Database Sources · 2/);
  assert.match(sourceTreeText, /MySQL Dev\s+MySQL\s+★/);
  assert.match(sourceTreeText, /ClickHouse Diagnostic\s+ClickHouse/);

  const collapsed = component.render(80).join("\n");
  assert.match(collapsed, /Database Sources · 2/);
  assert.match(collapsed, /MySQL Dev.*MySQL.*★/);
  assert.match(collapsed, /ClickHouse Diagnostic.*ClickHouse/);
  assert.doesNotMatch(collapsed, /mysql-a|ch-b|127\.0\.0\.1:3306|http:\/\/127\.0\.0\.1:8123/);
  assert.equal([...usedColors].every((color) => validColors.has(color)), true);
  assert.equal(usedColors.has("text"), true);

  component.handleInput("down");
  component.handleInput("enter");
  assert.ok(renders >= 2);
  const expanded = component.render(80).join("\n");
  assert.match(expanded, /ClickHouse Diagnostic.*ClickHouse/);
  assert.match(expanded, /source\s+ch-b/);
  assert.match(expanded, /http:\/\/127\.0\.0\.1:8123/);
  assert.match(expanded, /confirm on/);

  component.handleInput("up");
  component.handleInput("enter");
  assert.match(component.render(80).join("\n"), /MySQL Dev.*MySQL.*★/);
  assert.match(component.render(80).join("\n"), /source\s+mysql-a/);

  component.handleInput("escape");
  assert.equal(closed, true);
}

async function testWriteBoundaries() {
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
  assert.equal(mysqlAdapter.validateWrite(mysql, "CREATE VIEW v_alarm_type_catalog AS SELECT id FROM alarm_builtin_config").statementKind, "create");
  assert.equal(mysqlAdapter.validateWrite(mysql, "CREATE VIEW v_alarm_type_catalog AS SELECT id FROM alarm_builtin_config").databaseRequired, true);
  assert.equal(mysqlAdapter.validateWrite(mysql, "CREATE VIEW v_alarm_type_catalog AS SELECT id FROM alarm_builtin_config").forceConfirm, undefined);
  assert.equal(mysqlAdapter.validateWrite(mysql, "CREATE OR REPLACE VIEW `v_alarm_type_catalog` (`scope`, `code`) AS SELECT 'builtin' AS scope, code FROM alarm_builtin_config").statementKind, "create");
  assert.equal(mysqlAdapter.validateWrite(mysql, "CREATE OR REPLACE VIEW app_db.v_catalog AS SELECT id FROM alarm_builtin_config").databaseRequired, true);
  assert.equal(mysqlAdapter.validateWrite(mysql, "CREATE OR REPLACE VIEW app_db.v_catalog AS SELECT id FROM alarm_builtin_config").forceConfirm, true);
  assert.throws(() => mysqlAdapter.validateWrite(mysql, "CREATE ALGORITHM = MERGE VIEW v AS SELECT id FROM alarm_builtin_config"), /support only/);
  assert.throws(() => mysqlAdapter.validateWrite(mysql, "CREATE VIEW v AS TABLE alarm_builtin_config"), /support only/);
  assert.throws(() => mysqlAdapter.validateWrite(mysql, "CREATE OR REPLACE VIEW v"), /support only/);
  assert.equal(mysqlAdapter.validateWrite(mysql, "CREATE INDEX idx_email ON users (email)").statementKind, "create");
  assert.equal(mysqlAdapter.validateWrite(mysql, "CREATE UNIQUE INDEX idx_email ON users (email)").forceConfirm, true);
  assert.equal(mysqlAdapter.validateWrite(mysql, "CREATE INDEX idx_email ON users (email)").databaseRequired, true);
  assert.equal(mysqlAdapter.validateWrite(mysql, "DROP INDEX idx_email ON users").statementKind, "drop");
  assert.equal(mysqlAdapter.validateWrite(mysql, "DROP INDEX idx_email ON users").forceConfirm, true);
  assert.throws(() => mysqlAdapter.validateWrite(mysql, "DROP INDEX idx_email"), /single-object DROP/);
  assert.throws(() => mysqlAdapter.validateWrite(mysql, "CREATE INDEX idx_email ON users"), /support only/);
  assert.equal(mysqlAdapter.validateWrite(mysql, "ALTER TABLE users ADD COLUMN nickname varchar(32)").statementKind, "alter");
  assert.equal(mysqlAdapter.validateWrite(mysql, "ALTER TABLE users ADD COLUMN nickname varchar(32)").forceConfirm, undefined);
  assert.equal(mysqlAdapter.validateWrite(mysql, "ALTER TABLE users ADD PRIMARY KEY (id)").forceConfirm, undefined);
  assert.equal(mysqlAdapter.validateWrite(mysql, "ALTER TABLE users ADD UNIQUE (email)").forceConfirm, undefined);
  assert.equal(mysqlAdapter.validateWrite(mysql, "ALTER TABLE users ADD UNIQUE KEY uk_email (email)").forceConfirm, undefined);
  assert.equal(mysqlAdapter.validateWrite(mysql, "ALTER TABLE users ADD FOREIGN KEY (org_id) REFERENCES orgs (id)").forceConfirm, undefined);
  assert.equal(mysqlAdapter.validateWrite(mysql, "ALTER TABLE users ADD CONSTRAINT chk CHECK (age > 0)").forceConfirm, undefined);
  assert.throws(() => mysqlAdapter.validateWrite(mysql, "UPDATE users SET name = 'a'"), /WHERE clause/);
  assert.equal(mysqlAdapter.validateWrite(mysql, "INSERT INTO users SELECT id FROM archived").statementKind, "insert");
  assert.equal(mysqlAdapter.validateWrite(mysql, "INSERT INTO users (id) SELECT id FROM archived").forceConfirm, true);
  assert.throws(() => mysqlAdapter.validateWrite(mysql, "INSERT INTO users SET id = 1"), /support only/);
  assert.equal(mysqlAdapter.validateWrite(mysql, "ALTER TABLE users ADD COLUMN nickname varchar(32), DROP COLUMN old_name").forceConfirm, true);
  assert.equal(mysqlAdapter.validateWrite(mysql, "ALTER TABLE users DROP COLUMN old_name").statementKind, "alter");
  assert.equal(mysqlAdapter.validateWrite(mysql, "ALTER TABLE users DROP COLUMN old_name").forceConfirm, true);
  assert.equal(mysqlAdapter.validateWrite(mysql, "ALTER TABLE gateway_node DROP COLUMN vendor, DROP COLUMN model").forceConfirm, true);
  assert.equal(mysqlAdapter.validateWrite(mysql, "ALTER TABLE users MODIFY COLUMN nickname varchar(64)").forceConfirm, true);
  assert.equal(mysqlAdapter.validateWrite(mysql, "ALTER TABLE users CHANGE COLUMN nickname name varchar(64)").forceConfirm, true);
  assert.equal(mysqlAdapter.validateWrite(mysql, "ALTER TABLE users RENAME COLUMN nickname TO name").forceConfirm, true);
  assert.equal(mysqlAdapter.validateWrite(mysql, "ALTER TABLE users DROP INDEX idx_nickname").forceConfirm, true);
  assert.equal(mysqlAdapter.validateWrite(mysql, "ALTER TABLE users DROP PARTITION p0").forceConfirm, true);
  assert.equal(mysqlAdapter.validateWrite(mysql, "ALTER TABLE users DROP CHECK chk").forceConfirm, true);
  assert.equal(mysqlAdapter.validateWrite(mysql, "ALTER TABLE users DROP KEY idx_nickname").forceConfirm, true);
  assert.equal(mysqlAdapter.validateWrite(mysql, "ALTER TABLE users DROP COLUMN IF EXISTS old_name").forceConfirm, true);
  assert.throws(() => mysqlAdapter.validateWrite(mysql, "ALTER TABLE users DROP PROJECTION p"), /single destructive actions/);
  assert.throws(() => mysqlAdapter.validateWrite(mysql, "ALTER TABLE users DROP COLUMN a, DROP COLUMN b, ADD COLUMN c int, RANDOM GARBAGE"), /single destructive actions/);
  assert.throws(() => mysqlAdapter.validateWrite(mysql, "ALTER TABLE users ENGINE = InnoDB"), /supports only/);
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
  assert.equal(mysqlAdapter.validateWrite(mysql, "DROP VIEW IF EXISTS v_alarm_type_catalog").statementKind, "drop");
  assert.equal(mysqlAdapter.validateWrite(mysql, "DROP VIEW IF EXISTS v_alarm_type_catalog").databaseRequired, true);
  assert.equal(mysqlAdapter.validateWrite(mysql, "DROP VIEW `v_alarm_type_catalog`").statementKind, "drop");
  assert.throws(() => mysqlAdapter.validateWrite(mysql, "DROP VIEW v1, v2"), /single-object/);
  assert.equal(mysqlAdapter.validateWrite(mysql, "RENAME TABLE users TO users_archive").statementKind, "rename");
  assert.equal(mysqlAdapter.validateWrite(mysql, "RENAME TABLE app_db.users TO archive.users").databaseRequired, true);
  assert.throws(() => mysqlAdapter.validateWrite(mysql, "RENAME TABLE a TO b, c TO d"), /single-pair/);
  assert.equal(mysqlAdapter.validateWrite(mysql, "REPLACE INTO users (id) VALUES (1)").statementKind, "replace");
  assert.throws(() => mysqlAdapter.validateWrite(mysql, "REPLACE INTO users SELECT id FROM archived"), /support only/);
  assert.throws(() => mysqlAdapter.validateWrite(mysql, "CREATE FUNCTION f() RETURNS INT RETURN 1"), /support only/);
  assert.throws(() => mysqlAdapter.validateWrite(mysql, "WITH x AS (SELECT 1) INSERT INTO users SELECT * FROM x"), /support only/);
  await assert.rejects(() => mysqlAdapter.query(mysql, "app_db", "SELECT SLEEP(5)", 100), /time-wait/);
  await assert.rejects(() => mysqlAdapter.query(mysql, "app_db", "SELECT BENCHMARK(1000000, MD5('x'))", 100), /time-wait/);
  await assert.rejects(() => mysqlAdapter.query(mysql, "app_db", "SELECT GET_LOCK('k', 10)", 100), /time-wait/);
  await assert.rejects(() => mysqlAdapter.query(mysql, "app_db", "SELECT * FROM users INTO OUTFILE '/tmp/x'", 100), /file/);
  await assert.rejects(() => mysqlAdapter.query(mysql, "app_db", "SELECT * FROM users FOR UPDATE", 100), /lock/);

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
  assert.equal(clickhouseAdapter.validateWrite(clickhouse, "CREATE VIEW v_events AS SELECT id FROM events").statementKind, "create");
  assert.equal(clickhouseAdapter.validateWrite(clickhouse, "CREATE VIEW v_events AS SELECT id FROM events").forceConfirm, true);
  assert.equal(clickhouseAdapter.validateWrite(clickhouse, "CREATE OR REPLACE VIEW v_events AS SELECT id FROM events").forceConfirm, true);
  assert.equal(clickhouseAdapter.validateWrite(clickhouse, "DROP VIEW IF EXISTS v_events").statementKind, "drop");
  assert.equal(clickhouseAdapter.validateWrite(clickhouse, "DROP VIEW IF EXISTS v_events").forceConfirm, true);
  assert.equal(clickhouseAdapter.validateWrite(clickhouse, "CREATE DICTIONARY d (id UInt64) PRIMARY KEY id SOURCE(CLICKHOUSE(TABLE 'events')) LAYOUT(FLAT()) LIFETIME(0)").statementKind, "create");
  assert.equal(clickhouseAdapter.validateWrite(clickhouse, "CREATE DICTIONARY d (id UInt64) PRIMARY KEY id SOURCE(CLICKHOUSE(TABLE 'events')) LAYOUT(FLAT()) LIFETIME(0)").forceConfirm, true);
  assert.equal(clickhouseAdapter.validateWrite(clickhouse, "DROP DICTIONARY IF EXISTS d").statementKind, "drop");
  assert.equal(clickhouseAdapter.validateWrite(clickhouse, "DROP DICTIONARY IF EXISTS d").forceConfirm, true);
  assert.equal(clickhouseAdapter.validateWrite(clickhouse, "OPTIMIZE TABLE events FINAL").statementKind, "optimize");
  assert.equal(clickhouseAdapter.validateWrite(clickhouse, "OPTIMIZE TABLE events PARTITION '2024-01' FINAL").forceConfirm, true);
  assert.throws(() => clickhouseAdapter.validateWrite(clickhouse, "CREATE VIEW v_events ON CLUSTER c AS SELECT id FROM events"), /ON CLUSTER/);
  assert.equal(clickhouseAdapter.validateWrite(clickhouse, "ALTER TABLE events ADD COLUMN name String").statementKind, "alter");
  assert.equal(clickhouseAdapter.validateWrite(clickhouse, "ALTER TABLE events ADD COLUMN name String").forceConfirm, undefined);
  assert.equal(clickhouseAdapter.validateWrite(clickhouse, "ALTER TABLE events DROP COLUMN name").statementKind, "alter");
  assert.equal(clickhouseAdapter.validateWrite(clickhouse, "ALTER TABLE events DROP COLUMN name").forceConfirm, true);
  assert.equal(clickhouseAdapter.validateWrite(clickhouse, "ALTER TABLE events RENAME COLUMN old_name TO new_name").forceConfirm, true);
  assert.equal(clickhouseAdapter.validateWrite(clickhouse, "ALTER TABLE events MODIFY COLUMN name String").forceConfirm, true);
  assert.equal(clickhouseAdapter.validateWrite(clickhouse, "ALTER TABLE events CLEAR COLUMN payload").forceConfirm, true);
  assert.equal(clickhouseAdapter.validateWrite(clickhouse, "ALTER TABLE events DROP PARTITION '2024-01'").forceConfirm, true);
  assert.equal(clickhouseAdapter.validateWrite(clickhouse, "ALTER TABLE events ADD INDEX idx_id id TYPE minmax GRANULARITY 1").statementKind, "alter");
  assert.equal(clickhouseAdapter.validateWrite(clickhouse, "ALTER TABLE events ADD INDEX idx_id id TYPE minmax GRANULARITY 1").forceConfirm, undefined);
  assert.equal(clickhouseAdapter.validateWrite(clickhouse, "ALTER TABLE events DROP INDEX idx_id").forceConfirm, true);
  assert.throws(() => clickhouseAdapter.validateWrite(clickhouse, "ALTER TABLE events DROP PROJECTION p"), /single destructive actions/);
  assert.equal(clickhouseAdapter.validateWrite(clickhouse, "ALTER TABLE events ADD COLUMN a Int32, DROP COLUMN b").forceConfirm, true);
  assert.equal(clickhouseAdapter.validateWrite(clickhouse, "ALTER TABLE events DROP COLUMN a, MODIFY COLUMN b String").forceConfirm, true);
  await assert.rejects(() => clickhouseAdapter.query(clickhouse, "analytics", "SELECT * FROM events INTO OUTFILE '/tmp/x'", 100), /server-side file/);
  await assert.rejects(() => clickhouseAdapter.query(clickhouse, "analytics", "SELECT sleep(3)", 100), /time-wait/);
  await assert.rejects(() => clickhouseAdapter.query(clickhouse, "analytics", "SELECT sleepEachRow(0.1)", 100), /time-wait/);
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
  assert.throws(() => clickhouseAdapter.validateWrite(clickhouse, "ALTER TABLE events DELETE WHERE id = 1, DROP COLUMN name"), /single command/);
  assert.equal(clickhouseAdapter.validateWrite(clickhouse, "TRUNCATE TABLE IF EXISTS events").statementKind, "truncate");
  assert.throws(() => clickhouseAdapter.validateWrite(clickhouse, "TRUNCATE events"), /support only/);
  assert.equal(clickhouseAdapter.validateWrite(clickhouse, "DROP TABLE IF EXISTS events").statementKind, "drop");
  assert.equal(clickhouseAdapter.validateWrite(clickhouse, "DROP DATABASE IF EXISTS analytics").databaseRequired, false);
  assert.throws(() => clickhouseAdapter.validateWrite(clickhouse, "DROP TABLE events, other"), /single-object/);
  assert.equal(clickhouseAdapter.validateWrite(clickhouse, "RENAME TABLE events TO events_archive").statementKind, "rename");
  assert.throws(() => clickhouseAdapter.validateWrite(clickhouse, "RENAME TABLE a TO b, c TO d"), /single-pair/);
  assert.throws(() => clickhouseAdapter.validateWrite(clickhouse, "ALTER TABLE events UPDATE flag = 1 WHERE id = 1"), /support only/);
  assert.throws(() => clickhouseAdapter.validateWrite(clickhouse, "CREATE FUNCTION f AS (x) -> x + 1"), /support only/);
  assert.throws(() => clickhouseAdapter.validateWrite(clickhouse, "WITH x AS (SELECT 1) INSERT INTO events SELECT * FROM x"), /support only/);
  const readonlyMysql = { ...mysql, name: "readonly-mysql", allowWrite: false };
  assert.throws(() => mysqlAdapter.validateWrite(readonlyMysql, "INSERT INTO users (id) VALUES (1)"), /Writes are disabled/);
  assert.throws(() => mysqlAdapter.validateWrite(readonlyMysql, "INSERT INTO users (id) SELECT id FROM archived"), /Writes are disabled/);
  assert.throws(() => mysqlAdapter.validateWrite(readonlyMysql, "DELETE FROM users WHERE id = 1"), /Writes are disabled/);
  const readonlyClickHouse = { ...clickhouse, name: "readonly-clickhouse", allowWrite: false };
  assert.throws(() => clickhouseAdapter.validateWrite(readonlyClickHouse, "INSERT INTO events (id) SELECT id FROM archived_events"), /Writes are disabled/);
  assert.throws(() => mysqlAdapter.validateWrite(readonlyMysql, "TRUNCATE TABLE users"), /Writes are disabled/);
}

function testUsqlHelpers() {
  assert.equal(redactConnection("postgres://app:secret@db.local:5432/app"), "postgres://app:*****@db.local:5432/app");
  assert.equal(redactConnection("postgres://app@db.local:5432/app"), "postgres://app@db.local:5432/app");
  assert.equal(redactConnection("sqlite3:/data/app.db"), "sqlite3:/data/app.db");
  assert.equal(redactConnection("my_named_conn"), "my_named_conn");
  assert.equal(connectionScheme("ch://user@host/db"), "ch");
  assert.equal(connectionScheme("my_named_conn"), undefined);
  assert.equal(statementKind("SELECT 1"), "select");
  assert.equal(statementKind("  \\copy src dst 'SELECT 1' 't(a)'"), "meta");
  assert.equal(statementKind("insert into t values (1)"), "insert");
  assert.deepEqual(parseUsqlOutput('[{"a":1,"b":"x"}]'), { columns: ["a", "b"], rows: [[1, "x"]] });
  assert.deepEqual(parseUsqlOutput(""), {});
  assert.deepEqual(parseUsqlOutput("[]"), { columns: [], rows: [] });
  assert.equal(parseUsqlOutput("plain text").output, "plain text");

  // usql ignores an unterminated statement read from a file, so SQL must end with `;`.
  assert.equal(usqlScriptContents("SELECT 1"), "SELECT 1\n;\n");
  assert.equal(usqlScriptContents("SELECT 1;"), "SELECT 1;\n");
  assert.equal(usqlScriptContents("SELECT 1 -- note"), "SELECT 1 -- note\n;\n");
  assert.equal(usqlScriptContents("SELECT 1; -- note"), "SELECT 1; -- note\n", "a trailing comment must not trigger a second empty statement");
  assert.equal(usqlScriptContents("SELECT ';';"), "SELECT ';';\n", "a semicolon inside a string is not a terminator");
  assert.equal(usqlScriptContents("SELECT 1 /* ; */"), "SELECT 1 /* ; */\n;\n");
  assert.equal(usqlScriptContents("\\conninfo"), "\\conninfo\n");
  assert.equal(usqlScriptContents("\\copy src dst"), "\\copy src dst\n");

  const confirmation = __test__.buildUsqlConfirmation("postgres://app:secret@db.local:5432/app", "DELETE FROM sessions WHERE id = 1");
  assert.equal(confirmation.title, "Database usql · DELETE · postgres");
  assert.equal(confirmation.fields[0]?.value, "postgres://app:*****@db.local:5432/app");
  assert.equal(confirmation.fields[2]?.value, "DELETE");
  assert.doesNotMatch(confirmation.message, /secret/);
  assert.match(confirmation.sql, /DELETE\nFROM sessions\nWHERE id = 1/);
  assert.match(confirmation.message, /always needs your confirmation/);
  const policyConfirmation = __test__.buildUsqlConfirmation("postgres://app@db.local/app", "DELETE FROM sessions WHERE id = 1", { name: "app_mysql", allowWrite: false });
  assert.match(policyConfirmation.message, /Policy source: app_mysql · allow_write=false/);
  assert.ok(policyConfirmation.fields.some((field) => field.label === "Policy"));

  const cancelled: Record<string, unknown> = {
    tool: USQL_TOOL_NAME,
    connection: "postgres://app@db.local/app",
    statement_kind: "delete",
    executed: false,
    cancelled: true,
    requested_statement: "DELETE FROM sessions WHERE id = 1"
  };
  assert.match(__test__.formatUsql(cancelled as never), /Cancelled/);
  const blockedUsqlResult = { ...cancelled, cancelled: false, blocked: true, blocked_reason: "source_read_only", error: "Writes are disabled for source \"readonly\"." };
  assert.match(__test__.formatUsql(blockedUsqlResult as never), /Blocked: Writes are disabled/);

  const executed = { ...cancelled, cancelled: undefined, executed: true, columns: ["id"], rows: [[1]], row_count: 1, elapsed_ms: 12.5, warnings: [] };
  assert.match(__test__.formatUsql(executed as never), /Executed · 1 rows · 12\.5 ms/);
  const rendered = __test__.createUsqlResultComponent(executed as never, false, true).render(80);
  assert.ok(rendered.some((line) => line.includes("1 rows")));
  assert.ok(rendered.some((line) => line.includes("id")), "column header is rendered");
  const collapsedUsql = __test__.createUsqlResultComponent(executed as never, false, false).render(80).join("\n");
  assert.match(collapsedUsql, /1 rows/);
  assert.ok(!collapsedUsql.includes("│"), "collapsed usql hides the data table");

  const failed = { ...cancelled, cancelled: undefined, error: "usql timed out after 30000 ms.", next_action: "Inspect the database state" };
  assert.match(__test__.formatUsql(failed as never), /Error: usql timed out/);
  const errorRendered = __test__.createUsqlResultComponent(failed as never, false, false).render(80);
  assert.ok(errorRendered.some((line) => line.includes("Inspect the database state")));

}

async function testUsqlActivation() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-database-usql-"));
  const handlers = new Map<string, Array<(event: any, ctx: any) => Promise<unknown> | unknown>>();
  let activeTools: string[] = [];
  const ctx = { cwd: dir, ui: { setStatus() {}, notify() {}, theme: { fg: (_color: string, text: string) => text } } };
  databaseExtension({
    on(event: string, handler: (event: any, ctx: any) => Promise<unknown> | unknown) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerTool() {},
    registerCommand() {},
    getActiveTools() {
      return [...activeTools];
    },
    setActiveTools(nextTools: string[]) {
      activeTools = [...nextTools];
    }
  } as never);
  const sync = async () => {
    await handlers.get("before_agent_start")![0]!({ cwd: dir, systemPrompt: "base" }, ctx);
  };

  enableUsql();
  assert.equal(usqlAvailable(), true);
  await sync();
  assert.ok(!activeTools.includes(USQL_TOOL_NAME), "database tools default off without a project override");
  assert.ok(!activeTools.includes("database_query"));

  writeConfig(dir, { version: 2, enabled: true, default_sources: {}, sources: [{ name: "app", dialect: "mysql", options: {} }] });
  await sync();
  assert.ok(activeTools.includes("database_query"), "project opt-in enables configured tools");
  assert.ok(activeTools.includes(USQL_TOOL_NAME));

  setProjectConfigEnabled(dir, false);
  await sync();
  assert.ok(!activeTools.includes("database_query"));
  assert.ok(!activeTools.includes(USQL_TOOL_NAME), "/database off also disables the usql fallback");

  disableUsql();
  assert.equal(usqlAvailable(), false);
  setProjectConfigEnabled(dir, true);
  await sync();
  assert.ok(activeTools.includes("database_query"));
  assert.ok(!activeTools.includes(USQL_TOOL_NAME), "a missing usql binary removes the fallback tool");
  restoreUsqlEnv();
}

testSqlScanner();
testResultLimits();
testInitializeConfig();
testProjectOptIn();
testSourceSelection();
testSourceNameValidation();
await testDynamicRegistration();
testDatabaseContextPrompt();
await testToolPromptMetadata();
await testWriteBoundaries();
testDatabaseStatusText();
testSourceTree();
testUsqlHelpers();
await testDbxConnectionImportAndSecrets();
await testUsqlActivation();
console.log("pi-database self-check OK");
