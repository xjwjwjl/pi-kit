import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { clickhouseAdapter } from "./clickhouse.js";
import { getContextCwd, loadProjectConfig, selectSource } from "./config.js";
import { DATABASE_OUTPUT_SCHEMAS } from "./output-schemas.js";
import { mysqlAdapter } from "./mysql.js";
import { firstKeyword } from "./sql.js";
import { DatabasePolicyError } from "./types.js";
import type { DatabaseAdapter, ResolvedSource, ValidatedWrite, WriteResult } from "./types.js";
import {
  DescribeTableParams,
  ListTablesParams,
  QueryParams,
  SearchTablesParams,
  SourceParams,
  UsqlParams,
  WriteParams
} from "./schemas.js";
import {
  MetadataResultComponent,
  PingResultComponent,
  QueryResultComponent,
  buildWriteConfirmation,
  callSource,
  callString,
  createQueryViewTheme,
  createWriteResultComponent,
  formatSqlForUi,
  formatWrite,
  getResultDetails,
  isRecord,
  renderDatabaseCall,
  requestedDialect,
  sourceDetails,
  sourceListView,
  tableDescriptionView,
  tableListView,
  tableSearchView,
  databaseListView,
  writeResultColor,
  buildUsqlConfirmation,
  createUsqlResultComponent,
  formatUsql,
  createSqlConfirmationComponent,
  type SqlConfirmation,
  type SqlConfirmationDecision,
  type SqlConfirmationOptions,
  type SourceSummary,
  type UsqlResult
} from "./render.js";
import {
  USQL_DEFAULT_MAX_ROWS,
  USQL_DEFAULT_TIMEOUT_MS,
  USQL_MAX_ROWS_LIMIT,
  USQL_MAX_TIMEOUT_MS,
  USQL_TOOL_NAME,
  connectionScheme,
  redactConnection,
  resolveUsqlBinary,
  runUsqlStatement,
  statementKind,
  usqlAvailable
} from "./usql.js";
import type { UsqlRunResult } from "./usql.js";

const adapters: Record<ResolvedSource["dialect"], DatabaseAdapter> = {
  mysql: mysqlAdapter,
  clickhouse: clickhouseAdapter
};

export const writeQueues = new Map<string, Promise<void>>();

export type TrustedWriteSource = {
  name: string;
  dialect: ResolvedSource["dialect"];
  database?: string;
};

const trustedWriteSources = new Map<string, TrustedWriteSource>();

function writeTrustKey(source: ResolvedSource, database?: string): string {
  return `${writeQueueKey(source)}\u0000${database ?? ""}`;
}

export function clearTrustedWriteSources(): void {
  trustedWriteSources.clear();
}

export function trustWriteSource(source: ResolvedSource, database?: string): void {
  if (source.allowWrite) {
    trustedWriteSources.set(writeTrustKey(source, database), {
      name: source.name,
      dialect: source.dialect,
      ...(database ? { database } : {})
    });
  }
}

export function isWriteSourceTrusted(source: ResolvedSource, database?: string): boolean {
  return source.allowWrite && trustedWriteSources.has(writeTrustKey(source, database));
}

export function listTrustedWriteSources(): TrustedWriteSource[] {
  return [...trustedWriteSources.values()];
}
const CONFIGURED_TOOL_NAMES = [
  "database_list_sources",
  "database_ping",
  "database_list_databases",
  "database_list_tables",
  "database_search_tables",
  "database_describe_table",
  "database_query",
  "database_write"
] as const;
const DATABASE_TOOL_NAMES = [...CONFIGURED_TOOL_NAMES, USQL_TOOL_NAME] as const;


const DESTRUCTIVE_KINDS: ReadonlySet<ValidatedWrite["statementKind"]> = new Set(["delete", "drop", "truncate", "rename", "replace"]);

function requiresForcedConfirmation(write: ValidatedWrite): boolean {
  return write.forceConfirm === true || DESTRUCTIVE_KINDS.has(write.statementKind);
}

function adapterFor(source: ResolvedSource): DatabaseAdapter {
  return adapters[source.dialect];
}

