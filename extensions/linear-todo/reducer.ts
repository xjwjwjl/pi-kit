import {
  cloneTodoItem,
  cloneTodoState,
  cloneTodoStateForUndo,
  getTodoProgress,
  isTodoAction,
  isTodoState,
  maxTodoItemSequence,
  TODO_DESCRIPTION_MAX_LENGTH,
  TODO_DONE_WHEN_MAX_LENGTH,
  TODO_GOAL_MAX_LENGTH,
  TODO_MAX_ITEMS,
  TODO_RESULT_MAX_LENGTH,
  TODO_REASON_MAX_LENGTH,
  TODO_SCHEMA_VERSION,
  TODO_TITLE_MAX_LENGTH,
  type TodoAction,
  type TodoCompletionInput,
  type TodoInput,
  type TodoItem,
  type TodoState,
} from "./schema.ts";

export type TodoDomainErrorCode =
  | "INVALID_INPUT"
  | "INVALID_GOAL"
  | "INVALID_PLAN_TITLE"
  | "INVALID_TASKS"
  | "INVALID_TASK_TITLE"
  | "INVALID_DESCRIPTION"
  | "INVALID_DONE_WHEN"
  | "INVALID_RESULT"
  | "INVALID_COMPLETIONS"
  | "INVALID_REASON"
  | "INVALID_STATE"
  | "UNKNOWN_SCHEMA_VERSION"
  | "PLAN_ALREADY_ACTIVE"
  | "NO_PLAN"
  | "PLAN_BLOCKED"
  | "PLAN_COMPLETED"
  | "PLAN_NOT_BLOCKED"
  | "MISSING_PLAN_ID"
  | "NOTHING_TO_UNDO";

export class TodoDomainError extends Error {
  readonly code: TodoDomainErrorCode;

  constructor(code: TodoDomainErrorCode, message: string) {
    super(message);
    this.name = "TodoDomainError";
    this.code = code;
  }
}

export interface TodoTransition {
  state: TodoState | null;
  summary: string;
  changed: boolean;
}

export interface TodoReducerDependencies {
  /** Generates a new plan id. The reducer never calls a global id source itself. */
  createPlanId: () => string;
}

interface NormalizedTask {
  title: string;
  description?: string;
  doneWhen?: string;
}

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function requiredText(value: unknown, field: string, maxLength: number, code: TodoDomainErrorCode): string {
  if (typeof value !== "string") {
    throw new TodoDomainError(code, `${field} is required.`);
  }
  const normalized = normalizeWhitespace(value);
  if (!normalized) {
    throw new TodoDomainError(code, `${field} cannot be empty.`);
  }
  if (normalized.length > maxLength) {
    throw new TodoDomainError(code, `${field} must be at most ${maxLength} characters.`);
  }
  return normalized;
}

function optionalText(value: unknown, field: string, maxLength: number, code: TodoDomainErrorCode): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new TodoDomainError(code, `${field} must be a string.`);
  }
  const normalized = normalizeWhitespace(value);
  if (!normalized) return undefined;
  if (normalized.length > maxLength) {
    throw new TodoDomainError(code, `${field} must be at most ${maxLength} characters.`);
  }
  return normalized;
}

function normalizeTasks(value: unknown, options: { required: boolean; allowEmpty: boolean }): NormalizedTask[] {
  if (value === undefined) {
    if (options.required) throw new TodoDomainError("INVALID_TASKS", "tasks are required.");
    return [];
  }
  if (!Array.isArray(value)) {
    throw new TodoDomainError("INVALID_TASKS", "tasks must be an array.");
  }
  if (value.length > TODO_MAX_ITEMS) {
    throw new TodoDomainError("INVALID_TASKS", `A Todo plan can contain at most ${TODO_MAX_ITEMS} replacement tasks.`);
  }
  if (!options.allowEmpty && value.length === 0) {
    throw new TodoDomainError("INVALID_TASKS", "A Todo plan must contain at least one task.");
  }

  return Array.from(value, (rawTask: unknown, index) => {
    if (typeof rawTask !== "object" || rawTask === null || Array.isArray(rawTask)) {
      throw new TodoDomainError("INVALID_TASKS", `Task ${index + 1} must be an object.`);
    }
    for (const field of Object.keys(rawTask)) {
      if (!["title", "description", "doneWhen"].includes(field)) {
        throw new TodoDomainError("INVALID_TASKS", `Task ${index + 1} does not accept ${field}; only title, description and doneWhen are allowed.`);
      }
    }
    const task = rawTask as { title?: unknown; description?: unknown; doneWhen?: unknown };
    const title = requiredText(task.title, `Task ${index + 1} title`, TODO_TITLE_MAX_LENGTH, "INVALID_TASK_TITLE");
    const description = task.description === undefined ? undefined : requiredText(
      task.description, `Task ${index + 1} description`, TODO_DESCRIPTION_MAX_LENGTH, "INVALID_DESCRIPTION",
    );
    const doneWhen = optionalText(task.doneWhen, `Task ${index + 1} doneWhen`, TODO_DONE_WHEN_MAX_LENGTH, "INVALID_DONE_WHEN");
    return {
      title,
      ...(description === undefined ? {} : { description }),
      ...(doneWhen === undefined ? {} : { doneWhen }),
    };
  });
}

