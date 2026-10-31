import { Type } from "@sinclair/typebox";
import { USQL_MAX_ROWS_LIMIT, USQL_MAX_TIMEOUT_MS } from "./usql.js";

const SourceSelectionParams = {
  source: Type.Optional(Type.String({ description: "Configured database source name; must match dialect when both are provided" })),
  dialect: Type.Optional(Type.String({ pattern: "^(mysql|clickhouse)$", description: "MySQL or ClickHouse; selects that dialect's default source when source is omitted" }))
};

export const SourceParams = Type.Object(SourceSelectionParams);

export const ListTablesParams = Type.Object({
  ...SourceSelectionParams,
  database: Type.Optional(Type.String({ description: "Database name; defaults to the source database" }))
});

export const SearchTablesParams = Type.Object({
  ...SourceSelectionParams,
  term: Type.String({ description: "Case-insensitive table name or comment search text" }),
  database: Type.Optional(Type.String({ description: "Optional database filter" }))
});

export const DescribeTableParams = Type.Object({
  ...SourceSelectionParams,
  database: Type.String({ description: "Database containing the table" }),
  table: Type.String({ description: "Table to describe" })
});

export const QueryParams = Type.Object({
  ...SourceSelectionParams,
  database: Type.String({ minLength: 1, description: "Database to use for this query; required on every call" }),
  query: Type.String({ description: "Single read-only SQL statement" }),
  max_rows: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, description: "Maximum returned rows; defaults to the selected source max_rows" }))
});

export const WriteParams = Type.Object({
  ...SourceSelectionParams,
  database: Type.Optional(Type.String({ minLength: 1, description: "Database for table-scoped writes; omit only for CREATE DATABASE and DROP DATABASE" })),
  statement: Type.String({ description: "Single supported write statement" })
});

export const UsqlParams = Type.Object({
  connection: Type.String({
    minLength: 1,
    description: "usql DSN (postgres://user:pass@host/db, sqlite3:app.db, ch://host/db) or a connection name defined in the usql config file"
  }),
  source: Type.Optional(Type.String({
    minLength: 1,
    description: "Optional configured source name to bind this statement to that source's allow_write policy"
  })),
  statement: Type.String({
    minLength: 1,
    description: "One SQL statement, or one usql meta-command such as \\dt or \\copy"
  }),
  max_rows: Type.Optional(Type.Integer({ minimum: 1, maximum: USQL_MAX_ROWS_LIMIT, description: "Maximum returned rows; defaults to 100" })),
  timeout_ms: Type.Optional(Type.Integer({ minimum: 1000, maximum: USQL_MAX_TIMEOUT_MS, description: "Execution timeout in milliseconds; defaults to 30000" }))
});
