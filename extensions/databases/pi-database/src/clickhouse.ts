import { ClickHouseLogLevel, ResultSet, createClient, type ClickHouseClient } from "@clickhouse/client";
import { sourceWithDatabase } from "./config.js";
import { firstKeyword, hasMultipleStatements, hasTopLevelComma, normalizeSql } from "./sql.js";
import { DatabasePolicyError } from "./types.js";
import { boundItems, boundRows, boundTableNames, truncateText } from "./results.js";
import type { DatabaseAdapter, DescribeTableResult, ListDatabasesResult, PingResult, QueryResult, ResolvedSource, SearchTablesResult, TableResult, ValidatedWrite, WriteResult } from "./types.js";

const clients = new Map<string, ClickHouseClient>();
const clientCacheKeyBySource = new Map<string, string>();
const IDENTIFIER = "(?:`(?:``|[^`])+`|[A-Za-z_][A-Za-z0-9_$]*)";
const TABLE_IDENTIFIER = `${IDENTIFIER}(?:\\.${IDENTIFIER})?`;
const INSERT_VALUES_PATTERN = new RegExp(`^INSERT\\s+INTO\\s+${TABLE_IDENTIFIER}(?:\\s*\\([^)]*\\))?\\s+VALUES\\s*\\(`, "i");
const INSERT_SELECT_PATTERN = new RegExp(`^INSERT\\s+INTO\\s+${TABLE_IDENTIFIER}(?:\\s*\\([^)]*\\))?\\s+SELECT\\b`, "i");
const DELETE_PATTERN = new RegExp(`^DELETE\\s+FROM\\s+${TABLE_IDENTIFIER}\\s+WHERE`, "i");
const CREATE_TABLE_PATTERN = new RegExp(`^CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${TABLE_IDENTIFIER}\\s*\\(`, "i");
const CREATE_DATABASE_PATTERN = new RegExp(`^CREATE\\s+DATABASE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${IDENTIFIER}$`, "i");
const CREATE_MATERIALIZED_VIEW_PREFIX = /^CREATE\s+(?:OR\s+REPLACE\s+)?MATERIALIZED\s+VIEW\b/i;
const CREATE_MATERIALIZED_VIEW_OR_REPLACE = /^CREATE\s+OR\s+REPLACE\s+MATERIALIZED\s+VIEW\b/i;
const MATERIALIZED_VIEW_NAME_AND_CLUSTER = `${TABLE_IDENTIFIER}(?:\\s+ON\\s+CLUSTER\\s+${IDENTIFIER})?`;
const CREATE_MATERIALIZED_VIEW_TO_PATTERN = new RegExp(`^CREATE\\s+(?:OR\\s+REPLACE\\s+)?MATERIALIZED\\s+VIEW\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${MATERIALIZED_VIEW_NAME_AND_CLUSTER}\\s+TO\\s+${TABLE_IDENTIFIER}(?:\\s*\\([^)]*\\))?\\s+AS\\s+SELECT\\b`, "i");
const CREATE_MATERIALIZED_VIEW_ENGINE_PATTERN = new RegExp(`^CREATE\\s+(?:OR\\s+REPLACE\\s+)?MATERIALIZED\\s+VIEW\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${MATERIALIZED_VIEW_NAME_AND_CLUSTER}\\s+ENGINE\\s*=\\s+([\\s\\S]+?)\\s+AS\\s+SELECT\\b`, "i");
const ALTER_ADD_COLUMN_PATTERN = new RegExp(`^ALTER\\s+TABLE\\s+${TABLE_IDENTIFIER}\\s+ADD\\s+COLUMN\\b`, "i");
const ALTER_DELETE_PATTERN = new RegExp(`^ALTER\\s+TABLE\\s+${TABLE_IDENTIFIER}\\s+DELETE\\s+WHERE`, "i");
const TRUNCATE_PATTERN = new RegExp(`^TRUNCATE\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?${TABLE_IDENTIFIER}$`, "i");
const DROP_TABLE_PATTERN = new RegExp(`^DROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?${TABLE_IDENTIFIER}$`, "i");
const DROP_DATABASE_PATTERN = new RegExp(`^DROP\\s+DATABASE\\s+(?:IF\\s+EXISTS\\s+)?${IDENTIFIER}$`, "i");
const RENAME_TABLE_PATTERN = new RegExp(`^RENAME\\s+TABLE\\s+${TABLE_IDENTIFIER}\\s+TO\\s+${TABLE_IDENTIFIER}$`, "i");

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
  return source.queryTimeoutMs;
}