/** Validate the whole batch before applying a single atomic transition. */
function normalizeCompletions(input: TodoInput, remaining: number): TodoCompletionInput[] {
  const records: unknown = input.completions;
  if (!Array.isArray(records) || records.length === 0 || records.length > remaining) {
    throw new TodoDomainError(
      "INVALID_COMPLETIONS",
      `completions must be a non-empty array of at most ${remaining} record(s), one per remaining task.`,
    );
  }
  return Array.from(records, (record: unknown, index) => {
    if (typeof record !== "object" || record === null || Array.isArray(record)) {
      throw new TodoDomainError("INVALID_COMPLETIONS", `Completion ${index + 1} must be an object; use {} without a result.`);
    }
    for (const field of Object.keys(record)) {
      if (field !== "result") {
        throw new TodoDomainError("INVALID_COMPLETIONS", `Completion ${index + 1} does not accept ${field}; only result is optional.`);
      }
    }
    const result = optionalText(
      (record as Record<string, unknown>).result,
      `Completion ${index + 1} result`,
      TODO_RESULT_MAX_LENGTH,
      "INVALID_RESULT",
    );
    return result === undefined ? {} : { result };
  });
}

function assertInput(input: TodoInput): void {
  if (typeof input !== "object" || input === null || Array.isArray(input) || !isTodoAction((input as { action?: unknown }).action)) {
    throw new TodoDomainError(
      "INVALID_INPUT",
      "action must be one of plan, advance, replan, insert, undo, block, resume, show, or clear.",
    );
  }
}

/** Fields each action reads. Anything else is rejected so a call can never look accepted and do nothing. */
const APPLICABLE_FIELDS: Record<TodoAction, readonly string[]> = {
  plan: ["goal", "title", "tasks"],
  advance: ["completions"],
  replan: ["goal", "title", "tasks", "reason"],
  insert: ["tasks", "position"],
  undo: [],
  block: ["reason"],
  resume: [],
  show: [],
  clear: [],
};

function unusedFieldHint(action: TodoAction, field: string): string {
  if (field === "tasks") {
    return `${action} does not accept tasks. Use insert to add tasks or replan to replace the remaining plan.`;
  }
  if (field === "completions") {
    return `${action} does not accept completions. Use advance to complete consecutive tasks from the current position.`;
  }
  if (field === "reason") {
    return `${action} does not accept reason. Use block or replan when a reason is required.`;
  }
  if (field === "goal") {
    return `${action} does not accept goal. Use plan or replan to set the goal.`;
  }
  return `${action} does not accept ${field}.`;
}

function assertApplicableFields(input: TodoInput): void {
  const applicable = APPLICABLE_FIELDS[input.action];
  for (const field of Object.keys(input)) {
    if (field === "action" || applicable.includes(field)) continue;
    throw new TodoDomainError("INVALID_INPUT", unusedFieldHint(input.action, field));
  }
}

function assertPreviousState(previous: TodoState | null): asserts previous is TodoState {
  if (previous === null) {
    throw new TodoDomainError("NO_PLAN", "There is no active Todo plan.");
  }
  if (!isTodoState(previous)) {
    const version = (previous as unknown as { schemaVersion?: unknown }).schemaVersion;
    if (version !== undefined && version !== TODO_SCHEMA_VERSION) {
      throw new TodoDomainError("UNKNOWN_SCHEMA_VERSION", `Todo schemaVersion ${String(version)} is not supported.`);
    }
    throw new TodoDomainError("INVALID_STATE", "The current Todo state is invalid and cannot be changed.");
  }
}

