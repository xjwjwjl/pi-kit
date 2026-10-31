import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  cloneTodoState,
  getTodoSchemaVersion,
  isTodoState,
  type TodoAction,
  type TodoState,
} from "./schema.ts";

export const TODO_AUTO_CONTINUE_CUSTOM_TYPE = "linear-todo-auto-continue";

export interface TodoRuntimeState {
  todo: TodoState | null;
  compatibilityError?: string;
  forceReminder: boolean;
  userTurnReminder: boolean;
  turnsSinceMutation: number;
  skipNextContextReminder: boolean;
  lastRunStopReason?: string;
  nudgedStageKeys: Set<string>;
  /** Auto-continues already spent at each `planId:cursor` position. */
  nudgeCounts: Map<string, number>;
  /** Last successful explicit resume at each position; edits and undo never erase it. */
  resumeRevisions: Map<string, number>;
  /** Runtime-only user pause for auto-continue; never persisted. */
  paused: boolean;
  earlyStopWarning: boolean;
  /** A released completed plan (settled or restored by undo) keeps its state but no longer owns a Widget. */
  completedDismissed: boolean;
}

export interface TodoRecoveryResult {
  todo: TodoState | null;
  compatibilityError?: string;
  nudgedStageKeys: Set<string>;
  nudgeCounts: Map<string, number>;
  resumeRevisions: Map<string, number>;
}

export interface TodoStateStore {
  readonly runtime: TodoRuntimeState;
  getState(): TodoState | null;
  getCompatibilityError(): string | undefined;
  replace(next: TodoState | null, action?: TodoAction): void;
  recover(branch: readonly SessionEntry[]): void;
  getStageKey(state: TodoState): string;
  markNudged(stageKey: string, planId: string, cursor: number): void;
  isNudged(stageKey: string): boolean;
  nudgesAt(planId: string, cursor: number): number;
}

