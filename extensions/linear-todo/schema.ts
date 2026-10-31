import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";

export const TODO_SCHEMA_VERSION = 3 as const;
export const TODO_MAX_ITEMS = 20;
export const TODO_RECOMMENDED_MAX_ITEMS = 7;
export const TODO_GOAL_MAX_LENGTH = 300;
export const TODO_TITLE_MAX_LENGTH = 60;
export const TODO_DESCRIPTION_MAX_LENGTH = 300;
export const TODO_DONE_WHEN_MAX_LENGTH = 300;
export const TODO_RESULT_MAX_LENGTH = 1_000;
export const TODO_REASON_MAX_LENGTH = 500;
export const TODO_REMINDER_MAX_LENGTH = 600;
/** Reminder budget reserved for the goal line before the task list is rendered. */
export const TODO_REMINDER_GOAL_MAX_LENGTH = 120;
/** Auto-continues allowed at one (planId, cursor) position before the extension stops nudging. */
export const TODO_MAX_AUTO_CONTINUES_PER_STAGE = 3;

export const TodoActionSchema = StringEnum(
  ["plan", "advance", "replan", "insert", "undo", "block", "resume", "show", "clear"] as const,
  { description: "The Todo state transition to perform." },
);
export type TodoAction = Static<typeof TodoActionSchema>;

export const TodoPositionSchema = StringEnum(["next", "end"] as const, {
  description: "Where insert places new tasks: right after the current task (default) or at the end of the plan.",
});
export type TodoPosition = Static<typeof TodoPositionSchema>;

const TodoPlanTitleSchema = Type.String({
  description: "A stable, concise action overview covering the whole plan (verb + object, e.g. 检查并整理 wifi-audit), never just the current step. Put full scope in goal and execution details in task description. Required for plan and whenever replan changes the normalized goal.",
  minLength: 1,
  maxLength: TODO_TITLE_MAX_LENGTH,
});

export const TodoTaskInputSchema = Type.Object(
  {
    title: Type.String({
      description: "A concise action name (verb + object). Put execution details in description, acceptance criteria in doneWhen, and observed results only in advance completions.",
      minLength: 1,
      maxLength: TODO_TITLE_MAX_LENGTH,
    }),
    description: Type.Optional(
      Type.String({
        description: "Optional execution details and scope, not acceptance criteria or observed results.",
        minLength: 1,
        maxLength: TODO_DESCRIPTION_MAX_LENGTH,
      }),
    ),
    doneWhen: Type.Optional(
      Type.String({
        description: "A concise, verifiable completion condition.",
        maxLength: TODO_DONE_WHEN_MAX_LENGTH,
      }),
    ),
  },
  { additionalProperties: false },
);
export type TodoTaskInput = Static<typeof TodoTaskInputSchema>;

export const TodoCompletionInputSchema = Type.Object(
  {
    result: Type.Optional(
      Type.String({
        description: "An optional observed result after completing this task, not its completion condition or independently verified proof.",
        maxLength: TODO_RESULT_MAX_LENGTH,
      }),
    ),
  },
  { additionalProperties: false },
);
export type TodoCompletionInput = Static<typeof TodoCompletionInputSchema>;

export const TodoInputSchema = Type.Object(
  {
    action: TodoActionSchema,
    goal: Type.Optional(
      Type.String({
        description: "The complete overall goal and scope. Required for plan; optional for replan. A changed normalized goal requires an explicit new title.",
        maxLength: TODO_GOAL_MAX_LENGTH,
      }),
    ),
    title: Type.Optional(TodoPlanTitleSchema),
    tasks: Type.Optional(
      Type.Array(TodoTaskInputSchema, {
        description:
          "Tasks to create (plan), replacement tasks (replan; may be empty), or additional tasks to insert (insert).",
        maxItems: TODO_MAX_ITEMS,
      }),
    ),
    position: Type.Optional(TodoPositionSchema),
    completions: Type.Optional(
      Type.Array(TodoCompletionInputSchema, {
        description:
          "Required for advance: one record per already-completed consecutive task, starting at the current task. Use {} when no result note is needed. Cannot exceed the remaining tasks.",
        minItems: 1,
        maxItems: TODO_MAX_ITEMS,
      }),
    ),
    reason: Type.Optional(
      Type.String({
        description: "Why a plan is blocked or being revised.",
        maxLength: TODO_REASON_MAX_LENGTH,
      }),
    ),
  },
  { additionalProperties: false },
);
export type TodoInput = Static<typeof TodoInputSchema>;

