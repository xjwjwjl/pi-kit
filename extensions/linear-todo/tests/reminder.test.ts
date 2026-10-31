import assert from "node:assert/strict";
import test from "node:test";
import { emptyTodoReducerDependencies, reduceTodo } from "../reducer.ts";
import {
  buildAutoContinueText,
  buildReminder,
  buildTodoToolFeedback,
  selectReminder,
  shouldAutoContinue,
  shouldInjectReminder,
  TODO_REMINDER_MAX_LENGTH,
} from "../reminder.ts";
import { createTodoRuntimeState } from "../state.ts";
import {
  TODO_DESCRIPTION_MAX_LENGTH,
  TODO_DONE_WHEN_MAX_LENGTH,
  TODO_GOAL_MAX_LENGTH,
  TODO_TITLE_MAX_LENGTH,
  type TodoState,
} from "../schema.ts";

function state(): TodoState {
  return reduceTodo(
    null,
    {
      action: "plan",
      title: "Build the Todo extension",
      goal: "Deliver the linear Todo extension",
      tasks: [
        { title: "Explore the codebase", description: "Read the tool and lifecycle APIs", doneWhen: "Relevant APIs are identified" },
        { title: "Implement the extension", description: "Wire the sequential tool and session hooks", doneWhen: "The tool and hooks work" },
        { title: "Run tests", doneWhen: "All checks pass" },
      ],
    },
    emptyTodoReducerDependencies("reminder-plan"),
  ).state!;
}

test("compact reminders contain only the active task and next task", () => {
  const todo = state();
  const reminder = buildReminder(todo, "compact");

  assert.match(reminder, /\[Todo 0\/3\]/);
  assert.match(reminder, /Plan: Build the Todo extension/);
  assert.match(reminder, /Goal: Deliver the linear Todo extension/);
  assert.match(reminder, /Current: Explore the codebase/);
  assert.match(reminder, /Description: Read the tool and lifecycle APIs/);
  assert.match(reminder, /Next: Implement the extension/);
  assert.doesNotMatch(reminder, /Run tests/);
  assert.ok(reminder.length <= TODO_REMINDER_MAX_LENGTH);
});

test("full reminders list task statuses without result history", () => {
  const todo = state();
  const advanced = reduceTodo(todo, { action: "advance", completions: [{ result: "Found the APIs" }] }, emptyTodoReducerDependencies("unused")).state!;
  const reminder = buildReminder(advanced, "full");

  assert.match(reminder, /\[Todo 1\/3\]/);
  assert.match(reminder, /\[x\] Explore the codebase/);
  assert.match(reminder, /\[>] Implement the extension/);
  assert.match(reminder, /Description: Wire the sequential tool and session hooks/);
  assert.match(reminder, /\[ \] Run tests/);
  assert.doesNotMatch(reminder, /Found the APIs/);
});

test("automatic correction includes the task contract and respects the latest request", () => {
  const text = buildAutoContinueText(state());
  assert.match(text, /latest user request/);
  assert.match(text, /Goal: Deliver the linear Todo extension/);
  assert.match(text, /Current: Explore the codebase/);
  assert.match(text, /Description: Read the tool and lifecycle APIs/);
  assert.match(text, /Done when: Relevant APIs are identified/);
  assert.match(text, /observed results/);
  assert.match(text, /waiting for user input/);
  assert.doesNotMatch(text, /\/todos run/);
});

test("reminder selection respects force, user, periodic, and suppression order", () => {
  const runtime = createTodoRuntimeState();
  runtime.todo = state();

  assert.equal(shouldInjectReminder(runtime), false);
  runtime.forceReminder = true;
  assert.deepEqual(selectReminder(runtime), { mode: "full", reason: "force" });

  runtime.forceReminder = false;
  runtime.userTurnReminder = true;
  assert.deepEqual(selectReminder(runtime), { mode: "compact", reason: "user" });

  runtime.userTurnReminder = false;
  runtime.skipNextContextReminder = true;
  assert.deepEqual(selectReminder(runtime), { mode: null, reason: "skip" });

  runtime.skipNextContextReminder = false;
  runtime.turnsSinceMutation = 3;
  assert.deepEqual(selectReminder(runtime), { mode: "compact", reason: "periodic" });
});

