import { ClickHouseLogLevel, ResultSet, createClient, type ClickHouseClient } from "@clickhouse/client";
import { firstKeyword, hasMultipleStatements, normalizeSql } from "./sql.js";
import { DatabasePolicyError } from "./types.js";
import type { DatabaseAdapter, PingResult, QueryResult, ResolvedSource, TableResult, ValidatedWrite, WriteResult } from "./types.js";

const clients = new Map<string, ClickHouseClient>();
const clientCacheKeyBySource = new Map<string, string>();
const IDENTIFIER = "(?:`(?:``|[^`])+`|[A-Za-z_][A-Za-z0-9_$]*)";
const TABLE_IDENTIFIER = `${IDENTIFIER}(?:\\.${IDENTIFIER})?`;
const INSERT_PATTERN = new RegExp(`^INSERT\\s+INTO\\s+${TABLE_IDENTIFIER}(?:\\s*\\([^)]*\\))?\\s+VALUES\\s*\\(`, "i");
const CREATE_TABLE_PATTERN = new RegExp(`^CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${TABLE_IDENTIFIER}\\s*\\(`, "i");
const ALTER_ADD_COLUMN_PATTERN = new RegExp(`^ALTER\\s+TABLE\\s+${TABLE_IDENTIFIER}\\s+ADD\\s+COLUMN\\b`, "i");

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function asPositiveInteger(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return fallback;
}

function readPassword(source: ResolvedSource): string {
  const envName = asString(source.options.password_env);
  if (envName) {
    const password = process.env[envName];
    if (password === undefined) throw new Error(`Source "${source.name}" requires environment variable ${envName}.`);
    return password;
  }
  return typeof source.options.password === "string" ? source.options.password : "";
}

function url(source: ResolvedSource): string {
  const configured = asString(source.options.url);
  if (configured) return configured;
  const host = asString(source.options.host);
  if (!host) throw new Error(`Invalid ClickHouse source "${source.name}": url or host is required.`);
  const secure = source.options.secure === true;
  const protocol = secure ? "https" : "http";
  const port = asPositiveInteger(source.options.port, secure ? 8443 : 8123);
  return `${protocol}://${host}:${port}`;
}

function timeout(source: ResolvedSource): number {
  if (source.options.request_timeout_ms !== undefined) return asPositiveInteger(source.options.request_timeout_ms, 30_000);
  return asPositiveInteger(source.options.send_receive_timeout, 30) * 1000;
}

function sourceIdentity(source: ResolvedSource): string {
  return `${source.configPath}:${source.name}`;
}

function getClient(source: ResolvedSource): ClickHouseClient {
  const identity = sourceIdentity(source);
  const cached = clients.get(source.cacheKey);
  if (cached) {
    clientCacheKeyBySource.set(identity, source.cacheKey);
    return cached;
  }
  const previousKey = clientCacheKeyBySource.get(identity);
  if (previousKey && previousKey !== source.cacheKey) {
    const previous = clients.get(previousKey);
    clients.delete(previousKey);
    void previous?.close().catch(() => undefined);
  }
  const client = createClient({
    url: url(source),
    username: asString(source.options.username ?? source.options.user) ?? "default",
    password: readPassword(source),
    database: asString(source.options.database),
    pathname: asString(source.options.pathname ?? source.options.proxy_path),
    request_timeout: timeout(source),
    application: "pi-database",
    log: { level: ClickHouseLogLevel.OFF },
    keep_alive: { enabled: true },
    clickhouse_settings: { output_format_json_quote_64bit_integers: 0 }
  });
  clients.set(source.cacheKey, client);
  clientCacheKeyBySource.set(identity, source.cacheKey);
  return client;
}

function validateRead(statement: string): string {
  const normalized = normalizeSql(statement);
  if (!normalized) throw new Error("Query is empty.");
  if (hasMultipleStatements(statement)) throw new Error("database_query expects a single SQL statement.");
  const keyword = firstKeyword(normalized);
  if (!keyword || !["SELECT", "WITH", "SHOW", "DESCRIBE", "EXISTS", "DESC", "EXPLAIN"].includes(keyword)) {
    throw new Error("database_query supports read-only ClickHouse statements only.");
  }
  return normalized;
}

