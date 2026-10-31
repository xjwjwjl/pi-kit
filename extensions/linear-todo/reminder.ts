import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type ExtensionMode = ExtensionContext["mode"];
import {
  getTodoItemStatus,
  getTodoProgress,
  TODO_MAX_AUTO_CONTINUES_PER_STAGE,
  TODO_REMINDER_GOAL_MAX_LENGTH,
  TODO_REMINDER_MAX_LENGTH,
  type TodoItemStatus,
  type TodoState,
} from "./schema.ts";
import type { TodoRuntimeState } from "./state.ts";

export const TODO_CONTEXT_CUSTOM_TYPE = "linear-todo-context";
/** Correct an unfinished run without making an old plan override the latest request. */
export const TODO_AUTO_CONTINUE_TEXT =
  "Continue the current Todo task for the latest user request. Check its completion condition, finish the work, then call todo advance with completions for consecutive tasks already completed and optional observed results. If the request supersedes this plan, revise or clear it instead of executing obsolete tasks. If genuinely blocked or waiting for user input, call todo block with the concrete reason. Do not claim unrun checks or stop just to summarize.";
export const TODO_REMINDER_INTERVAL_TURNS = 3;
export { TODO_MAX_AUTO_CONTINUES_PER_STAGE, TODO_REMINDER_MAX_LENGTH };

export type ReminderMode = "compact" | "full";
export type ReminderReason = "force" | "user" | "periodic" | "skip" | "none";

export interface ReminderDecision {
  mode: ReminderMode | null;
  reason: ReminderReason;
}

/** Per-field cap so one long field can never consume the whole reminder budget. */
const FIELD_CAP = 120;
/** Share of the budget reserved for the task list in `full` mode. */
const TASKS_BUDGET = 150;

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function clip(text: string, max: number): string {
  if (max <= 0) return "";
  if (text.length <= max) return text;
  if (max === 1) return "…";
  return `${text.slice(0, max - 1)}…`;
}

function itemMarker(status: TodoItemStatus): string {
  switch (status) {
    case "completed":
      return "[x]";
    case "in_progress":
      return "[>]";
    case "blocked":
      return "[!]";
    case "pending":
      return "[ ]";
  }
}

function currentItem(state: TodoState): TodoState["items"][number] | undefined {
  return state.items[state.cursor];
}

function nextItem(state: TodoState): TodoState["items"][number] | undefined {
  return state.items[state.cursor + 1];
}

/**
 * Build the reminder with a budget instead of slicing the finished string.
 *
 * The old implementation assembled every line and cut the result at 600 characters, so a
 * maximum-length goal and title deleted `Next:` and the whole task list. Lines are now added
 * in priority order with per-field caps, and the task list gets a reserved share.
 */
export function buildReminder(state: TodoState, mode: ReminderMode, options: { paused?: boolean } = {}): string {
  return buildWorkingContext(state, mode, options);
}

/** Tool feedback keeps the complete execution contract; injected reminders use a bounded preview. */
function buildWorkingContext(state: TodoState, mode: ReminderMode, options: { paused?: boolean }, unabridged = false): string {
  const { completed, total } = getTodoProgress(state);
  const phaseLabel = state.phase === "active" ? "" : ` — ${state.phase}`;
  const lines: string[] = [];
  let used = 0;

  const remaining = () => unabridged ? Infinity : TODO_REMINDER_MAX_LENGTH - used;
  const push = (line: string) => {
    lines.push(line);
    used += line.length + 1;
  };
  const pushField = (label: string, value: string, cap = FIELD_CAP): boolean => {
    const room = Math.min(unabridged ? Infinity : cap, remaining() - label.length - 1);
    if (room < 8) return false;
    push(`${label} ${clip(value, room)}`);
    return true;
  };

  push(`[Todo ${completed}/${total}${phaseLabel}]`);
  pushField("Plan:", oneLine(state.title), 60);
  if (options.paused) push("Auto-continue: paused.");

  if (state.phase !== "completed") {
    const current = currentItem(state);
    // `full` renders every task with a marker, so repeating Current/Next there only spends budget.
    if (current && mode === "compact") pushField("Current:", oneLine(current.title));
    // Keep execution details separate from acceptance and leave room for goal and task context.
    if (current?.description) pushField("Description:", oneLine(current.description), 72);
    if (state.phase === "blocked" && state.blockedReason) pushField("Blocked:", oneLine(state.blockedReason), 40);
    if (current?.doneWhen) pushField("Done when:", oneLine(current.doneWhen), 60);
    const next = nextItem(state);
    if (next && mode === "compact") pushField("Next:", oneLine(next.title), 40);
  }

  const tasksReserve = mode === "full" ? Math.min(TASKS_BUDGET, Math.max(0, remaining() - 40)) : 0;
  const goalRoom = Math.min(unabridged ? Infinity : TODO_REMINDER_GOAL_MAX_LENGTH, remaining() - tasksReserve - "Goal:".length - 1);
  if (goalRoom >= 16) push(`Goal: ${clip(oneLine(state.goal), goalRoom)}`);

  if (mode === "full") pushTaskLines(state, remaining(), push);

  return lines.join("\n");
}