function makeResult(details: unknown, text?: string) {
  const serializedDetails = JSON.stringify(details);
  if (typeof serializedDetails !== "string") throw new Error("Database tool results must be JSON-serializable objects.");
  const structuredContent: unknown = JSON.parse(serializedDetails);
  if (!isRecord(structuredContent)) throw new Error("Database tool results must be JSON objects.");
  return {
    content: [{ type: "text" as const, text: text ?? serializedDetails }],
    details,
    structuredContent
  };
}

function isUncertainWriteError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /timeout|timed out|connection|socket|econn|network|aborted|reset|closed/i.test(message);
}

function blockedWriteNextAction(reason: DatabasePolicyError["reason"]): string {
  if (reason === "source_read_only") {
    return "Stop this write attempt. Explain this source policy to the user and ask what they want to do next. Do not bypass a read-only source with database_usql, bash, a database client, or config edits.";
  }
  if (reason === "invalid_statement") {
    return "Stop this write attempt. Fix the statement so it is one valid statement of a supported form, or ask the user how to proceed. Do not use database_usql for multiple statements or invalid input.";
  }
  return "Stop this write attempt. Explain the limitation and ask the user whether to run the statement through database_usql with confirmation, run it manually, or stop. Use database_usql only after explicit user approval; do not use bash, a database client, or config edits to bypass policy.";
}

export function writeQueueKey(source: ResolvedSource): string {
  return `${source.configPath}:${source.name}`;
}

export function serializeWrite<T>(source: ResolvedSource, task: () => Promise<T>): Promise<T> {
  const key = writeQueueKey(source);
  const previous = writeQueues.get(key) ?? Promise.resolve();
  const next = previous.then(task, task);
  const settled = next.then(
    () => undefined,
    () => undefined
  );
  writeQueues.set(key, settled);
  void settled.finally(() => {
    if (writeQueues.get(key) === settled) writeQueues.delete(key);
  });
  return next;
}

function refreshTrustStatus(ctx: unknown): void {
  if (!isRecord(ctx) || !isRecord(ctx.ui) || typeof ctx.ui.setStatus !== "function") return;
  const trusted = listTrustedWriteSources();
  if (trusted.length === 0) return;
  const text = `database: on · trusted: ${trusted.map((source) => `${source.name}${source.database ? `/${source.database}` : ""}`).join(", ")}`;
  const theme = isRecord(ctx.ui.theme) ? ctx.ui.theme : undefined;
  const value = theme && typeof theme.fg === "function"
    ? (theme.fg as (color: string, text: string) => string)("accent", text)
    : text;
  (ctx.ui.setStatus as (name: string, value: string) => void)("pi-database", value);
}

async function confirmSqlStatement(
  ctx: unknown,
  confirmation: SqlConfirmation,
  options: SqlConfirmationOptions = {}
): Promise<SqlConfirmationDecision | undefined> {
  if (!isRecord(ctx) || ctx.hasUI !== true || !isRecord(ctx.ui)) return undefined;
  const ui = ctx.ui as Record<string, unknown>;
  if (ctx.mode === "tui" && typeof ui.custom === "function") {
    return (ui.custom as (factory: (tui: unknown, theme: ConfirmationTheme, keybindings: unknown, done: (decision: SqlConfirmationDecision) => void) => Component) => Promise<SqlConfirmationDecision>)(
      (_tui, theme, _keybindings, done) => createSqlConfirmationComponent(confirmation, theme, done, options)
    );
  }
  if (typeof ui.confirm !== "function") return undefined;
  const confirmed = await (ui.confirm as (title: string, message: string) => Promise<boolean> | boolean)(confirmation.title, confirmation.message);
  return confirmed ? "once" : "cancel";
}

const USQL_READ_KINDS: ReadonlySet<string> = new Set(["select", "show", "describe", "desc", "explain", "with", "exists", "meta"]);
const USQL_POLICY_READ_KINDS: ReadonlySet<string> = new Set(["select", "show", "describe", "desc", "explain", "with", "exists"]);
const USQL_READ_META_COMMANDS: ReadonlySet<string> = new Set([
  "d", "dt", "l", "dn", "df", "dv", "di", "ds", "conninfo", "echo", "q", "quit",
  "pset", "timing", "x", "H", "T", "a", "C", "S", "?", "h", "help"
]);