function createItems(tasks: readonly NormalizedTask[], startSequence = 1): TodoItem[] {
  return tasks.map((task, index) => ({
    id: `t${startSequence + index}`,
    title: task.title,
    ...(task.description === undefined ? {} : { description: task.description }),
    ...(task.doneWhen === undefined ? {} : { doneWhen: task.doneWhen }),
  }));
}

/** Attach a one-step pre-image so `undo` can revert this transition. */
function withUndo(previous: TodoState | null, next: TodoState): TodoState {
  return {
    ...next,
    undo: { state: previous === null ? null : cloneTodoStateForUndo(previous) },
  };
}

function currentTaskLabel(state: TodoState): string {
  return state.items[state.cursor]?.title ?? "none";
}

function nextTaskLabel(state: TodoState): string | undefined {
  return state.items[state.cursor + 1]?.title;
}

function progressSummary(state: TodoState): string {
  const progress = getTodoProgress(state);
  return `${progress.completed}/${progress.total} tasks finished`;
}

function requirePlanId(dependencies: TodoReducerDependencies): string {
  const planId = dependencies.createPlanId();
  if (typeof planId !== "string" || !planId.trim()) {
    throw new TodoDomainError("MISSING_PLAN_ID", "A new Todo plan requires a non-empty plan id.");
  }
  return planId;
}

function reducePlan(previous: TodoState | null, input: TodoInput, dependencies: TodoReducerDependencies): TodoTransition {
  if (previous !== null) assertPreviousState(previous);
  if (previous?.phase === "active" || previous?.phase === "blocked") {
    throw new TodoDomainError("PLAN_ALREADY_ACTIVE", "An unfinished Todo plan already exists. Use replan or clear before creating a new plan.");
  }

  const goal = requiredText(input.goal, "goal", TODO_GOAL_MAX_LENGTH, "INVALID_GOAL");
  const title = requiredText(input.title, "title", TODO_TITLE_MAX_LENGTH, "INVALID_PLAN_TITLE");
  const tasks = normalizeTasks(input.tasks, { required: true, allowEmpty: false });
  const items = createItems(tasks);
  const state: TodoState = {
    schemaVersion: TODO_SCHEMA_VERSION,
    planId: requirePlanId(dependencies),
    title,
    goal,
    revision: 1,
    cursor: 0,
    nextItemSeq: items.length + 1,
    phase: "active",
    items,
  };

  return {
    state: withUndo(previous, state),
    changed: true,
    summary: `Created Todo plan with ${items.length} task(s).`,
  };
}

function reduceAdvance(previous: TodoState | null, input: TodoInput): TodoTransition {
  assertPreviousState(previous);
  if (previous.phase === "blocked") {
    throw new TodoDomainError("PLAN_BLOCKED", "The current Todo plan is blocked. Use resume or replan before advancing.");
  }
  if (previous.phase === "completed" || previous.cursor >= previous.items.length) {
    throw new TodoDomainError("PLAN_COMPLETED", "The Todo plan is already completed.");
  }

  const completions = normalizeCompletions(input, previous.items.length - previous.cursor);
  const cursor = previous.cursor + completions.length;
  const state: TodoState = {
    ...cloneTodoState(previous),
    revision: previous.revision + 1,
    cursor,
    phase: cursor === previous.items.length ? "completed" : "active",
  };
  for (const [offset, completion] of completions.entries()) {
    if (completion.result !== undefined) state.items[previous.cursor + offset]!.result = completion.result;
  }

  const planCompleted = state.phase === "completed" ? " Plan completed." : "";
  let summary = `Completed ${cursor}/${state.items.length}: `;
  if (completions.length === 1) {
    const result = completions[0]!.result;
    summary += `${state.items[previous.cursor]!.title}.${planCompleted}${result === undefined ? "" : ` Result: ${result}`}`;
  } else {
    summary += `${completions.length} tasks in this call.${planCompleted}\n`;
    summary += completions.map((completion, offset) => {
      const index = previous.cursor + offset;
      return `${index + 1}. ${state.items[index]!.title}.${completion.result === undefined ? "" : ` Result: ${completion.result}`}`;
    }).join("\n");
  }
  return { state: withUndo(previous, state), changed: true, summary };
}

