export type SqlDialect = "mysql" | "clickhouse";

export type JsonRecord = Record<string, unknown>;

export type ResolvedSource = {
  name: string;
  dialect: SqlDialect;
  options: JsonRecord;
  allowWriteAccess: boolean;
  configPath: string;
  cacheKey: string;
};

export type ResolvedProjectConfig = {
  configPath: string;
  defaultSource?: string;
  sources: ResolvedSource[];
};

export type QueryResult = {
  source: string;
  dialect: SqlDialect;
  columns: string[];
  rows: unknown[][];
  row_count: number;
  truncated: boolean;
  query_id?: string;
};

export type PingResult = {
  source: string;
  dialect: SqlDialect;
  ok: boolean;
  server_version?: string;
  current_database?: string | null;
};

export type TableResult = {
  source: string;
  dialect: SqlDialect;
  database: string;
  tables: string[];
};

export type ValidatedWrite = {
  statement: string;
  statementKind: "insert" | "update" | "create" | "alter";
};

export class DatabasePolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabasePolicyError";
  }
}

export type WriteResult = {
  source: string;
  dialect: SqlDialect;
  executed: boolean;
  cancelled: boolean;
  blocked?: boolean;
  statement_kind: ValidatedWrite["statementKind"] | "unknown";
  allow_write_access?: boolean;
  requested_statement?: string;
  next_action?: string;
  query_id?: string;
  affected_rows?: number;
  changed_rows?: number;
  insert_id?: number;
  warning_count?: number;
  reason?: string;
};

export type DatabaseAdapter = {
  dialect: SqlDialect;
  ping(source: ResolvedSource, signal?: AbortSignal): Promise<PingResult>;
  listDatabases(source: ResolvedSource, signal?: AbortSignal): Promise<string[]>;
  listTables(source: ResolvedSource, database: string, signal?: AbortSignal): Promise<TableResult>;
  query(source: ResolvedSource, statement: string, maxRows: number, signal?: AbortSignal): Promise<QueryResult>;
  validateWrite(source: ResolvedSource, statement: string): ValidatedWrite;
  write(source: ResolvedSource, write: ValidatedWrite, signal?: AbortSignal): Promise<WriteResult>;
  close(): Promise<void>;
};