/** Meta-commands are treated as writes unless they are known read-only commands. */
function usqlStatementWrites(statement: string, kind: string): boolean {
  if (/\bINTO\s+(?:OUTFILE|DUMPFILE)\b/i.test(statement)) return true;
  if (kind !== "meta") return !USQL_POLICY_READ_KINDS.has(kind);
  const match = /^\s*\\([A-Za-z?]+)/.exec(statement);
  return !match || !USQL_READ_META_COMMANDS.has(match[1]!);
}

export function syncToolActivation(pi: ExtensionAPI, cwd: string): boolean {
  let enabled = false;
  try {
    enabled = loadProjectConfig(cwd).enabled;
  } catch {
    // Invalid project or settings configs stay inactive and are surfaced in the status bar.
    enabled = false;
  }
  const databaseToolNames = new Set<string>(DATABASE_TOOL_NAMES);
  const activeTools = pi.getActiveTools();
  const nextTools = activeTools.filter((name) => !databaseToolNames.has(name));
  if (enabled) nextTools.push(...CONFIGURED_TOOL_NAMES);
  if (enabled && usqlAvailable()) nextTools.push(USQL_TOOL_NAME);
  const deduplicated = [...new Set(nextTools)];
  if (deduplicated.length !== activeTools.length || deduplicated.some((name, index) => name !== activeTools[index])) {
    pi.setActiveTools(deduplicated);
  }
  return enabled;
}

function ensureDatabaseEnabled(config: { enabled: boolean }): void {
  if (!config.enabled) {
    throw new Error("Database tools are disabled for this project. Run /database on to enable them.");
  }
}

function resolveCurrentSource(ctx: unknown, requested?: string, dialect?: string): ResolvedSource {
  const config = loadProjectConfig(getContextCwd(ctx));
  ensureDatabaseEnabled(config);
  return selectSource(config, requested, requestedDialect(dialect));
}

