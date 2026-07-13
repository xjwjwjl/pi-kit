import { highlightCode, keyHint, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, Text, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
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
import { firstKeyword } from "./src/sql.js";
import { DatabasePolicyError } from "./src/types.js";
import type { DatabaseAdapter, ResolvedSource, ValidatedWrite, WriteResult } from "./src/types.js";

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
  database: Type.String({ minLength: 1, description: "Database to use for this query; required on every call" }),
  query: Type.String({ description: "Single read-only SQL statement" }),
  max_rows: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, description: "Maximum returned rows; defaults to the selected source max_rows" }))
});

const WriteParams = Type.Object({
  source: Type.Optional(Type.String({ description: "Configured database source name" })),
  database: Type.Optional(Type.String({ minLength: 1, description: "Database for table-scoped writes; omit only for CREATE DATABASE" })),
  statement: Type.String({ description: "Single supported write statement" })
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function adapterFor(source: ResolvedSource): DatabaseAdapter {
  return adapters[source.dialect];
}

function makeResult(details: unknown, text = JSON.stringify(details)) {
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
    allow_write: source.allowWrite,
    write_confirm: source.writeConfirm,
    query_timeout_ms: source.queryTimeoutMs,
    max_rows: source.maxRows
  };
}

type ToolCallTheme = {
  fg(color: string, text: string): string;
  bold(text: string): string;
};

type ToolCallContext = {
  cwd: string;
  lastComponent?: Component;
};

function displayDialect(dialect: string): string {
  return dialect === "mysql" ? "MySQL" : dialect === "clickhouse" ? "ClickHouse" : dialect;
}

function renderDatabaseCall(
  action: string,
  source: { dialect?: string; name?: string } | undefined,
  targets: string[],
  theme: ToolCallTheme,
  context: ToolCallContext
): Component {
  const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
  const parts = [
    source?.dialect ? theme.fg("muted", ` · ${displayDialect(source.dialect)}`) : "",
    source?.name ? theme.fg("accent", ` · ${source.name}`) : "",
    ...targets.filter(Boolean).map((target) => theme.fg("muted", ` · ${target}`))
  ];
  text.setText(theme.fg("toolTitle", theme.bold(action)) + parts.join(""));
  return text;
}

function callSource(args: unknown, cwd: string): { name: string; dialect?: string; database?: string } {
  const requested = isRecord(args) && typeof args.source === "string" && args.source.trim() ? args.source.trim() : undefined;
  try {
    const source = selectSource(loadProjectConfig(cwd), requested);
    const database = typeof source.options.database === "string" && source.options.database.trim() ? source.options.database.trim() : undefined;
    return { name: source.name, dialect: source.dialect, database };
  } catch {
    return { name: requested ?? "source" };
  }
}

function callString(args: unknown, key: string): string | undefined {
  if (!isRecord(args) || typeof args[key] !== "string") return undefined;
  const value = args[key].trim();
  return value || undefined;
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

function matchingParen(sql: string, openIndex: number): number | undefined {
  let depth = 0;
  let quote: "'" | '"' | "`" | null = null;
  for (let index = openIndex; index < sql.length; index++) {
    const char = sql[index];
    if (quote) {
      if (char === quote && sql[index - 1] !== "\\") quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(") depth++;
    if (char === ")" && --depth === 0) return index;
  }
  return undefined;
}

function topLevelAs(sql: string, start: number): number | undefined {
  let depth = 0;
  let quote: "'" | '"' | "`" | null = null;
  for (let index = start; index < sql.length - 1; index++) {
    const char = sql[index];
    if (quote) {
      if (char === quote && sql[index - 1] !== "\\") quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(") {
      depth++;
      continue;
    }
    if (char === ")") {
      if (depth > 0) depth--;
      continue;
    }
    if (depth === 0 && sql.slice(index, index + 2).toUpperCase() === "AS" && !/[A-Za-z0-9_$]/.test(sql[index - 1] ?? "") && !/[A-Za-z0-9_$]/.test(sql[index + 2] ?? "")) {
      return index;
    }
  }
  return undefined;
}

function formatWithClause(sql: string): string | undefined {
  const withPrefix = sql.match(/^WITH\s+(?:RECURSIVE\s+)?/i);
  if (!withPrefix) return undefined;
  const definitions: string[] = [];
  let cursor = withPrefix[0].length;

  while (cursor < sql.length) {
    const asIndex = topLevelAs(sql, cursor);
    if (asIndex === undefined) return undefined;
    const name = sql.slice(cursor, asIndex).trim();
    let openIndex = asIndex + 2;
    while (/\s/.test(sql[openIndex] ?? "")) openIndex++;
    if (!name || sql[openIndex] !== "(") return undefined;
    const closeIndex = matchingParen(sql, openIndex);
    if (closeIndex === undefined) return undefined;
    definitions.push(`${name} AS (\n${formatSqlForUi(sql.slice(openIndex + 1, closeIndex)).split("\n").map((line) => `    ${line}`).join("\n")}\n  )`);
    cursor = closeIndex + 1;
    while (/\s/.test(sql[cursor] ?? "")) cursor++;
    if (sql[cursor] !== ",") break;
    cursor++;
    while (/\s/.test(sql[cursor] ?? "")) cursor++;
  }

  const mainQuery = sql.slice(cursor).trim();
  if (definitions.length === 0 || !mainQuery) return undefined;
  return `${withPrefix[0].trim()}\n  ${definitions.join(",\n  ")}\n${formatSqlForUi(mainQuery)}`;
}

function formatNestedSubqueries(sql: string): string {
  let output = "";
  let cursor = 0;
  let quote: "'" | '"' | "`" | null = null;
  for (let index = 0; index < sql.length; index++) {
    const char = sql[index];
    if (quote) {
      if (char === quote && sql[index - 1] !== "\\") quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char !== "(") continue;
    const closeIndex = matchingParen(sql, index);
    if (closeIndex === undefined) continue;
    const inner = sql.slice(index + 1, closeIndex);
    if (!/^\s*(?:SELECT|WITH)\b/i.test(inner)) continue;
    const lineStart = sql.lastIndexOf("\n", index) + 1;
    const indent = /^\s*/.exec(sql.slice(lineStart, index))?.[0] ?? "";
    output += sql.slice(cursor, index + 1);
    output += `\n${formatSqlForUi(inner).split("\n").map((line) => `${indent}  ${line}`).join("\n")}\n${indent})`;
    cursor = closeIndex + 1;
    index = closeIndex;
  }
  return output ? `${output}${sql.slice(cursor)}` : sql;
}

function formatSqlForUi(query: string): string {
  const compact = query.trim().replace(/\s+/g, " ");
  const formattedWithClause = formatWithClause(compact);
  if (formattedWithClause) return formattedWithClause;
  let formatted = compact
    .replace(/\b(FROM)\b/gi, "\n$1")
    .replace(/\b(PREWHERE)\b/gi, "\n$1")
    .replace(/\b(WHERE)\b/gi, "\n$1")
    .replace(/\b((?:LEFT|RIGHT|INNER|FULL|CROSS)\s+JOIN)\b/gi, "\n$1")
    .replace(/\b(JOIN)\b/gi, "\n$1")
    .replace(/\b(ON)\b/gi, "\n  $1")
    .replace(/\b(AND)\b/gi, "\n  $1")
    .replace(/\b(OR)\b/gi, "\n  $1")
    .replace(/\b(GROUP\s+BY)\b/gi, "\n$1")
    .replace(/\b(HAVING)\b/gi, "\n$1")
    .replace(/\b(QUALIFY)\b/gi, "\n$1")
    .replace(/\b(UNION(?:\s+ALL|\s+DISTINCT)?|INTERSECT|EXCEPT)\b\s*/gi, "\n$1\n")
    .replace(/\b(ORDER\s+BY)\b/gi, "\n$1")
    .replace(/\b(LIMIT\s+BY|LIMIT|OFFSET|FETCH\s+(?:FIRST|NEXT))\b/gi, "\n$1")
    .replace(/\b(SETTINGS)\b/gi, "\n$1");

  formatted = formatted.replace(/(^|\n)SELECT\s+([\s\S]*?)\nFROM\b/gim, (_match, prefix: string, selectList: string) => {
    const columns = splitTopLevelCommaList(selectList);
    return columns.length <= 1 ? `${prefix}SELECT ${selectList}\nFROM` : `${prefix}SELECT\n  ${columns.join(",\n  ")}\nFROM`;
  });
  return formatNestedSubqueries(formatted.split("\n").map((line) => line.trimEnd()).join("\n").trim());
}

function formatWriteSqlForUi(statement: string): string {
  const formatted = formatSqlForUi(statement)
    .replace(/\s+\bSET\b/gi, "\nSET")
    .replace(/\s+\bVALUES\b/gi, "\nVALUES")
    .replace(/\s+\bADD\s+(?=(?:COLUMN|INDEX)\b)/gi, "\nADD ");
  const values = formatted.match(/^([\s\S]*?\nVALUES)\s+([\s\S]+)$/i);
  if (values) {
    const rows = splitTopLevelCommaList(values[2]);
    if (rows.length > 1) return `${values[1]}\n  ${rows.join(",\n  ")}`;
  }
  const create = formatted.match(/^(CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[^\n(]+\()\s*([\s\S]*?)\s*\)$/i);
  if (!create) return formatted;
  const definitions = splitTopLevelCommaList(create[2]);
  return definitions.length > 1 ? `${create[1]}\n  ${definitions.join(",\n  ")}\n)` : formatted;
}

function getResultText(result: { content?: unknown }): string {
  const text = Array.isArray(result.content) ? result.content.find((item): item is { type: string; text: string } => isRecord(item) && item.type === "text") : undefined;
  return isRecord(text) && typeof text.text === "string" ? text.text : "";
}

type QueryViewTheme = {
  output: (text: string) => string;
  muted: (text: string) => string;
  accent: (text: string) => string;
  success: (text: string) => string;
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
    success: (text) => theme.fg("success", text),
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
  const clipped = truncateToWidth(value, width, "…").replace(/\x1b\[0m/g, "");
  const padding = " ".repeat(Math.max(0, width - visibleWidth(clipped)));
  return alignRight ? `${padding}${clipped}` : `${clipped}${padding}`;
}

function isNumericValue(value: unknown): boolean {
  return typeof value === "number" || typeof value === "bigint" || (typeof value === "string" && /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value));
}

function styleCell(value: unknown, cell: string, theme: QueryViewTheme, column?: string): string {
  if (column === "default") return value === "default" ? theme.success(cell) : theme.muted(cell);
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

function databaseListView(databases: string[], source: string, dialect: string, truncated = false): Record<string, unknown> {
  return {
    source,
    dialect,
    count_label: `${databases.length} databases`,
    truncated,
    warnings: [],
    columns: ["database"],
    rows: databases.map((db) => [db])
  };
}

function sourceListView(details: { config_path: string; sources: ReturnType<typeof sourceDetails>[] }): Record<string, unknown> {
  return {
    label: `config: ${details.config_path}`,
    count_label: `${details.sources.length} sources`,
    columns: ["source", "dialect", "host", "database", "default", "write", "confirm"],
    rows: details.sources.map((s) => [
      s.name,
      s.dialect,
      s.host ?? "—",
      s.database ?? "—",
      s.default ? "default" : "—",
      s.allow_write ? "yes" : "no",
      s.write_confirm ? "yes" : "no"
    ])
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
    label: `${result.database}.${result.table}`,
    detail_label: result.engine ?? "",
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
  if (columns.length === 0) return undefined;
  const separatorWidth = Math.max(0, columns.length - 1) * 3;
  const natural = columns.map((column, columnIndex) => Math.max(
    visibleWidth(column),
    ...rows.map((row) => visibleWidth(formatCell(row[columnIndex])))
  ));
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
  const t = theme ?? { output: (text: string) => text, muted: (text: string) => text, accent: (text: string) => text, success: (text: string) => text, border: (text: string) => text, error: (text: string) => text, number: (text: string) => text, nullValue: (text: string) => text, empty: (text: string) => text, sql: (text: string) => text.split("\n") };
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
        return styleCell(value, cell, t, columns[index]);
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
        lines.push(`${t.muted(label)} ${t.border("│")} ${styleCell(rawValue, value, t, column)}`)
      });
    });
  }

  const shownRows = widths ? tableRows.length : (expanded ? rows.length : Math.min(rows.length, 3));
  if (shownRows < rows.length) {
    lines.push(t.muted("..."), t.muted(`${rows.length - shownRows} more rows (${keyHint("app.tools.expand", "to expand")})`));
  }
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
  const t = theme ?? { output: (text: string) => text, muted: (text: string) => text, accent: (text: string) => text, success: (text: string) => text, border: (text: string) => text, error: (text: string) => text, number: (text: string) => text, nullValue: (text: string) => text, empty: (text: string) => text, sql: (text: string) => text.split("\n") };
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
  const rowCount = typeof details.row_count === "number" ? details.row_count : 0;
  const truncated = details.truncated === true ? " · truncated" : "";
  const elapsedText = formatElapsed(details.elapsed_ms);
  const elapsed = elapsedText ? ` · ${elapsedText}` : "";
  const dataLines = renderQueryData(details, expanded, safeWidth, t);
  if (dataLines.length) {
    if (lines.length) lines.push("");
    lines.push(...dataLines, "");
  }
  lines.push(truncateToWidth(t.muted(`${rowCount} rows${elapsed}${truncated}`), safeWidth));
  const warnings = Array.isArray(details.warnings) ? details.warnings.filter((warning): warning is string => typeof warning === "string") : [];
  for (const warning of warnings) lines.push(...wrapTextWithAnsi(t.muted(`Warning: ${warning}`), safeWidth));
  const queryId = typeof details.query_id === "string" && details.query_id ? details.query_id : "";
  if (expanded && queryId) lines.push("", t.muted(`Query ID: ${queryId}`));
  return lines.map((line) => truncateToWidth(line, safeWidth));
}

function renderMetadataResultLines(view: Record<string, unknown>, result: { content?: unknown }, isError: boolean, expanded: boolean, width: number, theme: QueryViewTheme): string[] {
  const safeWidth = Math.max(1, width);
  if (isError) return wrapTextWithAnsi(theme.error(`Error: ${getResultText(result).trim() || "Operation failed"}`), safeWidth);

  const source = typeof view.source === "string" && view.source ? view.source : "";
  const dialect = typeof view.dialect === "string" && view.dialect ? view.dialect : "";
  const label = typeof view.label === "string" && view.label ? view.label : "";
  const detailLabel = typeof view.detail_label === "string" && view.detail_label ? view.detail_label : "";
  const countLabel = typeof view.count_label === "string" ? view.count_label : "";
  const truncated = view.truncated === true ? " · truncated" : "";

  const displayLabel = source || dialect ? detailLabel : label;
  const headerParts = [displayLabel, countLabel].filter(Boolean).map((part) => theme.muted(part));
  if (truncated) headerParts.push(theme.muted(truncated));

  const plainPrefix = [displayLabel, countLabel, truncated].filter(Boolean).join(" · ");
  const lines = visibleWidth(plainPrefix) <= safeWidth
    ? [headerParts.join(theme.muted(" · "))]
    : [truncateToWidth(theme.muted(displayLabel), safeWidth), theme.muted(`${countLabel}${truncated}`)];

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
    const ok = this.details.ok === true;
    const version = typeof this.details.server_version === "string" ? this.details.server_version : "";
    const latency = formatElapsed(this.details.latency_ms) ?? "";
    const database = typeof this.details.current_database === "string" && this.details.current_database ? this.details.current_database : null;
    const status = ok ? this.theme.accent("connected") : this.theme.error("unreachable");
    const versionSuffix = [version, latency].filter(Boolean).map((value) => ` · ${value}`).join("");
    const dbLine = database ? this.theme.muted(`current database: ${database}`) : "";
    const lines = [truncateToWidth(`${status}${this.theme.muted(versionSuffix)}`, safeWidth)];
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

type WriteConfirmation = {
  title: string;
  source: string;
  dialect: string;
  action: string;
  database?: string;
  sql: string;
  message: string;
};

type ConfirmationTheme = {
  fg(color: string, text: string): string;
  bold(text: string): string;
};

function buildWriteConfirmation(source: ResolvedSource, write: ValidatedWrite, database?: string): WriteConfirmation {
  const action = write.statementKind.toUpperCase();
  const dialect = source.dialect === "mysql" ? "MySQL" : "ClickHouse";
  const sql = formatWriteSqlForUi(write.statement);
  return {
    title: `Database Write · ${action} · ${dialect}`,
    source: source.name,
    dialect,
    action,
    database,
    sql,
    message: [
      "Database write requires your confirmation.",
      `Source: ${source.name}`,
      `Dialect: ${dialect}`,
      ...(database ? [`Database: ${database}`] : []),
      `Action: ${action}`,
      "",
      "SQL:",
      sql,
      "",
      "Enter confirms execution · Esc cancels"
    ].join("\n")
  };
}

function createWriteConfirmationComponent(
  confirmation: WriteConfirmation,
  theme: ConfirmationTheme,
  done: (confirmed: boolean) => void
): Component & { handleInput(data: string): void } {
  return {
    render(width: number): string[] {
      const lineWidth = Math.max(1, width);
      const line = (text: string) => truncateToWidth(text, lineWidth);
      const field = (label: string, value: string, color: string) =>
        line(` ${theme.fg("dim", label.padEnd(9))}${theme.fg(color, value)}`);
      const sqlLines = highlightCode(confirmation.sql, "sql").flatMap((sqlLine) =>
        wrapTextWithAnsi(`  ${sqlLine}`, lineWidth)
      );
      return [
        theme.fg("border", "─".repeat(lineWidth)),
        line(` ${theme.fg("warning", theme.bold(confirmation.title))}`),
        "",
        field("Source", confirmation.source, "accent"),
        field("Dialect", confirmation.dialect, "muted"),
        ...(confirmation.database ? [field("Database", confirmation.database, "muted")] : []),
        field("Action", confirmation.action, "warning"),
        "",
        line(` ${theme.fg("dim", "SQL")}`),
        ...sqlLines,
        "",
        line(` ${theme.fg("success", "Enter")} ${theme.fg("dim", "confirm")}   ${theme.fg("muted", "Esc")} ${theme.fg("dim", "cancel")}`),
        theme.fg("border", "─".repeat(lineWidth))
      ];
    },
    invalidate() {},
    handleInput(data: string): void {
      if (matchesKey(data, Key.enter)) done(true);
      else if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) done(false);
    }
  };
}

function formatRowCount(value: number): string {
  return `${value} row${value === 1 ? "" : "s"}`;
}

function writeMetricParts(details: WriteResult): string[] {
  if (details.statement_kind === "insert") {
    const parts: string[] = [];
    if (typeof details.affected_rows === "number") parts.push(formatRowCount(details.affected_rows));
    if (typeof details.insert_id === "number" && details.insert_id !== 0) parts.push(`insert id ${details.insert_id}`);
    return parts;
  }
  if (details.statement_kind === "update") {
    const parts: string[] = [];
    if (typeof details.affected_rows === "number") parts.push(`affected ${details.affected_rows}`);
    if (typeof details.changed_rows === "number") parts.push(`changed ${details.changed_rows}`);
    return parts;
  }
  return [];
}

function writeSql(details: WriteResult): string | undefined {
  return typeof details.requested_statement === "string" && details.requested_statement.trim()
    ? formatWriteSqlForUi(details.requested_statement)
    : undefined;
}

function formatWriteWithSql(details: WriteResult, lines: string[]): string {
  const sql = writeSql(details);
  return (sql ? [sql, "", ...lines] : lines).join("\n");
}

function writeTarget(details: WriteResult): string {
  return [details.dialect, details.source, details.database].filter((value): value is string => typeof value === "string" && value.length > 0).join(" · ");
}

function formatWrite(details: WriteResult): string {
  if (details.cancelled) {
    return formatWriteWithSql(details, ["Cancelled"]);
  }
  if (details.blocked) {
    return formatWriteWithSql(details, [
      `Write blocked: ${details.reason ?? "Current policy does not allow this statement."}`,
      details.next_action ?? "Explain the policy and ask the user what to do next."
    ]);
  }
  if (details.outcome === "unknown") {
    const target = writeTarget(details);
    return formatWriteWithSql(details, [
      ...(target ? [`Target: ${target}`] : []),
      `Write outcome unknown: ${details.reason ?? "The connection ended before the result was known."}`,
      details.next_action ?? "Verify the database before taking any further action. Do not retry automatically."
    ]);
  }
  if (!details.executed) {
    return formatWriteWithSql(details, [details.reason ?? "Write not executed"]);
  }
  const metrics = writeMetricParts(details);
  const target = writeTarget(details);
  const lines: string[] = [["Success", ...metrics].join(" · ")];
  if (target) lines.push(`Target: ${target}`);
  if (details.write_confirm === false) lines.push("Confirmation: skipped by source policy");
  if (typeof details.warning_count === "number" && details.warning_count > 0) lines.push(`Warnings: ${details.warning_count}`);
  if (typeof details.query_id === "string") lines.push(`Query ID: ${details.query_id}`);
  return formatWriteWithSql(details, lines);
}

function createWriteResultComponent(details: WriteResult, expanded: boolean, theme: ConfirmationTheme): Component {
  return {
    render(width: number): string[] {
      const metrics = details.executed ? writeMetricParts(details) : [];
      const status = details.cancelled
        ? theme.fg("warning", "Cancelled")
        : theme.fg("accent", "Success") + (metrics.length ? theme.fg("muted", ` · ${metrics.join(" · ")}`) : "");
      const lines: string[] = [];

      const sql = writeSql(details);
      if (sql) {
        lines.push(...highlightCode(sql, "sql").flatMap((line) => wrapTextWithAnsi(line, width)), "");
      }
      lines.push(truncateToWidth(status, width));

      if (expanded && (details.write_confirm === false || (details.warning_count ?? 0) > 0 || details.query_id)) {
        lines.push("");
        if (details.write_confirm === false) lines.push(theme.fg("dim", "Confirmation: skipped by source policy"));
        if ((details.warning_count ?? 0) > 0) lines.push(theme.fg("warning", `Warnings: ${details.warning_count}`));
        if (details.query_id) lines.push(theme.fg("dim", `Query ID: ${details.query_id}`));
      }
      return lines;
    },
    invalidate() {}
  };
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

async function confirmWrite(ctx: unknown, confirmation: WriteConfirmation): Promise<boolean | undefined> {
  if (!isRecord(ctx) || ctx.hasUI !== true || !isRecord(ctx.ui)) return undefined;
  const ui = ctx.ui as Record<string, unknown>;
  if (ctx.mode === "tui" && typeof ui.custom === "function") {
    return (ui.custom as (factory: (tui: unknown, theme: ConfirmationTheme, keybindings: unknown, done: (confirmed: boolean) => void) => Component) => Promise<boolean>)(
      (_tui, theme, _keybindings, done) => createWriteConfirmationComponent(confirmation, theme, done)
    );
  }
  if (typeof ui.confirm !== "function") return undefined;
  return (ui.confirm as (title: string, message: string) => Promise<boolean> | boolean)(confirmation.title, confirmation.message);
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
    renderCall(_args, theme, context) {
      return renderDatabaseCall("Database Sources", undefined, [], theme, context);
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
    parameters: SourceParams,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const source = resolveCurrentSource(ctx, (params as { source?: string }).source);
      return makeResult(await adapterFor(source).ping(source, signal));
    },
    renderCall(args, theme, context) {
      const source = callSource(args, context.cwd);
      return renderDatabaseCall("Database Ping", source, [], theme, context);
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
      "Use database_list_databases to list database/catalog namespaces visible to a configured source."
    ],
    parameters: SourceParams,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const source = resolveCurrentSource(ctx, (params as { source?: string }).source);
      return makeResult(await adapterFor(source).listDatabases(source, signal));
    },
    renderCall(args, theme, context) {
      const source = callSource(args, context.cwd);
      return renderDatabaseCall("Database Databases", source, [], theme, context);
    },
    renderResult(result, options, theme, context) {
      const details = isRecord(result.details) ? result.details : {};
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
    renderCall(args, theme, context) {
      const source = callSource(args, context.cwd);
      return renderDatabaseCall("Database Tables", source, [callString(args, "database") ?? source.database ?? ""], theme, context);
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
    renderCall(args, theme, context) {
      const source = callSource(args, context.cwd);
      return renderDatabaseCall("Database Find tables", source, [callString(args, "database") ?? "", callString(args, "term") ?? ""], theme, context);
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
    renderCall(args, theme, context) {
      const source = callSource(args, context.cwd);
      const target = [callString(args, "database"), callString(args, "table")].filter(Boolean).join(".");
      return renderDatabaseCall("Database Describe", source, [target], theme, context);
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
      "Use database_query only for a single read-only SQL query and always pass database."
    ],
    parameters: QueryParams,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const input = params as { source?: string; database?: string; query: string; max_rows?: number };
      const source = resolveCurrentSource(ctx, input.source);
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
    label: "Database Write",
    description: "Execute one supported write statement using the selected source confirmation policy.",
    promptSnippet: "Execute a dialect-specific data or additive schema change using source write policy",
    promptGuidelines: [
      "Use database_write only for an explicit user-requested change after selecting the correct source; never use bash or a local database client as a write fallback.",
      "database_write requires database for table-scoped writes; omit database only for CREATE DATABASE. It follows the selected source confirmation policy and rejects destructive, delete, replacement, rename, multi-statement, and unsupported SQL. If it returns blocked, stop and explain the selected source policy to the user.",
      "If database_write reports outcome unknown after a timeout or lost connection, first use database_query or metadata tools to verify database state; do not retry automatically and never use bash or a database client to bypass policy."
    ],
    parameters: WriteParams,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const input = params as { source?: string; database?: string; statement: string };
      const source = resolveCurrentSource(ctx, input.source);
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
            statement_kind: "unknown",
            allow_write: source.allowWrite,
            write_confirm: source.writeConfirm,
            database,
            requested_statement: input.statement,
            reason: error.message,
            next_action: "Stop. Explain this source policy to the user and ask what they want to do next. Do not use bash, a database client, or config edits to bypass it."
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
            statement_kind: write.statementKind,
            allow_write: source.allowWrite,
            write_confirm: source.writeConfirm,
            requested_statement: write.statement,
            reason: "database_write requires a database argument for this statement.",
            next_action: "Pass database for this table-scoped write. CREATE DATABASE is the only supported write that omits database."
          };
          return makeResult(result, formatWrite(result));
        }
        if (source.writeConfirm) {
          const confirmation = buildWriteConfirmation(source, write, database);
          const confirmed = await confirmWrite(ctx, confirmation);
          if (confirmed === undefined) {
            const result: WriteResult = {
              source: source.name,
              dialect: source.dialect,
              executed: false,
              cancelled: false,
              statement_kind: write.statementKind,
              write_confirm: true,
              database,
              requested_statement: write.statement,
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
              statement_kind: write.statementKind,
              write_confirm: true,
              database,
              requested_statement: write.statement
            };
            return makeResult(result, formatWrite(result));
          }
        }
        onUpdate({ content: [{ type: "text", text: `Writing to ${database ? `${source.name}.${database}` : source.name}...` }] });
        try {
          const result: WriteResult = {
            ...(await adapter.write(source, database, write, signal)),
            write_confirm: source.writeConfirm,
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
      const details = isRecord(result.details) ? result.details as WriteResult : undefined;
      if (context.isError || !details) {
        const text = context.isError ? String(result.content?.[0]?.text ?? "Write failed") : "Write completed";
        return new Text(theme.fg(writeResultColor(details, context.isError), text), 0, 0);
      }
      if (details.executed || details.cancelled) return createWriteResultComponent(details, options.expanded, theme);
      return new Text(theme.fg(writeResultColor(details, false), formatWrite(details)), 0, 0);
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
  formatWriteSqlForUi,
  buildWriteConfirmation,
  createWriteConfirmationComponent,
  createWriteResultComponent,
  formatWrite,
  writeQueueKey,
  serializeWrite
};
