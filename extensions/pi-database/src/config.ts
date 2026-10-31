import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import type { JsonRecord, ResolvedProjectConfig, ResolvedSource, SqlDialect } from "./types.js";
import { loadDbxSources } from "./dbx.js";
import { usqlAvailable } from "./usql.js";

export const CONFIG_FILE_PATH = path.join(".pi", "databases.json");
export const PROJECT_SETTINGS_PATH = path.join(".pi", "settings.json");
export const PROJECT_SETTINGS_KEY = "piDatabase";
const TOOLS_ENABLED_SETTING = "toolsEnabled";
const DBX_IMPORT_ENABLED_SETTING = "dbxImportEnabled";

const TEMPLATE = {
  version: 2,
  dbx_connections: true,
  default_sources: {},
  sources: []
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.toLowerCase() === "true") return true;
    if (value.toLowerCase() === "false") return false;
  }
  return fallback;
}

function asPositiveInteger(value: unknown, fallback: number, maximum?: number): number {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : NaN;
  if (!Number.isFinite(number) || number <= 0) return fallback;
  const normalized = Math.floor(number);
  return maximum === undefined ? normalized : Math.min(normalized, maximum);
}

function isDialect(value: unknown): value is SqlDialect {
  return value === "mysql" || value === "clickhouse";
}

export function getContextCwd(ctx: unknown): string {
  return isRecord(ctx) && typeof ctx.cwd === "string" && ctx.cwd ? ctx.cwd : process.cwd();
}