function validateWrite(source: ResolvedSource, statement: string): ValidatedWrite {
  const normalized = normalizeSql(statement);
  if (!normalized) throw new DatabasePolicyError("Statement is empty.");
  if (!source.allowWriteAccess) throw new DatabasePolicyError(`Writes are disabled for source "${source.name}".`);
  if (hasMultipleStatements(statement)) throw new DatabasePolicyError("database_write expects a single SQL statement.");
  if (/\bON\s+CLUSTER\b/i.test(normalized)) throw new DatabasePolicyError("ClickHouse writes do not support ON CLUSTER.");
  if (/^ALTER\s+TABLE\b[\s\S]*\b(DELETE|DROP|MODIFY|CLEAR|REPLACE|MOVE|FETCH|FREEZE|REMOVE)\b/i.test(normalized)) {
    throw new DatabasePolicyError("ClickHouse writes do not support destructive or mutation ALTER TABLE statements.");
  }
  if (INSERT_PATTERN.test(normalized)) return { statement: normalized, statementKind: "insert" };
  if (CREATE_TABLE_PATTERN.test(normalized)) {
    if (/\bAS\s+SELECT\b/i.test(normalized)) throw new DatabasePolicyError("Derived CREATE TABLE statements are not supported.");
    return { statement: normalized, statementKind: "create" };
  }
  if (ALTER_ADD_COLUMN_PATTERN.test(normalized)) return { statement: normalized, statementKind: "alter" };
  throw new DatabasePolicyError("ClickHouse writes support only INSERT ... VALUES, CREATE TABLE, and ALTER TABLE ... ADD COLUMN.");
}

async function selectJson<T extends Record<string, unknown>>(source: ResolvedSource, query: string, signal?: AbortSignal): Promise<T[]> {
  const result = await getClient(source).query({
    query,
    format: "JSONEachRow",
    abort_signal: signal,
    clickhouse_settings: { readonly: "1", output_format_json_quote_64bit_integers: 0 }
  });
  return result.json<T>();
}

function requiredDatabase(source: ResolvedSource, requested?: string): string {
  const database = requested ?? asString(source.options.database);
  if (!database) throw new Error(`Source "${source.name}" requires a database argument.`);
  return database;
}

function sqlString(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

export const clickhouseAdapter: DatabaseAdapter = {
  dialect: "clickhouse",

  async ping(source, signal): Promise<PingResult> {
    const client = getClient(source);
    const ping = await client.ping({ select: true, abort_signal: signal });
    if (!ping.success) throw new Error(ping.error.message);
    const rows = await selectJson<{ server_version?: string; current_database?: string }>(
      source,
      "SELECT version() AS server_version, currentDatabase() AS current_database",
      signal
    );
    return {
      source: source.name,
      dialect: "clickhouse",
      ok: true,
      server_version: rows[0]?.server_version,
      current_database: rows[0]?.current_database ?? null
    };
  },

  async listDatabases(source, signal): Promise<string[]> {
    const rows = await selectJson<{ name?: string }>(source, "SELECT name FROM system.databases ORDER BY name", signal);
    return rows.map((row) => String(row.name ?? "")).filter(Boolean);
  },

  async listTables(source, database, signal): Promise<TableResult> {
    const selected = requiredDatabase(source, database);
    const rows = await selectJson<{ name?: string }>(
      source,
      `SELECT name FROM system.tables WHERE database = ${sqlString(selected)} ORDER BY name`,
      signal
    );
    return {
      source: source.name,
      dialect: "clickhouse",
      database: selected,
      tables: rows.map((row) => String(row.name ?? "")).filter(Boolean)
    };
  },

  async query(source, statement, maxRows, signal): Promise<QueryResult> {
    const normalized = validateRead(statement).replace(/\s+FORMAT\s+[A-Za-z0-9_]+\s*$/i, "");
    const response = await getClient(source).exec({
      query: normalized,
      abort_signal: signal,
      clickhouse_settings: {
        readonly: "1",
        default_format: "JSONCompact",
        max_result_rows: String(maxRows + 1),
        result_overflow_mode: "break",
        output_format_json_quote_64bit_integers: 0
      }
    });
    const payload = await new ResultSet(response.stream, "JSONCompact", response.query_id).json() as {
      meta?: Array<{ name: string }>;
      data?: unknown[];
    };
    const columns = Array.isArray(payload.meta) ? payload.meta.map((column) => column.name) : [];
    const rows = Array.isArray(payload.data)
      ? payload.data.map((row) => Array.isArray(row) ? row : columns.map((column) => (row as Record<string, unknown>)[column]))
      : [];
    const limited = rows.slice(0, maxRows);
    return {
      source: source.name,
      dialect: "clickhouse",
      columns,
      rows: limited,
      row_count: limited.length,
      truncated: rows.length > limited.length,
      query_id: response.query_id
    };
  },

  validateWrite: validateWrite,

  async write(source, write, signal): Promise<WriteResult> {
    if (signal?.aborted) throw new Error("Operation aborted.");
    const response = await getClient(source).command({
      query: write.statement,
      abort_signal: signal,
      clickhouse_settings: { readonly: "0" }
    });
    return {
      source: source.name,
      dialect: "clickhouse",
      executed: true,
      cancelled: false,
      statement_kind: write.statementKind,
      query_id: response.query_id
    };
  },

  async close(): Promise<void> {
    const active = [...clients.values()];
    clients.clear();
    clientCacheKeyBySource.clear();
    await Promise.all(active.map((client) => client.close()));
  }
};
