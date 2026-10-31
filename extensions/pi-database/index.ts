import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { Component } from "@mariozechner/pi-tui";
import { clickhouseAdapter } from "./src/clickhouse.js";
import {
  buildDatabaseContextPrompt,
  databaseStatusText,
  getContextCwd,
  initializeProjectConfig,
  loadProjectConfig,
  setDbxConnectionsEnabled,
  setProjectConfigEnabled
} from "./src/config.js";
import { mysqlAdapter } from "./src/mysql.js";
import { createSourceTreeComponent, formatSourceTreeText } from "./src/source-tree.js";
import type { SourceTreeTheme } from "./src/source-tree.js";
import { registerTools, serializeWrite, syncToolActivation, writeQueueKey, writeQueues, clearTrustedWriteSources, isWriteSourceTrusted, trustWriteSource, listTrustedWriteSources } from "./src/tools.js";
import {
  PingResultComponent,
  buildWriteConfirmation,
  createWriteConfirmationComponent,
  createSqlConfirmationComponent,
  createWriteResultComponent,
  databaseListView,
  formatElapsed,
  formatSqlForUi,
  formatWrite,
  formatWriteSqlForUi,
  isNumericValue,
  renderMetadataResultLines,
  renderQueryData,
  renderQueryResultLines,
  sourceDetails,
  sourceListView,
  tableDescriptionView,
  tableListView,
  tableSearchView,
  writeResultColor,
  buildUsqlConfirmation,
  createUsqlResultComponent,
  formatUsql
} from "./src/render.js";

