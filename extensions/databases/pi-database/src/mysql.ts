import mysql from "mysql2/promise";
import type { Pool, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { firstKeyword, hasMultipleStatements, hasTopLevelKeyword, normalizeSql } from "./sql.js";
import { DatabasePolicyError } from "./types.js";
import type { DatabaseAdapter, PingResult, QueryResult, ResolvedSource, TableResult, ValidatedWrite, WriteResult } from "./types.js";

const pools = new Map<string, Pool>();
const poolCacheKeyBySource = new Map<string, string>();
const IDENTIFIER = "(?:`(?:``|[^`])+`|[A-Za-z_][A-Za-z0-9_$]*)";
const TABLE_IDENTIFIER = `${IDENTIFIER}(?:\\.${IDENTIFIER})?`;
const INSERT_PATTERN = new RegExp(`^INSERT\\s+INTO\\s+${TABLE_IDENTIFIER}(?:\\s*\\([^)]*\\))?\\s+VALUES\\s*\\(`, "i");
const UPDATE_PATTERN = new RegExp(`^UPDATE\\s+${TABLE_IDENTIFIER}\\s+SET\\s+`, "i");
const CREATE_TABLE_PATTERN = new RegExp(`^CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${TABLE_IDENTIFIER}\\s*\\(`, "i");
const ALTER_ADD_PATTERN = new RegExp(`^ALTER\\s+TABLE\\s+${TABLE_IDENTIFIER}\\s+ADD\\s+(?:COLUMN|INDEX)\\b`, "i");

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

function sourceIdentity(source: ResolvedSource): string {
  return `${source.configPath}:${source.name}`;
}

function getPool(source: ResolvedSource): Pool {
  const identity = sourceIdentity(source);
  const cached = pools.get(source.cacheKey);
  if (cached) {
    poolCacheKeyBySource.set(identity, source.cacheKey);
    return cached;
  }
  const previousKey = poolCacheKeyBySource.get(identity);
  if (previousKey && previousKey !== source.cacheKey) {
    const previous = pools.get(previousKey);
    pools.delete(previousKey);
    void previous?.end().catch(() => undefined);
  }
  const host = asString(source.options.host);
  const socketPath = asString(source.options.socketPath);
  const user = asString(source.options.user ?? source.options.username);
  if (!user || (!host && !socketPath)) throw new Error(`Invalid MySQL source "${source.name}": host or socketPath and user are required.`);
  const pool = mysql.createPool({
    host,
    port: asPositiveInteger(source.options.port, 3306),
    user,
    password: readPassword(source),
    database: asString(source.options.database),
    socketPath,
    charset: asString(source.options.charset),
    connectTimeout: asPositiveInteger(source.options.connect_timeout_ms, 10_000),
    connectionLimit: asPositiveInteger(source.options.pool_size, 10),
    waitForConnections: true,
    queueLimit: 0,
    multipleStatements: false,
    dateStrings: true,
    ssl: source.options.ssl === true || typeof source.options.ssl === "object" ? source.options.ssl as mysql.SslOptions : undefined
  });
  pools.set(source.cacheKey, pool);
  poolCacheKeyBySource.set(identity, source.cacheKey);
  return pool;
}

function timeout(source: ResolvedSource): number {
  return asPositiveInteger(source.options.query_timeout_ms, 30_000);
}

function buildReadQuery(statement: string, maxRows: number): string {
  return firstKeyword(statement) === "SELECT"
    ? `SELECT * FROM (${statement}) AS pi_database_limited LIMIT ${maxRows + 1}`
    : statement;
}

function validateRead(statement: string): string {
  const normalized = normalizeSql(statement);
  if (!normalized) throw new Error("Query is empty.");
  if (hasMultipleStatements(statement)) throw new Error("database_query expects a single SQL statement.");
  if (/\/\*!/.test(statement)) throw new Error("MySQL executable comments are not allowed.");
  const keyword = firstKeyword(normalized);
  if (!keyword || !["SELECT", "WITH", "SHOW", "DESCRIBE", "DESC", "EXPLAIN"].includes(keyword)) {
    throw new Error("database_query supports read-only MySQL statements only.");
  }
  if (/\b(FOR\s+UPDATE|LOCK\s+IN\s+SHARE\s+MODE|INTO\s+OUTFILE|INTO\s+DUMPFILE|LOAD_FILE\s*\()\b/i.test(normalized)) {
    throw new Error("This MySQL read query uses a blocked lock or file operation.");
  }
  return normalized;
}

function validateWrite(source: ResolvedSource, statement: string): ValidatedWrite {
  const normalized = normalizeSql(statement);
  if (!normalized) throw new DatabasePolicyError("Statement is empty.");
  if (!source.allowWriteAccess) throw new DatabasePolicyError(`Writes are disabled for source "${source.name}".`);
  if (hasMultipleStatements(statement)) throw new DatabasePolicyError("database_write expects a single SQL statement.");
  if (/\/\*!/.test(statement)) throw new DatabasePolicyError("MySQL executable comments are not allowed.");
  const keyword = firstKeyword(normalized);
  if (keyword === "INSERT" && INSERT_PATTERN.test(normalized)) return { statement: normalized, statementKind: "insert" };
  if (keyword === "UPDATE" && UPDATE_PATTERN.test(normalized)) {
    if (!hasTopLevelKeyword(normalized, "WHERE")) throw new DatabasePolicyError("MySQL UPDATE statements require a top-level WHERE clause.");
    return { statement: normalized, statementKind: "update" };
  }
  if (keyword === "CREATE" && CREATE_TABLE_PATTERN.test(normalized)) {
    if (hasTopLevelKeyword(normalized, "AS") || hasTopLevelKeyword(normalized, "LIKE")) {
      throw new DatabasePolicyError("Derived CREATE TABLE statements are not supported.");
    }
    return { statement: normalized, statementKind: "create" };
  }
  if (keyword === "ALTER" && ALTER_ADD_PATTERN.test(normalized)) {
    const destructiveActions = ["DROP", "DELETE", "MODIFY", "CHANGE", "RENAME", "REPLACE", "TRUNCATE", "CLEAR", "REMOVE", "MOVE"];
    if (destructiveActions.some((action) => hasTopLevelKeyword(normalized, action))) {
      throw new DatabasePolicyError("MySQL writes do not support destructive ALTER TABLE statements.");
    }
    return { statement: normalized, statementKind: "alter" };
  }
  throw new DatabasePolicyError("MySQL writes support only INSERT ... VALUES, UPDATE ... WHERE, CREATE TABLE, and ALTER TABLE ... ADD COLUMN/INDEX.");
}

function rowValues(row: unknown, columns: string[]): unknown[] {
  if (Array.isArray(row)) return row;
  if (!row || typeof row !== "object") return columns.map(() => undefined);
  return columns.map((column) => (row as Record<string, unknown>)[column]);
}

function requiredDatabase(source: ResolvedSource, requested?: string): string {
  const database = requested ?? asString(source.options.database);
  if (!database) throw new Error(`Source "${source.name}" requires a database argument.`);
  return database;
}

export const mysqlAdapter: DatabaseAdapter = {
  dialect: "mysql",

  async ping(source, signal): Promise<PingResult> {
    if (signal?.aborted) throw new Error("Operation aborted.");
    const [rows] = await getPool(source).query<RowDataPacket[]>({
      sql: "SELECT VERSION() AS server_version, DATABASE() AS current_database",
      timeout: timeout(source)
    });
    const row = rows[0];
    return {
      source: source.name,
      dialect: "mysql",
      ok: true,
      server_version: typeof row?.server_version === "string" ? row.server_version : undefined,
      current_database: row?.current_database == null ? null : String(row.current_database)
    };
  },

  async listDatabases(source, signal): Promise<string[]> {
    if (signal?.aborted) throw new Error("Operation aborted.");
    const [rows] = await getPool(source).query<RowDataPacket[]>({ sql: "SHOW DATABASES", timeout: timeout(source) });
    return rows.map((row) => String(row.Database ?? "")).filter(Boolean);
  },

  async listTables(source, database, signal): Promise<TableResult> {
    if (signal?.aborted) throw new Error("Operation aborted.");
    const selected = requiredDatabase(source, database);
    const [rows] = await getPool(source).query<RowDataPacket[]>({
      sql: "SELECT table_name FROM information_schema.tables WHERE table_schema = ? ORDER BY table_name",
      values: [selected],
      timeout: timeout(source)
    });
    return {
      source: source.name,
      dialect: "mysql",
      database: selected,
      tables: rows.map((row) => String(row.table_name ?? "")).filter(Boolean)
    };
  },

  async query(source, statement, maxRows, signal): Promise<QueryResult> {
    if (signal?.aborted) throw new Error("Operation aborted.");
    const normalized = validateRead(statement);
    const [rows, fields] = await getPool(source).query({
      sql: buildReadQuery(normalized, maxRows),
      timeout: timeout(source),
      rowsAsArray: true
    });
    const columns = Array.isArray(fields) ? fields.map((field) => field.name) : [];
    const rawRows = Array.isArray(rows) ? rows : [];
    const limited = rawRows.slice(0, maxRows).map((row) => rowValues(row, columns));
    return {
      source: source.name,
      dialect: "mysql",
      columns,
      rows: limited,
      row_count: limited.length,
      truncated: rawRows.length > limited.length,
      query_id: `mysql-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`
    };
  },

  validateWrite: validateWrite,

  async write(source, write, signal): Promise<WriteResult> {
    if (signal?.aborted) throw new Error("Operation aborted.");
    const [result] = await getPool(source).query({ sql: write.statement, timeout: timeout(source) });
    const header = result as ResultSetHeader;
    return {
      source: source.name,
      dialect: "mysql",
      executed: true,
      cancelled: false,
      statement_kind: write.statementKind,
      query_id: `mysql-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`,
      affected_rows: header.affectedRows,
      changed_rows: header.changedRows,
      insert_id: header.insertId,
      warning_count: header.warningStatus
    };
  },

  async close(): Promise<void> {
    const active = [...pools.values()];
    pools.clear();
    poolCacheKeyBySource.clear();
    await Promise.all(active.map((pool) => pool.end()));
  }
};
