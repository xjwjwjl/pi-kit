import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import type { JsonRecord, ResolvedProjectConfig, ResolvedSource, SqlDialect } from "./types.js";

export const CONFIG_FILE_PATH = path.join(".pi", "databases.json");

const TEMPLATE = {
  version: 2,
  enabled: true,
  default_sources: {
    mysql: "mysql_localhost",
    clickhouse: "clickhouse_localhost"
  },
  sources: [
    {
      name: "mysql_localhost",
      label: "MySQL Local",
      dialect: "mysql",
      allow_write: true,
      write_confirm: false,
      query_timeout_ms: 30000,
      max_rows: 100,
      options: {
        host: "127.0.0.1",
        port: 3306,
        user: "readonly_user",
        password: "",
        database: ""
      }
    },
    {
      name: "clickhouse_localhost",
      label: "ClickHouse Local",
      dialect: "clickhouse",
      allow_write: true,
      write_confirm: false,
      query_timeout_ms: 30000,
      max_rows: 100,
      options: {
        url: "http://localhost:8123",
        username: "default",
        password: "",
        database: ""
      }
    }
  ]
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

function sourceCacheKey(name: string, dialect: SqlDialect, options: JsonRecord, queryTimeoutMs: number): string {
  return JSON.stringify({ name, dialect, options, queryTimeoutMs });
}

export function sourceWithDatabase(source: ResolvedSource, database: string): ResolvedSource {
  const options = { ...source.options, database };
  return {
    ...source,
    options,
    cacheKey: sourceCacheKey(source.name, source.dialect, options, source.queryTimeoutMs)
  };
}

function resolveSource(value: unknown, configPath: string): ResolvedSource {
  if (!isRecord(value)) throw new Error(`Invalid ${configPath}: every source must be an object.`);
  const name = asString(value.name);
  if (!name || !/^[a-z][a-z0-9_.-]*$/i.test(name)) {
    throw new Error(`Invalid ${configPath}: source names must use letters, digits, underscores, dots, or hyphens.`);
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
  const configPath = findProjectConfigPath(cwd);
  if (!configPath) {
    throw new Error(`No database config found for ${cwd}. Run /database on to create .pi/databases.json.`);
  }
  const root = parseConfig(configPath);
  if (root.version !== 2 || !Array.isArray(root.sources) || !isRecord(root.default_sources)) {
    throw new Error(`Invalid ${configPath}: expected a version 2 config with default_sources and a sources array. Run /database on for a fresh template.`);
  }
  if (Object.prototype.hasOwnProperty.call(root, "default_source")) {
    throw new Error(`Invalid ${configPath}: default_source is no longer supported; use default_sources instead.`);
  }
  const sources = root.sources.map((source) => resolveSource(source, configPath));
  if (sources.length === 0) throw new Error(`Invalid ${configPath}: sources must not be empty.`);
  const names = new Set<string>();
  for (const source of sources) {
    if (names.has(source.name)) throw new Error(`Invalid ${configPath}: source "${source.name}" is duplicated.`);
    names.add(source.name);
  }
  const enabled = asBoolean(root.enabled, true);
  const defaultSources = resolveDefaultSources(root.default_sources, sources, configPath);
  return { configPath, enabled, defaultSources, sources };
}

export function selectSource(config: ResolvedProjectConfig, requested?: string, dialect?: SqlDialect): ResolvedSource {
  if (requested) {
    const source = config.sources.find((item) => item.name === requested);
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

export function databaseStatusText(config: { enabled?: boolean }): string {
  return config.enabled === false ? "database: off" : "database: on";
}

export function buildDatabaseContextPrompt(cwd: string): string | undefined {
  try {
    const config = loadProjectConfig(cwd);
    if (!config.enabled) return undefined;
    const sources = config.sources
      .map((source) => `- ${source.name}: ${source.dialect}${config.defaultSources[source.dialect] === source.name ? " (default)" : ""}${source.allowWrite && !source.writeConfirm ? " (write confirmation off)" : ""}`)
      .join("\n");
    return [
      "Configured database sources are available through database_* tools:",
      sources,
      "",
      "For requests about these configured databases, use the database_* tool family.",
      "Use database_list_tables only when the database is known; use database_search_tables when the target table is unknown; use database_describe_table before guessing columns; use database_ping for connectivity; and use database_query only for read-only SQL.",
      "Default sources select only connections, never databases. When source is omitted, pass dialect to select that dialect's configured default; an explicit source must match dialect when both are passed. With multiple sources and neither source nor dialect, call database_list_sources first. For database_query and database_list_tables, always pass database. If the database is unknown, call database_list_databases first.",
      "Use database_write only for an explicit user-requested allowed change. It accepts exactly one supported SQL statement per call. For multi-step operations, use separate calls and handle each result independently; do not submit scripts, semicolon-separated statements, or USE/database-selection statements, do not assume the sequence is atomic, and pass database instead of USE. It requires database for table-scoped writes; omit database only for CREATE DATABASE and DROP DATABASE. ClickHouse supports CREATE MATERIALIZED VIEW ... TO ... AS SELECT or ... ENGINE = ... AS SELECT forms, including ON CLUSTER. CREATE OR REPLACE and INSERT ... SELECT (INSERT INTO <table> [(columns)] SELECT ...) always require interactive confirmation; POPULATE, refreshable/window views, DEFINER, and SQL SECURITY are rejected. It follows the selected source's confirmation policy and must not be retried automatically after a timeout or connection loss.",
      "DELETE, TRUNCATE, DROP, RENAME, REPLACE, and destructive ALTER (DROP/MODIFY/CHANGE/RENAME column, etc.) statements always require interactive confirmation regardless of write_confirm.",
      "If database_write returns blocked or unsupported, stop. State the selected source, dialect, and allow_write setting, then ask the user what to do. If its outcome is unknown, first verify the database with database_query or metadata tools and do not retry automatically. Do not bypass this policy with non-database_* tools or config edits."
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

export function setProjectConfigEnabled(cwd: string, enabled: boolean): { configPath: string; created: boolean; changed: boolean; enabled: boolean } {
  const existingPath = findProjectConfigPath(cwd);
  if (!existingPath) {
    if (!enabled) {
      return { configPath: path.join(path.resolve(cwd), CONFIG_FILE_PATH), created: false, changed: false, enabled: false };
    }
    const result = initializeProjectConfig(cwd);
    return { configPath: result.configPath, created: result.created, changed: result.created, enabled: true };
  }

  const config = loadProjectConfig(cwd);
  if (config.enabled === enabled) {
    return { configPath: config.configPath, created: false, changed: false, enabled };
  }
  const root = parseConfig(config.configPath);
  root.enabled = enabled;
  writeProjectConfig(config.configPath, root);
  return { configPath: config.configPath, created: false, changed: true, enabled };
}