export type TodoPhase = "active" | "blocked" | "completed";

export interface TodoItem {
  id: string;
  title: string;
  description?: string;
  doneWhen?: string;
  result?: string;
}

export interface TodoUndoSnapshot {
  /** The state before the last mutating transition; `null` when no plan existed. */
  state: TodoState | null;
}

export interface TodoState {
  schemaVersion: typeof TODO_SCHEMA_VERSION;
  planId: string;
  title: string;
  goal: string;
  /** Monotonic mutation counter: every transition with `changed: true` bumps it. */
  revision: number;
  cursor: number;
  nextItemSeq: number;
  phase: TodoPhase;
  items: TodoItem[];
  blockedReason?: string;
  /** One-step pre-image so a wrong transition can be reverted with `undo`. */
  undo?: TodoUndoSnapshot;
}

export interface TodoToolDetails {
  action: TodoAction;
  state: TodoState | null;
  transition: string;
  error?: string;
  compatibilityError?: string;
}

export type TodoItemStatus = "completed" | "in_progress" | "blocked" | "pending";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
}

function isNonEmptyString(value: unknown, maxLength?: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && (maxLength === undefined || value.trim().length <= maxLength);
}

function itemSequence(id: string): number | undefined {
  const match = /^t([1-9]\d*)$/.exec(id);
  if (!match) return undefined;
  const sequence = Number(match[1]);
  return Number.isSafeInteger(sequence) ? sequence : undefined;
}

export function maxTodoItemSequence(items: readonly TodoItem[]): number {
  let max = 0;
  for (const item of items) {
    const sequence = itemSequence(item.id);
    if (sequence !== undefined) max = Math.max(max, sequence);
  }
  return max;
}

export function isTodoAction(value: unknown): value is TodoAction {
  return (
    value === "plan" ||
    value === "advance" ||
    value === "replan" ||
    value === "insert" ||
    value === "undo" ||
    value === "block" ||
    value === "resume" ||
    value === "show" ||
    value === "clear"
  );
}

export function getTodoItemStatus(state: TodoState, index: number): TodoItemStatus {
  if (index < state.cursor) return "completed";
  if (index === state.cursor && state.phase === "active") return "in_progress";
  if (index === state.cursor && state.phase === "blocked") return "blocked";
  return "pending";
}

export function getTodoProgress(state: TodoState): { completed: number; total: number; remaining: number } {
  const total = state.items.length;
  const completed = Math.min(Math.max(state.cursor, 0), total);
  return { completed, total, remaining: Math.max(0, total - completed) };
}

export function getTodoSchemaVersion(value: unknown): unknown {
  return isRecord(value) ? value.schemaVersion : undefined;
}

