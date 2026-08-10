import type { Component } from "@mariozechner/pi-tui";
import { Key, matchesKey, truncateToWidth } from "@mariozechner/pi-tui";

export type SourceTreeNode = {
  name: string;
  dialect: string;
  default: boolean;
  host: string;
  database: string;
  allow_write: boolean;
  write_confirm: boolean;
  query_timeout_ms: number;
  max_rows: number;
};

export type SourceTreeColor = "border" | "accent" | "dim" | "muted" | "success" | "text";

export type SourceTreeTheme = {
  fg(color: SourceTreeColor, text: string): string;
  bold(text: string): string;
};

export type SourceTreeTui = {
  requestRender(force?: boolean): void;
};

export function createSourceTreeComponent(
  tui: SourceTreeTui,
  configPath: string,
  sources: readonly SourceTreeNode[],
  theme: SourceTreeTheme,
  done: (result: undefined) => void
): Component & { handleInput(data: string): void } {
  const defaultNames = sources.filter((source) => source.default).map((source) => source.name);
  const expanded = new Set(defaultNames.length > 0 ? defaultNames : sources.length === 1 ? [sources[0]!.name] : []);
  let selected = 0;

  const hint = [
    theme.fg("dim", "↑↓"), theme.fg("muted", "select"),
    theme.fg("dim", "Enter"), theme.fg("muted", "toggle"),
    theme.fg("dim", "Esc"), theme.fg("muted", "close")
  ].join(" · ");

  const field = (label: string, value: string, width: number) =>
    truncateToWidth(`      ${theme.fg("dim", label.padEnd(10))}${theme.fg("muted", value)}`, Math.max(1, width));

  return {
    render(width: number): string[] {
      const safeWidth = Math.max(1, width);
      const line = (text: string) => truncateToWidth(text, safeWidth);
      const lines: string[] = [
        theme.fg("border", "─".repeat(safeWidth)),
        line(`${theme.fg("accent", theme.bold(`Database Sources · ${sources.length}`))}${theme.fg("dim", ` · ${configPath}`)}`),
        ""
      ];
      sources.forEach((source, index) => {
        const isSelected = index === selected;
        const isExpanded = expanded.has(source.name);
        const flag = source.default ? theme.fg("success", " · default") : "";
        const name = isSelected ? theme.fg("accent", theme.bold(source.name)) : theme.fg("text", source.name);
        lines.push(line(` ${isSelected ? theme.fg("accent", "›") : " "} ${theme.fg("muted", isExpanded ? "▼" : "▶")} ${name}${theme.fg("muted", ` (${source.dialect})`)}${flag}`));
        if (isExpanded) {
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
