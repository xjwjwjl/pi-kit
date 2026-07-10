import { highlightCode, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import type { Component } from "@mariozechner/pi-tui";
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

const writeQueues = new Map<string, Promise<void>>();

const SourceParams = Type.Object({
  source: Type.Optional(Type.String({ description: "Configured database source name" }))
});

const ListTablesParams = Type.Object({
  source: Type.Optional(Type.String({ description: "Configured database source name" })),
  database: Type.Optional(Type.String({ description: "Database name; defaults to the source database" }))
});

const SearchTablesParams = Type.Object({
  source: Type.Optional(Type.String({ description: "Configured database source name" })),
  term: Type.String({ description: "Case-insensitive table name or comment search text" }),
  database: Type.Optional(Type.String({ description: "Optional database filter" }))
});

const DescribeTableParams = Type.Object({
  source: Type.Optional(Type.String({ description: "Configured database source name" })),
  database: Type.String({ description: "Database containing the table" }),
  table: Type.String({ description: "Table to describe" })
});

const QueryParams = Type.Object({
  source: Type.Optional(Type.String({ description: "Configured database source name" })),
  query: Type.String({ description: "Single read-only SQL statement" }),
  max_rows: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, description: "Maximum returned rows; defaults to the selected source max_rows" }))
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
    allow_write_access: source.allowWriteAccess,
    query_timeout_ms: source.queryTimeoutMs,
    max_rows: source.maxRows
  };
}

function splitTopLevelCommaList(value: string): string[] {
  const items: string[] = [];
  let current = "";
  let depth = 0;
  let quote: "'" | '"' | "`" | null = null;

  for (let index = 0; index < value.length; index++) {
    const char = value[index]!;
    const previous = value[index - 1];
    if (quote) {
      current += char;
      if (char === quote && previous !== "\\") quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      current += char;
      continue;
    }
    if (char === "(") depth++;
    else if (char === ")" && depth > 0) depth--;
    if (char === "," && depth === 0) {
      items.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) items.push(current.trim());
  return items;
}

function formatSqlForUi(query: string): string {
  let formatted = query.trim()
    .replace(/\s+/g, " ")
    .replace(/\b(FROM)\b/gi, "\n$1")
    .replace(/\b(WHERE)\b/gi, "\n$1")
    .replace(/\b((?:LEFT|RIGHT|INNER|FULL|CROSS)\s+JOIN)\b/gi, "\n$1")
    .replace(/\b(JOIN)\b/gi, "\n$1")
    .replace(/\b(ON)\b/gi, "\n  $1")
    .replace(/\b(AND)\b/gi, "\n  $1")
    .replace(/\b(OR)\b/gi, "\n  $1")
    .replace(/\b(GROUP\s+BY)\b/gi, "\n$1")
    .replace(/\b(ORDER\s+BY)\b/gi, "\n$1")
    .replace(/\b(LIMIT)\b/gi, "\n$1")
    .replace(/\b(SETTINGS)\b/gi, "\n$1");

  formatted = formatted.replace(/^SELECT\s+([\s\S]*?)\nFROM\b/i, (_match, selectList: string) => {
    const columns = splitTopLevelCommaList(selectList);
    return columns.length <= 1 ? `SELECT ${selectList}\nFROM` : `SELECT\n  ${columns.join(",\n  ")}\nFROM`;
  });
  return formatted.split("\n").map((line) => line.trimEnd()).join("\n").trim();
}

function getResultText(result: { content?: unknown }): string {
  const text = Array.isArray(result.content) ? result.content.find((item): item is { type: string; text: string } => isRecord(item) && item.type === "text") : undefined;
  return isRecord(text) && typeof text.text === "string" ? text.text : "";
}

type QueryViewTheme = {
  output: (text: string) => string;
  muted: (text: string) => string;
  accent: (text: string) => string;
  border: (text: string) => string;
  error: (text: string) => string;
  number: (text: string) => string;
  nullValue: (text: string) => string;
  empty: (text: string) => string;
  sql: (text: string) => string[];
};

function createQueryViewTheme(theme: { fg(color: string, text: string): string }): QueryViewTheme {
  return {
    output: (text) => theme.fg("toolOutput", text),
    muted: (text) => theme.fg("muted", text),
    accent: (text) => theme.fg("accent", text),
    border: (text) => theme.fg("borderMuted", text),
    error: (text) => theme.fg("error", text),
    number: (text) => theme.fg("syntaxNumber", text),
    nullValue: (text) => theme.fg("dim", text),
    empty: (text) => theme.fg("muted", text),
    sql: (text) => highlightCode(text, "sql")
  };
}

function formatCell(value: unknown): string {
  if (value === null) return "NULL";
  if (value === undefined) return "—";
  if (typeof value === "string") return value === "" ? '""' : JSON.stringify(value).slice(1, -1);
  if (typeof value === "object") return JSON.stringify(value) ?? String(value);
  return String(value);
}

function fitCell(value: string, width: number, alignRight = false): string {
  const clipped = truncateToWidth(value, width, "…");
  const padding = " ".repeat(Math.max(0, width - visibleWidth(clipped)));
  return alignRight ? `${padding}${clipped}` : `${clipped}${padding}`;
}

function isNumericValue(value: unknown): boolean {
  return typeof value === "number" || typeof value === "bigint" || (typeof value === "string" && /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value));
}

