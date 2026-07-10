import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { clickhouseAdapter } from "./src/clickhouse.js";
import {
  buildDatabaseContextPrompt,
  findProjectConfigPath,
  getContextCwd,
  initializeProjectConfig,
  loadProjectConfig,
  migrateLegacyProjectConfig,
  selectSource
} from "./src/config.js";
import { mysqlAdapter } from "./src/mysql.js";
import { DatabasePolicyError } from "./src/types.js";
import type { DatabaseAdapter, ResolvedSource, WriteResult } from "./src/types.js";

const adapters: Record<ResolvedSource["dialect"], DatabaseAdapter> = {
  mysql: mysqlAdapter,
  clickhouse: clickhouseAdapter
};

let writeQueue: Promise<void> = Promise.resolve();

const SourceParams = Type.Object({
  source: Type.Optional(Type.String({ description: "Configured database source name" }))
});

const ListTablesParams = Type.Object({
  source: Type.Optional(Type.String({ description: "Configured database source name" })),
  database: Type.Optional(Type.String({ description: "Database name; defaults to the source database" }))
});

const QueryParams = Type.Object({
  source: Type.Optional(Type.String({ description: "Configured database source name" })),
  query: Type.String({ description: "Single read-only SQL statement" }),
  max_rows: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, description: "Maximum returned rows; default 100" }))
});