function reduceReplan(previous: TodoState | null, input: TodoInput): TodoTransition {
  assertPreviousState(previous);
  if (previous.phase === "completed") {
    throw new TodoDomainError("PLAN_COMPLETED", "The Todo plan is already completed. Create a new plan instead of replanning it.");
  }
  const reason = requiredText(input.reason, "reason", TODO_REASON_MAX_LENGTH, "INVALID_REASON");
  const tasks = normalizeTasks(input.tasks, { required: true, allowEmpty: true });
  const goal = input.goal === undefined ? previous.goal : requiredText(input.goal, "goal", TODO_GOAL_MAX_LENGTH, "INVALID_GOAL");
  const goalChanged = normalizeWhitespace(goal) !== normalizeWhitespace(previous.goal);
  const title = input.title === undefined && !goalChanged
    ? previous.title
    : requiredText(input.title, "title", TODO_TITLE_MAX_LENGTH, "INVALID_PLAN_TITLE");
  const completedItems = previous.items.slice(0, previous.cursor).map(cloneTodoItem);
  if (tasks.length === 0 && completedItems.length === 0) {
    // A completed plan with zero items is not a plan: nothing is left to report or resume.
    throw new TodoDomainError(
      "INVALID_TASKS",
      "replan needs at least one task when no task has been completed yet. Use clear to discard the plan.",
    );
  }
  if (completedItems.length + tasks.length > TODO_MAX_ITEMS) {
    throw new TodoDomainError("INVALID_TASKS", `The revised Todo plan can contain at most ${TODO_MAX_ITEMS} total tasks, including completed history.`);
  }
  const items = [...completedItems, ...createItems(tasks, previous.nextItemSeq)];
  const cursor = completedItems.length;
  const phase = tasks.length === 0 ? "completed" : "active";
  const state: TodoState = {
    ...cloneTodoState(previous),
    title,
    goal,
    revision: previous.revision + 1,
    cursor,
    nextItemSeq: previous.nextItemSeq + tasks.length,
    phase,
    items,
  };
  delete state.blockedReason;

  return {
    state: withUndo(previous, state),
    changed: true,
    summary:
      tasks.length === 0
        ? `Replanned Todo (${reason}). No remaining tasks; plan is completed.`
        : `Replanned Todo (${reason}). Preserved ${completedItems.length} completed task(s).`,
  };
}

function reduceInsert(previous: TodoState | null, input: TodoInput): TodoTransition {
  assertPreviousState(previous);
  if (previous.phase === "blocked") {
    throw new TodoDomainError("PLAN_BLOCKED", "The current Todo plan is blocked. Use resume before inserting tasks.");
  }
  if (previous.phase === "completed" || previous.cursor >= previous.items.length) {
    throw new TodoDomainError("PLAN_COMPLETED", "A completed Todo plan cannot accept new tasks. Create a new plan instead.");
  }
  const position = input.position ?? "next";
  if (position !== "next" && position !== "end") {
    throw new TodoDomainError("INVALID_INPUT", 'position must be "next" or "end".');
  }
  const tasks = normalizeTasks(input.tasks, { required: true, allowEmpty: false });
  if (previous.items.length + tasks.length > TODO_MAX_ITEMS) {
    throw new TodoDomainError(
      "INVALID_TASKS",
      `The Todo plan can contain at most ${TODO_MAX_ITEMS} tasks in total, including ${previous.items.length} existing task(s).`,
    );
  }

  const inserted = createItems(tasks, previous.nextItemSeq);
  const at = position === "end" ? previous.items.length : previous.cursor + 1;
  const items = [
    ...previous.items.slice(0, at).map(cloneTodoItem),
    ...inserted,
    ...previous.items.slice(at).map(cloneTodoItem),
  ];
  const state: TodoState = {
    ...cloneTodoState(previous),
    revision: previous.revision + 1,
    items,
    nextItemSeq: previous.nextItemSeq + inserted.length,
  };

  return {
    state: withUndo(previous, state),
    changed: true,
    summary:
      position === "end"
        ? `Inserted ${inserted.length} task(s) at the end of the plan.`
        : `Inserted ${inserted.length} task(s) after the current task.`,
  };
}