export function isTodoState(value: unknown): value is TodoState {
  if (!isRecord(value)) return false;
  if (Object.keys(value).some((field) => ![
    "schemaVersion", "planId", "title", "goal", "revision", "cursor", "nextItemSeq", "phase", "items", "blockedReason", "undo",
  ].includes(field))) return false;
  if (value.schemaVersion !== TODO_SCHEMA_VERSION) return false;
  if (!isNonEmptyString(value.planId)) return false;
  if (!isNonEmptyString(value.title, TODO_TITLE_MAX_LENGTH)) return false;
  if (!isNonEmptyString(value.goal, TODO_GOAL_MAX_LENGTH)) return false;
  if (!isFiniteInteger(value.revision) || value.revision < 1) return false;
  if (!isFiniteInteger(value.cursor) || value.cursor < 0) return false;
  if (!isFiniteInteger(value.nextItemSeq) || value.nextItemSeq < 1) return false;
  if (value.phase !== "active" && value.phase !== "blocked" && value.phase !== "completed") return false;
  if (!Array.isArray(value.items) || value.items.length > TODO_MAX_ITEMS) return false;
  if (value.blockedReason !== undefined && !isNonEmptyString(value.blockedReason, TODO_REASON_MAX_LENGTH)) return false;

  const ids = new Set<string>();
  for (const rawItem of value.items) {
    if (!isRecord(rawItem)) return false;
    if (Object.keys(rawItem).some((field) => !["id", "title", "description", "doneWhen", "result"].includes(field))) return false;
    if (!isNonEmptyString(rawItem.id) || !/^t[1-9]\d*$/.test(rawItem.id)) return false;
    if (ids.has(rawItem.id)) return false;
    ids.add(rawItem.id);
    if (!isNonEmptyString(rawItem.title, TODO_TITLE_MAX_LENGTH)) return false;
    if (rawItem.description !== undefined && !isNonEmptyString(rawItem.description, TODO_DESCRIPTION_MAX_LENGTH)) return false;
    if (rawItem.doneWhen !== undefined && !isNonEmptyString(rawItem.doneWhen, TODO_DONE_WHEN_MAX_LENGTH)) return false;
    if (rawItem.result !== undefined && !isNonEmptyString(rawItem.result, TODO_RESULT_MAX_LENGTH)) return false;
  }

  if (value.cursor > value.items.length) return false;
  if (value.phase === "completed" && value.cursor !== value.items.length) return false;
  if ((value.phase === "active" || value.phase === "blocked") && value.cursor >= value.items.length) return false;
  if (value.phase !== "blocked" && value.blockedReason !== undefined) return false;
  if (value.nextItemSeq <= maxTodoItemSequence(value.items)) return false;
  if (value.undo !== undefined) {
    if (!isRecord(value.undo)) return false;
    if (Object.keys(value.undo).some((field) => field !== "state")) return false;
    if (!Object.prototype.hasOwnProperty.call(value.undo, "state")) return false;
    const undoState = value.undo.state;
    if (undoState !== null) {
      if (!isTodoState(undoState)) return false;
      // Undo is one step deep: a nested snapshot would grow every persisted message.
      if (undoState.undo !== undefined) return false;
    }
  }
  return true;
}

export function cloneTodoItem(item: TodoItem): TodoItem {
  return {
    id: item.id,
    title: item.title,
    ...(item.description === undefined ? {} : { description: item.description }),
    ...(item.doneWhen === undefined ? {} : { doneWhen: item.doneWhen }),
    ...(item.result === undefined ? {} : { result: item.result }),
  };
}

export function cloneTodoState(state: TodoState): TodoState {
  return {
    schemaVersion: TODO_SCHEMA_VERSION,
    planId: state.planId,
    title: state.title,
    goal: state.goal,
    revision: state.revision,
    cursor: state.cursor,
    nextItemSeq: state.nextItemSeq,
    phase: state.phase,
    items: state.items.map(cloneTodoItem),
    ...(state.blockedReason === undefined ? {} : { blockedReason: state.blockedReason }),
    ...(state.undo === undefined
      ? {}
      : { undo: { state: state.undo.state === null ? null : cloneTodoState(state.undo.state) } }),
  };
}

/** Clone a state as an undo snapshot: the snapshot never carries its own undo. */
export function cloneTodoStateForUndo(state: TodoState): TodoState {
  const clone = cloneTodoState(state);
  delete clone.undo;
  return clone;
}