test("blocked plans include the reason and never qualify for auto continuation", () => {
  const todo = state();
  const blocked = reduceTodo(todo, { action: "block", reason: "Need user input" }, emptyTodoReducerDependencies("unused")).state!;
  const reminder = buildReminder(blocked, "compact");
  assert.match(reminder, /Blocked: Need user input/);
  assert.equal(shouldAutoContinue({
    mode: "tui",
    state: blocked,
    hasPendingMessages: false,
    lastRunStopReason: "stop",
    lastRunWasUserAbort: false,
    alreadyNudged: false,
    nudgesAtStage: 0,
  }), false);
});

test("auto continuation is enabled once per active stage and only in TUI/RPC", () => {
  const todo = state();
  const base = {
    state: todo,
    hasPendingMessages: false,
    lastRunStopReason: "stop",
    lastRunWasUserAbort: false,
    alreadyNudged: false,
    nudgesAtStage: 0,
  } as const;

  assert.equal(shouldAutoContinue({ mode: "tui", ...base }), true);
  assert.equal(shouldAutoContinue({ mode: "rpc", ...base }), true);
  assert.equal(shouldAutoContinue({ mode: "json", ...base }), false);
  assert.equal(shouldAutoContinue({ mode: "print", ...base }), false);
  assert.equal(shouldAutoContinue({ mode: "tui", ...base, alreadyNudged: true }), false);
  assert.equal(shouldAutoContinue({ mode: "tui", ...base, hasPendingMessages: true }), false);
  assert.equal(shouldAutoContinue({ mode: "tui", ...base, lastRunStopReason: "error" }), false);
  assert.equal(shouldAutoContinue({ mode: "tui", ...base, lastRunStopReason: "aborted" }), false);
  assert.equal(shouldAutoContinue({ mode: "tui", ...base, lastRunStopReason: "deferred" }), false);
  assert.equal(shouldAutoContinue({ mode: "tui", ...base, runtimeActive: false }), false);
  assert.equal(shouldAutoContinue({ mode: "tui", ...base, lastRunWasUserAbort: true }), false);
  assert.equal(shouldAutoContinue({ mode: "tui", ...base, paused: true }), false);
  assert.equal(shouldAutoContinue({ mode: "tui", ...base, nudgesAtStage: 2 }), true);
  assert.equal(shouldAutoContinue({ mode: "tui", ...base, nudgesAtStage: 3 }), false);
});

test("the reminder budget keeps every structural line at maximum-length input", () => {
  const maxState: TodoState = {
    schemaVersion: 3,
    title: "P".repeat(TODO_TITLE_MAX_LENGTH),
    planId: "budget",
    goal: "G".repeat(TODO_GOAL_MAX_LENGTH),
    revision: 1,
    cursor: 0,
    nextItemSeq: 8,
    phase: "active",
    items: Array.from({ length: 7 }, (_, index) => ({
      id: `t${index + 1}`,
      title: `${index + 1}:${"T".repeat(TODO_TITLE_MAX_LENGTH - 2)}`,
      description: "E".repeat(TODO_DESCRIPTION_MAX_LENGTH),
      doneWhen: "D".repeat(TODO_DONE_WHEN_MAX_LENGTH),
    })),
  };

  const compact = buildReminder(maxState, "compact");
  assert.ok(compact.length <= TODO_REMINDER_MAX_LENGTH, "compact reminder must respect the budget");
  assert.match(compact, /^Current: /m, "the current task must survive truncation");
  assert.match(compact, /^Next: /m, "the next task must survive truncation");
  assert.match(compact, /^Done when: /m);
  assert.match(compact, /^Description: E/m);
  assert.match(compact, /^Plan: P/m);
  const goalLine = compact.split("\n").find((line) => line.startsWith("Goal: "))!;
  assert.ok(goalLine.length <= "Goal: ".length + 120, "the goal line is capped");
  assert.ok(goalLine.endsWith("…"), "a clipped goal is marked as truncated");

  const full = buildReminder(maxState, "full");
  assert.ok(full.length <= TODO_REMINDER_MAX_LENGTH);
  assert.match(full, /^\[>\] /m, "full mode must show at least the current task");
  assert.match(full, /^Tasks/m);
});