function styleCell(value: unknown, cell: string, theme: QueryViewTheme): string {
  if (value === null) return theme.nullValue(cell);
  if (value === "") return theme.empty(cell);
  if (isNumericValue(value)) return theme.number(cell);
  return theme.output(cell);
}

function formatElapsed(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${value.toFixed(1)} ms`;
}

function tableListView(result: { source: string; dialect: string; database: string; tables: string[]; truncated: boolean }): Record<string, unknown> {
  return {
    source: result.source,
    dialect: result.dialect,
    label: result.database,
    count_label: `${result.tables.length} tables`,
    truncated: result.truncated,
    warnings: [],
    columns: ["table"],
    rows: result.tables.map((table) => [table])
  };
}

function tableSearchView(result: { source: string; dialect: string; matches: Array<{ database: string; table: string; type?: string; engine?: string; comment?: string | null }>; truncated: boolean }): Record<string, unknown> {
  return {
    source: result.source,
    dialect: result.dialect,
    count_label: `${result.matches.length} matches`,
    truncated: result.truncated,
    warnings: [],
    columns: ["database", "table", "type", "engine", "comment"],
    rows: result.matches.map((match) => [match.database, match.table, match.type ?? null, match.engine ?? null, match.comment ?? null])
  };
}

function databaseListView(databases: string[], source: string, dialect: string): Record<string, unknown> {
  return {
    source,
    dialect,
    count_label: `${databases.length} databases`,
    truncated: false,
    warnings: [],
    columns: ["database"],
    rows: databases.map((db) => [db])
  };
}

function sourceListView(details: { config_path: string; sources: ReturnType<typeof sourceDetails>[] }): Record<string, unknown> {
  return {
    label: `config: ${details.config_path}`,
    count_label: `${details.sources.length} sources`,
    columns: ["source", "dialect", "host", "database", "default", "write"],
    rows: details.sources.map((s) => [s.name, s.dialect, s.host ?? "—", s.database ?? "—", s.default ? "✓" : "—", s.allow_write_access ? "yes" : "no"])
  };
}

function tableDescriptionView(result: {
  source: string;
  dialect: string;
  database: string;
  table: string;
  engine?: string;
  columns: Array<{ name: string; type: string; nullable?: boolean; default?: string | null; comment?: string | null; position?: number }>;
  indexes: Array<{ name: string; columns: string[]; unique?: boolean; type?: string }>;
  create_statement?: string;
  truncated: boolean;
  warnings: string[];
}): Record<string, unknown> {
  return {
    source: result.source,
    dialect: result.dialect,
    label: `${result.database}.${result.table}${result.engine ? ` · ${result.engine}` : ""}`,
    count_label: `${result.columns.length} columns · ${result.indexes.length} indexes`,
    truncated: result.truncated,
    warnings: result.warnings,
    columns: ["#", "name", "type", "nullable", "default", "comment"],
    rows: result.columns.map((column) => [column.position ?? null, column.name, column.type, column.nullable === undefined ? null : column.nullable ? "yes" : "no", column.default ?? null, column.comment ?? null]),
    indexes: result.indexes,
    create_statement: result.create_statement
  };
}

function allocateColumnWidths(columns: string[], rows: unknown[][], width: number): number[] | undefined {
  if (columns.length === 0 || columns.length > 8 || width < 40) return undefined;
  const separatorWidth = Math.max(0, columns.length - 1) * 3;
  const natural = columns.map((column, columnIndex) => Math.min(32, Math.max(
    visibleWidth(column),
    ...rows.map((row) => visibleWidth(formatCell(row[columnIndex])))
  )));
  const widths = natural.map((columnWidth) => Math.min(columnWidth, 8));
  let remaining = width - separatorWidth - widths.reduce((sum, columnWidth) => sum + columnWidth, 0);
  if (remaining < 0) return undefined;
  while (remaining > 0) {
    let grew = false;
    for (let columnIndex = 0; columnIndex < widths.length && remaining > 0; columnIndex++) {
      if (widths[columnIndex]! >= natural[columnIndex]!) continue;
      widths[columnIndex]!++;
      remaining--;
      grew = true;
    }
    if (!grew) break;
  }
  return widths;
}

function renderQueryData(details: Record<string, unknown>, expanded: boolean, width: number, theme?: QueryViewTheme): string[] {
  const t = theme ?? { output: (text: string) => text, muted: (text: string) => text, accent: (text: string) => text, border: (text: string) => text, error: (text: string) => text, number: (text: string) => text, nullValue: (text: string) => text, empty: (text: string) => text, sql: (text: string) => text.split("\n") };
  const columns = Array.isArray(details.columns) ? details.columns.filter((column): column is string => typeof column === "string") : [];
  const rows = Array.isArray(details.rows) ? details.rows.filter((row): row is unknown[] => Array.isArray(row)) : [];
  if (columns.length === 0) return [];
  if (rows.length === 0) return [t.muted("No rows returned.")];

  const tableRows = expanded ? rows : rows.slice(0, 10);
  const widths = allocateColumnWidths(columns, tableRows, width);
  const lines: string[] = [];
  if (widths) {
    const separator = t.border(" │ ");
    lines.push(columns.map((column, index) => t.accent(fitCell(column, widths[index]!))).join(separator));
    lines.push(t.border(widths.map((columnWidth) => "─".repeat(columnWidth)).join("─┼─")));
    for (const row of tableRows) {
      lines.push(columns.map((_column, index) => {
        const value = row[index];
        const text = formatCell(value);
        const cell = fitCell(text, widths[index]!, isNumericValue(value));
        return styleCell(value, cell, t);
      }).join(separator));
    }
  } else {
    const recordRows = expanded ? rows : rows.slice(0, 3);
    const labelWidth = Math.min(24, Math.max(1, ...columns.map(visibleWidth)));
    const valueWidth = Math.max(1, width - labelWidth - 3);
    recordRows.forEach((row, rowIndex) => {
      if (rowIndex > 0) lines.push(t.border("─".repeat(Math.min(width, 24))));
      lines.push(t.accent(`#${rowIndex + 1}`));
      columns.forEach((column, columnIndex) => {
        const label = fitCell(column, labelWidth);
        const rawValue = row[columnIndex];
        const value = truncateToWidth(formatCell(rawValue), valueWidth, "…");
        lines.push(`${t.muted(label)} ${t.border("│")} ${styleCell(rawValue, value, t)}`);
      });
    });
  }

  const shownRows = widths ? tableRows.length : (expanded ? rows.length : Math.min(rows.length, 3));
  if (shownRows < rows.length) lines.push(t.muted(`… ${rows.length - shownRows} more rows (expand to view)`));
  return lines;
}