export function registerCommands(pi: ExtensionAPI): void {
  pi.registerCommand("database", {
    description: " [list|config init|on|off|dbx on|dbx off|trust|trust off]",
    argumentHint: "list|config init|on|off|dbx on|dbx off|trust|trust off",
    getArgumentCompletions: (prefix: string) => {
      const normalized = prefix.trim().toLowerCase();
      return ["list", "config init", "on", "off", "dbx on", "dbx off", "trust", "trust off"]
        .filter((value) => value.startsWith(normalized))
        .map((value) => ({ value, label: value }));
    },
    handler: async (args, ctx) => {
      const command = args.trim().toLowerCase() || "list";
      if (command === "trust" || command === "trust off") {
        if (command === "trust off") {
          clearTrustedWriteSources();
          refreshDatabaseStatus(pi, ctx);
          ctx.ui.notify("Cleared session trust for all database sources.", "info");
          return;
        }
        const trusted = listTrustedWriteSources();
        const summary = trusted.map((source) => `${source.name}${source.database ? `/${source.database}` : ""} (${source.dialect})`).join(", ");
        ctx.ui.notify(
          trusted.length === 0 ? "No database sources are trusted for this session." : `Trusted for this session: ${summary}`,
          "info"
        );
        return;
      }
      if (command === "dbx on" || command === "dbx off") {
        const enabled = command === "dbx on";
        try {
          const result = setDbxConnectionsEnabled(getContextCwd(ctx), enabled);
          refreshDatabaseStatus(pi, ctx);
          const state = enabled ? "enabled" : "disabled";
          if (result.created) {
            ctx.ui.notify(`DBX connection import is ${state} for this project. Project settings saved to ${result.settingsPath}.`, "info");
          } else if (result.changed) {
            ctx.ui.notify(`DBX connection import is ${state} for this project.`, "info");
          } else {
            ctx.ui.notify(`DBX connection import is already ${state} for this project.`, "info");
          }
        } catch (error) {
          refreshDatabaseStatus(pi, ctx);
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        }
        return;
      }
      if (command === "list") {
        try {
          const config = loadProjectConfig(getContextCwd(ctx));
          const nodes = sourceTreeNodes(config);
          if (ctx.mode === "tui" && typeof (ctx.ui as Record<string, unknown>).custom === "function") {
            const custom = (ctx.ui as Record<string, unknown>).custom as (factory: (tui: { requestRender(force?: boolean): void }, theme: SourceTreeTheme, keybindings: unknown, done: (result: undefined) => void) => Component) => Promise<undefined>;
            await custom((tui, theme, _keybindings, done) => createSourceTreeComponent(tui, config.configPath, nodes, theme, done, config.enabled));
            return;
          }
          ctx.ui.notify(formatSourceTreeText(nodes, config.enabled).join("\n"), "info");
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
        }
        return;
      }

      if (command === "config init") {
        try {
          const result = initializeProjectConfig(getContextCwd(ctx));
          refreshDatabaseStatus(pi, ctx);
          if (result.created) {
            ctx.ui.notify(`Created project database config at ${result.configPath}.`, "info");
          } else {
            ctx.ui.notify(`A database config already exists at ${result.configPath}; no changes were made.`, "info");
          }
        } catch (error) {
          refreshDatabaseStatus(pi, ctx);
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        }
        return;
      }

      if (command !== "on" && command !== "off") {
        ctx.ui.notify("Usage: /database [list|config init|on|off|dbx on|dbx off]", "warning");
        return;
      }

      const enabled = command === "on";
      try {
        const result = setProjectConfigEnabled(getContextCwd(ctx), enabled);
        refreshDatabaseStatus(pi, ctx);
        const state = enabled ? "enabled" : "disabled";
        if (result.created) {
          ctx.ui.notify(`Database tools are ${state} for this project. Project settings saved to ${result.settingsPath}.`, "info");
        } else if (result.changed) {
          ctx.ui.notify(`Database tools are ${state} for this project.`, "info");
        } else {
          ctx.ui.notify(`Database tools are already ${state} for this project.`, "info");
        }
      } catch (error) {
        refreshDatabaseStatus(pi, ctx);
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    }
  });
}

type DatabaseStatusContext = {
  cwd?: string;
  ui: {
    setStatus(name: string, value: string | undefined): void;
    theme: { fg(color: string, text: string): string };
  };
};

function sourceTreeNodes(config: ReturnType<typeof loadProjectConfig>) {
  return config.sources.map((source) => {
    const details = sourceDetails(source, config.defaultSources[source.dialect] === source.name);
    return { ...details, host: details.host ?? "" };
  });
}

function refreshDatabaseStatus(pi: ExtensionAPI, ctx: DatabaseStatusContext): void {
  const cwd = getContextCwd(ctx);
  syncToolActivation(pi, cwd);
  try {
    const config = loadProjectConfig(cwd);
    const status = databaseStatusText(config);
    const trusted = listTrustedWriteSources();
    const suffix = trusted.length > 0
      ? ` · trusted: ${trusted.map((source) => `${source.name}${source.database ? `/${source.database}` : ""}`).join(", ")}`
      : "";
    ctx.ui.setStatus("pi-database", status === undefined ? undefined : ctx.ui.theme.fg("accent", `${status}${suffix}`));
  } catch {
    ctx.ui.setStatus("pi-database", ctx.ui.theme.fg("error", "database: config error"));
  }
}

export default function databaseExtension(pi: ExtensionAPI) {
  // Register definitions during extension loading so Pi can render persisted
  // tool rows while restoring a session, before session_start is emitted.
  registerCommands(pi);
  registerTools(pi);

  pi.on("before_agent_start", async (event, ctx) => {
    const cwd = event.cwd ?? getContextCwd(ctx);
    syncToolActivation(pi, cwd);
    const prompt = buildDatabaseContextPrompt(cwd);
    return prompt ? { systemPrompt: `${event.systemPrompt}\n\n${prompt}` } : undefined;
  });

  pi.on("session_start", async (_event, ctx) => {
    clearTrustedWriteSources();
    refreshDatabaseStatus(pi, ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    clearTrustedWriteSources();
    ctx.ui.setStatus("pi-database", undefined);
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
  createSqlConfirmationComponent,
  createWriteResultComponent,
  formatWrite,
  writeQueueKey,
  serializeWrite,
  clearTrustedWriteSources,
  isWriteSourceTrusted,
  trustWriteSource,
  listTrustedWriteSources,
  buildUsqlConfirmation,
  createUsqlResultComponent,
  formatUsql
};