/** Ledger key for the per-position auto-continue budget. */
export function nudgeCountKey(planId: string, cursor: number): string {
  return `${planId}:${cursor}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isToolResultTodoEntry(entry: SessionEntry): entry is Extract<SessionEntry, { type: "message" }> {
  if (entry.type !== "message") return false;
  return entry.message.role === "toolResult" && entry.message.toolName === "todo";
}

const TODO_DETAILS_ACTIONS = new Set<string>([
  "plan",
  "advance",
  "replan",
  "insert",
  "undo",
  "block",
  "resume",
  "show",
  "clear",
]);

// `toolName === "todo"` is not proof of ownership: another extension can register a tool with the
// same name, and its results would otherwise be read as a corrupt snapshot and lock recovery until
// `clear`. Every result this extension writes carries its own action name plus a transition line,
// so requiring that signature skips foreign results while still recognizing historical entries.
function isTodoToolDetails(details: unknown): boolean {
  if (!isRecord(details)) return false;
  if (typeof details.compatibilityError === "string" && details.compatibilityError.trim()) return true;
  return typeof details.action === "string" && TODO_DETAILS_ACTIONS.has(details.action) && typeof details.transition === "string";
}

function schemaVersionLabel(value: unknown): string {
  if (value === undefined) return "missing";
  if (typeof value === "string" || typeof value === "number") return String(value);
  return "unknown";
}

const MISSING_STATE_ERROR =
  "The latest Todo tool result does not contain a supported state snapshot. Clear Todo to start a new plan.";

// Host-generated failures (thrown errors, rejected arguments, unknown tools, aborted calls) are
// recorded as `isError: true` with `details: {}`. They carry no state, so they must be skipped:
// treating them as an unsupported snapshot would lock the extension until `clear`. A result that
// is *not* an error but still lacks `state` remains a genuine compatibility problem.
function readTodoDetailsState(
  details: unknown,
  isError: boolean,
):
  | { kind: "state"; state: TodoState | null }
  | { kind: "compatibility"; error: string }
  | { kind: "ignore" } {
  if (details === undefined || details === null) return { kind: "ignore" };
  if (!isRecord(details)) {
    return isError ? { kind: "ignore" } : { kind: "compatibility", error: MISSING_STATE_ERROR };
  }
  if (typeof details.compatibilityError === "string" && details.compatibilityError.trim()) {
    return { kind: "compatibility", error: details.compatibilityError.trim() };
  }
  if (!Object.prototype.hasOwnProperty.call(details, "state")) {
    return isError ? { kind: "ignore" } : { kind: "compatibility", error: MISSING_STATE_ERROR };
  }

  const state = details.state;
  if (state === null) return { kind: "state", state: null };
  if (isTodoState(state)) return { kind: "state", state: cloneTodoState(state) };

  const version = getTodoSchemaVersion(state);
  return {
    kind: "compatibility",
    error: `Todo schemaVersion ${schemaVersionLabel(version)} is not supported. Clear Todo to start a new plan.`,
  };
}

function readStageKey(entry: SessionEntry): string | undefined {
  if (entry.type !== "custom_message" || entry.customType !== TODO_AUTO_CONTINUE_CUSTOM_TYPE) return undefined;
  if (!isRecord(entry.details) || typeof entry.details.stageKey !== "string") return undefined;
  const stageKey = entry.details.stageKey.trim();
  return stageKey || undefined;
}

function readNudgePosition(entry: SessionEntry): { planId: string; cursor: number } | undefined {
  if (entry.type !== "custom_message" || entry.customType !== TODO_AUTO_CONTINUE_CUSTOM_TYPE) return undefined;
  if (!isRecord(entry.details)) return undefined;
  const { planId, cursor } = entry.details;
  if (typeof planId !== "string" || !planId.trim()) return undefined;
  if (typeof cursor !== "number" || !Number.isInteger(cursor) || cursor < 0) return undefined;
  return { planId: planId.trim(), cursor };
}

function positionStageKey(planId: string, cursor: number, resumeRevision: number): string {
  return JSON.stringify(["linear-todo-nudge", 1, planId, cursor, resumeRevision]);
}

/** Stable across plan edits; explicit resume reopens eligibility at the same position. */
export function stageKey(state: TodoState, resumeRevision = 0): string {
  return positionStageKey(state.planId, state.cursor, resumeRevision);
}

export function recoverTodoFromBranch(branch: readonly SessionEntry[]): TodoRecoveryResult {
  const nudgedStageKeys = new Set<string>();
  const nudgeCounts = new Map<string, number>();
  const resumeRevisions = new Map<string, number>();
  let todo: TodoState | null = null;
  let compatibilityError: string | undefined;

  // Replay policy history in branch order: an old nudge belongs to the resume epoch
  // at the time it was emitted, never to a later resume on the same position.
  for (const entry of branch) {
    if (isToolResultTodoEntry(entry)) {
      const message = entry.message as { details?: unknown; isError?: boolean };
      const details = message.details;
      if (!isRecord(details) || !isTodoToolDetails(details)) continue;
      const result = readTodoDetailsState(details, message.isError === true);
      if (result.kind === "ignore") continue;
      if (result.kind === "compatibility") {
        todo = null;
        compatibilityError = result.error;
        continue;
      }
      const next = result.state;
      if (
        details.action === "resume" && message.isError !== true && details.error === undefined &&
        next?.phase === "active" && (next.planId !== todo?.planId || next.revision !== todo?.revision)
      ) {
        resumeRevisions.set(nudgeCountKey(next.planId, next.cursor), next.revision);
      }
      todo = next;
      compatibilityError = undefined;
      continue;
    }

    const key = readStageKey(entry);
    if (key) nudgedStageKeys.add(key);
    let position = readNudgePosition(entry);
    // Old messages sometimes carried only the mutation-revision key. Associate them
    // only with an exactly matching preceding snapshot, not by parsing opaque IDs.
    if (!position && todo && key === `${todo.planId}:${todo.revision}`) {
      position = { planId: todo.planId, cursor: todo.cursor };
    }
    if (position) {
      const countKey = nudgeCountKey(position.planId, position.cursor);
      nudgedStageKeys.add(positionStageKey(position.planId, position.cursor, resumeRevisions.get(countKey) ?? 0));
      nudgeCounts.set(countKey, (nudgeCounts.get(countKey) ?? 0) + 1);
    }
  }

  return { todo, compatibilityError, nudgedStageKeys, nudgeCounts, resumeRevisions };
}

export function createTodoRuntimeState(): TodoRuntimeState {
  return {
    todo: null,
    forceReminder: false,
    userTurnReminder: false,
    turnsSinceMutation: 0,
    skipNextContextReminder: false,
    nudgedStageKeys: new Set<string>(),
    nudgeCounts: new Map<string, number>(),
    resumeRevisions: new Map<string, number>(),
    paused: false,
    earlyStopWarning: false,
    completedDismissed: false,
  };
}

export function createTodoStateStore(onChanged?: () => void): TodoStateStore {
  const runtime = createTodoRuntimeState();

  const notify = () => {
    try {
      onChanged?.();
    } catch {
      // UI refresh is deliberately outside the state commit boundary.
    }
  };

  return {
    runtime,

    getState(): TodoState | null {
      return runtime.todo === null ? null : cloneTodoState(runtime.todo);
    },

    getCompatibilityError(): string | undefined {
      return runtime.compatibilityError;
    },

    replace(next: TodoState | null, action?: TodoAction): void {
      if (
        action === "resume" && next?.phase === "active" &&
        (next.planId !== runtime.todo?.planId || next.revision !== runtime.todo?.revision)
      ) {
        runtime.resumeRevisions.set(nudgeCountKey(next.planId, next.cursor), next.revision);
      }
      runtime.todo = next === null ? null : cloneTodoState(next);
      runtime.compatibilityError = undefined;
      runtime.forceReminder = false;
      runtime.userTurnReminder = false;
      runtime.turnsSinceMutation = 0;
      runtime.skipNextContextReminder = true;
      runtime.earlyStopWarning = false;
      // A newly completed plan stays visible until settle. Undo restoring a completed
      // pre-image is treated as released history, even when that completion happened earlier in this run.
      runtime.completedDismissed = next?.phase === "completed" && action === "undo";
      notify();
    },

    recover(branch: readonly SessionEntry[]): void {
      const recovered = recoverTodoFromBranch(branch);
      runtime.todo = recovered.todo === null ? null : cloneTodoState(recovered.todo);
      runtime.compatibilityError = recovered.compatibilityError;
      runtime.forceReminder = recovered.todo !== null;
      runtime.userTurnReminder = false;
      runtime.turnsSinceMutation = 0;
      runtime.skipNextContextReminder = false;
      runtime.lastRunStopReason = undefined;
      runtime.nudgedStageKeys = recovered.nudgedStageKeys;
      runtime.nudgeCounts = recovered.nudgeCounts;
      runtime.resumeRevisions = recovered.resumeRevisions;
      // Pause is a runtime-only control: a fresh session starts with auto-continue enabled.
      runtime.paused = false;
      runtime.earlyStopWarning = false;
      // A recovered completed plan belongs to an already-settled run.
      runtime.completedDismissed = recovered.todo?.phase === "completed";
      notify();
    },

    getStageKey(state: TodoState): string {
      return stageKey(state, runtime.resumeRevisions.get(nudgeCountKey(state.planId, state.cursor)) ?? 0);
    },

    markNudged(key: string, planId: string, cursor: number): void {
      runtime.nudgedStageKeys.add(key);
      const countKey = nudgeCountKey(planId, cursor);
      runtime.nudgeCounts.set(countKey, (runtime.nudgeCounts.get(countKey) ?? 0) + 1);
    },

    isNudged(key: string): boolean {
      return runtime.nudgedStageKeys.has(key);
    },

    nudgesAt(planId: string, cursor: number): number {
      return runtime.nudgeCounts.get(nudgeCountKey(planId, cursor)) ?? 0;
    },
  };
}
