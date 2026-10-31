import { highlightCode, keyHint } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, Text, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import type { Component } from "@mariozechner/pi-tui";
import { loadProjectConfig, selectSource } from "./config.js";
import { splitTopLevelParts } from "./sql.js";
import type { ResolvedSource, SqlDialect, ValidatedWrite, WriteResult } from "./types.js";
import { connectionScheme, redactConnection, statementKind } from "./usql.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function sourceDetails(source: ResolvedSource, isDefault: boolean) {
  const host = typeof source.options.host === "string" ? source.options.host : undefined;
  const url = typeof source.options.url === "string" ? source.options.url : undefined;
  const database = typeof source.options.database === "string" ? source.options.database : undefined;
  return {
    name: source.name,
    label: source.label ?? source.name,
    dialect: source.dialect,
    provider: source.provider ?? "project",
    default: isDefault,
    host: host ?? url,
    database,
    allow_write: source.allowWrite,
    write_confirm: source.writeConfirm,
    query_timeout_ms: source.queryTimeoutMs,
    max_rows: source.maxRows
  };
}

export type SourceSummary = ReturnType<typeof sourceDetails>;

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

export function renderDatabaseCall(
  action: string,
  source: { dialect?: string; name?: string } | undefined,
  targets: string[],
  theme: ToolCallTheme,
  context: ToolCallContext
): Component {
  const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
  const parts = [
    ...targets.filter(Boolean).map((target) => theme.fg("muted", ` · ${target}`)),
    source?.name ? theme.fg("muted", ` · ${source.name}`) : "",
    source?.dialect ? theme.fg("muted", ` · ${displayDialect(source.dialect)}`) : ""
  ];
  text.setText(theme.fg("toolTitle", theme.bold(action)) + parts.join(""));
  return text;
}

export function requestedDialect(value: unknown): SqlDialect | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error('dialect must be "mysql" or "clickhouse".');
  const dialect = value.trim();
  if (!dialect) return undefined;
  if (dialect === "mysql" || dialect === "clickhouse") return dialect;
  throw new Error('dialect must be "mysql" or "clickhouse".');
}

export function callSource(args: unknown, cwd: string): { name: string; dialect?: string; database?: string } {
  const requested = isRecord(args) && typeof args.source === "string" && args.source.trim() ? args.source.trim() : undefined;
  let dialect: SqlDialect | undefined;
  try {
    dialect = requestedDialect(isRecord(args) ? args.dialect : undefined);
    const source = selectSource(loadProjectConfig(cwd), requested, dialect);
    const database = typeof source.options.database === "string" && source.options.database.trim() ? source.options.database.trim() : undefined;
    return { name: source.name, dialect: source.dialect, database };
  } catch {
    return { name: requested ?? "source", dialect };
  }
}

