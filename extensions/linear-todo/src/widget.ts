import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { getTodoProgress } from "../schema.ts";
import { sanitizeRenderText, type TodoRenderSnapshot } from "./render-shared.ts";

const VISIBLE_COMPLETED_LIMIT = 2;
const VISIBLE_REMAINING_LIMIT = 3;
const MIN_FRAME_WIDTH = 12;
const FRAME_WIDTH = visibleWidth("╭─ ");

export interface TodoWidgetRow {
  readonly title: string;
  readonly kind: "completed" | "current" | "pending";
}

export interface TodoWidgetAlerts {
  readonly blocked: boolean;
  readonly blockedReason?: string;
  readonly paused: boolean;
  readonly earlyStop: boolean;
}

export interface TodoWidgetPlan {
  readonly kind: "plan";
  readonly title: string;
  readonly progress: { readonly completed: number; readonly total: number };
  readonly rows: readonly TodoWidgetRow[];
  readonly hiddenCompleted: number;
  readonly hiddenPending: number;
  readonly alerts: TodoWidgetAlerts;
}

export type TodoWidgetModel =
  | { readonly kind: "hidden" }
  | { readonly kind: "unavailable"; readonly message: string }
  | TodoWidgetPlan;

/** Select recent completions, the current task and the next two once for both UI modes. */
export function buildTodoWidgetModel(snapshot: TodoRenderSnapshot): TodoWidgetModel {
  if (snapshot.compatibilityError !== undefined) {
    return { kind: "unavailable", message: sanitizeRenderText(snapshot.compatibilityError) };
  }
  const state = snapshot.state;
  if (state === null) return { kind: "hidden" };
  // A completed plan keeps its full state for /todos and undo, but a released completion
  // (settled, or restored by undo) drops the Widget just like a cleared plan.
  if (state.phase === "completed" && snapshot.completedDismissed === true) return { kind: "hidden" };

  const { completed, total } = getTodoProgress(state);
  const start = Math.max(0, state.cursor - VISIBLE_COMPLETED_LIMIT);
  const end = Math.min(state.items.length, state.cursor + VISIBLE_REMAINING_LIMIT);
  const rows: TodoWidgetRow[] = state.items.slice(start, end).map((item, offset) => {
    const index = start + offset;
    return {
      title: sanitizeRenderText(item.title),
      kind: index < state.cursor ? "completed" : index === state.cursor ? "current" : "pending",
    };
  });
  const finished = state.phase === "completed";
  return {
    kind: "plan",
    title: sanitizeRenderText(state.title),
    progress: { completed, total },
    rows,
    hiddenCompleted: start,
    hiddenPending: total - end,
    alerts: {
      blocked: state.phase === "blocked",
      blockedReason: state.phase === "blocked" && state.blockedReason !== undefined
        ? sanitizeRenderText(state.blockedReason)
        : undefined,
      paused: !finished && snapshot.paused === true,
      earlyStop: !finished && snapshot.earlyStopWarning === true,
    },
  };
}

function progressText(plan: TodoWidgetPlan): string {
  return `${plan.progress.completed}/${plan.progress.total}`;
}

function rowMarker(row: TodoWidgetRow): string {
  return row.kind === "completed" ? "✓" : row.kind === "current" ? "→" : "○";
}

function hiddenCompletedText(count: number): string {
  return `较早已完成 ${count} 项`;
}

function hiddenPendingText(count: number): string {
  return `另有 ${count} 项待办`;
}

interface AlertPart {
  text: string;
  color: "warning" | "text" | "muted";
}

function alertParts(alerts: TodoWidgetAlerts): AlertPart[] {
  const labels: string[] = [];
  if (alerts.blocked) labels.push("阻塞");
  if (alerts.paused) labels.push("自动续跑已暂停");
  if (alerts.earlyStop) labels.push("提前停止");
  if (labels.length === 0) return [];

  const parts: AlertPart[] = [{ text: `! ${labels.join(" · ")}`, color: "warning" }];
  if (alerts.blocked && alerts.blockedReason) {
    parts.push({ text: `${labels.length === 1 ? "：" : " · 原因："}${alerts.blockedReason}`, color: "text" });
  }
  if (alerts.paused && labels.length === 1) parts.push({ text: " · /todos resume", color: "muted" });
  return parts;
}

