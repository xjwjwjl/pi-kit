import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import type { JsonRecord, ResolvedProjectConfig, ResolvedSource, SqlDialect } from "./types.js";

export const CONFIG_FILE_PATH = path.join(".pi", "databases.json");

const TEMPLATE = {
  version: 1,
  default_source: "",
  sources: [
    {
      name: "mysql_localhost",
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
  return {
    name,
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

export function loadProjectConfig(cwd: string): ResolvedProjectConfig {
  const configPath = findProjectConfigPath(cwd);
  if (!configPath) {
    throw new Error(`No database config found for ${cwd}. Run /database-init to create .pi/databases.json.`);
  }
  const root = parseConfig(configPath);
  if (root.version !== 1 || !Array.isArray(root.sources)) {
    throw new Error(`Invalid ${configPath}: expected a version 1 config with a sources array. Run /database-init for a fresh template.`);
  }
  const sources = root.sources.map((source) => resolveSource(source, configPath));
  if (sources.length === 0) throw new Error(`Invalid ${configPath}: sources must not be empty.`);
  const names = new Set<string>();
  for (const source of sources) {
    if (names.has(source.name)) throw new Error(`Invalid ${configPath}: source "${source.name}" is duplicated.`);
    names.add(source.name);
  }
  const defaultSource = asString(root.default_source);
  if (defaultSource && !names.has(defaultSource)) {
    throw new Error(`Invalid ${configPath}: default_source "${defaultSource}" does not exist.`);
  }
  return { configPath, defaultSource, sources };
}

export function selectSource(config: ResolvedProjectConfig, requested?: string): ResolvedSource {
  if (requested) {
    const source = config.sources.find((item) => item.name === requested);
    if (!source) throw new Error(`Unknown database source "${requested}". Call database_list_sources first.`);
    return source;
  }
  if (config.defaultSource) return config.sources.find((item) => item.name === config.defaultSource)!;
  if (config.sources.length === 1) return config.sources[0]!;
  throw new Error("Multiple database sources are configured without default_source. Pass source or call database_list_sources.");
}

export function databaseStatusText(config: { defaultSource?: string; sources: readonly { name: string }[] }): string {
  const { sources, defaultSource } = config;
  if (sources.length === 1) return `database: ${sources[0]!.name}`;
  if (defaultSource) return `database: ${defaultSource} +${sources.length - 1}`;
  return `database: ${sources.length} sources`;
}

export function buildDatabaseContextPrompt(cwd: string): string | undefined {
  try {
    const config = loadProjectConfig(cwd);
    const sources = config.sources
      .map((source) => `- ${source.name}: ${source.dialect}${source.name === config.defaultSource ? " (default)" : ""}${source.allowWrite && !source.writeConfirm ? " (write confirmation off)" : ""}`)
      .join("\n");
    return [
      "Configured database sources are available through database_* tools:",
      sources,
      "",
      "For requests about these configured databases, use the database_* tool family.",
      "Use database_list_tables only when the database is known; use database_search_tables when the target table is unknown; use database_describe_table before guessing columns; use database_ping for connectivity; and use database_query only for read-only SQL.",
      "A default source selects only the connection, never a database. When the intended source is unclear, call database_list_sources first; omit source only for the listed default source or when exactly one source exists. For database_query and database_list_tables, always pass database. If the database is unknown, call database_list_databases first.",
      "Use database_write only for an explicit user-requested allowed change. It requires database for table-scoped writes; omit database only for CREATE DATABASE and DROP DATABASE. ClickHouse supports CREATE MATERIALIZED VIEW ... TO ... AS SELECT or ... ENGINE = ... AS SELECT forms, including ON CLUSTER. CREATE OR REPLACE and INSERT ... SELECT (INSERT INTO <table> [(columns)] SELECT ...) always require interactive confirmation; POPULATE, refreshable/window views, DEFINER, and SQL SECURITY are rejected. It follows the selected source's confirmation policy and must not be retried automatically after a timeout or connection loss.",
      "DELETE, TRUNCATE, DROP, RENAME, and REPLACE statements always require interactive confirmation regardless of write_confirm.",
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