function sourceIdentity(source: ResolvedSource): string {
  return `${source.configPath}:${source.name}:${asString(source.options.database) ?? ""}`;
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

function validateMaterializedView(normalized: string): ValidatedWrite | undefined {
  if (!CREATE_MATERIALIZED_VIEW_PREFIX.test(normalized)) return undefined;
  if (/^CREATE\s+OR\s+REPLACE\s+MATERIALIZED\s+VIEW\s+IF\s+NOT\s+EXISTS\b/i.test(normalized)) {
    throw new DatabasePolicyError("ClickHouse materialized view writes cannot combine OR REPLACE with IF NOT EXISTS.");
  }
  const forceConfirm = CREATE_MATERIALIZED_VIEW_OR_REPLACE.test(normalized);
  if (CREATE_MATERIALIZED_VIEW_TO_PATTERN.test(normalized)) {
    return { statement: normalized, statementKind: "create", databaseRequired: true, forceConfirm: forceConfirm || undefined };
  }
  const engineMatch = CREATE_MATERIALIZED_VIEW_ENGINE_PATTERN.exec(normalized);
  if (engineMatch) {
    const definition = engineMatch[1] ?? "";
    if (/\b(?:POPULATE|REFRESH|DEFINER)\b|\bSQL\s+SECURITY\b/i.test(definition)) {
      throw new DatabasePolicyError("ClickHouse materialized view writes do not support POPULATE, REFRESH, DEFINER, or SQL SECURITY.");
    }
    return { statement: normalized, statementKind: "create", databaseRequired: true, forceConfirm: forceConfirm || undefined };
  }
  throw new DatabasePolicyError("ClickHouse materialized view writes support only CREATE MATERIALIZED VIEW ... TO ... AS SELECT and CREATE MATERIALIZED VIEW ... ENGINE = ... AS SELECT.");
}

function validateWrite(source: ResolvedSource, statement: string): ValidatedWrite {
  const normalized = normalizeSql(statement);
  if (!normalized) throw new DatabasePolicyError("Statement is empty.");
  if (!source.allowWrite) throw new DatabasePolicyError(`Writes are disabled for source "${source.name}".`);
  if (hasMultipleStatements(statement)) throw new DatabasePolicyError("database_write expects a single SQL statement.");
  const materializedView = validateMaterializedView(normalized);
  if (/\bON\s+CLUSTER\b/i.test(normalized) && !materializedView) throw new DatabasePolicyError("ClickHouse writes do not support ON CLUSTER outside standard materialized view creation.");
  if (/^ALTER\s+TABLE\b[\s\S]*\b(DROP|MODIFY|CLEAR|REPLACE|MOVE|FETCH|FREEZE|REMOVE)\b/i.test(normalized)) {
    throw new DatabasePolicyError("ClickHouse writes do not support destructive or mutation ALTER TABLE statements.");
  }
  if (INSERT_VALUES_PATTERN.test(normalized)) return { statement: normalized, statementKind: "insert", databaseRequired: true };
  if (INSERT_SELECT_PATTERN.test(normalized)) return { statement: normalized, statementKind: "insert", databaseRequired: true, forceConfirm: true };
  if (firstKeyword(normalized) === "DELETE") {
    if (!DELETE_PATTERN.test(normalized)) throw new DatabasePolicyError("ClickHouse writes support only DELETE ... FROM ... WHERE ... statements.");
    return { statement: normalized, statementKind: "delete", databaseRequired: true };
  }
  if (ALTER_DELETE_PATTERN.test(normalized)) {
    if (hasTopLevelComma(normalized)) {
      throw new DatabasePolicyError("ClickHouse ALTER TABLE ... DELETE WHERE must be a single command without additional ALTER commands.");
    }
    return { statement: normalized, statementKind: "delete", databaseRequired: true };
  }
  if (firstKeyword(normalized) === "TRUNCATE") {
    if (!TRUNCATE_PATTERN.test(normalized)) throw new DatabasePolicyError("ClickHouse writes support only single-table TRUNCATE TABLE statements.");
    return { statement: normalized, statementKind: "truncate", databaseRequired: true };
  }
  if (firstKeyword(normalized) === "DROP") {
    if (DROP_TABLE_PATTERN.test(normalized)) return { statement: normalized, statementKind: "drop", databaseRequired: true };
    if (DROP_DATABASE_PATTERN.test(normalized)) return { statement: normalized, statementKind: "drop", databaseRequired: false };
    throw new DatabasePolicyError("ClickHouse writes support only single-object DROP TABLE and DROP DATABASE statements.");
  }
  if (firstKeyword(normalized) === "RENAME") {
    if (!RENAME_TABLE_PATTERN.test(normalized)) throw new DatabasePolicyError("ClickHouse writes support only single-pair RENAME TABLE statements.");
    return { statement: normalized, statementKind: "rename", databaseRequired: true };
  }
  if (CREATE_DATABASE_PATTERN.test(normalized)) return { statement: normalized, statementKind: "create", databaseRequired: false };
  if (materializedView) return materializedView;
  if (CREATE_TABLE_PATTERN.test(normalized)) {
    if (/\bAS\s+SELECT\b/i.test(normalized)) throw new DatabasePolicyError("Derived CREATE TABLE statements are not supported.");
    return { statement: normalized, statementKind: "create", databaseRequired: true };
  }
  if (ALTER_ADD_COLUMN_PATTERN.test(normalized)) return { statement: normalized, statementKind: "alter", databaseRequired: true };
  throw new DatabasePolicyError("ClickHouse writes support only INSERT ... VALUES, INSERT ... SELECT, DELETE ... WHERE, TRUNCATE, DROP, RENAME, CREATE DATABASE, CREATE TABLE, CREATE MATERIALIZED VIEW, and ALTER TABLE ... ADD COLUMN.");
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
    const startedAt = performance.now();
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
      latency_ms: performance.now() - startedAt,
      server_version: rows[0]?.server_version,
      current_database: rows[0]?.current_database ?? null
    };
  },

  async listDatabases(source, signal): Promise<ListDatabasesResult> {
    const rows = await selectJson<{ name?: string }>(source, "SELECT name FROM system.databases ORDER BY name", signal);
    const bounded = boundItems(rows.map((row) => String(row.name ?? "")).filter(Boolean));
    return { source: source.name, dialect: "clickhouse", databases: bounded.items, truncated: bounded.truncated };
  },

  async listTables(source, database, signal): Promise<TableResult> {
    const selected = requiredDatabase(source, database);
    const rows = await selectJson<{ name?: string }>(
      source,
      `SELECT name FROM system.tables WHERE database = ${sqlString(selected)} ORDER BY name LIMIT 501`,
      signal
    );
    const bounded = boundTableNames(rows.map((row) => String(row.name ?? "")).filter(Boolean));
    return {
      source: source.name,
      dialect: "clickhouse",
      database: selected,
      tables: bounded.tables,
      truncated: bounded.truncated
    };
  },

  async searchTables(source, term, database, signal): Promise<SearchTablesResult> {
    if (signal?.aborted) throw new Error("Operation aborted.");
    const needle = term.trim();
    if (!needle) throw new Error("Search term is required.");
    const databaseWhere = database ? `database = ${sqlString(database)} AND ` : "";
    const rows = await selectJson<{ database?: string; name?: string; engine?: string; comment?: string }>(
      source,
      `SELECT database, name, engine, comment FROM system.tables
       WHERE ${databaseWhere} (positionCaseInsensitiveUTF8(name, ${sqlString(needle)}) > 0 OR positionCaseInsensitiveUTF8(comment, ${sqlString(needle)}) > 0)
       ORDER BY database, name LIMIT 501`,
      signal
    );
    const rawMatches = rows.slice(0, 500).map((row) => ({
      database: String(row.database ?? ""),
      table: String(row.name ?? ""),
      engine: row.engine == null ? undefined : String(row.engine),
      comment: row.comment == null ? null : truncateText(String(row.comment)).value
    })).filter((match) => match.database && match.table);
    const bounded = boundItems(rawMatches);
    return { source: source.name, dialect: "clickhouse", matches: bounded.items, truncated: rows.length > rawMatches.length || bounded.truncated };
  },

  async describeTable(source, database, table, signal): Promise<DescribeTableResult> {
    if (signal?.aborted) throw new Error("Operation aborted.");
    const tables = await selectJson<{ engine?: string; create_table_query?: string }>(
      source,
      `SELECT engine, create_table_query FROM system.tables WHERE database = ${sqlString(database)} AND name = ${sqlString(table)} LIMIT 1`,
      signal
    );
    const metadata = tables[0];
    if (!metadata) throw new Error(`Table \"${database}.${table}\" was not found.`);
    const columns = await selectJson<{ name?: string; type?: string; default_expression?: string; comment?: string; position?: number }>(
      source,
      `SELECT name, type, default_expression, comment, position FROM system.columns
       WHERE database = ${sqlString(database)} AND table = ${sqlString(table)} ORDER BY position LIMIT 501`,
      signal
    );
    const boundedColumns = boundItems(columns.map((column) => ({
      name: String(column.name ?? ""),
      type: String(column.type ?? ""),
      default: column.default_expression == null ? null : truncateText(String(column.default_expression)).value,
      comment: column.comment == null ? null : truncateText(String(column.comment)).value,
      position: Number(column.position ?? 0)
    })));
    const createText = metadata.create_table_query == null ? undefined : truncateText(String(metadata.create_table_query));
    const truncated = boundedColumns.truncated || createText?.truncated === true;
    return {
      source: source.name,
      dialect: "clickhouse",
      database,
      table,
      engine: metadata.engine == null ? undefined : String(metadata.engine),
      columns: boundedColumns.items,
      indexes: [],
      create_statement: createText?.value,
      truncated,
      warnings: truncated ? ["Table metadata was truncated to the result limits."] : []
    };
  },

  async query(source, database, statement, maxRows, signal): Promise<QueryResult> {
    const querySource = sourceWithDatabase(source, database);
    const normalized = validateRead(statement).replace(/\s+FORMAT\s+[A-Za-z0-9_]+\s*$/i, "");
    const response = await getClient(querySource).exec({
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
    const bounded = boundRows(rows, maxRows);
    return {
      source: source.name,
      dialect: "clickhouse",
      database,
      columns,
      rows: bounded.rows,
      row_count: bounded.rows.length,
      truncated: bounded.truncated,
      warnings: bounded.warnings,
      query_id: response.query_id
    };
  },

  validateWrite: validateWrite,

  async write(source, database, write, signal): Promise<WriteResult> {
    if (signal?.aborted) throw new Error("Operation aborted.");
    const writeSource = database ? sourceWithDatabase(source, database) : source;
    const response = await getClient(writeSource).command({
      query: write.statement,
      abort_signal: signal,
      clickhouse_settings: { readonly: "0", mutations_sync: "1" }
    });
    return {
      source: source.name,
      dialect: "clickhouse",
      database,
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