test("paused blocked reminders retain all critical fields within the budget", () => {
  const todo = state();
  todo.title = "P".repeat(TODO_TITLE_MAX_LENGTH);
  todo.goal = "G".repeat(TODO_GOAL_MAX_LENGTH);
  todo.phase = "blocked";
  todo.blockedReason = "B".repeat(500);
  for (const item of todo.items) {
    item.title = "T".repeat(TODO_TITLE_MAX_LENGTH);
    item.description = "E".repeat(TODO_DESCRIPTION_MAX_LENGTH);
    item.doneWhen = "D".repeat(TODO_DONE_WHEN_MAX_LENGTH);
  }
  for (const mode of ["compact", "full"] as const) {
    const text = buildReminder(todo, mode, { paused: true });
    assert.ok(text.length <= TODO_REMINDER_MAX_LENGTH, mode);
    assert.match(text, /Auto-continue: paused/);
    assert.match(text, /^Plan: P/m);
    assert.match(text, /^Goal: G/m);
    assert.match(text, /^Description: E/m);
    assert.match(text, /^Done when: D/m);
    assert.match(text, /^Blocked: B/m);
    assert.match(text, mode === "compact" ? /^Current: T/m : /^\[!\] T/m);
    if (mode === "compact") assert.match(text, /^Next: T/m);
    assert.doesNotMatch(text, /Run \/todos/);
  }
});

test("tool feedback preserves unabridged execution fields while context reminders stay bounded", () => {
  const todo = state();
  todo.title = "P".repeat(TODO_TITLE_MAX_LENGTH);
  todo.goal = `${"G".repeat(TODO_GOAL_MAX_LENGTH - 9)}GOAL_END!`;
  todo.phase = "blocked";
  todo.blockedReason = `${"B".repeat(480)}BLOCKER_END!`;
  todo.items[0]!.description = `${"E".repeat(TODO_DESCRIPTION_MAX_LENGTH - 12)}DETAILS_END!`;
  todo.items[0]!.doneWhen = `${"D".repeat(TODO_DONE_WHEN_MAX_LENGTH - 10)}CHECK_END!`;
  const feedback = buildTodoToolFeedback(todo, "Updated", true);
  for (const value of [todo.title, todo.goal, todo.blockedReason, todo.items[0]!.description!, todo.items[0]!.doneWhen!]) {
    assert.ok(feedback.includes(value), `tool feedback clipped ${value.slice(-20)}`);
  }
  for (const mode of ["compact", "full"] as const) {
    const reminder = buildReminder(todo, mode, { paused: true });
    assert.ok(reminder.length <= TODO_REMINDER_MAX_LENGTH);
    assert.match(reminder, /^Description: E/m);
    assert.match(reminder, /^Done when: D/m);
    assert.match(reminder, /^Blocked: B/m);
    assert.match(reminder, /^Goal: G/m);
  }
});

test("full recovery reminders keep a late current task visible instead of only completed history", () => {
  const todo = state();
  todo.items = Array.from({ length: 20 }, (_, index) => ({
    id: `t${index + 1}`, title: `${index + 1}: ${"T".repeat(55)}`, description: `Execution detail ${index + 1}`, doneWhen: `Condition ${index + 1}`,
  }));
  todo.cursor = 18;
  todo.nextItemSeq = 21;
  const text = buildReminder(todo, "full");
  assert.ok(text.length <= TODO_REMINDER_MAX_LENGTH);
  assert.match(text, /^Description: Execution detail 19/m);
  assert.match(text, /^Done when: Condition 19/m);
  assert.match(text, /^\[>\] 19:/m);
  assert.match(text, /^Goal: /m);
});

test("completed plans never inject a reminder even when all reminder flags are armed", () => {
  const runtime = createTodoRuntimeState();
  runtime.todo = { ...state(), phase: "completed", cursor: 3 };
  runtime.forceReminder = true;
  runtime.userTurnReminder = true;
  runtime.turnsSinceMutation = 100;
  assert.deepEqual(selectReminder(runtime), { mode: null, reason: "none" });
});