/** RPC has no terminal width; render the same selected rows without theme or layout padding. */
export function formatTodoWidgetLines(model: TodoWidgetModel): string[] {
  if (model.kind === "hidden") return [];
  if (model.kind === "unavailable") return [`Todo 不可用：${model.message}`];

  const lines = [`计划：${model.title} · ${progressText(model)}`];
  if (model.hiddenCompleted > 0) lines.push(`  … ${hiddenCompletedText(model.hiddenCompleted)}`);
  for (const row of model.rows) {
    lines.push(`  ${rowMarker(row)} ${row.title}`);
  }
  if (model.hiddenPending > 0) lines.push(`  … ${hiddenPendingText(model.hiddenPending)}`);
  const alert = alertParts(model.alerts).map((part) => part.text).join("");
  if (alert) lines.push(`  ${alert}`);
  return lines;
}

function renderHeader(plan: TodoWidgetPlan, theme: Theme, width: number): string {
  const count = `${plan.progress.completed}/${plan.progress.total}`;
  const countColor = plan.progress.completed > 0 ? "success" : "text";
  const progressLabel = "（";
  const progressEnd = "）";
  const titleWidth = width - visibleWidth(progressLabel + count + progressEnd);
  if (titleWidth < 1) {
    return truncateToWidth(theme.fg(countColor, count), width, "…");
  }
  return theme.fg("text", truncateToWidth(plan.title, titleWidth, "…"))
    + theme.fg("muted", progressLabel)
    + theme.fg(countColor, count)
    + theme.fg("muted", progressEnd);
}

function renderRow(row: TodoWidgetRow, blocked: boolean, theme: Theme, width: number): string {
  const prefix = `${rowMarker(row)} `;
  const current = row.kind === "current";
  const completed = row.kind === "completed";
  const currentBlocked = current && blocked;
  const markerColor = completed ? "success" : currentBlocked ? "warning" : current ? "accent" : "muted";
  const titleColor = completed ? "muted" : current && !blocked ? "accent" : "text";
  let title = theme.fg(titleColor, row.title);
  if (current) title = theme.bold(title);
  return truncateToWidth(theme.fg(markerColor, prefix) + title, width, "…");
}

function renderAlert(alerts: TodoWidgetAlerts, theme: Theme, width: number): string {
  const parts = alertParts(alerts);
  if (parts.length === 0) return "";
  const signal = theme.fg(parts[0]!.color, parts[0]!.text);
  // A fitting status must not lose its final glyph merely to make room for a clipped reason.
  if (visibleWidth(signal) >= width) return truncateToWidth(signal, width, "…");
  const detail = parts.slice(1).map((part) => theme.fg(part.color, part.text)).join("");
  return truncateToWidth(signal + detail, width, "…");
}

/** This component displays plan position, not execution telemetry, and never mutates the plan. */
export class TodoWidget implements Component {
  private readonly model: TodoWidgetModel;
  private readonly theme: Theme;
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(model: TodoWidgetModel, theme: Theme) {
    this.model = model;
    this.theme = theme;
  }

  render(width: number): string[] {
    if (width <= 0) return [];
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

    const model = this.model;
    const lines: string[] = [];
    if (model.kind === "unavailable") {
      const unavailable = this.theme.fg("warning", "Todo 不可用：") + this.theme.fg("text", model.message);
      lines.push(truncateToWidth(unavailable, width, "…"));
    } else if (model.kind === "plan") {
      const framed = width >= MIN_FRAME_WIDTH;
      const contentWidth = width - (framed ? FRAME_WIDTH : 0);
      lines.push(renderHeader(model, this.theme, contentWidth));
      if (model.hiddenCompleted > 0) {
        lines.push(truncateToWidth(this.theme.fg("muted", `… ${hiddenCompletedText(model.hiddenCompleted)}`), contentWidth, "…"));
      }
      for (const row of model.rows) lines.push(renderRow(row, model.alerts.blocked, this.theme, contentWidth));
      if (model.hiddenPending > 0) {
        lines.push(truncateToWidth(this.theme.fg("muted", hiddenPendingText(model.hiddenPending)), contentWidth, "…"));
      }
      const alert = renderAlert(model.alerts, this.theme, contentWidth);
      if (alert) lines.push(alert);
      if (framed) {
        for (let index = 0; index < lines.length; index += 1) {
          const prefix = index === 0 ? "╭─ " : index === lines.length - 1 ? "╰─ " : "│  ";
          lines[index] = this.theme.fg("dim", prefix) + lines[index];
        }
      }
    }

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}
