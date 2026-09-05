import type { Component } from "@mariozechner/pi-tui";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

export type SourceTreeNode = {
  name: string;
  label: string;
  dialect: string;
  default: boolean;
  host: string;
  database: string;
  allow_write: boolean;
  write_confirm: boolean;
  query_timeout_ms: number;
  max_rows: number;
};

export type SourceTreeColor = "border" | "accent" | "dim" | "muted" | "success" | "warning" | "text";

export type SourceTreeTheme = {
  fg(color: SourceTreeColor, text: string): string;
  bold(text: string): string;
};

export type SourceTreeTui = {
  requestRender(force?: boolean): void;
};

function dialectLabel(dialect: string): string {
  return dialect === "mysql" ? "MySQL" : dialect === "clickhouse" ? "ClickHouse" : dialect;
}

function sourceLabel(source: SourceTreeNode): string {
  return source.label || source.name;
}

function padToWidth(value: string, width: number): string {
  return `${value}${" ".repeat(Math.max(0, width - visibleWidth(value)))}`;
}

function columnWidths(sources: readonly SourceTreeNode[]): { label: number; dialect: number } {
  return {
    label: Math.max(1, ...sources.map((source) => visibleWidth(sourceLabel(source)))),
    dialect: Math.max(1, ...sources.map((source) => visibleWidth(dialectLabel(source.dialect))))
  };
}

export function formatSourceTreeText(sources: readonly SourceTreeNode[], enabled = true): string[] {
  const widths = columnWidths(sources);
  const lines = [`Database Sources · ${sources.length}${enabled ? "" : " · disabled"}`, ""];
  for (const source of sources) {
    const label = padToWidth(sourceLabel(source), widths.label);
    const dialect = padToWidth(dialectLabel(source.dialect), widths.dialect);
    lines.push(`${label}  ${dialect}${source.default ? "  ★" : ""}`);
  }
  return lines;
}

export function createSourceTreeComponent(
  tui: SourceTreeTui,
  _configPath: string,
  sources: readonly SourceTreeNode[],
  theme: SourceTreeTheme,
  done: (result: undefined) => void,
  enabled = true
): Component & { handleInput(data: string): void } {
  const widths = columnWidths(sources);
  const expanded = new Set<string>();
  let selected = 0;

  const hint = [
    theme.fg("dim", "↑↓"), theme.fg("muted", "select"),
    theme.fg("dim", "Enter"), theme.fg("muted", "details"),
    theme.fg("dim", "Esc"), theme.fg("muted", "close")
  ].join(" · ");

  const field = (label: string, value: string, width: number) =>
    truncateToWidth(`  ${theme.fg("dim", label.padEnd(10))}${theme.fg("muted", value)}`, Math.max(1, width));

  return {
    render(width: number): string[] {
      const safeWidth = Math.max(1, width);
      const line = (text: string) => truncateToWidth(text, safeWidth);
      const lines: string[] = [
        theme.fg("border", "─".repeat(safeWidth)),
        line(`${theme.fg("accent", theme.bold(`Database Sources · ${sources.length}`))}${enabled ? "" : theme.fg("warning", " · disabled")}`),
        ""
      ];
      sources.forEach((source, sourceIndex) => {
        const isSelected = sourceIndex === selected;
        const label = padToWidth(sourceLabel(source), widths.label);
        const dialect = padToWidth(dialectLabel(source.dialect), widths.dialect);
        const displayLabel = isSelected ? theme.fg("accent", theme.bold(label)) : theme.fg("text", label);
        const displayDialect = theme.fg("muted", dialect);
        const defaultMarker = source.default ? `  ${theme.fg("success", "★")}` : "";
        lines.push(line(`${displayLabel}  ${displayDialect}${defaultMarker}`));
        if (expanded.has(source.name)) {
          lines.push(field("source", source.name, safeWidth));
          lines.push(field("host", source.host || "—", safeWidth));
          lines.push(field("database", source.database || "—", safeWidth));
          lines.push(field("policy", `write ${source.allow_write ? "on" : "off"} · confirm ${source.write_confirm ? "on" : "off"}`, safeWidth));
          lines.push(field("limits", `${source.query_timeout_ms} ms · max ${source.max_rows} rows`, safeWidth));
        }
      });
      lines.push("", line(hint), theme.fg("border", "─".repeat(safeWidth)));
      return lines;
    },
    invalidate(): void {},
    handleInput(data: string): void {
      if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
        done(undefined);
        return;
      }
      if (sources.length === 0) return;
      if (matchesKey(data, Key.up)) {
        selected = (selected - 1 + sources.length) % sources.length;
        tui.requestRender();
      } else if (matchesKey(data, Key.down)) {
        selected = (selected + 1) % sources.length;
        tui.requestRender();
      } else if (matchesKey(data, Key.enter) || matchesKey(data, Key.right)) {
        const name = sources[selected]?.name;
        if (!name) return;
        if (expanded.has(name)) expanded.delete(name);
        else expanded.add(name);
        tui.requestRender();
      }
    }
  };
}
