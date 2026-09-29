import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type {
  AgentToolResult,
  Theme,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { Container, Spacer, Text, getCapabilities, hyperlink, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export interface CodexImageGenFailure {
  index: number;
  error: string;
}

export interface CodexImageGenDetails {
  requestedCount: number;
  generatedCount: number;
  paths: string[];
  dimensions?: Array<string | null>;
  referenceImages?: string[];
  quality?: string;
  size?: string;
  durationMs?: number;
  failures: CodexImageGenFailure[];
  model: string;
}

export interface CodexImageGenArgs {
  prompt?: string;
  count?: number;
  quality?: string;
  reference_images?: string[];
  output_path?: string;
}

/** Subset of pi's tool render context used by these renderers. */
export interface CodexImageGenRenderContext {
  expanded?: boolean;
  executionStarted?: boolean;
  isError?: boolean;
  cwd?: string;
}

const EXPANDED_PROMPT_LINES = 12;
const RESULT_INDENT = 2;
/** `truncateToWidth` appends a full SGR reset, which would cancel the tool row's background. */
const ANSI_RESET = "\x1b[0m";

/** Wraps text to the render width and caps it to a fixed number of lines. */
class WrappedText implements Component {
  private readonly text: string;
  private readonly style: (value: string) => string;
  private readonly paddingX: number;
  private readonly maxLines: number;

  constructor(
    text: string,
    style: (value: string) => string,
    paddingX: number,
    maxLines: number,
  ) {
    this.text = text;
    this.style = style;
    this.paddingX = paddingX;
    this.maxLines = maxLines;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const inner = Math.max(1, width - this.paddingX);
    const lines = wrapParagraphs(this.text, inner);
    let shown = lines;
    if (lines.length > this.maxLines) {
      shown = lines.slice(0, this.maxLines);
      const last = shown[shown.length - 1] ?? "";
      shown[shown.length - 1] = `${truncatePlainToWidth(last, Math.max(0, inner - 1))}…`;
    }
    const padding = " ".repeat(this.paddingX);
    return shown.map((line) => `${padding}${this.style(line)}`);
  }
}

function truncatePlainToWidth(text: string, width: number): string {
  return truncateToWidth(text, width, "").replaceAll(ANSI_RESET, "");
}

function linkPath(styledText: string, relativePath: string, cwd: string | undefined): string {
  if (!cwd || !getCapabilities().hyperlinks) return styledText;
  return hyperlink(styledText, pathToFileURL(resolve(cwd, relativePath)).href);
}

function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1_000);
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

function wrapParagraphs(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.replace(/\r\n?/gu, "\n").split("\n")) {
    if (!paragraph) {
      lines.push("");
      continue;
    }
    lines.push(...wrapTextWithAnsi(paragraph, width));
  }
  return lines.length ? lines : [""];
}

export function renderCodexImageCall(
  args: CodexImageGenArgs,
  theme: Theme,
  context: CodexImageGenRenderContext,
  durationMs?: number,
): Component {
  const container = new Container();
  const count = typeof args?.count === "number" ? args.count : 1;
  const title = theme.fg("toolTitle", theme.bold(`codex_image_gen ×${count}`));
  const elapsed = typeof durationMs === "number" && Number.isFinite(durationMs)
    ? theme.fg("muted", ` · ${formatDuration(durationMs)}`)
    : context?.executionStarted && !context.isError
      ? theme.fg("muted", " · Generating…")
      : "";
  const referenceCount = args?.reference_images?.length ?? 0;
  const references = referenceCount > 0
    ? theme.fg("muted", ` · ${referenceCount} ref${referenceCount === 1 ? "" : "s"}`)
    : "";
  container.addChild(new Text(`${title}${references}${elapsed}`, 0, 0));

  const prompt = typeof args?.prompt === "string" ? args.prompt.trim() : "";
  if (prompt && context?.expanded) {
    container.addChild(
      new WrappedText(prompt, (value) => theme.fg("text", value), 0, EXPANDED_PROMPT_LINES),
    );
  }

  return container;
}

export function renderCodexImageResult(
  result: AgentToolResult<CodexImageGenDetails>,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: CodexImageGenRenderContext,
): Component {
  const details = result.details;
  if (!details) {
    const output = result.content
      .filter((item): item is { type: "text"; text: string } => item.type === "text")
      .map((item) => item.text)
      .join("\n")
      .trim();
    return new Text(context?.isError ? theme.fg("error", output) : output, 0, 0);
  }

  const container = new Container();
  const paths = details.paths;
  const complete = details.failures.length === 0 && details.generatedCount >= details.requestedCount;
  // Separate the request (prompt) from the result details only when expanded.
  if (options.expanded) container.addChild(new Spacer(1));
  if (!complete) {
    const status = `⚠ ${details.generatedCount}/${details.requestedCount} images`;
    container.addChild(new Text(theme.fg("error", status), 0, 0));
  }

  if (options.expanded) {
    const references = details.referenceImages ?? [];
    const model = [details.model, details.quality]
      .filter((part): part is string => Boolean(part))
      .join(" · ");
    const labels = [
      ...(references.length > 0 ? ["refs"] : []),
      ...(model ? ["model"] : []),
    ];
    const labelWidth = Math.max(0, ...labels.map((label) => visibleWidth(label)));
    // Keep reference and generated-image tree branches indented by one space.
    const treeIndent = 1;

    if (references.length > 1) {
      container.addChild(new Text(theme.fg("muted", "refs"), 0, 0));
      references.forEach((path, index) => {
        const branch = index === references.length - 1 ? "└ " : "├ ";
        const linkedPath = linkPath(theme.fg("accent", path), path, context.cwd);
        container.addChild(
          new Text(theme.fg("muted", branch) + linkedPath, treeIndent, 0),
        );
      });
    } else if (references.length === 1) {
      const linkedPath = linkPath(theme.fg("accent", references[0]), references[0], context.cwd);
      container.addChild(
        new Text(`${theme.fg("muted", "refs".padEnd(labelWidth))}  ${linkedPath}`, 0, 0),
      );
    }

    if (model) {
      container.addChild(
        new Text(`${theme.fg("muted", "model".padEnd(labelWidth))}  ${theme.fg("text", model)}`, 0, 0),
      );
    }

    const dimensions = details.dimensions ?? [];
    paths.forEach((path, index) => {
      const branch = index === paths.length - 1 ? "└ " : "├ ";
      const size = dimensions[index];
      const linkedPath = linkPath(theme.fg("accent", path), path, context.cwd);
      let line = theme.fg("muted", branch) + linkedPath;
      if (size) line += `  ${theme.fg("muted", `[${size}]`)}`;
      container.addChild(new Text(line, treeIndent, 0));
    });

    for (const failure of details.failures) {
      container.addChild(
        new Text(theme.fg("error", `failed  #${failure.index}  ${failure.error}`), RESULT_INDENT, 0),
      );
    }
  }

  return container;
}
