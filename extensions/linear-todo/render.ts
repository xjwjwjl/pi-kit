import type { AgentToolResult, KeybindingsManager, Theme, ThemeColor, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { matchesKey, ScrollView, type Component, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
  getTodoItemStatus,
  getTodoProgress,
  isTodoAction,
  type TodoAction,
  type TodoItemStatus,
  type TodoState,
  type TodoToolDetails,
} from "./schema.ts";
import { displayText, sanitizeRenderText as toolText, type TodoRenderSnapshot } from "./src/render-shared.ts";
const CLOSE_KEYBINDING = "app.interrupt";

/** Narrow view of the injected keybindings, so the component never hardcodes a key. */
export interface TodoKeybindings {
  matches(data: string, keybinding: string): boolean;
  getKeys(keybinding: string): readonly string[];
}

export function formatKeyLabel(key: string): string {
  const names: Record<string, string> = {
    escape: "Esc",
    esc: "Esc",
    enter: "Enter",
    return: "Enter",
    tab: "Tab",
    space: "Space",
    backspace: "Backspace",
    delete: "Delete",
    ctrl: "Ctrl",
    alt: "Alt",
    shift: "Shift",
    super: "Super",
    up: "↑",
    down: "↓",
    pageUp: "PgUp",
    pageDown: "PgDn",
    home: "Home",
    end: "End",
  };
  return key
    .split("+")
    .map((part) => names[part] ?? (part.length === 1 ? part.toUpperCase() : part))
    .join("+");
}

function closeHint(keybindings?: TodoKeybindings): string {
  const [first] = keybindings?.getKeys(CLOSE_KEYBINDING) ?? [];
  return first ? `Press ${formatKeyLabel(first)} to close` : "Press Esc to close";
}

function plainContent(result: AgentToolResult<TodoToolDetails>): string {
  return result.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function statusMarker(status: TodoItemStatus): string {
  switch (status) {
    case "completed":
      return "✓";
    case "in_progress":
      return "→";
    case "blocked":
      return "!";
    case "pending":
      return "○";
  }
}

function statePhaseLabel(state: TodoState): string {
  return state.phase === "completed" ? "completed" : state.phase.toUpperCase();
}

function progressLabel(state: TodoState): string {
  const progress = getTodoProgress(state);
  return `${progress.completed}/${progress.total}`;
}

function itemLine(state: TodoState, index: number, includeResult: boolean): string {
  const item = state.items[index]!;
  const marker = statusMarker(getTodoItemStatus(state, index));
  let line = `${marker} ${index + 1}. ${displayText(item.title)}`;
  if (item.description) line += ` — description: ${displayText(item.description)}`;
  if (item.doneWhen) line += ` — done when: ${displayText(item.doneWhen)}`;
  if (includeResult && item.result) line += ` — result: ${displayText(item.result)}`;
  return line;
}

export function formatTodoListLines(snapshot: TodoRenderSnapshot, includeResults = true): string[] {
  if (snapshot.compatibilityError) {
    return ["Todo unavailable", displayText(snapshot.compatibilityError), "Use the todo clear action to start a new plan."];
  }
  if (snapshot.state === null) return ["No active Todo plan."];

  const state = snapshot.state;
  const progress = getTodoProgress(state);
  const lines = [`Todo ${progress.completed}/${progress.total} done — ${statePhaseLabel(state)}`, `Plan: ${displayText(state.title)}`, `Goal: ${displayText(state.goal)}`];
  if (state.phase === "blocked" && state.blockedReason) lines.push(`Blocked: ${displayText(state.blockedReason)}`);
  if (snapshot.paused) lines.push("Auto-continue paused.");
  lines.push("");
  for (let index = 0; index < state.items.length; index += 1) {
    lines.push(itemLine(state, index, includeResults));
  }
  if (snapshot.earlyStopWarning) {
    lines.push("");
    lines.push("Warning: agent stopped before completing the current task.");
  }
  return lines;
}

export function formatTodoListText(snapshot: TodoRenderSnapshot, includeResults = true): string {
  return formatTodoListLines(snapshot, includeResults).join("\n");
}

function styleItemLine(state: TodoState, index: number, theme: Theme): string {
  const item = state.items[index]!;
  const status = getTodoItemStatus(state, index);
  const markerColor = status === "completed" ? "success" : status === "blocked" ? "warning" : status === "in_progress" ? "accent" : "dim";
  const textColor = status === "completed" ? "muted" : "text";
  return `${theme.fg(markerColor, statusMarker(status))} ${theme.fg("muted", `${index + 1}.`)} ${theme.fg(textColor, toolText(item.title))}`;
}

const TODO_LIST_VISIBLE_LINES = 8;
const LIST_NAVIGATION = [
  ["tui.select.up", "up"],
  ["tui.select.down", "down"],
  ["tui.select.pageUp", "pageUp"],
  ["tui.select.pageDown", "pageDown"],
  ["tui.editor.cursorLineStart", "home"],
  ["tui.editor.cursorLineEnd", "end"],
] as const;

export class TodoListComponent implements Component {
  private cachedWidth?: number;
  private cachedLines?: string[];
  private readonly snapshot: TodoRenderSnapshot;
  private readonly theme: Theme;
  private readonly onClose: () => void;
  private readonly keybindings?: TodoKeybindings;
  private readonly viewport: ScrollView;
  private readonly requestRender: () => void;
  private positioned = false;
  private currentItemLine = 0;

  constructor(
    snapshot: TodoRenderSnapshot,
    theme: Theme,
    onClose: () => void,
    keybindings?: TodoKeybindings | KeybindingsManager,
    requestRender: () => void = () => {},
  ) {
    this.snapshot = snapshot;
    this.theme = theme;
    this.onClose = onClose;
    this.keybindings = keybindings as TodoKeybindings | undefined;
    // The custom screen renders flat lines; ScrollView owns the clamped viewport position.
    this.viewport = new ScrollView({ render: (width) => this.renderBody(width), invalidate: () => {} });
    this.requestRender = requestRender;
  }

  handleInput(data: string): void {
    const keys = this.keybindings?.getKeys(CLOSE_KEYBINDING) ?? [];
    const close = this.keybindings
      ? (keys.length > 0 ? this.keybindings.matches(data, CLOSE_KEYBINDING) : matchesKey(data, "escape"))
      : matchesKey(data, "escape") || matchesKey(data, "ctrl+c");
    if (close) {
      this.onClose();
      return;
    }
    const navigation = LIST_NAVIGATION.find(([binding, fallback]) =>
      this.keybindings ? this.keybindings.matches(data, binding) : matchesKey(data, fallback),
    );
    if (!navigation) return;
    switch (navigation[1]) {
      case "up": this.viewport.scrollBy(-1); break;
      case "down": this.viewport.scrollBy(1); break;
      case "pageUp": this.viewport.scrollBy(-TODO_LIST_VISIBLE_LINES); break;
      case "pageDown": this.viewport.scrollBy(TODO_LIST_VISIBLE_LINES); break;
      case "home": this.viewport.scrollToStart(); break;
      case "end": this.viewport.scrollToEnd(); break;
    }
  }

  private renderBody(width: number): string[] {
    const lines: string[] = [];
    const push = (text: string, indent = 0) => lines.push(...indentedLines(text, width, indent).map((line) => truncateToWidth(line, width)));
    this.currentItemLine = 0;
    if (this.snapshot.compatibilityError || this.snapshot.state === null) {
      for (const [index, line] of formatTodoListLines(this.snapshot, true).entries()) {
        push(this.theme.fg(this.snapshot.compatibilityError && index === 0 ? "warning" : "muted", toolText(line)));
      }
      return lines;
    }

    const state = this.snapshot.state;
    push(this.theme.fg("muted", `Goal: ${toolText(state.goal)}`));
    if (state.phase === "blocked" && state.blockedReason) {
      push(this.theme.fg("warning", `Blocked: ${toolText(state.blockedReason)}`));
    }
    if (this.snapshot.paused) push(this.theme.fg("warning", "Auto-continue paused. Run /todos resume to re-enable."));
    const focusIndex = Math.min(state.cursor, state.items.length - 1);
    for (let index = 0; index < state.items.length; index += 1) {
      if (index === focusIndex) this.currentItemLine = lines.length;
      push(styleItemLine(state, index, this.theme));
      const item = state.items[index]!;
      if (item.description) push(this.theme.fg("muted", `description: ${toolText(item.description)}`), 2);
      if (item.doneWhen) push(this.theme.fg("muted", `done when: ${toolText(item.doneWhen)}`), 2);
      if (item.result) push(this.theme.fg("muted", `完成结果: ${toolText(item.result)}`), 2);
    }
    if (this.snapshot.earlyStopWarning) push(this.theme.fg("warning", "Warning: agent stopped before completing the current task."));
    return lines;
  }

  render(width: number): string[] {
    if (width < 1) return [];
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

    const lines = ["", truncateToWidth(this.theme.fg("accent", " Todo List "), width)];
    const state = this.snapshot.compatibilityError ? null : this.snapshot.state;
    if (state) {
      const progress = getTodoProgress(state);
      lines.push(truncateToWidth(this.theme.fg("accent", `Todo ${progress.completed}/${progress.total} done — ${statePhaseLabel(state)}`), width));
      lines.push(truncateToWidth(this.theme.fg("muted", `Plan: ${toolText(state.title)}`), width));
    }
    lines.push("");
    const body = this.viewport.render(width);
    this.viewport.updateLayout(body.length, TODO_LIST_VISIBLE_LINES, () => {
      this.invalidate();
      this.requestRender();
    });
    if (!this.positioned) {
      this.positioned = true;
      if (state) this.viewport.scrollTo(Math.max(0, this.currentItemLine - 2));
    }
    const offset = this.viewport.scrollTop;
    lines.push(...body.slice(offset, offset + TODO_LIST_VISIBLE_LINES));
    lines.push("");
    if (body.length > TODO_LIST_VISIBLE_LINES) {
      lines.push(truncateToWidth(this.theme.fg("muted", `Lines ${offset + 1}–${Math.min(offset + TODO_LIST_VISIBLE_LINES, body.length)}/${body.length}`), width));
    }
    const navigation = LIST_NAVIGATION.flatMap(([binding, fallback]) => {
      const key = this.keybindings ? this.keybindings.getKeys(binding)[0] : fallback;
      return key ? [formatKeyLabel(key)] : [];
    });
    if (navigation.length > 0) {
      lines.push(truncateToWidth(this.theme.fg("dim", `Scroll: ${navigation.join(" / ")}`), width));
    }
    lines.push(truncateToWidth(this.theme.fg("dim", closeHint(this.keybindings)), width), "");

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}

type RenderContext = Parameters<NonNullable<ToolRenderers["renderCall"]>>[2];
type TodoToolContext = Partial<Pick<RenderContext, "args" | "argsComplete" | "isPartial" | "isError" | "outputPad">>;

interface TodoEvent {
  action?: TodoAction;
  progress?: string;
  summary: string;
  marker?: string;
  color?: ThemeColor;
  summaryColor?: ThemeColor;
  count?: number;
}

const EMPTY_TOOL_COMPONENT: Component = { render: () => [], invalidate() {} };

function toolArgs(args: unknown): Record<string, unknown> {
  return typeof args === "object" && args !== null && !Array.isArray(args) ? args as Record<string, unknown> : {};
}

/** Plain content lines: no background block and no blank rows, but the host's outputPad inset. */
function toolComponent(render: (width: number) => string[], outputPad = 0): Component {
  return {
    invalidate() {},
    render(width) {
      if (width <= 0) return [];
      const padding = Math.min(Math.max(0, Math.floor(outputPad)), Math.floor((width - 1) / 2));
      const innerWidth = width - padding * 2;
      const inset = " ".repeat(padding);
      return render(innerWidth).map((line) => `${inset}${truncateToWidth(line, innerWidth, "…")}${inset}`);
    },
  };
}

/** Below this width the summary wins over the counter, regardless of the content. */
const PROGRESS_MIN_WIDTH = 48;
const PROGRESS_SEPARATOR = " · ";

function eventLine(event: TodoEvent, theme: Theme, width: number): string {
  const identity = theme.fg("toolTitle", theme.bold("Todo"));
  const marker = event.marker ? `${theme.fg(event.color ?? "text", event.marker)} ` : "";
  const summary = event.summary ? toolText(event.summary) : "…";
  // One space on each side of the marker keeps the glyph centred between the name and the summary.
  const body = `${identity} ${marker}${theme.fg(event.summary ? event.summaryColor ?? "text" : "muted", summary)}`;
  if (!event.progress || width < PROGRESS_MIN_WIDTH) return truncateToWidth(body, width, "…");
  // The counter follows the summary instead of the row edge: wide terminals no longer push it
  // away from the content. Only the summary loses cells when the line does not fit.
  const reserve = visibleWidth(event.progress) + PROGRESS_SEPARATOR.length;
  const head = truncateToWidth(body, Math.max(1, width - reserve), "…");
  return `${head}${theme.fg("dim", PROGRESS_SEPARATOR)}${theme.fg("muted", event.progress)}`;
}

function resultEvent(result: AgentToolResult<TodoToolDetails>, context: TodoToolContext): TodoEvent {
  const details = result.details;
  const args = toolArgs(context.args);
  const action = isTodoAction(details?.action) ? details.action : isTodoAction(args.action) ? args.action : undefined;
  const state = details?.state;
  const event: TodoEvent = {
    action,
    progress: state ? progressLabel(state) : undefined,
    summary: details?.transition ?? plainContent(result),
  };
  if (details?.compatibilityError) {
    return { ...event, progress: undefined, summary: `不可用：${details.compatibilityError}`, marker: "!", color: "warning" };
  }
  if (details?.error || context.isError) {
    // A rejected call did not move the plan, so its old counter would read as progress.
    return {
      ...event,
      progress: undefined,
      summary: details?.error || plainContent(result) || "操作失败",
      marker: "✗",
      color: "error",
      summaryColor: "error",
    };
  }
  if (!state) {
    if (details?.state === null && action === "show") event.summary = "暂无计划";
    if (details?.state === null && action === "undo") event.summary = "已撤销计划创建";
    if (details?.state === null && action === "clear") event.summary = "已清空当前计划";
    return event;
  }
  if (state.phase === "blocked") {
    return { ...event, summary: state.blockedReason ?? "计划受阻", marker: "!", color: "warning" };
  }

  const current = state.items[state.cursor];
  const previous = state.undo?.state;
  switch (action) {
    case "plan":
    case "replan":
      event.summary = `${action === "plan" ? "创建计划" : "调整计划"}：${state.title}`;
      if (state.phase === "completed") {
        event.marker = "✓";
        event.color = "success";
        event.summary = "计划完成";
        event.summaryColor = "success";
      }
      break;
    case "advance": {
      const count = previous?.planId === state.planId ? state.cursor - previous.cursor : 1;
      event.count = count;
      event.marker = "✓";
      event.color = "success";
      if (state.phase === "completed") {
        event.summary = "计划完成";
        event.summaryColor = "success";
      } else if (count > 1 && count !== state.cursor) {
        // Only label the batch when it differs from the counter's numerator; otherwise the
        // "等 N 项" repeats the progress already shown to the right.
        event.summary = `${state.items[state.cursor - 1]?.title ?? "已完成"} 等 ${count} 项`;
      } else {
        event.summary = state.items[state.cursor - 1]?.title ?? "已完成当前任务";
      }
      break;
    }
    case "resume":
      event.summary = current ? `已恢复 ${current.title}` : "计划完成";
      break;
    case "show":
      if (state.phase === "completed") {
        event.marker = "✓";
        event.color = "success";
        event.summary = "计划完成";
        event.summaryColor = "success";
      } else {
        event.summary = current ? `查看 ${current.title}` : "暂无任务";
      }
      break;
    case "insert": {
      const count = Array.isArray(args.tasks) ? args.tasks.length : previous ? state.items.length - previous.items.length : 0;
      const position = args.position === "end" ? "追加到末尾" : "当前项之后";
      event.count = count;
      event.summary = count > 0 ? `补充 ${count} 项任务（${position}）` : "已补充任务";
      break;
    }
    case "undo":
      event.summary = "已撤销上次变更";
      break;
  }
  return event;
}

function indentedLines(text: string, width: number, indent: number): string[] {
  const padding = " ".repeat(Math.min(indent, Math.max(0, width - 1)));
  return wrapTextWithAnsi(text, width - padding.length).map((line) => padding + line);
}

interface DetailLine {
  /** Already themed; may contain ANSI escapes. */
  readonly text: string;
  readonly indent?: number;
}

interface DetailSection {
  readonly label: string;
  readonly labelColor?: ThemeColor;
  readonly marker?: { readonly text: string; readonly color: ThemeColor };
  readonly value?: string;
  readonly valueColor?: ThemeColor;
  readonly body?: readonly DetailLine[];
}

const DETAIL_SECTION = "  ├─ ";
const DETAIL_GUIDE = "  │ ";
const DETAIL_CLOSE = "  ╰─";
const DETAIL_MIN_RAIL_WIDTH = 24;

/** The reducer's clear summary is the only record of how many unfinished tasks were dropped. */
function clearedPlanText(transition: string | undefined): string {
  const unfinished = /with (\d+) unfinished/.exec(transition ?? "");
  if (unfinished) return `已清空当前计划（${unfinished[1]} 项未完成）`;
  return transition?.includes("completed") ? "已清空已完成的计划" : "已清空当前计划";
}

/** Only the tasks this call added or replaced, so a plan row does not replay earlier history. */
function addedItemRange(
  state: TodoState,
  action: TodoAction | undefined,
  args: Record<string, unknown>,
): { start: number; end: number } | undefined {
  const previous = state.undo?.state;
  if (action === "plan") return { start: 0, end: state.items.length };
  if (action === "replan" && previous?.planId === state.planId) return { start: previous.cursor, end: state.items.length };
  if (action === "insert") {
    const count = Array.isArray(args.tasks) ? args.tasks.length : 0;
    if (count <= 0) return undefined;
    const start = args.position === "end" ? state.items.length - count : state.cursor + 1;
    return { start: Math.max(0, start), end: Math.min(state.items.length, start + count) };
  }
  return undefined;
}

function completedItemRange(state: TodoState, event: TodoEvent): { start: number; end: number } {
  const previous = state.undo?.state;
  const start = previous?.planId === state.planId ? previous.cursor : Math.max(0, state.cursor - (event.count ?? 1));
  return { start, end: state.cursor };
}

function outcomeLines(state: TodoState, event: TodoEvent, args: Record<string, unknown>, theme: Theme): DetailLine[] {
  const lines: DetailLine[] = [];
  if (event.action === "advance") {
    const { start, end } = completedItemRange(state, event);
    for (const item of state.items.slice(start, end)) {
      lines.push({ text: theme.fg("success", "✓ ") + theme.fg("text", toolText(item.title)) });
      if (item.result) lines.push({ text: theme.fg("muted", toolText(item.result)), indent: 2 });
    }
    return lines;
  }
  const range = addedItemRange(state, event.action, args);
  if (!range) return lines;
  for (const item of state.items.slice(range.start, range.end)) {
    lines.push({ text: theme.fg("accent", "+ ") + theme.fg("text", toolText(item.title)) });
    if (item.description) lines.push({ text: theme.fg("dim", `说明 ${toolText(item.description)}`), indent: 2 });
    if (item.doneWhen) lines.push({ text: theme.fg("dim", `验收 ${toolText(item.doneWhen)}`), indent: 2 });
  }
  return lines;
}

interface DetailLayout {
  readonly sections: readonly DetailSection[];
  readonly footer?: string;
}

const DETAIL_FOOTER = "/todos 查看完整计划";

function detailSections(
  result: AgentToolResult<TodoToolDetails>,
  event: TodoEvent,
  context: TodoToolContext,
  theme: Theme,
): DetailLayout {
  const details = result.details;
  const args = toolArgs(context.args);
  const state = details?.state;
  const sections: DetailSection[] = [];
  if (event.action) {
    const count = event.count && event.count > 1 ? ` · 本次 ${event.count} 项` : "";
    sections.push({ label: "操作", value: `${event.action}${count}` });
  }
  if (details?.compatibilityError) {
    sections.push({ label: "错误", value: details.compatibilityError, valueColor: "warning", labelColor: "warning" });
    return { sections };
  }
  if (details?.error || context.isError) {
    sections.push({
      label: "错误",
      value: details?.error || plainContent(result) || event.summary,
      valueColor: "error",
      labelColor: "error",
    });
    if (!state) return { sections };
    // The rejected call left the plan where it was; label that state instead of implying progress.
    sections.push({ label: "计划", value: state.title });
    sections.push(currentSection(state));
    return { sections, footer: DETAIL_FOOTER };
  }
  if (!state) {
    sections.push({ label: "结果", value: event.action === "clear" ? clearedPlanText(details?.transition) : event.summary });
    return { sections };
  }

  // Primary content first: what this call produced, then the plan it belongs to.
  if (state.phase === "blocked" && state.blockedReason) {
    sections.push({ label: "受阻", value: state.blockedReason, labelColor: "warning" });
  }
  const outcome = outcomeLines(state, event, args, theme);
  if (outcome.length > 0) sections.push({ label: "结果", body: outcome });
  sections.push({ label: "计划", value: state.title });
  sections.push({ label: "目标", value: state.goal });
  if (event.action === "replan" && typeof args.reason === "string" && args.reason) {
    sections.push({ label: "原因", value: args.reason });
  }
  sections.push(currentSection(state));
  return { sections, footer: DETAIL_FOOTER };
}

function currentSection(state: TodoState): DetailSection {
  const current = state.items[state.cursor];
  const finished = state.phase === "completed";
  return {
    label: "当前",
    marker: finished ? { text: "✓", color: "success" } : current ? { text: "→", color: "accent" } : undefined,
    value: finished ? "计划完成" : current ? current.title : "暂无任务",
  };
}

/**
 * compact-tool-ui tree: \`├─\` introduces a section, \`│ \` carries its content on one shared
 * column, and \`╰─\` closes the tree. Inline label/value pairs are deliberately avoided so no
 * second value column appears.
 */
function renderDetailSections(layout: DetailLayout, theme: Theme, width: number): string[] {
  const { sections, footer } = layout;
  const rail = width >= DETAIL_MIN_RAIL_WIDTH;
  const sectionPrefix = rail ? DETAIL_SECTION : "  ";
  const guide = rail ? DETAIL_GUIDE : "  ";
  const available = Math.max(1, width - visibleWidth(guide));
  const lines: string[] = [];
  const emit = (text: string, indent = 0) => {
    const prefix = " ".repeat(Math.min(indent, available - 1));
    for (const line of wrapTextWithAnsi(text, Math.max(1, available - prefix.length))) {
      lines.push(theme.fg("borderMuted", guide) + prefix + line);
    }
  };

  for (const section of sections) {
    const head = theme.bold(theme.fg(section.labelColor ?? "muted", section.label));
    const headWidth = Math.max(1, width - visibleWidth(sectionPrefix));
    for (const line of wrapTextWithAnsi(head, headWidth)) lines.push(theme.fg("borderMuted", sectionPrefix) + line);
    if (section.value !== undefined) {
      const marker = section.marker ? `${theme.fg(section.marker.color, section.marker.text)} ` : "";
      emit(marker + theme.fg(section.valueColor ?? "text", toolText(section.value)));
    }
    for (const line of section.body ?? []) emit(line.text, line.indent ?? 0);
  }
  if (rail) {
    const close = theme.fg("borderMuted", DETAIL_CLOSE);
    lines.push(footer ? `${close} ${theme.fg("muted", footer)}` : close);
  } else if (footer) {
    emit(theme.fg("muted", footer));
  }
  return lines;
}

function expandedEventLines(
  result: AgentToolResult<TodoToolDetails>,
  event: TodoEvent,
  context: TodoToolContext,
  theme: Theme,
  width: number,
): string[] {
  return renderDetailSections(detailSections(result, event, context, theme), theme, width);
}

export function renderTodoCall(args: unknown, theme: Theme, context: TodoToolContext = {}): Component {
  // On completion the result slot owns the entire event. No shared mutable state is needed, so
  // replayed calls and older rows cannot accidentally pick up the live Widget's current state.
  if (context.isPartial === false) return EMPTY_TOOL_COMPONENT;
  const record = toolArgs(args);
  const event: TodoEvent = { action: isTodoAction(record.action) ? record.action : undefined, summary: "…" };
  if (context.argsComplete !== false) {
    if (typeof record.reason === "string") {
      event.summary = record.reason;
    } else if (typeof record.title === "string") {
      event.summary = event.action === "plan" ? `正在创建计划：${record.title}` : record.title;
    } else if (Array.isArray(record.tasks)) {
      event.summary = `${record.tasks.length} 项任务`;
    } else if (Array.isArray(record.completions)) {
      event.summary = `${record.completions.length} 项完成记录`;
    }
  }
  return toolComponent((width) => [eventLine(event, theme, width)], context.outputPad);
}

export function renderTodoResult(
  result: AgentToolResult<TodoToolDetails>,
  options: { expanded: boolean; isPartial?: boolean },
  theme: Theme,
  context: TodoToolContext = {},
): Component {
  if (options.isPartial) return EMPTY_TOOL_COMPONENT;
  const event = resultEvent(result, context);
  return toolComponent((width) => {
    const lines = [eventLine(event, theme, width)];
    if (options.expanded) lines.push(...expandedEventLines(result, event, context, theme, width));
    return lines;
  }, context.outputPad);
}