function renderQueryResultLines(
  args: unknown,
  result: { content?: unknown; details?: unknown },
  isError: boolean,
  expanded: boolean,
  width: number,
  theme?: QueryViewTheme
): string[] {
  const t = theme ?? { output: (text: string) => text, muted: (text: string) => text, accent: (text: string) => text, border: (text: string) => text, error: (text: string) => text, number: (text: string) => text, nullValue: (text: string) => text, empty: (text: string) => text, sql: (text: string) => text.split("\n") };
  const safeWidth = Math.max(1, width);
  const query = isRecord(args) && typeof args.query === "string" ? formatSqlForUi(args.query) : "";
  const lines = query
    ? t.sql(query).flatMap((line) => wrapTextWithAnsi(line, safeWidth))
    : [];
  if (isError) {
    if (lines.length) lines.push("");
    return [...lines, ...wrapTextWithAnsi(t.error(`Error: ${getResultText(result).trim() || "Query failed"}`), safeWidth)];
  }

  const details = isRecord(result.details) ? result.details : {};
  const source = typeof details.source === "string" ? details.source : "database";
  const dialect = typeof details.dialect === "string" ? details.dialect : "";
  const rowCount = typeof details.row_count === "number" ? details.row_count : 0;
  const truncated = details.truncated === true ? " · truncated" : "";
  const elapsedText = formatElapsed(details.elapsed_ms);
  const elapsed = elapsedText ? ` · ${elapsedText}` : "";
  if (lines.length) lines.push("");
  const sourceText = `${source} · ${dialect}`;
  const statsText = `${rowCount} rows${elapsed}${truncated}`;
  if (visibleWidth(`${sourceText} · ${statsText}`) <= safeWidth) {
    lines.push(`${t.muted(dialect)}${t.accent(` · ${source}`)}${t.muted(` · ${statsText}`)}`);
  } else {
    lines.push(truncateToWidth(`${t.muted(dialect)}${t.accent(` · ${source}`)}`, safeWidth));
    lines.push(truncateToWidth(t.muted(statsText), safeWidth));
  }
  const warnings = Array.isArray(details.warnings) ? details.warnings.filter((warning): warning is string => typeof warning === "string") : [];
  for (const warning of warnings) lines.push(...wrapTextWithAnsi(t.muted(`Warning: ${warning}`), safeWidth));
  const dataLines = renderQueryData(details, expanded, safeWidth, t);
  if (dataLines.length) lines.push("", ...dataLines);
  return lines.map((line) => truncateToWidth(line, safeWidth));
}

