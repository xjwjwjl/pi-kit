import { Type } from "@sinclair/typebox";

const dialectSchema = Type.Union([Type.Literal("mysql"), Type.Literal("clickhouse")]);
const nullableStringSchema = Type.Union([Type.String(), Type.Null()]);
const optionalStringSchema = Type.Optional(Type.String());
const unknownRowsSchema = Type.Array(Type.Array(Type.Unknown()));

const sourceSchema = Type.Object({
  name: Type.String(),
  label: Type.String(),
  dialect: dialectSchema,
  provider: Type.Union([Type.Literal("project"), Type.Literal("dbx")]),
  default: Type.Boolean(),
  host: optionalStringSchema,
  database: optionalStringSchema,
  allow_write: Type.Boolean(),
  write_confirm: Type.Boolean(),
  query_timeout_ms: Type.Integer(),
  max_rows: Type.Integer()
});

const columnSchema = Type.Object({
  name: Type.String(),
  type: Type.String(),
  nullable: Type.Optional(Type.Boolean()),
  default: Type.Optional(nullableStringSchema),
  comment: Type.Optional(nullableStringSchema),
  position: Type.Optional(Type.Integer())
});

const indexSchema = Type.Object({
  name: Type.String(),
  columns: Type.Array(Type.String()),
  unique: Type.Optional(Type.Boolean()),
  type: optionalStringSchema
});

export const DATABASE_OUTPUT_SCHEMAS = {
  database_list_sources: Type.Object({
    config_path: Type.String(),
    default_sources: Type.Object({
      mysql: optionalStringSchema,
      clickhouse: optionalStringSchema
    }),
    sources: Type.Array(sourceSchema),
    warnings: Type.Optional(Type.Array(Type.String()))
  }),
  database_ping: Type.Object({
    source: Type.String(),
    dialect: dialectSchema,
    ok: Type.Boolean(),
    latency_ms: Type.Optional(Type.Number()),
    server_version: optionalStringSchema,
    current_database: Type.Optional(nullableStringSchema)
  }),
  database_list_databases: Type.Object({
    source: Type.String(),
    dialect: dialectSchema,
    databases: Type.Array(Type.String()),
    truncated: Type.Boolean()
  }),
  database_list_tables: Type.Object({
    source: Type.String(),
    dialect: dialectSchema,
    database: Type.String(),
    tables: Type.Array(Type.String()),
    truncated: Type.Boolean()
  }),
  database_search_tables: Type.Object({
    source: Type.String(),
    dialect: dialectSchema,
    matches: Type.Array(Type.Object({
      database: Type.String(),
      table: Type.String(),
      type: optionalStringSchema,
      engine: optionalStringSchema,
      comment: Type.Optional(nullableStringSchema)
    })),
    truncated: Type.Boolean()
  }),
  database_describe_table: Type.Object({
    source: Type.String(),
    dialect: dialectSchema,
    database: Type.String(),
    table: Type.String(),
    engine: optionalStringSchema,
    columns: Type.Array(columnSchema),
    indexes: Type.Array(indexSchema),
    create_statement: optionalStringSchema,
    truncated: Type.Boolean(),
    warnings: Type.Array(Type.String())
  }),
  database_query: Type.Object({
    source: Type.String(),
    dialect: dialectSchema,
    database: Type.String(),
    columns: Type.Array(Type.String()),
    rows: unknownRowsSchema,
    row_count: Type.Integer(),
    truncated: Type.Boolean(),
    warnings: Type.Array(Type.String()),
    elapsed_ms: Type.Optional(Type.Number()),
    query_id: optionalStringSchema
  }),
  database_write: Type.Object({
    source: Type.String(),
    dialect: dialectSchema,
    executed: Type.Boolean(),
    cancelled: Type.Boolean(),
    blocked: Type.Optional(Type.Boolean()),
    blocked_reason: Type.Optional(Type.Union([
      Type.Literal("source_read_only"),
      Type.Literal("missing_database"),
      Type.Literal("unsupported_statement"),
      Type.Literal("invalid_statement"),
      Type.Literal("confirmation_required"),
      Type.Literal("cancelled")
    ])),
    trusted_for_session: Type.Optional(Type.Boolean()),
    statement_kind: Type.String(),
    allow_write: Type.Optional(Type.Boolean()),
    write_confirm: Type.Optional(Type.Boolean()),
    forced_confirm: Type.Optional(Type.Boolean()),
    database: optionalStringSchema,
    requested_statement: optionalStringSchema,
    next_action: optionalStringSchema,
    query_id: optionalStringSchema,
    affected_rows: Type.Optional(Type.Number()),
    changed_rows: Type.Optional(Type.Number()),
    insert_id: Type.Optional(Type.Number()),
    warning_count: Type.Optional(Type.Number()),
    reason: optionalStringSchema,
    outcome: Type.Optional(Type.Literal("unknown"))
  }),
  database_usql: Type.Object({
    tool: Type.String(),
    connection: Type.String(),
    driver: optionalStringSchema,
    source: optionalStringSchema,
    allow_write: Type.Optional(Type.Boolean()),
    blocked: Type.Optional(Type.Boolean()),
    blocked_reason: Type.Optional(Type.Literal("source_read_only")),
    statement_kind: Type.String(),
    executed: Type.Boolean(),
    cancelled: Type.Optional(Type.Boolean()),
    confirmed: Type.Optional(Type.Boolean()),
    requested_statement: optionalStringSchema,
    columns: Type.Optional(Type.Array(Type.String())),
    rows: Type.Optional(unknownRowsSchema),
    row_count: Type.Optional(Type.Integer()),
    truncated: Type.Optional(Type.Boolean()),
    warnings: Type.Optional(Type.Array(Type.String())),
    elapsed_ms: Type.Optional(Type.Number()),
    output: optionalStringSchema,
    stderr: optionalStringSchema,
    exit_code: Type.Optional(Type.Integer()),
    error: optionalStringSchema,
    reason: optionalStringSchema,
    next_action: optionalStringSchema
  })
} as const;