export function callString(args: unknown, key: string): string | undefined {
  if (!isRecord(args) || typeof args[key] !== "string") return undefined;
  const value = args[key].trim();
  return value || undefined;
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

export function formatSqlForUi(query: string): string {
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

  formatted = formatted.replace(/\bSELECT\s+([\s\S]*?)\nFROM\b/gim, (_match, selectList: string) => {
    const columns = splitTopLevelParts(selectList);
    return columns.length <= 1 ? `SELECT ${selectList}\nFROM` : `SELECT\n  ${columns.join(",\n  ")}\nFROM`;
  });
  return formatNestedSubqueries(formatted.split("\n").map((line) => line.trimEnd()).join("\n").trim());
}

function formatInsertTargetColumnsForUi(sql: string): string {
  const match = sql.match(/^(INSERT\s+INTO\s+[\s\S]*?)\(([^()]*)\)(?=\s+(?:SELECT|VALUES)\b)/i);
  if (!match) return sql;
  const columns = splitTopLevelParts(match[2] ?? "");
  if (columns.length <= 1) return sql;
  return `${match[1]}(\n  ${columns.join(",\n  ")}\n)\n${sql.slice(match[0].length).trimStart()}`;
}

function formatRenameTableForUi(sql: string): string {
  return sql.replace(/^RENAME\s+TABLE\s+(.+?)\s+TO\s+/i, (_match, source: string) => `RENAME TABLE ${source}\nTO `);
}

export function formatWriteSqlForUi(statement: string): string {
  let formatted = formatSqlForUi(statement)
    .replace(/\s+\bSET\b/gi, "\nSET")
    .replace(/\s+\bVALUES\b/gi, "\nVALUES")
    .replace(/\s+\bADD\s+(?=(?:COLUMN|INDEX)\b)/gi, "\nADD ");
  formatted = formatInsertTargetColumnsForUi(formatted);
  formatted = formatRenameTableForUi(formatted);
  const values = formatted.match(/^([\s\S]*?\nVALUES)\s+([\s\S]+)$/i);
  if (values) {
    const rows = splitTopLevelParts(values[2]);
    if (rows.length > 1) return `${values[1]}\n  ${rows.join(",\n  ")}`;
  }
  const create = formatted.match(/^(CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[^\n(]+\()\s*([\s\S]*?)\s*\)$/i);
  if (!create) return formatted;
  const definitions = splitTopLevelParts(create[2]);
  return definitions.length > 1 ? `${create[1]}\n  ${definitions.join(",\n  ")}\n)` : formatted;
}

export function getResultText(result: { content?: unknown }): string {
  const text = Array.isArray(result.content) ? result.content.find((item): item is { type: string; text: string } => isRecord(item) && item.type === "text") : undefined;
  return isRecord(text) && typeof text.text === "string" ? text.text : "";
}

export function getResultDetails(result: { content?: unknown; details?: unknown }): Record<string, unknown> {
  if (isRecord(result.details)) return result.details;
  const text = getResultText(result).trim();
  if (!text.startsWith("{")) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
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

export function createQueryViewTheme(theme: { fg(color: string, text: string): string }): QueryViewTheme {
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

export function isNumericValue(value: unknown): boolean {
  return typeof value === "number" || typeof value === "bigint" || (typeof value === "string" && /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value));
}

function styleCell(value: unknown, cell: string, theme: QueryViewTheme, column?: string): string {
  if (column === "default") return value === "default" ? theme.success(cell) : theme.muted(cell);
  if (value === null) return theme.nullValue(cell);
  if (value === "") return theme.empty(cell);
  if (isNumericValue(value)) return theme.number(cell);
  return theme.output(cell);
}

export function formatElapsed(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${value.toFixed(1)} ms`;
}

function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** Comfortable cell width; a column that cannot reach this is dropped from the collapsed table instead of squeezed thinner. */
const COMFORT_COLUMN_WIDTH = 12;

export function tableListView(result: { source: string; dialect: string; database: string; tables: string[]; truncated: boolean }): Record<string, unknown> {
  return {
    source: result.source,
    dialect: result.dialect,
    label: result.database,
    count_label: countLabel(result.tables.length, "table"),
    truncated: result.truncated,
    warnings: [],
    collapse_to_call: true,
    columns: ["table"],
    rows: result.tables.map((table) => [table])
  };
}

export function tableSearchView(result: { source: string; dialect: string; matches: Array<{ database: string; table: string; type?: string; engine?: string; comment?: string | null }>; truncated: boolean }): Record<string, unknown> {
  return {
    source: result.source,
    dialect: result.dialect,
    count_label: countLabel(result.matches.length, "match", "matches"),
    truncated: result.truncated,
    warnings: [],
    collapse_to_call: true,
    columns: ["database", "table", "type", "engine", "comment"],
    rows: result.matches.map((match) => [match.database, match.table, match.type ?? undefined, match.engine ?? undefined, match.comment ?? undefined])
  };
}

export function databaseListView(databases: string[], source: string, dialect: string, truncated = false): Record<string, unknown> {
  return {
    source,
    dialect,
    count_label: countLabel(databases.length, "database"),
    truncated,
    warnings: [],
    collapse_to_call: true,
    columns: ["database"],
    rows: databases.map((db) => [db])
  };
}

export function sourceListView(details: { config_path: string; sources: SourceSummary[]; warnings?: string[] }): Record<string, unknown> {
  return {
    label: `config: ${details.config_path}`,
    count_label: countLabel(details.sources.length, "source"),
    warnings: details.warnings ?? [],
    collapse_to_call: true,
    columns: ["provider", "label", "source", "dialect", "host", "database", "default", "write", "confirm"],
    rows: details.sources.map((s) => [
      s.provider ?? "project",
      s.label ?? s.name,
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

export function tableDescriptionView(result: {
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
    count_label: `${countLabel(result.columns.length, "column")} · ${countLabel(result.indexes.length, "index", "indexes")}`,
    truncated: result.truncated,
    warnings: result.warnings,
    collapse_to_call: true,
    columns: ["#", "name", "type", "nullable", "default", "comment"],
    rows: result.columns.map((column) => [column.position ?? null, column.name, column.type, column.nullable === undefined ? undefined : column.nullable ? "yes" : "no", column.default ?? undefined, column.comment ?? undefined]),
    indexes: result.indexes,
    create_statement: result.create_statement
  };
}

type ColumnLayout = {
  widths: number[];
  hiddenCount: number;
};

function allocateColumnWidths(columns: string[], rows: unknown[][], width: number): ColumnLayout {
  const natural = columns.map((column, columnIndex) => Math.max(
    visibleWidth(column),
    ...rows.map((row) => visibleWidth(formatCell(row[columnIndex])))
  ));
  const desired = natural.map((columnWidth) => Math.min(columnWidth, COMFORT_COLUMN_WIDTH));
  const required = (visible: number) =>
    desired.slice(0, visible).reduce((sum, columnWidth) => sum + columnWidth, 0) + Math.max(0, visible - 1) * 3;
  let visible = columns.length;
  while (visible > 1 && required(visible) > width) visible--;
  const widths = desired.slice(0, visible);
  let remaining = width - Math.max(0, visible - 1) * 3 - widths.reduce((sum, columnWidth) => sum + columnWidth, 0);
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
  return { widths, hiddenCount: columns.length - visible };
}

export function renderQueryData(details: Record<string, unknown>, expanded: boolean, width: number, theme?: QueryViewTheme): string[] {
  const t = theme ?? { output: (text: string) => text, muted: (text: string) => text, accent: (text: string) => text, success: (text: string) => text, border: (text: string) => text, error: (text: string) => text, number: (text: string) => text, nullValue: (text: string) => text, empty: (text: string) => text, sql: (text: string) => text.split("\n") };
  const columns = Array.isArray(details.columns) ? details.columns.filter((column): column is string => typeof column === "string") : [];
  const rows = Array.isArray(details.rows) ? details.rows.filter((row): row is unknown[] => Array.isArray(row)) : [];
  if (columns.length === 0 || rows.length === 0) return [];

  const tableRows = expanded ? rows : rows.slice(0, 10);
  const layout = allocateColumnWidths(columns, tableRows, width);
  // Collapsed rows stay horizontal so more columns are scannable; expanding is what trades the
  // table for the full vertical record when every column cannot fit side by side.
  const horizontal = layout.hiddenCount === 0 || !expanded;
  const visibleCount = columns.length - layout.hiddenCount;
  const lines: string[] = [];
  let shownRows: number;
  if (horizontal) {
    const widths = layout.widths;
    const separator = t.border(" │ ");
    lines.push(columns.slice(0, visibleCount).map((column, index) => t.accent(fitCell(column, widths[index]!))).join(separator));
    lines.push(t.border(widths.map((columnWidth) => "─".repeat(columnWidth)).join("─┼─")));
    for (const row of tableRows) {
      lines.push(columns.slice(0, visibleCount).map((_column, index) => {
        const value = row[index];
        const text = formatCell(value);
        const cell = fitCell(text, widths[index]!, isNumericValue(value));
        return styleCell(value, cell, t, columns[index]);
      }).join(separator));
    }
    shownRows = tableRows.length;
  } else {
    const labelWidth = Math.min(24, Math.max(1, ...columns.map(visibleWidth)));
    const valueWidth = Math.max(1, width - labelWidth - 3);
    rows.forEach((row, rowIndex) => {
      if (rowIndex > 0) lines.push(t.border("─".repeat(Math.min(width, 24))));
      lines.push(t.accent(`#${rowIndex + 1}`));
      columns.forEach((column, columnIndex) => {
        const label = fitCell(column, labelWidth);
        const rawValue = row[columnIndex];
        const value = truncateToWidth(formatCell(rawValue), valueWidth, "…");
        lines.push(`${t.muted(label)} ${t.border("│")} ${styleCell(rawValue, value, t, column)}`)
      });
    });
    shownRows = rows.length;
  }

  const hints: string[] = [];
  if (shownRows < rows.length) hints.push(countLabel(rows.length - shownRows, "more row"));
  if (horizontal && layout.hiddenCount > 0) hints.push(`+${countLabel(layout.hiddenCount, "column")}`);
  if (hints.length > 0) {
    lines.push(truncateToWidth(t.muted(`… ${hints.join(" · ")} (${keyHint("app.tools.expand", "to expand")})`), width));
  }
  return lines;
}