function renderMetadataResultLines(view: Record<string, unknown>, result: { content?: unknown }, isError: boolean, expanded: boolean, width: number, theme: QueryViewTheme): string[] {
  const safeWidth = Math.max(1, width);
  if (isError) return wrapTextWithAnsi(theme.error(`Error: ${getResultText(result).trim() || "Operation failed"}`), safeWidth);

  const source = typeof view.source === "string" && view.source ? view.source : "";
  const dialect = typeof view.dialect === "string" && view.dialect ? view.dialect : "";
  const label = typeof view.label === "string" && view.label ? view.label : "";
  const countLabel = typeof view.count_label === "string" ? view.count_label : "";
  const truncated = view.truncated === true ? " · truncated" : "";

  const headerParts: string[] = [];
  if (dialect) headerParts.push(theme.muted(dialect));
  if (source) {
    const sep = headerParts.length ? " · " : "";
    headerParts.push(`${theme.muted(sep)}${theme.accent(source)}`);
  }
  if (label) {
    const sep = headerParts.length ? " · " : "";
    headerParts.push(theme.muted(`${sep}${label}`));
  }
  if (countLabel) {
    const sep = headerParts.length ? " · " : "";
    headerParts.push(theme.muted(`${sep}${countLabel}`));
  }
  if (truncated) headerParts.push(theme.muted(truncated));

  const plainPrefix = [dialect, source ? ` · ${source}` : "", label ? ` · ${label}` : "", countLabel ? ` · ${countLabel}` : "", truncated].join("");

  const lines = visibleWidth(plainPrefix) <= safeWidth
    ? [headerParts.join("")]
    : [truncateToWidth(`${dialect ? theme.muted(dialect) : ""}${source ? theme.accent(` · ${source}`) : ""}${label ? theme.muted(` · ${label}`) : ""}`, safeWidth), theme.muted(`${countLabel}${truncated}`)];

  const warnings = Array.isArray(view.warnings) ? view.warnings.filter((warning): warning is string => typeof warning === "string") : [];
  for (const warning of warnings) lines.push(...wrapTextWithAnsi(theme.muted(`Warning: ${warning}`), safeWidth));
  const dataLines = renderQueryData(view, expanded, safeWidth, theme);
  if (dataLines.length) lines.push("", ...dataLines);

  if (expanded && Array.isArray(view.indexes)) {
    const indexes = view.indexes.filter(isRecord);
    if (indexes.length) {
      lines.push("", theme.accent("Indexes"));
      for (const index of indexes) {
        const name = typeof index.name === "string" ? index.name : "(unnamed)";
        const columns = Array.isArray(index.columns) ? index.columns.filter((column): column is string => typeof column === "string").join(", ") : "";
        const bits = [index.unique === true ? "unique" : undefined, typeof index.type === "string" ? index.type : undefined].filter(Boolean).join(" · ");
        lines.push(...wrapTextWithAnsi(theme.output(`${name}${bits ? ` (${bits})` : ""}: ${columns}`), safeWidth));
      }
    }
  }

  if (expanded && typeof view.create_statement === "string" && view.create_statement) {
    lines.push("", theme.accent("DDL"), ...theme.sql(view.create_statement).flatMap((line) => wrapTextWithAnsi(line, safeWidth)));
  }
  return lines.map((line) => truncateToWidth(line, safeWidth));
}