const WriteParams = Type.Object({
  source: Type.Optional(Type.String({ description: "Configured database source name" })),
  statement: Type.String({ description: "Single supported write statement. Execution always requires user confirmation." })
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function adapterFor(source: ResolvedSource): DatabaseAdapter {
  return adapters[source.dialect];
}

function makeResult(details: unknown, text = JSON.stringify(details, null, 2)) {
  return { content: [{ type: "text" as const, text }], details };
}

function sourceDetails(source: ResolvedSource, isDefault: boolean) {
  const host = typeof source.options.host === "string" ? source.options.host : undefined;
  const url = typeof source.options.url === "string" ? source.options.url : undefined;
  const database = typeof source.options.database === "string" ? source.options.database : undefined;
  return {
    name: source.name,
    dialect: source.dialect,
    default: isDefault,
    host: host ?? url,
    database,
    allow_write_access: source.allowWriteAccess
  };
}

function formatSources(details: { config_path: string; sources: ReturnType<typeof sourceDetails>[] }): string {
  const lines = [`Sources: ${details.sources.length}`];
  for (const source of details.sources) {
    const address = [source.host, source.database].filter(Boolean).join(" / ");
    lines.push(`- ${source.name}${source.default ? " (default)" : ""}: ${source.dialect}${address ? ` | ${address}` : ""}`);
  }
  return lines.join("\n");
}

function formatQuery(details: Record<string, unknown>): string {
  const source = typeof details.source === "string" ? details.source : "database";
  const dialect = typeof details.dialect === "string" ? details.dialect : "";
  const rows = typeof details.row_count === "number" ? details.row_count : 0;
  const truncated = details.truncated === true ? " (truncated)" : "";
  return `${source} (${dialect})\nRows: ${rows}${truncated}`;
}

function writeResultColor(details: WriteResult | undefined, isError: boolean): "error" | "warning" | "toolOutput" {
  if (isError) return "error";
  return details?.blocked === true ? "warning" : "toolOutput";
}

function formatWrite(details: WriteResult): string {
  if (details.cancelled) return `${details.source} (${details.dialect})\nWrite cancelled`;
  if (details.blocked) {
    return `${details.source} (${details.dialect})\nWrite blocked: ${details.reason ?? "Current policy does not allow this statement."}\n${details.next_action ?? "Explain the policy and ask the user what to do next."}`;
  }
  if (!details.executed) return `${details.source} (${details.dialect})\n${details.reason ?? "Write not executed"}`;
  const lines = [`${details.source} (${details.dialect})`, `${details.statement_kind.toUpperCase()} executed`];
  if (typeof details.affected_rows === "number") lines.push(`Affected rows: ${details.affected_rows}`);
  if (typeof details.changed_rows === "number") lines.push(`Changed rows: ${details.changed_rows}`);
  if (typeof details.insert_id === "number" && details.insert_id !== 0) lines.push(`Insert ID: ${details.insert_id}`);
  if (typeof details.query_id === "string") lines.push(`Query ID: ${details.query_id}`);
  return lines.join("\n");
}

function serializeWrite<T>(task: () => Promise<T>): Promise<T> {
  const next = writeQueue.then(task, task);
  writeQueue = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

async function confirmWrite(ctx: unknown, title: string, message: string): Promise<boolean | undefined> {
  if (!isRecord(ctx) || ctx.hasUI !== true || !isRecord(ctx.ui) || typeof ctx.ui.confirm !== "function") return undefined;
  return (ctx.ui.confirm as (title: string, message: string) => Promise<boolean> | boolean)(title, message);
}

function resolveCurrentSource(ctx: unknown, requested?: string): ResolvedSource {
  const config = loadProjectConfig(getContextCwd(ctx));
  return selectSource(config, requested);
}

function registerCommands(pi: ExtensionAPI): void {
  pi.registerCommand("database-init", {
    description: "Create a version 1 multi-source .pi/databases.json template",
    handler: async (_args, ctx) => {
      const result = initializeProjectConfig(getContextCwd(ctx));
      if (result.created) {
        ctx.ui.notify(`Created ${result.configPath}`, "info");
        return;
      }
      ctx.ui.notify(`${result.reason} Using ${result.configPath}`, "warning");
    }
  });

  pi.registerCommand("database-migrate", {
    description: "Convert a legacy single-connection databases.json to the version 1 source format",
    handler: async (_args, ctx) => {
      const configPath = findProjectConfigPath(getContextCwd(ctx));
      if (!configPath) {
        ctx.ui.notify("No database config found. Run /database-init first.", "warning");
        return;
      }
      if (ctx.hasUI !== true) {
        ctx.ui.notify("Interactive confirmation is required to migrate database config.", "warning");
        return;
      }
      const confirmed = await ctx.ui.confirm("Migrate database config", `Convert ${configPath} to version 1 multi-source format?`);
      if (!confirmed) return;
      const result = migrateLegacyProjectConfig(getContextCwd(ctx));
      ctx.ui.notify(result.migrated ? `Migrated ${result.configPath}` : result.reason ?? "No migration performed.", result.migrated ? "info" : "warning");
    }
  });
}

function registerTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "database_list_sources",
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
      const details = {
        config_path: config.configPath,
        sources: config.sources.map((source) => sourceDetails(source, source.name === config.defaultSource))
      };
      return makeResult(details, formatSources(details));
    }
  });

  pi.registerTool({
    name: "database_ping",
    label: "Database Ping",
    description: "Verify that a configured database source is reachable.",
    promptSnippet: "Check connectivity for a configured database source",
    promptGuidelines: [
      "Use database_ping when the user asks whether a configured MySQL or ClickHouse source is reachable."
    ],
    parameters: SourceParams,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const source = resolveCurrentSource(ctx, (params as { source?: string }).source);
      return makeResult(await adapterFor(source).ping(source, signal));
    }
  });

  pi.registerTool({
    name: "database_list_databases",
    label: "Database List Databases",
    description: "List databases visible to a configured source.",
    promptSnippet: "List databases visible through a configured MySQL or ClickHouse source",
    promptGuidelines: [
      "Use database_list_databases when the user asks which databases exist or are visible on a configured source.",
      "For requests such as 'current MySQL data sources有哪些数据库', use database_list_databases rather than searching for a local client."
    ],
    parameters: SourceParams,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const source = resolveCurrentSource(ctx, (params as { source?: string }).source);
      const databases = await adapterFor(source).listDatabases(source, signal);
      return makeResult({ source: source.name, dialect: source.dialect, databases }, `Databases: ${databases.length}\n${databases.map((database) => `- ${database}`).join("\n")}`);
    }
  });

  pi.registerTool({
    name: "database_list_tables",
    label: "Database List Tables",
    description: "List tables in a database source.",
    promptSnippet: "List tables in one database through a configured source",
    promptGuidelines: [
      "Use database_list_tables when the user asks for tables and the database is known; pass database when the source has no default database."
    ],
    parameters: ListTablesParams,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const input = params as { source?: string; database?: string };
      const source = resolveCurrentSource(ctx, input.source);
      const result = await adapterFor(source).listTables(source, input.database ?? String(source.options.database ?? ""), signal);
      return makeResult(result, `${result.source} (${result.dialect})\nDatabase: ${result.database}\nTables: ${result.tables.length}`);
    }
  });

  pi.registerTool({
    name: "database_query",
    label: "Database Query",
    description: "Execute one read-only SQL query against a configured source.",
    promptSnippet: "Run a bounded read-only SQL query against a configured MySQL or ClickHouse source",
    promptGuidelines: [
      "Use database_query for configured MySQL or ClickHouse data requests instead of shelling out to a local database client.",
      "Use database_list_sources before database_query when the intended source is not already known, and database_list_tables before guessing table or column names.",
      "database_query is read-only. Use database_write only for an explicit user-requested allowed change."
    ],
    parameters: QueryParams,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const input = params as { source?: string; query: string; max_rows?: number };
      const source = resolveCurrentSource(ctx, input.source);
      onUpdate({ content: [{ type: "text", text: `Querying ${source.name}...` }] });
      const maxRows = Math.max(1, Math.min(input.max_rows ?? 100, 500));
      const result = await adapterFor(source).query(source, input.query, maxRows, signal);
      return makeResult(result, formatQuery(result));
    },
    renderResult(result, _options, theme, context) {
      const details = isRecord(result.details) ? result.details : {};
      return new Text(theme.fg(context.isError ? "error" : "toolOutput", context.isError ? String(result.content?.[0]?.text ?? "Query failed") : formatQuery(details)), 0, 0);
    }
  });

  pi.registerTool({
    name: "database_write",
    label: "Database Write",
    description: "Execute one supported write statement after interactive user confirmation.",
    promptSnippet: "Execute one confirmed, dialect-specific data or additive schema change on a configured source",
    promptGuidelines: [
      "Use database_write only for an explicit user-requested change after selecting the correct source; never use bash or a local database client as a write fallback.",
      "database_write always prompts the user to confirm and rejects destructive, delete, replacement, rename, multi-statement, and unsupported SQL. If it returns blocked, stop and explain the selected source policy to the user.",
      "Do not retry database_write after a timeout or lost connection without first checking the database, and never use bash or a database client to bypass a blocked result."
    ],
    parameters: WriteParams,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const input = params as { source?: string; statement: string };
      return serializeWrite(async () => {
        const source = resolveCurrentSource(ctx, input.source);
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
            statement_kind: "unknown",
            allow_write_access: source.allowWriteAccess,
            requested_statement: input.statement,
            reason: error.message,
            next_action: "Stop. Explain this source policy to the user and ask what they want to do next. Do not use bash, a database client, or config edits to bypass it."
          };
          return makeResult(result, formatWrite(result));
        }
        const confirmed = await confirmWrite(
          ctx,
          `Confirm ${source.dialect} ${write.statementKind}`,
          `Source: ${source.name}\nDialect: ${source.dialect}\n\n${write.statement}\n\nExecute this statement?`
        );
        if (confirmed === undefined) {
          const result: WriteResult = {
            source: source.name,
            dialect: source.dialect,
            executed: false,
            cancelled: false,
            statement_kind: write.statementKind,
            reason: "Interactive confirmation is required; no write was executed."
          };
          return makeResult(result, formatWrite(result));
        }
        if (!confirmed) {
          const result: WriteResult = {
            source: source.name,
            dialect: source.dialect,
            executed: false,
            cancelled: true,
            statement_kind: write.statementKind
          };
          return makeResult(result, formatWrite(result));
        }
        onUpdate({ content: [{ type: "text", text: `Writing to ${source.name}...` }] });
        const result = await adapter.write(source, write, signal);
        return makeResult(result, formatWrite(result));
      });
    },
    renderResult(result, _options, theme, context) {
      const details = isRecord(result.details) ? result.details as WriteResult : undefined;
      const text = context.isError ? String(result.content?.[0]?.text ?? "Write failed") : details ? formatWrite(details) : "Write completed";
      return new Text(theme.fg(writeResultColor(details, context.isError), text), 0, 0);
    }
  });
}

export default function databaseExtension(pi: ExtensionAPI) {
  registerCommands(pi);
  registerTools(pi);

  pi.on("before_agent_start", async (event, ctx) => {
    const prompt = buildDatabaseContextPrompt(event.cwd ?? getContextCwd(ctx));
    return prompt ? { systemPrompt: `${event.systemPrompt}\n\n${prompt}` } : undefined;
  });

  pi.on("session_start", async (_event, ctx) => {
    try {
      const config = loadProjectConfig(getContextCwd(ctx));
      ctx.ui.setStatus("pi-database", `database: ${config.sources.length} source${config.sources.length === 1 ? "" : "s"}`);
    } catch {
      ctx.ui.setStatus("pi-database", "database: no config");
    }
  });

  pi.on("session_shutdown", async () => {
    await Promise.all([mysqlAdapter.close(), clickhouseAdapter.close()]);
  });
}

export const __test__ = {
  registerCommands,
  registerTools,
  writeResultColor
};