export function buildTodoToolFeedback(state: TodoState | null, summary: string, paused = false): string {
  if (state === null) return summary;
  return `${summary}\n${buildWorkingContext(state, "compact", { paused }, true)}`;
}

export function buildAutoContinueText(state: TodoState): string {
  return `${TODO_AUTO_CONTINUE_TEXT}\n${buildReminder(state, "compact")}`;
}

function pushTaskLines(state: TodoState, budget: number, push: (line: string) => void): void {
  if (state.items.length === 0 || budget <= 0) return;
  const rendered = state.items.map(
    (item, index) => `${itemMarker(getTodoItemStatus(state, index))} ${oneLine(item.title)}`,
  );

  // Reserve the widest possible header so the selected lines always fit afterwards.
  const headerReserve = `Tasks (1-${rendered.length} of ${rendered.length}):`.length + 1;
  const bodyBudget = budget - headerReserve;

  const collect = (from: number): string[] => {
    const selected: string[] = [];
    let used = 0;
    for (let index = from; index < rendered.length; index += 1) {
      const line = rendered[index]!;
      if (used + line.length + 1 > bodyBudget) break;
      selected.push(line);
      used += line.length + 1;
    }
    return selected;
  };

  // Prefer the whole plan from the start; fall back to a window that keeps the current task.
  let start = 0;
  let selected = collect(0);
  if (selected.length <= state.cursor) {
    start = Math.min(state.cursor, state.items.length - 1);
    selected = collect(start);
  }

  if (selected.length === 0) {
    // No room for a header and a full line: keep at least the current task, clipped.
    const room = budget - 5;
    if (room < 8) return;
    push(`${itemMarker(getTodoItemStatus(state, start))} ${clip(oneLine(state.items[start]!.title), room)}`);
    return;
  }

  const end = start + selected.length;
  push(
    start === 0 && end >= rendered.length ? "Tasks:" : `Tasks (${start + 1}-${end} of ${rendered.length}):`,
  );
  for (const line of selected) push(line);
}

export function selectReminder(runtime: TodoRuntimeState): ReminderDecision {
  const state = runtime.todo;
  if (state === null || state.phase === "completed") return { mode: null, reason: "none" };
  if (runtime.forceReminder) return { mode: "full", reason: "force" };
  if (runtime.userTurnReminder) return { mode: "compact", reason: "user" };
  if (runtime.skipNextContextReminder) return { mode: null, reason: "skip" };
  if (runtime.turnsSinceMutation >= TODO_REMINDER_INTERVAL_TURNS) {
    return { mode: "compact", reason: "periodic" };
  }
  return { mode: null, reason: "none" };
}

export function shouldInjectReminder(runtime: TodoRuntimeState): boolean {
  return selectReminder(runtime).mode !== null;
}

export function shouldAutoContinue(input: {
  mode: ExtensionMode;
  state: TodoState | null;
  hasPendingMessages: boolean;
  lastRunStopReason?: string;
  lastRunWasUserAbort: boolean;
  alreadyNudged: boolean;
  nudgesAtStage: number;
  paused?: boolean;
  runtimeActive?: boolean;
}): boolean {
  const { mode, state } = input;
  if (input.runtimeActive === false) return false;
  if (input.paused === true) return false;
  if (mode !== "tui" && mode !== "rpc") return false;
  if (state === null || state.phase !== "active" || state.cursor >= state.items.length) return false;
  if (input.hasPendingMessages || input.lastRunWasUserAbort || input.alreadyNudged) return false;
  // Explicit block/resume may grant another correction, but never beyond this position's cap.
  if (input.nudgesAtStage >= TODO_MAX_AUTO_CONTINUES_PER_STAGE) return false;
  if (
    input.lastRunStopReason === "error" ||
    input.lastRunStopReason === "aborted" ||
    input.lastRunStopReason === "deferred"
  ) {
    return false;
  }
  return true;
}