class PingResultComponent implements Component {
  private readonly details: Record<string, unknown>;
  private readonly result: { content?: unknown };
  private readonly isError: boolean;
  private readonly theme: QueryViewTheme;

  constructor(details: Record<string, unknown>, result: { content?: unknown }, isError: boolean, theme: QueryViewTheme) {
    this.details = details;
    this.result = result;
    this.isError = isError;
    this.theme = theme;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    if (this.isError) return wrapTextWithAnsi(this.theme.error(`Error: ${getResultText(this.result).trim() || "Ping failed"}`), safeWidth);
    const source = typeof this.details.source === "string" ? this.details.source : "";
    const dialect = typeof this.details.dialect === "string" ? this.details.dialect : "";
    const ok = this.details.ok === true;
    const version = typeof this.details.server_version === "string" ? this.details.server_version : "";
    const database = typeof this.details.current_database === "string" && this.details.current_database ? this.details.current_database : null;
    const status = ok ? this.theme.accent("connected") : this.theme.error("unreachable");
    const versionSuffix = version ? ` · ${version}` : "";
    const dbLine = database ? this.theme.muted(`current database: ${database}`) : "";
    const lines = [truncateToWidth(`${this.theme.muted(dialect)}${this.theme.accent(` · ${source}`)} ${status}${this.theme.muted(versionSuffix)}`, safeWidth)];
    if (dbLine) lines.push(truncateToWidth(dbLine, safeWidth));
    return lines;
  }

  invalidate(): void {}
}

class MetadataResultComponent implements Component {
  private readonly view: Record<string, unknown>;
  private readonly result: { content?: unknown };
  private readonly isError: boolean;
  private readonly expanded: boolean;
  private readonly theme: QueryViewTheme;

  constructor(view: Record<string, unknown>, result: { content?: unknown }, isError: boolean, expanded: boolean, theme: QueryViewTheme) {
    this.view = view;
    this.result = result;
    this.isError = isError;
    this.expanded = expanded;
    this.theme = theme;
  }

  render(width: number): string[] {
    return renderMetadataResultLines(this.view, this.result, this.isError, this.expanded, width, this.theme);
  }

  invalidate(): void {}
}

class QueryResultComponent implements Component {
  private readonly args: unknown;
  private readonly result: { content?: unknown; details?: unknown };
  private readonly isError: boolean;
  private readonly expanded: boolean;
  private readonly theme: QueryViewTheme;