export function renderQueryResultLines(
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

  const details = getResultDetails(result);
  const rowCount = typeof details.row_count === "number" ? details.row_count : 0;
  const truncated = details.truncated === true ? " · truncated" : "";
  const elapsedText = formatElapsed(details.elapsed_ms);
  const elapsed = elapsedText ? ` · ${elapsedText}` : "";
  // Collapsed query cards carry only the statement and its summary; expand to see the data table.
  const dataLines = expanded ? renderQueryData(details, true, safeWidth, t) : [];
  if (lines.length) lines.push("");
  lines.push(truncateToWidth(t.muted(`${rowCount} rows${elapsed}${truncated}`), safeWidth));
  const warnings = Array.isArray(details.warnings) ? details.warnings.filter((warning): warning is string => typeof warning === "string") : [];
  for (const warning of warnings) lines.push(...wrapTextWithAnsi(t.muted(`Warning: ${warning}`), safeWidth));
  const queryId = typeof details.query_id === "string" && details.query_id ? details.query_id : "";
  if (queryId) lines.push(t.muted(`Query ID: ${queryId}`));
  if (dataLines.length) lines.push("", ...dataLines);
  return lines.map((line) => truncateToWidth(line, safeWidth));
}

export function renderMetadataResultLines(view: Record<string, unknown>, result: { content?: unknown }, isError: boolean, expanded: boolean, width: number, theme: QueryViewTheme): string[] {
  const safeWidth = Math.max(1, width);
  if (isError) return wrapTextWithAnsi(theme.error(`Error: ${getResultText(result).trim() || "Operation failed"}`), safeWidth);
  // Views that mark `collapse_to_call` keep the collapsed card down to its call row; expand for the payload.
  if (view.collapse_to_call === true && !expanded) return [];

  const source = typeof view.source === "string" && view.source ? view.source : "";
  const dialect = typeof view.dialect === "string" && view.dialect ? view.dialect : "";
  const label = typeof view.label === "string" && view.label ? view.label : "";
  const detailLabel = typeof view.detail_label === "string" && view.detail_label ? view.detail_label : "";
  const count = typeof view.count_label === "string" ? view.count_label : "";
  const truncated = view.truncated === true ? "truncated" : "";

  const displayLabel = source || dialect ? detailLabel : label;
  const plainPrefix = [displayLabel, count, truncated].filter(Boolean).join(" · ");
  const headerParts = [displayLabel, count, truncated].filter(Boolean).map((part) => theme.muted(part));
  const fallbackSuffix = [count, truncated].filter(Boolean).join(" · ");
  const lines: string[] = visibleWidth(plainPrefix) <= safeWidth
    ? [headerParts.join(theme.muted(" · "))]
    : [truncateToWidth(theme.muted(displayLabel), safeWidth), theme.muted(fallbackSuffix)];

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

export class PingResultComponent implements Component {
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

export class MetadataResultComponent implements Component {
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

export class QueryResultComponent implements Component {
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

export function writeResultColor(details: WriteResult | undefined, isError: boolean): "error" | "warning" | "toolOutput" {
  if (isError) return "error";
  return details?.blocked === true || details?.blocked_reason === "confirmation_required" || details?.cancelled || details?.outcome === "unknown" ? "warning" : "toolOutput";
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

export function buildWriteConfirmation(source: ResolvedSource, write: ValidatedWrite, database?: string): WriteConfirmation {
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

export function createWriteConfirmationComponent(
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

export type SqlConfirmationField = { label: string; value: string; color: string };

export type SqlConfirmation = {
  title: string;
  fields: SqlConfirmationField[];
  sql: string;
  message: string;
};

export type SqlConfirmationDecision = "once" | "session" | "cancel";

export type SqlConfirmationOptions = {
  allowSessionTrust?: boolean;
  sessionTrustLabel?: string;
};

export function createSqlConfirmationComponent(
  confirmation: SqlConfirmation,
  theme: ConfirmationTheme,
  done: (decision: SqlConfirmationDecision) => void,
  options: SqlConfirmationOptions = {}
): Component & { handleInput(data: string): void } {
  return {
    render(width: number): string[] {
      const lineWidth = Math.max(1, width);
      const line = (text: string) => truncateToWidth(text, lineWidth);
      const field = ({ label, value, color }: SqlConfirmationField) =>
        line(` ${theme.fg("dim", label.padEnd(9))}${theme.fg(color, value)}`);
      const sqlLines = highlightCode(confirmation.sql, "sql").flatMap((sqlLine) =>
        wrapTextWithAnsi(`  ${sqlLine}`, lineWidth)
      );
      const footer = [
        `${theme.fg("success", "Enter")} ${theme.fg("dim", "confirm")}`,
        ...(options.allowSessionTrust
          ? [`${theme.fg("success", "Trust")} ${theme.fg("dim", `(t) ${options.sessionTrustLabel ?? "this source for this session"}`)}`]
          : []),
        `${theme.fg("muted", "Esc")} ${theme.fg("dim", "cancel")}`
      ].join("   ");
      return [
        theme.fg("border", "─".repeat(lineWidth)),
        line(` ${theme.fg("warning", theme.bold(confirmation.title))}`),
        "",
        ...confirmation.fields.map(field),
        "",
        line(` ${theme.fg("dim", "SQL")}`),
        ...sqlLines,
        "",
        ...(options.allowSessionTrust
          ? [line(` ${theme.fg("warning", "Trusting this source skips confirmation, including destructive statements, until the session ends.")}`), ""]
          : []),
        line(` ${footer}`),
        theme.fg("border", "─".repeat(lineWidth))
      ];
    },
    invalidate() {},
    handleInput(data: string): void {
      if (matchesKey(data, Key.enter)) done("once");
      else if (options.allowSessionTrust && (matchesKey(data, "t") || data === "T")) done("session");
      else if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) done("cancel");
    }
  };
}

export type UsqlResult = {
  tool: string;
  connection: string;
  driver?: string;
  source?: string;
  allow_write?: boolean;
  blocked?: boolean;
  blocked_reason?: "source_read_only";
  statement_kind: string;
  executed: boolean;
  cancelled?: boolean;
  confirmed?: boolean;
  requested_statement?: string;
  columns?: string[];
  rows?: unknown[][];
  row_count?: number;
  truncated?: boolean;
  warnings?: string[];
  elapsed_ms?: number;
  output?: string;
  stderr?: string;
  exit_code?: number;
  error?: string;
  reason?: string;
  next_action?: string;
};

export function buildUsqlConfirmation(connection: string, statement: string, policySource?: { name: string; allowWrite: boolean }): SqlConfirmation {
  const kind = statementKind(statement);
  const driver = connectionScheme(connection) ?? "connection";
  const redacted = redactConnection(connection);
  const sql = formatSqlForUi(statement);
  const policyLine = policySource ? `${policySource.name} · allow_write=${policySource.allowWrite}` : undefined;
  return {
    title: `Database usql · ${kind.toUpperCase()} · ${driver}`,
    fields: [
      { label: "Connection", value: redacted, color: "accent" },
      { label: "Driver", value: driver, color: "muted" },
      ...(policyLine ? [{ label: "Policy", value: policyLine, color: policySource!.allowWrite ? "success" : "warning" }] : []),
      { label: "Action", value: kind.toUpperCase(), color: "warning" }
    ],
    sql,
    message: [
      policySource
        ? `This statement is bound to source ${policySource.name}; writes require allow_write=${policySource.allowWrite}.`
        : "This statement bypasses the configured source policies and always needs your confirmation.",
      `Connection: ${redacted}`,
      `Driver: ${driver}`,
      ...(policyLine ? [`Policy source: ${policyLine}`] : []),
      `Action: ${kind.toUpperCase()}`,
      "",
      "SQL:",
      sql,
      "",
      "Enter confirms execution · Esc cancels"
    ].join("\n")
  };
}

export function formatUsql(details: UsqlResult): string {
  const lines: string[] = [];
  const sql = typeof details.requested_statement === "string" && details.requested_statement.trim()
    ? formatSqlForUi(details.requested_statement)
    : undefined;
  if (sql) lines.push(sql, "");
  if (details.cancelled) {
    lines.push("Cancelled · no statement was executed");
    return lines.join("\n");
  }
  if (details.blocked) {
    lines.push(`Blocked: ${details.error ?? details.reason ?? "This statement is not allowed."}`);
    if (details.next_action) lines.push(details.next_action);
    return lines.join("\n");
  }
  if (details.error) {
    lines.push(`Error: ${details.error}`);
    if (details.next_action) lines.push(details.next_action);
    return lines.join("\n");
  }
  if (!details.executed) {
    lines.push(details.reason ?? "Statement not executed");
    if (details.next_action) lines.push(details.next_action);
    return lines.join("\n");
  }
  const metrics = [`${details.row_count ?? 0} rows`];
  const elapsed = formatElapsed(details.elapsed_ms);
  if (elapsed) metrics.push(elapsed);
  if (details.truncated) metrics.push("truncated");
  lines.push(`Executed · ${metrics.join(" · ")}`);
  if (details.output) lines.push("", details.output);
  if (details.stderr) lines.push("", `stderr: ${details.stderr}`);
  return lines.join("\n");
}

export function createUsqlResultComponent(details: UsqlResult, isError: boolean, expanded: boolean, theme?: QueryViewTheme): Component {
  const t = theme ?? {
    output: (text: string) => text,
    muted: (text: string) => text,
    accent: (text: string) => text,
    success: (text: string) => text,
    border: (text: string) => text,
    error: (text: string) => text,
    number: (text: string) => text,
    nullValue: (text: string) => text,
    empty: (text: string) => text,
    sql: (text: string) => text.split("\n")
  };
  return {
    render(width: number): string[] {
      const safeWidth = Math.max(1, width);
      const lines: string[] = [];
      const sql = typeof details.requested_statement === "string" && details.requested_statement.trim()
        ? formatSqlForUi(details.requested_statement)
        : "";
      if (sql) lines.push(...t.sql(sql).flatMap((line) => wrapTextWithAnsi(line, safeWidth)), "");
      if (isError || details.error) {
        lines.push(...wrapTextWithAnsi(t.error(`Error: ${details.error ?? "usql execution failed"}`), safeWidth));
        if (details.next_action) lines.push(...wrapTextWithAnsi(t.muted(details.next_action), safeWidth));
        return lines.map((line) => truncateToWidth(line, safeWidth));
      }
      if (details.cancelled) {
        lines.push(t.muted("Cancelled · no statement was executed"));
        return lines.map((line) => truncateToWidth(line, safeWidth));
      }
      if (!details.executed) {
        lines.push(...wrapTextWithAnsi(t.muted(details.reason ?? "Statement not executed"), safeWidth));
        if (details.next_action) lines.push(...wrapTextWithAnsi(t.muted(details.next_action), safeWidth));
        return lines.map((line) => truncateToWidth(line, safeWidth));
      }
      const columns = Array.isArray(details.columns) ? details.columns.filter((column): column is string => typeof column === "string") : [];
      const rows = Array.isArray(details.rows) ? details.rows.filter((row): row is unknown[] => Array.isArray(row)) : [];
      const hasRows = columns.length > 0 && rows.length > 0;
      const dataLines = expanded && hasRows ? renderQueryData({ columns, rows, warnings: [] }, true, safeWidth, t) : [];
      const metrics = [`${details.row_count ?? 0} rows`];
      const elapsed = formatElapsed(details.elapsed_ms);
      if (elapsed) metrics.push(elapsed);
      if (details.truncated) metrics.push("truncated");
      lines.push(truncateToWidth(t.muted(metrics.join(" · ")), safeWidth));
      for (const warning of Array.isArray(details.warnings) ? details.warnings.filter((warning): warning is string => typeof warning === "string") : []) {
        lines.push(...wrapTextWithAnsi(t.muted(`Warning: ${warning}`), safeWidth));
      }
      if (dataLines.length) lines.push("", ...dataLines);
      else if (!hasRows && details.output) lines.push("", ...wrapTextWithAnsi(t.output(details.output), safeWidth));
      if (expanded && details.stderr) lines.push("", ...wrapTextWithAnsi(t.muted(`stderr: ${details.stderr}`), safeWidth));
      return lines.map((line) => truncateToWidth(line, safeWidth));
    },
    invalidate() {}
  };
}

function formatRowCount(value: number): string {
  return `${value} row${value === 1 ? "" : "s"}`;
}

function writeMetricParts(details: WriteResult): string[] {
  if (details.statement_kind === "insert" || details.statement_kind === "replace") {
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

export function formatWrite(details: WriteResult): string {
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
  if (details.trusted_for_session) lines.push("Confirmation: skipped by session trust");
  else if (details.forced_confirm) lines.push("Confirmation: required by operation safety policy");
  else if (details.write_confirm === false) lines.push("Confirmation: skipped by source policy");
  if (typeof details.warning_count === "number" && details.warning_count > 0) lines.push(`Warnings: ${details.warning_count}`);
  if (typeof details.query_id === "string") lines.push(`Query ID: ${details.query_id}`);
  return formatWriteWithSql(details, lines);
}

export function createWriteResultComponent(details: WriteResult, expanded: boolean, theme: ConfirmationTheme): Component {
  return {
    render(width: number): string[] {
      const metrics = details.executed ? writeMetricParts(details) : [];
      const status = details.cancelled
        ? theme.fg("warning", "Cancelled")
        : details.blocked
          ? theme.fg("warning", "Blocked")
          : details.blocked_reason === "confirmation_required"
            ? theme.fg("warning", "Confirmation required")
            : details.outcome === "unknown"
              ? theme.fg("warning", "Outcome unknown")
              : details.executed
                ? theme.fg("accent", "Success") + (metrics.length ? theme.fg("muted", ` · ${metrics.join(" · ")}`) : "")
                : theme.fg("warning", "Not executed");
      const lines: string[] = [];

      const sql = writeSql(details);
      if (sql) {
        lines.push(...highlightCode(sql, "sql").flatMap((line) => wrapTextWithAnsi(line, width)), "");
      }
      lines.push(truncateToWidth(status, width));

      if (expanded && (details.trusted_for_session || details.write_confirm === false || details.forced_confirm || (details.warning_count ?? 0) > 0 || details.query_id)) {
        lines.push("");
        if (details.trusted_for_session) lines.push(theme.fg("warning", "Confirmation: skipped by session trust"));
        else if (details.forced_confirm) lines.push(theme.fg("warning", "Confirmation: required by operation safety policy"));
        else if (details.write_confirm === false) lines.push(theme.fg("dim", "Confirmation: skipped by source policy"));
        if ((details.warning_count ?? 0) > 0) lines.push(theme.fg("warning", `Warnings: ${details.warning_count}`));
        if (details.query_id) lines.push(theme.fg("dim", `Query ID: ${details.query_id}`));
      }
      return lines;
    },
    invalidate() {}
  };
}