function reduceUndo(previous: TodoState | null): TodoTransition {
  if (previous === null) {
    throw new TodoDomainError("NOTHING_TO_UNDO", "There is no Todo plan to undo.");
  }
  assertPreviousState(previous);
  const snapshot = previous.undo;
  if (snapshot === undefined) {
    throw new TodoDomainError("NOTHING_TO_UNDO", "The last Todo transition cannot be undone.");
  }
  if (snapshot.state === null) {
    return { state: null, changed: true, summary: "Undid the last Todo transition. No plan remains." };
  }
  if (!isTodoState(snapshot.state)) {
    throw new TodoDomainError("INVALID_STATE", "The stored undo snapshot is not a valid Todo state.");
  }

  const restored: TodoState = {
    ...cloneTodoState(snapshot.state),
    revision: previous.revision + 1,
    // Undo restores tasks, not the IDs already allocated within this plan.
    nextItemSeq: snapshot.state.planId === previous.planId
      ? Math.max(snapshot.state.nextItemSeq, previous.nextItemSeq)
      : snapshot.state.nextItemSeq,
  };
  delete restored.undo;

  return {
    state: restored,
    changed: true,
    summary: "Undid the last Todo transition.",
  };
}

function reduceBlock(previous: TodoState | null, input: TodoInput): TodoTransition {
  assertPreviousState(previous);
  if (previous.phase === "blocked") {
    throw new TodoDomainError("PLAN_BLOCKED", "The Todo plan is already blocked. Use resume or replan.");
  }
  if (previous.phase === "completed" || previous.cursor >= previous.items.length) {
    throw new TodoDomainError("PLAN_COMPLETED", "A completed Todo plan cannot be blocked.");
  }
  const reason = requiredText(input.reason, "reason", TODO_REASON_MAX_LENGTH, "INVALID_REASON");
  const state: TodoState = {
    ...cloneTodoState(previous),
    revision: previous.revision + 1,
    phase: "blocked",
    blockedReason: reason,
  };
  return {
    state: withUndo(previous, state),
    changed: true,
    summary: "Blocked Todo.",
  };
}

function reduceResume(previous: TodoState | null): TodoTransition {
  assertPreviousState(previous);
  if (previous.phase !== "blocked") {
    throw new TodoDomainError("PLAN_NOT_BLOCKED", "The Todo plan is not blocked.");
  }
  const state: TodoState = {
    ...cloneTodoState(previous),
    revision: previous.revision + 1,
    phase: "active",
  };
  delete state.blockedReason;
  return {
    state: withUndo(previous, state),
    changed: true,
    summary: "Resumed Todo.",
  };
}

function reduceShow(previous: TodoState | null): TodoTransition {
  if (previous === null) {
    return { state: null, changed: false, summary: "No active Todo plan." };
  }
  assertPreviousState(previous);
  const state = cloneTodoState(previous);
  const next = nextTaskLabel(state);
  const suffix = next ? ` Next: ${next}` : "";
  return {
    state,
    changed: false,
    summary: `Todo ${progressSummary(state)}. Current: ${currentTaskLabel(state)}.${suffix}`,
  };
}

function reduceClear(previous: TodoState | null): TodoTransition {
  if (previous === null) {
    return { state: null, changed: false, summary: "No Todo plan to clear." };
  }
  assertPreviousState(previous);
  const remaining = getTodoProgress(previous).remaining;
  return {
    state: null,
    changed: true,
    summary: remaining > 0 ? `Cleared Todo plan with ${remaining} unfinished task(s).` : "Cleared completed Todo plan.",
  };
}

export function reduceTodo(
  previous: TodoState | null,
  input: TodoInput,
  dependencies: TodoReducerDependencies,
): TodoTransition {
  assertInput(input);
  assertApplicableFields(input);

  switch (input.action) {
    case "plan":
      return reducePlan(previous, input, dependencies);
    case "advance":
      return reduceAdvance(previous, input);
    case "replan":
      return reduceReplan(previous, input);
    case "insert":
      return reduceInsert(previous, input);
    case "undo":
      return reduceUndo(previous);
    case "block":
      return reduceBlock(previous, input);
    case "resume":
      return reduceResume(previous);
    case "show":
      return reduceShow(previous);
    case "clear":
      return reduceClear(previous);
  }
}

export function emptyTodoReducerDependencies(planId = "test-plan"): TodoReducerDependencies {
  return { createPlanId: () => planId };
}

export function assertTodoStateInvariant(state: TodoState): void {
  if (!isTodoState(state)) {
    throw new TodoDomainError("INVALID_STATE", "Todo state invariant failed.");
  }
  if (state.nextItemSeq <= maxTodoItemSequence(state.items)) {
    throw new TodoDomainError("INVALID_STATE", "Todo nextItemSeq must remain greater than every allocated task id.");
  }
}