  constructor(args: unknown, result: { content?: unknown; details?: unknown }, isError: boolean, expanded: boolean, theme: QueryViewTheme) {
    this.args = args;
    this.result = result;
    this.isError = isError;
    this.expanded = expanded;
    this.theme = theme;
  }

  render(width: number): string[] {
    return renderQueryResultLines(this.args, this.result, this.isError, this.expanded, width, this.theme);
  }

  invalidate(): void {}
}

function writeResultColor(details: WriteResult | undefined, isError: boolean): "error" | "warning" | "toolOutput" {
  if (isError) return "error";
  return details?.blocked === true || details?.outcome === "unknown" ? "warning" : "toolOutput";
}

function formatWrite(details: WriteResult): string {
  if (details.cancelled) return `${details.source} (${details.dialect})\nWrite cancelled`;
  if (details.blocked) {
    return `${details.source} (${details.dialect})\nWrite blocked: ${details.reason ?? "Current policy does not allow this statement."}\n${details.next_action ?? "Explain the policy and ask the user what to do next."}`;
  }
  if (details.outcome === "unknown") {
    return `${details.source} (${details.dialect})\nWrite outcome unknown: ${details.reason ?? "The connection ended before the result was known."}\n${details.next_action ?? "Verify the database before taking any further action. Do not retry automatically."}`;
  }
  if (!details.executed) return `${details.source} (${details.dialect})\n${details.reason ?? "Write not executed"}`;
  const lines = [`${details.source} (${details.dialect})`, `${details.statement_kind.toUpperCase()} executed`];
  if (typeof details.affected_rows === "number") lines.push(`Affected rows: ${details.affected_rows}`);
  if (typeof details.changed_rows === "number") lines.push(`Changed rows: ${details.changed_rows}`);
  if (typeof details.insert_id === "number" && details.insert_id !== 0) lines.push(`Insert ID: ${details.insert_id}`);
  if (typeof details.query_id === "string") lines.push(`Query ID: ${details.query_id}`);
  return lines.join("\n");
}

function isUncertainWriteError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /timeout|timed out|connection|socket|econn|network|aborted|reset|closed/i.test(message);
}

function writeQueueKey(source: ResolvedSource): string {
  return `${source.configPath}:${source.name}`;
}

