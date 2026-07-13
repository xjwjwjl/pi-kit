export type SqlDialect = "mysql" | "clickhouse";

export type JsonRecord = Record<string, unknown>;

export type ResolvedSource = {
  name: string;
  dialect: SqlDialect;
  options: JsonRecord;
  allowWrite: boolean;
  writeConfirm: boolean;
  queryTimeoutMs: number;
  maxRows: number;
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
  database: string;
  columns: string[];
  rows: unknown[][];
  row_count: number;
  truncated: boolean;
  warnings: string[];
  elapsed_ms?: number;
  query_id?: string;
};

export type PingResult = {
  source: string;
  dialect: SqlDialect;
  ok: boolean;
  latency_ms?: number;
  server_version?: string;
  current_database?: string | null;
};

export type ListDatabasesResult = {
  source: string;
  dialect: SqlDialect;
  databases: string[];
  truncated: boolean;
};

export type TableResult = {
  source: string;
  dialect: SqlDialect;
  database: string;
  tables: string[];
  truncated: boolean;
};

export type TableMatch = {
  database: string;
  table: string;
  type?: string;
  engine?: string;
  comment?: string | null;
};

export type SearchTablesResult = {
  source: string;
  dialect: SqlDialect;
  matches: TableMatch[];
  truncated: boolean;
};

export type ColumnInfo = {
  name: string;
  type: string;
  nullable?: boolean;
  default?: string | null;
  comment?: string | null;
  position?: number;
};

export type IndexInfo = {
  name: string;
  columns: string[];
  unique?: boolean;
  type?: string;
};

export type DescribeTableResult = {
  source: string;
  dialect: SqlDialect;
  database: string;
  table: string;
  engine?: string;
  columns: ColumnInfo[];
  indexes: IndexInfo[];
  create_statement?: string;
  truncated: boolean;
  warnings: string[];
};

export type ValidatedWrite = {
  statement: string;
  statementKind: "insert" | "update" | "create" | "alter";
  databaseRequired: boolean;
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
  allow_write?: boolean;
  write_confirm?: boolean;
  database?: string;
  requested_statement?: string;
  next_action?: string;
  query_id?: string;
  affected_rows?: number;
  changed_rows?: number;
  insert_id?: number;
  warning_count?: number;
  reason?: string;
  outcome?: "unknown";
};

export type DatabaseAdapter = {
  dialect: SqlDialect;
  ping(source: ResolvedSource, signal?: AbortSignal): Promise<PingResult>;
  listDatabases(source: ResolvedSource, signal?: AbortSignal): Promise<ListDatabasesResult>;
  listTables(source: ResolvedSource, database: string, signal?: AbortSignal): Promise<TableResult>;
  searchTables(source: ResolvedSource, term: string, database?: string, signal?: AbortSignal): Promise<SearchTablesResult>;
  describeTable(source: ResolvedSource, database: string, table: string, signal?: AbortSignal): Promise<DescribeTableResult>;
  query(source: ResolvedSource, database: string, statement: string, maxRows: number, signal?: AbortSignal): Promise<QueryResult>;
  validateWrite(source: ResolvedSource, statement: string): ValidatedWrite;
  write(source: ResolvedSource, database: string | undefined, write: ValidatedWrite, signal?: AbortSignal): Promise<WriteResult>;
  close(): Promise<void>;
};