export function registerTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "database_list_sources",
    outputSchema: DATABASE_OUTPUT_SCHEMAS.database_list_sources,
    label: "Database List Sources",
    description: "List all configured MySQL and ClickHouse sources for the current project.",
    promptSnippet: "List configured MySQL and ClickHouse sources before choosing a database connection",
    promptGuidelines: [
      "Use database_list_sources first when a database request does not clearly identify one configured source.",
      "Use database_* tools for configured databases instead of bash, mysql, clickhouse-client, or another local database client."
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const config = loadProjectConfig(getContextCwd(ctx));
      ensureDatabaseEnabled(config);
      const details = {
        config_path: config.configPath,
        default_sources: config.defaultSources,
        sources: config.sources.map((source) => sourceDetails(source, config.defaultSources[source.dialect] === source.name)),
        ...(config.dbxWarning ? { warnings: [config.dbxWarning] } : {})
      };
      return makeResult(details);
    },
    renderCall(_args, theme, context) {
      return renderDatabaseCall("Database Sources", undefined, [], theme, context);
    },
    renderResult(result, options, theme, context) {
      const details = getResultDetails(result);
      const view = sourceListView(details as { config_path: string; sources: SourceSummary[]; warnings?: string[] });
      return new MetadataResultComponent(view, result, context.isError, options.expanded, createQueryViewTheme(theme));
    }
  });

  pi.registerTool({
    name: "database_ping",
    outputSchema: DATABASE_OUTPUT_SCHEMAS.database_ping,
    label: "Database Ping",
    description: "Verify that a configured database source is reachable.",
    promptSnippet: "Check connectivity for a configured database source",
    parameters: SourceParams,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const input = params as { source?: string; dialect?: string };
      const source = resolveCurrentSource(ctx, input.source, input.dialect);
      return makeResult(await adapterFor(source).ping(source, signal));
    },
    renderCall(args, theme, context) {
      const source = callSource(args, context.cwd);
      return renderDatabaseCall("Database Ping", source, [], theme, context);
    },
    renderResult(result, _options, theme, context) {
      const details = getResultDetails(result);
      return new PingResultComponent(details, result, context.isError, createQueryViewTheme(theme));
    }
  });

  pi.registerTool({
    name: "database_list_databases",
    outputSchema: DATABASE_OUTPUT_SCHEMAS.database_list_databases,
    label: "Database List Databases",
    description: "List databases visible to a configured source.",
    promptSnippet: "List databases visible through a configured MySQL or ClickHouse source",
    promptGuidelines: [
      "Use database_list_databases to list database/catalog namespaces visible to a configured source."
    ],
    parameters: SourceParams,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const input = params as { source?: string; dialect?: string };
      const source = resolveCurrentSource(ctx, input.source, input.dialect);
      return makeResult(await adapterFor(source).listDatabases(source, signal));
    },
    renderCall(args, theme, context) {
      const source = callSource(args, context.cwd);
      return renderDatabaseCall("Database Databases", source, [], theme, context);
    },
    renderResult(result, options, theme, context) {
      const details = getResultDetails(result);
      const view = databaseListView(
        Array.isArray(details.databases) ? details.databases as string[] : [],
        typeof details.source === "string" ? details.source : "",
        typeof details.dialect === "string" ? details.dialect : "",
        details.truncated === true
      );
      return new MetadataResultComponent(view, result, context.isError, options.expanded, createQueryViewTheme(theme));
    }
  });

  pi.registerTool({
    name: "database_list_tables",
    outputSchema: DATABASE_OUTPUT_SCHEMAS.database_list_tables,
    label: "Database List Tables",
    description: "List tables in a database source.",
    promptSnippet: "List tables in one database through a configured source",
    promptGuidelines: [
      "Use database_list_tables when the user asks for tables and the database is known; pass database when the source has no default database."
    ],
    parameters: ListTablesParams,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const input = params as { source?: string; dialect?: string; database?: string };
      const source = resolveCurrentSource(ctx, input.source, input.dialect);
      const result = await adapterFor(source).listTables(source, input.database ?? String(source.options.database ?? ""), signal);
      return makeResult(result);
    },
    renderCall(args, theme, context) {
      const source = callSource(args, context.cwd);
      return renderDatabaseCall("Database Tables", source, [callString(args, "database") ?? source.database ?? ""], theme, context);
    },
    renderResult(result, options, theme, context) {
      const details = getResultDetails(result);
      const view = Object.keys(details).length > 0 ? tableListView(details as never) : {};
      return new MetadataResultComponent(view, result, context.isError, options.expanded, createQueryViewTheme(theme));
    }
  });

  pi.registerTool({
    name: "database_search_tables",
    outputSchema: DATABASE_OUTPUT_SCHEMAS.database_search_tables,
    label: "Database Search Tables",
    description: "Search table names and comments across one configured source.",
    promptSnippet: "Find likely tables by name or comment before writing SQL",
    promptGuidelines: [
      "Use database_search_tables when the user gives a business term or the target table is unknown; do not guess table names in database_query.",
      "Pass database to database_search_tables when the search should stay inside one database."
    ],
    parameters: SearchTablesParams,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const input = params as { source?: string; dialect?: string; term: string; database?: string };
      const source = resolveCurrentSource(ctx, input.source, input.dialect);
      const result = await adapterFor(source).searchTables(source, input.term, input.database, signal);
      return makeResult(result);
    },
    renderCall(args, theme, context) {
      const source = callSource(args, context.cwd);
      return renderDatabaseCall("Database Find tables", source, [callString(args, "database") ?? "", callString(args, "term") ?? ""], theme, context);
    },
    renderResult(result, options, theme, context) {
      const details = getResultDetails(result);
      const view = Object.keys(details).length > 0 ? tableSearchView(details as never) : {};
      return new MetadataResultComponent(view, result, context.isError, options.expanded, createQueryViewTheme(theme));
    }
  });

  pi.registerTool({
    name: "database_describe_table",
    outputSchema: DATABASE_OUTPUT_SCHEMAS.database_describe_table,
    label: "Database Describe Table",
    description: "Describe columns, indexes, engine, and create statement for one table.",
    promptSnippet: "Inspect a table's columns and schema before querying or changing it",
    promptGuidelines: [
      "Use database_describe_table before database_query or database_write when exact table columns or schema are unknown."
    ],
    parameters: DescribeTableParams,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const input = params as { source?: string; dialect?: string; database: string; table: string };
      const source = resolveCurrentSource(ctx, input.source, input.dialect);
      const result = await adapterFor(source).describeTable(source, input.database, input.table, signal);
      return makeResult(result);
    },
    renderCall(args, theme, context) {
      const source = callSource(args, context.cwd);
      const target = [callString(args, "database"), callString(args, "table")].filter(Boolean).join(".");
      return renderDatabaseCall("Database Describe", source, [target], theme, context);
    },
    renderResult(result, options, theme, context) {
      const details = getResultDetails(result);
      const view = Object.keys(details).length > 0 ? tableDescriptionView(details as never) : {};
      return new MetadataResultComponent(view, result, context.isError, options.expanded, createQueryViewTheme(theme));
    }
  });

  pi.registerTool({
    name: "database_query",
    outputSchema: DATABASE_OUTPUT_SCHEMAS.database_query,
    label: "Database Query",
    description: "Execute one read-only SQL query against a configured source.",
    promptSnippet: "Run a bounded read-only SQL query against a configured MySQL or ClickHouse source",
    promptGuidelines: [
      "Use database_query only for a single read-only SQL query and always pass database."
    ],
    parameters: QueryParams,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const input = params as { source?: string; dialect?: string; database?: string; query: string; max_rows?: number };
      const source = resolveCurrentSource(ctx, input.source, input.dialect);
      const database = typeof input.database === "string" ? input.database.trim() : "";
      if (!database) throw new Error("database_query requires a database argument.");
      onUpdate({ content: [{ type: "text", text: `${formatSqlForUi(input.query)}\n\nRunning...` }] });
      const maxRows = Math.max(1, Math.min(input.max_rows ?? source.maxRows, 500));
      const startedAt = performance.now();
      const result = await adapterFor(source).query(source, database, input.query, maxRows, signal);
      result.elapsed_ms = performance.now() - startedAt;
      return makeResult(result);
    },
    renderResult(result, options, theme, context) {
      if (options.isPartial) {
        const query = isRecord(context.args) && typeof context.args.query === "string" ? context.args.query : "";
        const text = query ? `${highlightCode(formatSqlForUi(query), "sql").join("\n")}\n\n${theme.fg("muted", "Running...")}` : theme.fg("muted", "Running...");
        return new Text(text, 0, 0);
      }
      return new QueryResultComponent(context.args, result, context.isError, options.expanded, createQueryViewTheme(theme));
    },
    renderCall(args, theme, context) {
      const source = callSource(args, context.cwd);
      return renderDatabaseCall("Database Query", source, [callString(args, "database") ?? ""], theme, context);
    }
  });

  pi.registerTool({
    name: "database_write",
    outputSchema: DATABASE_OUTPUT_SCHEMAS.database_write,
    label: "Database Write",
    description: "Execute one supported write statement using the selected source confirmation policy.",
    promptSnippet: "Execute a dialect-specific write (data or schema change) using the selected source policy",
    promptGuidelines: [
      "Use database_write only for an explicit user-requested change after selecting the correct source; never use bash or a local database client as a write fallback.",
      "database_write accepts exactly one supported SQL statement per call. For multi-step operations, use separate calls and handle each result independently; do not submit scripts, semicolon-separated statements, or USE/database-selection statements, and do not assume the sequence is atomic. Pass database instead of USE. It requires database for table-scoped writes; omit database only for CREATE DATABASE and DROP DATABASE. ClickHouse supports standard CREATE MATERIALIZED VIEW ... TO ... AS SELECT or ... ENGINE = ... AS SELECT forms, including ON CLUSTER. MySQL supports CREATE [OR REPLACE] VIEW <view> [(columns)] AS SELECT ... (no ALGORITHM, DEFINER, or SQL SECURITY) and single-object DROP VIEW; CREATE VIEW follows the source write_confirm policy, while CREATE OR REPLACE VIEW always requires forced interactive confirmation. ClickHouse CREATE OR REPLACE materialized-view variants and INSERT ... SELECT (INSERT INTO <table> [(columns)] SELECT ...) require forced interactive confirmation; POPULATE, refreshable/window views, DEFINER, and SQL SECURITY are rejected. It follows the selected source confirmation policy and rejects unsupported SQL. DELETE, TRUNCATE, DROP, RENAME, REPLACE, and destructive ALTER (DROP/MODIFY/CHANGE/RENAME column, etc.) always require interactive confirmation regardless of write_confirm. If blocked_reason is \"source_read_only\" or \"missing_database\", stop and explain the source policy; do not bypass it. If blocked_reason is \"unsupported_statement\", explain the limitation and ask whether to run it through database_usql with confirmation, run it manually, or stop; use database_usql only after explicit user approval. If blocked_reason is \"invalid_statement\", fix the statement shape or ask the user.",
      "If database_write reports outcome unknown after a timeout or lost connection, first use database_query or metadata tools to verify database state; do not retry automatically and never use bash or a database client to bypass policy."
    ],
    parameters: WriteParams,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const input = params as { source?: string; dialect?: string; database?: string; statement: string };
      const source = resolveCurrentSource(ctx, input.source, input.dialect);
      const database = typeof input.database === "string" ? input.database.trim() || undefined : undefined;
      return serializeWrite(source, async () => {
        const adapter = adapterFor(source);
        let write;
        try {
          write = adapter.validateWrite(source, input.statement);
        } catch (error) {
          if (!(error instanceof DatabasePolicyError)) throw error;
          const result: WriteResult = {
            source: source.name,
            dialect: source.dialect,
            executed: false,
            cancelled: false,
            blocked: true,
            blocked_reason: error.reason,
            statement_kind: "unknown",
            allow_write: source.allowWrite,
            write_confirm: source.writeConfirm,
            database,
            requested_statement: input.statement,
            reason: error.message,
            next_action: blockedWriteNextAction(error.reason)
          };
          return makeResult(result, formatWrite(result));
        }
        if (write.databaseRequired && !database) {
          const result: WriteResult = {
            source: source.name,
            dialect: source.dialect,
            executed: false,
            cancelled: false,
            blocked: true,
            blocked_reason: "missing_database",
            statement_kind: write.statementKind,
            allow_write: source.allowWrite,
            write_confirm: source.writeConfirm,
            requested_statement: write.statement,
            reason: "database_write requires a database argument for this statement.",
            next_action: "Pass database for this table-scoped write. CREATE DATABASE and DROP DATABASE are the only supported writes that omit database; do not use database_usql to bypass this requirement."
          };
          return makeResult(result, formatWrite(result));
        }
        const forcedConfirm = requiresForcedConfirmation(write);
        const confirmationRequired = source.writeConfirm || forcedConfirm;
        const trustedForSession = isWriteSourceTrusted(source, database);
        let sessionTrustUsed = false;
        if (confirmationRequired && !trustedForSession) {
          const confirmation = buildWriteConfirmation(source, write, database);
          const decision = await confirmSqlStatement(ctx, {
            title: confirmation.title,
            fields: [
              { label: "Source", value: confirmation.source, color: "accent" },
              { label: "Dialect", value: confirmation.dialect, color: "muted" },
              ...(confirmation.database ? [{ label: "Database", value: confirmation.database, color: "muted" }] : []),
              { label: "Action", value: confirmation.action, color: "warning" }
            ],
            sql: confirmation.sql,
            message: confirmation.message
          }, {
            allowSessionTrust: true,
            sessionTrustLabel: database ? `this database (${database}) for this session` : "this source for this session"
          });
          if (decision === undefined) {
            const result: WriteResult = {
              source: source.name,
              dialect: source.dialect,
              executed: false,
              cancelled: false,
              blocked_reason: "confirmation_required",
              statement_kind: write.statementKind,
              write_confirm: true,
              forced_confirm: forcedConfirm || undefined,
              database,
              requested_statement: write.statement,
              reason: "Interactive confirmation is required; no write was executed."
            };
            return makeResult(result, formatWrite(result));
          }
          if (decision === "cancel") {
            const result: WriteResult = {
              source: source.name,
              dialect: source.dialect,
              executed: false,
              cancelled: true,
              blocked_reason: "cancelled",
              statement_kind: write.statementKind,
              write_confirm: true,
              forced_confirm: forcedConfirm || undefined,
              database,
              requested_statement: write.statement
            };
            return makeResult(result, formatWrite(result));
          }
          if (decision === "session") {
            trustWriteSource(source, database);
            sessionTrustUsed = true;
            refreshTrustStatus(ctx);
          }
        }
        onUpdate({ content: [{ type: "text", text: `Writing to ${database ? `${source.name}.${database}` : source.name}...` }] });
        try {
          const result: WriteResult = {
            ...(await adapter.write(source, database, write, signal)),
            ...(sessionTrustUsed || (trustedForSession && confirmationRequired) ? { trusted_for_session: true } : {}),
            write_confirm: source.writeConfirm,
            forced_confirm: forcedConfirm || undefined,
            requested_statement: write.statement
          };
          return makeResult(result, formatWrite(result));
        } catch (error) {
          if (!isUncertainWriteError(error)) throw error;
          const result: WriteResult = {
            source: source.name,
            dialect: source.dialect,
            executed: false,
            cancelled: false,
            statement_kind: write.statementKind,
            write_confirm: source.writeConfirm,
            forced_confirm: forcedConfirm || undefined,
            database,
            requested_statement: write.statement,
            outcome: "unknown",
            reason: error instanceof Error ? error.message : String(error),
            next_action: "Write outcome is unknown. First use database_query or database_list_tables to verify the database state before any further action. Do not retry this write automatically."
          };
          return makeResult(result, formatWrite(result));
        }
      });
    },
    renderCall(args, theme, context) {
      const source = callSource(args, context.cwd);
      const statement = callString(args, "statement") ?? "";
      return renderDatabaseCall("Database Write", source, [callString(args, "database") ?? "", firstKeyword(statement) ?? "SQL"], theme, context);
    },
    renderResult(result, options, theme, context) {
      const parsedDetails = getResultDetails(result);
      const details = Object.keys(parsedDetails).length > 0 ? parsedDetails as WriteResult : undefined;
      if (context.isError || !details) {
        const text = context.isError ? String(result.content?.[0]?.text ?? "Write failed") : "Write completed";
        return new Text(theme.fg(writeResultColor(details, context.isError), text), 0, 0);
      }
      if (details.executed || details.cancelled) return createWriteResultComponent(details, options.expanded, theme);
      return new Text(theme.fg(writeResultColor(details, false), formatWrite(details)), 0, 0);
    }
  });

  pi.registerTool({
    name: USQL_TOOL_NAME,
    outputSchema: DATABASE_OUTPUT_SCHEMAS.database_usql,
    label: "Database usql",
    description: "Execute one SQL statement or usql meta-command through the local usql binary against any supported database. Always asks for confirmation.",
    promptSnippet: "Run a statement through usql for an unconfigured database or a statement database_write rejects as unsupported",
    promptGuidelines: [
      "Use database_usql only when database_query, database_write, and the metadata tools cannot do the job: the target dialect is not MySQL or ClickHouse, the connection is not in .pi/databases.json, a usql meta-command is required, or database_write returned blocked_reason \"unsupported_statement\" and the user explicitly approved running the statement through usql. Prefer the configured database_* tools in every other case. Never use database_usql to bypass blocked_reason \"source_read_only\" or \"missing_database\".",
      "database_usql runs outside every configured source policy unless source is supplied: with source, writes require that source's allow_write; write_confirm and the database_write statement allowlist still do not apply. Only the interactive confirmation stands between the statement and the database, so read it carefully before approving. Never use database_usql to bypass blocked_reason \"source_read_only\".",
      "database_usql accepts exactly one statement or meta-command per call. It always asks for confirmation, returns cancelled when you decline, and never retries on its own. Never run usql, psql, mysql, or another database client through bash as a fallback.",
      "If database_usql reports an error after a timeout or a lost connection, the outcome is unknown: inspect the database state with the appropriate tools before doing anything else, and never retry automatically."
    ],
    parameters: UsqlParams,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const input = params as { connection?: string; source?: string; statement?: string; max_rows?: number; timeout_ms?: number };
      const connection = typeof input.connection === "string" ? input.connection.trim() : "";
      const statement = typeof input.statement === "string" ? input.statement.trim() : "";
      if (!connection) throw new Error("database_usql requires a connection argument.");
      if (!statement) throw new Error("database_usql requires a statement argument.");

      const redacted = redactConnection(connection);
      const kind = statementKind(statement);
      const policySource = typeof input.source === "string" && input.source.trim()
        ? resolveCurrentSource(ctx, input.source)
        : undefined;
      const policyWrites = policySource ? usqlStatementWrites(statement, kind) : false;
      const base: UsqlResult = {
        tool: USQL_TOOL_NAME,
        connection: redacted,
        ...(connectionScheme(connection) ? { driver: connectionScheme(connection) } : {}),
        ...(policySource ? { source: policySource.name, allow_write: policySource.allowWrite } : {}),
        statement_kind: kind,
        executed: false,
        requested_statement: statement
      };

      if (policySource && policyWrites && !policySource.allowWrite) {
        const result: UsqlResult = {
          ...base,
          blocked: true,
          blocked_reason: "source_read_only",
          error: `Writes are disabled for source "${policySource.name}".`,
          next_action: "Use a writable source, or omit source only when the target is not a configured source."
        };
        return makeResult(result, formatUsql(result));
      }

      const binary = resolveUsqlBinary();
      if (!binary) {
        const result: UsqlResult = {
          ...base,
          error: "The usql binary was not found on PATH.",
          next_action: "Install usql, or set PI_DATABASE_USQL_BIN to its full path, then call database_usql again."
        };
        return makeResult(result, formatUsql(result));
      }

      const decision = await confirmSqlStatement(ctx, buildUsqlConfirmation(connection, statement, policySource));
      if (decision === undefined) {
        const result: UsqlResult = {
          ...base,
          reason: "Interactive confirmation is required; no statement was executed."
        };
        return makeResult(result, formatUsql(result));
      }
      if (decision === "cancel") {
        const result: UsqlResult = { ...base, cancelled: true, confirmed: false };
        return makeResult(result, formatUsql(result));
      }

      const maxRows = Math.max(1, Math.min(input.max_rows ?? USQL_DEFAULT_MAX_ROWS, USQL_MAX_ROWS_LIMIT));
      const timeoutMs = Math.max(1000, Math.min(input.timeout_ms ?? USQL_DEFAULT_TIMEOUT_MS, USQL_MAX_TIMEOUT_MS));
      const startedAt = performance.now();
      onUpdate({ content: [{ type: "text", text: `${formatSqlForUi(statement)}\n\nRunning via usql...` }] });
      try {
        const run: UsqlRunResult = await runUsqlStatement({ binary, connection, statement, maxRows, timeoutMs, signal, cwd: getContextCwd(ctx) });
        const result: UsqlResult = {
          ...base,
          confirmed: true,
          executed: true,
          ...(run.columns ? { columns: run.columns } : {}),
          ...(run.rows ? { rows: run.rows } : {}),
          row_count: run.row_count,
          truncated: run.truncated,
          warnings: run.warnings,
          elapsed_ms: performance.now() - startedAt,
          ...(run.output ? { output: run.output } : {}),
          ...(run.stderr ? { stderr: run.stderr } : {}),
          exit_code: run.exit_code
        };
        if (run.exit_code !== 0) {
          result.executed = false;
          result.error = run.stderr || `usql exited with code ${run.exit_code}.`;
          if (!USQL_READ_KINDS.has(kind)) {
            result.next_action = "The statement may have partially applied. Inspect the database state before any further action and do not retry automatically.";
          }
        }
        return makeResult(result, formatUsql(result));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const result: UsqlResult = { ...base, confirmed: true, error: message };
        if (!USQL_READ_KINDS.has(kind) && isUncertainWriteError(error)) {
          result.next_action = "The statement outcome is unknown. Inspect the database state before any further action and do not retry automatically.";
        }
        return makeResult(result, formatUsql(result));
      }
    },
    renderCall(args, theme, context) {
      const connection = callString(args, "connection");
      const statement = callString(args, "statement") ?? "";
      return renderDatabaseCall(
        "Database usql",
        { name: connection ? redactConnection(connection) : undefined, dialect: connection ? connectionScheme(connection) : undefined },
        [statementKind(statement).toUpperCase()],
        theme,
        context
      );
    },
    renderResult(result, options, theme, context) {
      const parsedDetails = getResultDetails(result);
      const details = Object.keys(parsedDetails).length > 0 ? (parsedDetails as UsqlResult) : undefined;
      if (!details) {
        return new Text(theme.fg(context.isError ? "error" : "toolOutput", getResultText(result).trim() || "usql completed"), 0, 0);
      }
      return createUsqlResultComponent(details, context.isError, options.expanded, createQueryViewTheme(theme));
    }
  });
}