function serializeWrite<T>(source: ResolvedSource, task: () => Promise<T>): Promise<T> {
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
      return makeResult(details);
    },
    renderResult(result, options, theme, context) {
      const details = isRecord(result.details) ? result.details : {};
      const view = sourceListView(details as { config_path: string; sources: ReturnType<typeof sourceDetails>[] });
      return new MetadataResultComponent(view, result, context.isError, options.expanded, createQueryViewTheme(theme));
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
    },
    renderResult(result, _options, theme, context) {
      const details = isRecord(result.details) ? result.details : {};
      return new PingResultComponent(details, result, context.isError, createQueryViewTheme(theme));
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
      return makeResult({ source: source.name, dialect: source.dialect, databases });
    },
    renderResult(result, options, theme, context) {
      const details = isRecord(result.details) ? result.details : {};
      const view = databaseListView(Array.isArray(details.databases) ? details.databases as string[] : [], typeof details.source === "string" ? details.source : "", typeof details.dialect === "string" ? details.dialect : "");
      return new MetadataResultComponent(view, result, context.isError, options.expanded, createQueryViewTheme(theme));
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
      return makeResult(result);
    },
    renderResult(result, options, theme, context) {
      const view = isRecord(result.details) ? tableListView(result.details as never) : {};
      return new MetadataResultComponent(view, result, context.isError, options.expanded, createQueryViewTheme(theme));
    }
  });

  pi.registerTool({
    name: "database_search_tables",
    label: "Database Search Tables",
    description: "Search table names and comments across one configured source.",
    promptSnippet: "Find likely tables by name or comment before writing SQL",
    promptGuidelines: [
      "Use database_search_tables when the user gives a business term or the target table is unknown; do not guess table names in database_query.",
      "Pass database to database_search_tables when the search should stay inside one database."
    ],
    parameters: SearchTablesParams,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const input = params as { source?: string; term: string; database?: string };
      const source = resolveCurrentSource(ctx, input.source);
      const result = await adapterFor(source).searchTables(source, input.term, input.database, signal);
      return makeResult(result);
    },
    renderResult(result, options, theme, context) {
      const view = isRecord(result.details) ? tableSearchView(result.details as never) : {};
      return new MetadataResultComponent(view, result, context.isError, options.expanded, createQueryViewTheme(theme));
    }
  });

  pi.registerTool({
    name: "database_describe_table",
    label: "Database Describe Table",
    description: "Describe columns, indexes, engine, and create statement for one table.",
    promptSnippet: "Inspect a table's columns and schema before querying or changing it",
    promptGuidelines: [
      "Use database_describe_table before database_query or database_write when exact table columns or schema are unknown."
    ],
    parameters: DescribeTableParams,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const input = params as { source?: string; database: string; table: string };
      const source = resolveCurrentSource(ctx, input.source);
      const result = await adapterFor(source).describeTable(source, input.database, input.table, signal);
      return makeResult(result);
    },
    renderResult(result, options, theme, context) {
      const view = isRecord(result.details) ? tableDescriptionView(result.details as never) : {};
      return new MetadataResultComponent(view, result, context.isError, options.expanded, createQueryViewTheme(theme));
    }
  });

  pi.registerTool({
    name: "database_query",
    label: "Database Query",
    description: "Execute one read-only SQL query against a configured source.",
    promptSnippet: "Run a bounded read-only SQL query against a configured MySQL or ClickHouse source",
    promptGuidelines: [
      "Use database_query for configured MySQL or ClickHouse data requests instead of shelling out to a local database client.",
      "Use database_list_sources before database_query when the intended source is not already known, database_search_tables when the target table is unknown, and database_describe_table before guessing column names.",
      "database_query is read-only. Use database_write only for an explicit user-requested allowed change."
    ],
    parameters: QueryParams,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const input = params as { source?: string; query: string; max_rows?: number };
      const source = resolveCurrentSource(ctx, input.source);
      onUpdate({ content: [{ type: "text", text: `${formatSqlForUi(input.query)}\n\nRunning...` }] });
      const maxRows = Math.max(1, Math.min(input.max_rows ?? source.maxRows, 500));
      const startedAt = performance.now();
      const result = await adapterFor(source).query(source, input.query, maxRows, signal);
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
      "If database_write reports outcome unknown after a timeout or lost connection, first use database_query or metadata tools to verify database state; do not retry automatically and never use bash or a database client to bypass policy."
    ],
    parameters: WriteParams,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const input = params as { source?: string; statement: string };
      const source = resolveCurrentSource(ctx, input.source);
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
        try {
          const result = await adapter.write(source, write, signal);
          return makeResult(result, formatWrite(result));
        } catch (error) {
          if (!isUncertainWriteError(error)) throw error;
          const result: WriteResult = {
            source: source.name,
            dialect: source.dialect,
            executed: false,
            cancelled: false,
            statement_kind: write.statementKind,
            requested_statement: write.statement,
            outcome: "unknown",
            reason: error instanceof Error ? error.message : String(error),
            next_action: "Write outcome is unknown. First use database_query or database_list_tables to verify the database state before any further action. Do not retry this write automatically."
          };
          return makeResult(result, formatWrite(result));
        }
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
    writeQueues.clear();
    await Promise.all([mysqlAdapter.close(), clickhouseAdapter.close()]);
  });
}

export const __test__ = {
  registerCommands,
  registerTools,
  formatSqlForUi,
  isNumericValue,
  formatElapsed,
  tableListView,
  tableSearchView,
  tableDescriptionView,
  databaseListView,
  sourceListView,
  renderQueryData,
  renderQueryResultLines,
  renderMetadataResultLines,
  PingResultComponent,
  writeResultColor,
  writeQueueKey,
  serializeWrite
};
