import type { AgentToolResult, Theme, ToolRenderContext, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Container, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { DEFAULT_OPENAI_WEB_SEARCH_MODEL, OPENAI_WEB_SEARCH_TOOL_NAME } from "./openai-web-search.js";

export interface OpenAIWebSearchCallArgs {
  query?: string;
  model?: string;
}

interface SearchCallState {
  startedAt?: number;
  endedAt?: number;
}

type SearchCallContext = ToolRenderContext<SearchCallState, OpenAIWebSearchCallArgs>;

/** `truncateToWidth` appends a full SGR reset, which would cancel the tool row's background. */
const ANSI_RESET = "\x1b[0m";

/** Compact call line: `openai_web_search <query> · <model> · <status>`. */
export function renderOpenAIWebSearchCall(
  args: OpenAIWebSearchCallArgs,
  theme: Theme,
  context: SearchCallContext,
): Component {
  const query = typeof args?.query === "string" ? args.query.trim() : "";
  const model = args?.model ?? DEFAULT_OPENAI_WEB_SEARCH_MODEL;
  return new SearchCallLine(
    theme.fg("toolTitle", theme.bold(OPENAI_WEB_SEARCH_TOOL_NAME)),
    query,
    buildMetaText(theme, model, context),
    theme,
  );
}

/** Drops the query from the right so the model and status stay visible. */
class SearchCallLine implements Component {
  private readonly title: string;
  private readonly query: string;
  private readonly meta: string;
  private readonly theme: Theme;

  constructor(title: string, query: string, meta: string, theme: Theme) {
    this.title = title;
    this.query = query;
    this.meta = meta;
    this.theme = theme;
  }

  render(width: number): string[] {
    if (width <= 0) return [];
    const budget = width - visibleWidth(this.title) - visibleWidth(this.meta) - (this.query ? 1 : 0);
    let query = this.query;
    if (query && visibleWidth(query) > Math.max(0, budget)) {
      query = budget > 1 ? `${truncatePlainToWidth(query, budget - 1)}…` : "";
    }
    if (!query) return [`${this.title}${this.meta}`];
    return [`${this.title} ${this.theme.fg("text", query)}${this.meta}`];
  }

  invalidate(): void {}
}

/**
 * Keeps successful results out of the collapsed transcript: the call line already names the query,
 * model, and status. Expanding the row (ctrl+o or click) reveals the full text.
 */
export function renderOpenAIWebSearchResult(
  result: AgentToolResult<unknown>,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: SearchCallContext,
): Component {
  const text = getResultText(result);
  if (!text) return new Container();
  if (options.expanded) {
    return new Text(theme.fg(context.isError ? "error" : "toolOutput", text), 0, 0);
  }
  // Errors stay visible: they carry the actionable reason, not the long answer.
  if (context.isError) return new Text(theme.fg("error", text), 0, 0);
  return new Container();
}

function getResultText(result: AgentToolResult<unknown>): string {
  return result.content
    .filter((item): item is { type: "text"; text: string } => item.type === "text")
    .map((item) => item.text)
    .join("\n")
    .trim();
}

function buildMetaText(theme: Theme, model: string, context: SearchCallContext): string {
  const duration = resolveDuration(context);
  const parts = [theme.fg("muted", `· ${model}`)];
  if (context.isError) {
    parts.push(theme.fg("error", "· failed"));
  } else if (context.executionStarted && context.isPartial) {
    parts.push(theme.fg("muted", "· searching…"));
  } else if (duration !== undefined) {
    parts.push(theme.fg("muted", `· ${formatDuration(duration)}`));
  }
  return ` ${parts.join(" ")}`;
}

function resolveDuration(context: SearchCallContext): number | undefined {
  const state = context.state;
  if (context.executionStarted && state.startedAt === undefined) state.startedAt = Date.now();
  if (!context.isPartial && context.executionStarted && state.endedAt === undefined) {
    state.endedAt = Date.now();
  }
  if (context.durationMs !== undefined) return context.durationMs;
  if (state.startedAt === undefined || state.endedAt === undefined) return undefined;
  return Math.max(0, state.endedAt - state.startedAt);
}

function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1_000);
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

function truncatePlainToWidth(text: string, width: number): string {
  return truncateToWidth(text, width, "").replaceAll(ANSI_RESET, "");
}