export function findProjectConfigPath(startDir: string): string | undefined {
  let current = path.resolve(startDir);
  while (true) {
    const configPath = path.join(current, CONFIG_FILE_PATH);
    if (existsSync(configPath)) return configPath;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function parseConfig(configPath: string): JsonRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read ${configPath}: ${message}`);
  }
  if (!isRecord(parsed)) throw new Error(`Invalid ${configPath}: expected a JSON object.`);
  return parsed;
}

function booleanOverride(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.toLowerCase() === "true") return true;
    if (value.toLowerCase() === "false") return false;
  }
  return undefined;
}

function readProjectDatabaseSettings(cwd: string): JsonRecord {
  const settingsPath = path.join(path.resolve(cwd), PROJECT_SETTINGS_PATH);
  if (!existsSync(settingsPath)) return {};
  const settings = parseConfig(settingsPath);
  return isRecord(settings[PROJECT_SETTINGS_KEY]) ? settings[PROJECT_SETTINGS_KEY] as JsonRecord : {};
}

function writeProjectDatabaseSetting(cwd: string, key: string, value: boolean): { settingsPath: string; created: boolean; changed: boolean } {
  const settingsPath = path.join(path.resolve(cwd), PROJECT_SETTINGS_PATH);
  const fileExists = existsSync(settingsPath);
  const settings = fileExists ? parseConfig(settingsPath) : {};
  const databaseSettings = isRecord(settings[PROJECT_SETTINGS_KEY])
    ? { ...settings[PROJECT_SETTINGS_KEY] }
    : {};
  if (databaseSettings[key] === value) return { settingsPath, created: false, changed: false };
  databaseSettings[key] = value;
  settings[PROJECT_SETTINGS_KEY] = databaseSettings;
  writeProjectConfig(settingsPath, settings);
  return { settingsPath, created: !fileExists, changed: true };
}

function sourceCacheKey(name: string, dialect: SqlDialect, options: JsonRecord, queryTimeoutMs: number, dbxSecretFingerprint?: string): string {
  return JSON.stringify({ name, dialect, options, queryTimeoutMs, dbxSecretFingerprint });
}

export function sourceWithDatabase(source: ResolvedSource, database: string): ResolvedSource {
  const options = { ...source.options, database };
  return {
    ...source,
    options,
    cacheKey: sourceCacheKey(source.name, source.dialect, options, source.queryTimeoutMs, source.dbxSecretFingerprint)
  };
}

function resolveSource(value: unknown, configPath: string): ResolvedSource {
  if (!isRecord(value)) throw new Error(`Invalid ${configPath}: every source must be an object.`);
  const name = asString(value.name);
  if (!name || !/^[a-z0-9][a-z0-9_.-]*$/i.test(name)) {
    throw new Error(`Invalid ${configPath}: source names must start with a letter or digit and may contain letters, digits, underscores, dots, or hyphens.`);
  }
  if (!isDialect(value.dialect)) throw new Error(`Invalid ${configPath}: source "${name}" has an unsupported dialect.`);
  if (!isRecord(value.options)) throw new Error(`Invalid ${configPath}: source "${name}" requires an options object.`);
  const allowWrite = asBoolean(value.allow_write, true);
  const writeConfirm = asBoolean(value.write_confirm, false);
  const queryTimeoutMs = asPositiveInteger(value.query_timeout_ms, 30_000);
  const maxRows = asPositiveInteger(value.max_rows, 100, 500);
  const options = { ...value.options };
  const label = asString(value.label);
  return {
    name,
    label,
    dialect: value.dialect,
    options,
    allowWrite,
    writeConfirm,
    queryTimeoutMs,
    maxRows,
    configPath,
    cacheKey: sourceCacheKey(name, value.dialect, options, queryTimeoutMs)
  };
}

function resolveDefaultSources(value: unknown, sources: readonly ResolvedSource[], configPath: string): Partial<Record<SqlDialect, string>> {
  if (!isRecord(value)) throw new Error(`Invalid ${configPath}: default_sources must be an object.`);
  const sourceByName = new Map(sources.map((source) => [source.name, source]));
  const defaultSources: Partial<Record<SqlDialect, string>> = {};
  for (const [dialect, sourceNameValue] of Object.entries(value)) {
    if (!isDialect(dialect)) throw new Error(`Invalid ${configPath}: default_sources supports only mysql and clickhouse keys.`);
    const sourceName = asString(sourceNameValue);
    if (!sourceName) throw new Error(`Invalid ${configPath}: default_sources.${dialect} must be a source name.`);
    const source = sourceByName.get(sourceName);
    if (!source) throw new Error(`Invalid ${configPath}: default_sources.${dialect} "${sourceName}" does not exist.`);
    if (source.dialect !== dialect) {
      throw new Error(`Invalid ${configPath}: default_sources.${dialect} must reference a ${dialect} source, not "${sourceName}" (${source.dialect}).`);
    }
    defaultSources[dialect] = source.name;
  }
  return defaultSources;
}

export function loadProjectConfig(cwd: string): ResolvedProjectConfig {
  const existingConfigPath = findProjectConfigPath(cwd);
  const configPath = existingConfigPath ?? "DBX local profile (no project config)";
  const root = existingConfigPath ? parseConfig(existingConfigPath) : {};
  if (existingConfigPath && (root.version !== 2 || !Array.isArray(root.sources) || !isRecord(root.default_sources))) {
    throw new Error(`Invalid ${configPath}: expected a version 2 config with default_sources and a sources array. Run /database config init for a fresh template.`);
  }
  if (Object.prototype.hasOwnProperty.call(root, "default_source")) {
    throw new Error(`Invalid ${configPath}: default_source is no longer supported; use default_sources instead.`);
  }
  const projectSettings = readProjectDatabaseSettings(cwd);
  const projectSources = existingConfigPath
    ? (root.sources as unknown[]).map((source) => resolveSource(source, configPath))
    : [];
  const dbxImportEnabled = booleanOverride(projectSettings[DBX_IMPORT_ENABLED_SETTING])
    ?? asBoolean(root.dbx_connections, true);
  const dbxDiscovery = dbxImportEnabled ? loadDbxSources(projectSources.map((source) => source.name)) : { sources: [] };
  const sources = [...projectSources, ...dbxDiscovery.sources];
  const names = new Set<string>();
  for (const source of sources) {
    if (names.has(source.name)) throw new Error(`Invalid ${configPath}: source "${source.name}" is duplicated.`);
    names.add(source.name);
  }
  const enabled = booleanOverride(projectSettings[TOOLS_ENABLED_SETTING]) ?? asBoolean(root.enabled, false);
  const defaultSources = resolveDefaultSources(existingConfigPath ? root.default_sources : {}, sources, configPath);
  return {
    configPath,
    enabled,
    dbxImportEnabled,
    ...(dbxDiscovery.warning ? { dbxWarning: dbxDiscovery.warning } : {}),
    defaultSources,
    sources
  };
}

export function selectSource(config: ResolvedProjectConfig, requested?: string, dialect?: SqlDialect): ResolvedSource {
  if (requested) {
    const sourceByName = config.sources.find((item) => item.name === requested);
    const aliasMatches = config.sources.filter((item) => item.dbxConnectionName === requested);
    if (sourceByName && aliasMatches.some((item) => item !== sourceByName)) {
      const stableNames = [...new Set([sourceByName.name, ...aliasMatches.map((item) => item.name)])].join(", ");
      throw new Error(`Source name "${requested}" conflicts with a DBX connection name. Use a stable source name instead: ${stableNames}.`);
    }
    const source = sourceByName ?? (aliasMatches.length === 1 ? aliasMatches[0] : undefined);
    if (!source && aliasMatches.length > 1) {
      const stableNames = aliasMatches.map((item) => item.name).join(", ");
      throw new Error(`DBX connection name "${requested}" is ambiguous. Use a stable source name instead: ${stableNames}.`);
    }
    if (!source) throw new Error(`Unknown database source "${requested}". Call database_list_sources first.`);
    if (dialect && source.dialect !== dialect) {
      throw new Error(`Database source "${requested}" uses ${source.dialect}, not requested dialect ${dialect}.`);
    }
    return source;
  }
  if (dialect) {
    const defaultSource = config.defaultSources[dialect];
    if (!defaultSource) throw new Error(`No default ${dialect} source is configured. Pass source or set default_sources.${dialect}.`);
    return config.sources.find((item) => item.name === defaultSource)!;
  }
  if (config.sources.length === 1) return config.sources[0]!;
  throw new Error("Multiple database sources are configured. Pass source or dialect, or call database_list_sources.");
}

export function databaseStatusText(config: { enabled?: boolean }): string | undefined {
  return config.enabled === false ? undefined : "database: on";
}

function buildDatabaseBootstrapPrompt(config?: ResolvedProjectConfig): string {
  return [
    "No project database configuration (.pi/databases.json) was found; supported MySQL and ClickHouse connections are loaded from the local DBX profile by default.",
    `Database tools are ${config?.enabled ? "on" : "off"} for this project. Use /database on or /database off to change and persist the project setting in .pi/settings.json.`,
    "Use /database config init only when you want a project .pi/databases.json to define custom sources or default_sources. Do not create this file just to use DBX connections.",
    ...(config?.dbxWarning ? [`DBX source discovery warning: ${config.dbxWarning}`] : []),
    ...(config?.enabled && usqlAvailable()
      ? [
          "database_usql is enabled for this project. Use it only when a configured source cannot reach the database. Pass source to bind a configured source's allow_write policy; without source it ignores configured write policies and relies on interactive confirmation alone."
        ]
      : [])
  ].join("\n");
}

export function buildDatabaseContextPrompt(cwd: string): string | undefined {
  const hasProjectConfig = findProjectConfigPath(cwd) !== undefined;
  try {
    const config = loadProjectConfig(cwd);
    if (!config.enabled) return hasProjectConfig ? undefined : buildDatabaseBootstrapPrompt(config);
    if (!hasProjectConfig && config.sources.length === 0) return buildDatabaseBootstrapPrompt(config);
    const sources = config.sources
      .map((source) => `- ${source.name}${source.dbxConnectionName ? ` (DBX connection name: ${source.dbxConnectionName})` : ""}: ${source.dialect}${source.provider === "dbx" ? " (DBX direct)" : ""}${config.defaultSources[source.dialect] === source.name ? " (default)" : ""}${source.allowWrite && !source.writeConfirm ? " (write confirmation off)" : ""}`)
      .join("\n");
    return [
      "Database sources are available through database_* tools:",
      ...(!hasProjectConfig ? ["DBX MySQL and ClickHouse connections come directly from the local DBX profile; use /database config init only to configure custom sources or defaults."] : []),
      sources,
      ...(config.dbxWarning ? ["", `DBX source discovery warning: ${config.dbxWarning}`] : []),
      "",
      ...(config.dbxImportEnabled
        ? ["DBX sources use DBX's local connection profile and saved credentials with pi-database's native drivers. Credentials are never included in source listings or results."]
        : []),
      "For requests about these configured databases, use the database_* tool family.",
      "Use database_list_tables only when the database is known; use database_search_tables when the target table is unknown; use database_describe_table before guessing columns; use database_ping for connectivity; and use database_query only for read-only SQL.",
      "Default sources select only connections, never databases. When source is omitted, pass dialect to select that dialect's configured default; an explicit source must match dialect when both are passed. DBX connection names shown in the source list are accepted as source aliases; if a DBX name is ambiguous, use its stable dbx-<name> source name. With multiple sources and neither source nor dialect, call database_list_sources first. For database_query and database_list_tables, always pass database. If the database is unknown, call database_list_databases first.",
      "Use database_write only for an explicit user-requested allowed change. It accepts exactly one supported SQL statement per call. For multi-step operations, use separate calls and handle each result independently; do not submit scripts, semicolon-separated statements, or USE/database-selection statements, do not assume the sequence is atomic, and pass database instead of USE. It requires database for table-scoped writes; omit database only for CREATE DATABASE and DROP DATABASE. ClickHouse supports CREATE MATERIALIZED VIEW ... TO ... AS SELECT or ... ENGINE = ... AS SELECT forms, including ON CLUSTER. MySQL supports CREATE [OR REPLACE] VIEW <view> [(columns)] AS SELECT ... (no ALGORITHM, DEFINER, or SQL SECURITY) and single-object DROP VIEW; replacing a view follows the source write_confirm policy. ClickHouse CREATE OR REPLACE materialized-view variants and INSERT ... SELECT (INSERT INTO <table> [(columns)] SELECT ...) always require interactive confirmation; POPULATE, refreshable/window views, DEFINER, and SQL SECURITY are rejected. It follows the selected source's confirmation policy and must not be retried automatically after a timeout or connection loss.",
      "DELETE, TRUNCATE, DROP, RENAME, REPLACE, and destructive ALTER (DROP/MODIFY/CHANGE/RENAME column, etc.) statements always require interactive confirmation regardless of write_confirm.",
      "If database_write returns blocked_reason \"source_read_only\" or \"missing_database\", stop. State the selected source, dialect, and allow_write setting, then ask the user what to do; never bypass a read-only source. If blocked_reason is \"unsupported_statement\", state the limitation and ask whether to run the statement through database_usql with confirmation, run it manually, or stop; use database_usql only after explicit user approval. If blocked_reason is \"invalid_statement\", fix the statement shape or ask the user. If its outcome is unknown, first verify the database with database_query or metadata tools and do not retry automatically. Do not use bash, a database client, or config edits to bypass policy.",
      ...(usqlAvailable()
        ? [
            "database_usql is the fallback for a database that has no configured source, such as PostgreSQL, SQLite, or another dialect outside MySQL and ClickHouse; for a statement that database_write explicitly rejects as unsupported; or when an usql meta-command is required. Use it only after the configured database_* tools cannot do the job and the user explicitly approves, or when the user explicitly requests it. Pass source when targeting a configured source so its allow_write policy is enforced; without source it ignores allow_write, write_confirm, and the database_write allowlist and relies on interactive confirmation alone. Never use it to bypass blocked_reason \"source_read_only\"."
          ]
        : [])
    ].join("\n");
  } catch {
    return undefined;
  }
}

function writeProjectConfig(configPath: string, root: unknown): void {
  const directory = path.dirname(configPath);
  mkdirSync(directory, { recursive: true });
  let mode = 0o600;
  try {
    mode = statSync(configPath).mode & 0o777;
  } catch {
    // New files default to owner-only permissions where supported.
  }
  const tempPath = `${configPath}.${process.pid}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(root, null, 2)}\n`, { encoding: "utf-8", mode });
  renameSync(tempPath, configPath);
}

export function initializeProjectConfig(cwd: string): { created: boolean; configPath: string; reason?: string } {
  const targetPath = path.join(path.resolve(cwd), CONFIG_FILE_PATH);
  const existingPath = findProjectConfigPath(cwd);
  if (existingPath) {
    return {
      created: false,
      configPath: existingPath,
      reason: path.resolve(existingPath) === targetPath ? "A project database config already exists." : "A database config is already inherited from a parent directory."
    };
  }
  writeProjectConfig(targetPath, TEMPLATE);
  return { created: true, configPath: targetPath };
}

export function setProjectConfigEnabled(cwd: string, enabled: boolean): { settingsPath: string; created: boolean; changed: boolean; enabled: boolean } {
  return { ...writeProjectDatabaseSetting(cwd, TOOLS_ENABLED_SETTING, enabled), enabled };
}

export function setDbxConnectionsEnabled(cwd: string, enabled: boolean): { settingsPath: string; created: boolean; changed: boolean; enabled: boolean } {
  return { ...writeProjectDatabaseSetting(cwd, DBX_IMPORT_ENABLED_SETTING, enabled), enabled };
}
