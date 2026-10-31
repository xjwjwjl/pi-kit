import assert from "node:assert/strict";
import test from "node:test";
import {
  assertTodoStateInvariant,
  emptyTodoReducerDependencies,
  reduceTodo,
  TodoDomainError,
  type TodoTransition,
} from "../reducer.ts";
import type { TodoInput, TodoState } from "../schema.ts";

function reduce(previous: TodoState | null, input: TodoInput): TodoTransition {
  return reduceTodo(previous, input, emptyTodoReducerDependencies("plan-1"));
}

function planInput(tasks = ["Explore", "Implement", "Verify"]): TodoInput {
  return {
    action: "plan",
    title: "Ship the feature",
    goal: "Ship the complete feature with verification",
    tasks: tasks.map((title) => ({ title, description: `Execute ${title} within the feature scope`, doneWhen: `${title} is complete` })),
  };
}

function expectDomainError(code: TodoDomainError["code"], fn: () => unknown): void {
  assert.throws(fn, (error: unknown) => error instanceof TodoDomainError && error.code === code);
}

test("plan creates a V3 cursor-based active state with stable task ids and no timestamps", () => {
  const transition = reduce(null, planInput());
  assert.equal(transition.changed, true);
  assert.equal(transition.state?.schemaVersion, 3);
  assert.equal(transition.state?.planId, "plan-1");
  assert.equal(transition.state?.title, "Ship the feature");
  assert.equal(transition.state?.revision, 1);
  assert.equal(transition.state?.cursor, 0);
  assert.equal(transition.state?.phase, "active");
  assert.deepEqual(transition.state?.items.map((item) => item.id), ["t1", "t2", "t3"]);
  assert.equal(transition.state?.nextItemSeq, 4);
  assert.equal(Object.hasOwn(transition.state!, "createdAt"), false);
  assert.equal(Object.hasOwn(transition.state!, "updatedAt"), false);
  assertTodoStateInvariant(transition.state!);
});

test("advance atomically records a result and moves to the next task", () => {
  const created = reduce(null, planInput()).state!;
  const before = structuredClone(created);
  const transition = reduce(created, { action: "advance", completions: [{ result: "Exploration found the integration point." }] });
  assert.equal(transition.state?.cursor, 1);
  assert.equal(transition.state?.revision, 2);
  assert.equal(transition.state?.phase, "active");
  assert.equal(transition.state?.items[0]?.result, "Exploration found the integration point.");
  assert.equal(transition.state?.items[1]?.title, "Implement");
  assert.equal(transition.state?.items[0]?.description, created.items[0]?.description);
  assert.deepEqual(created, before);
});

test("the final advance completes the plan without clearing its history", () => {
  const state = reduce(null, planInput(["Only task"])).state!;
  const transition = reduce(state, { action: "advance", completions: [{ result: "Done" }] });
  assert.equal(transition.state?.phase, "completed");
  assert.equal(transition.state?.cursor, 1);
  assert.equal(transition.state?.revision, 2);
  assert.equal(transition.state?.items[0]?.result, "Done");
  assert.match(transition.summary, /Plan completed/);
});

test("block, resume and undo preserve execution metadata and the cursor", () => {
  const active = reduce(null, planInput()).state!;
  const blocked = reduce(active, { action: "block", reason: "Missing test credentials" }).state!;
  assert.equal(blocked.phase, "blocked");
  assert.equal(blocked.cursor, active.cursor);
  assert.equal(blocked.revision, active.revision + 1);
  assert.equal(blocked.blockedReason, "Missing test credentials");
  const resumed = reduce(blocked, { action: "resume" }).state!;
  assert.equal(resumed.phase, "active");
  assert.equal(resumed.cursor, active.cursor);
  assert.equal(resumed.revision, blocked.revision + 1);
  assert.equal(resumed.blockedReason, undefined);
  for (const state of [blocked, resumed, reduce(resumed, { action: "undo" }).state!]) {
    assert.equal(state.title, active.title);
    assert.equal(state.goal, active.goal);
    assert.deepEqual(state.items, active.items);
  }
  assert.equal(reduce(resumed, { action: "undo" }).state?.phase, "blocked");
});

test("replan keeps completed history and allocates never-reused ids", () => {
  const created = reduce(null, planInput()).state!;
  const advanced = reduce(created, { action: "advance", completions: [{ result: "Explored" }] }).state!;
  const replanned = reduce(advanced, {
    action: "replan", reason: "The implementation path changed",
    title: "Ship the revised feature", goal: "Ship the revised feature with new scope",
    tasks: [{ title: "Implement revised path", description: "Use the new integration path" }, { title: "Run verification" }],
  }).state!;
  assert.equal(replanned.revision, 3);
  assert.equal(replanned.cursor, 1);
  assert.equal(replanned.phase, "active");
  assert.deepEqual(replanned.items.map((item) => item.id), ["t1", "t4", "t5"]);
  assert.deepEqual(replanned.items[0], advanced.items[0]);
  assert.equal(replanned.items[1]?.description, "Use the new integration path");
  assert.equal(replanned.nextItemSeq, 6);
  assert.equal(replanned.goal, "Ship the revised feature with new scope");
  assert.equal(replanned.title, "Ship the revised feature");
});

test("an empty replan completes active or blocked remaining work while preserving completed history", () => {
  const created = reduce(null, planInput(["First", "Second"])).state!;
  const active = reduce(created, { action: "advance", completions: [{}] }).state!;
  const blocked = reduce(active, { action: "block", reason: "No longer needed" }).state!;
  for (const state of [active, blocked]) {
    const replanned = reduce(state, { action: "replan", reason: "Nothing else is required", tasks: [] }).state!;
    assert.equal(replanned.phase, "completed");
    assert.equal(replanned.cursor, 1);
    assert.deepEqual(replanned.items, active.items.slice(0, 1));
    assert.equal(replanned.revision, state.revision + 1);
    assert.equal(replanned.nextItemSeq, state.nextItemSeq);
    assert.equal(replanned.blockedReason, undefined);
    assert.equal(replanned.title, state.title);
    assertTodoStateInvariant(replanned);
  }
});

test("show is read-only and clear removes the current snapshot", () => {
  const created = reduce(null, planInput()).state!;
  const shown = reduce(created, { action: "show" });
  assert.equal(shown.changed, false);
  assert.deepEqual(shown.state, created);
  assert.notEqual(shown.state, created);
  shown.state!.items[0]!.description = "External mutation";
  assert.notDeepEqual(shown.state, created);
  const cleared = reduce(created, { action: "clear" });
  assert.equal(cleared.changed, true);
  assert.equal(cleared.state, null);
  assert.match(cleared.summary, /unfinished/);
  for (const action of ["show", "clear"] as const) assert.equal(reduce(null, { action }).changed, false);
});

test("illegal transitions fail without mutating the previous state", () => {
  const active = reduce(null, planInput()).state!;
  const before = structuredClone(active);
  expectDomainError("PLAN_ALREADY_ACTIVE", () => reduce(active, planInput()));
  const blocked = reduce(active, { action: "block", reason: "Wait" }).state!;
  expectDomainError("PLAN_ALREADY_ACTIVE", () => reduce(blocked, planInput()));
  expectDomainError("PLAN_BLOCKED", () => reduce(blocked, { action: "advance", completions: [{}] }));
  expectDomainError("PLAN_BLOCKED", () => reduce(blocked, { action: "insert", tasks: [{ title: "New" }] }));
  expectDomainError("PLAN_NOT_BLOCKED", () => reduce(active, { action: "resume" }));
  expectDomainError("NO_PLAN", () => reduce(null, { action: "advance", completions: [{}] }));
  const completed = reduce(reduce(null, planInput(["Done"])).state!, { action: "advance", completions: [{}] }).state!;
  expectDomainError("PLAN_COMPLETED", () => reduce(completed, { action: "replan", reason: "No longer needed", tasks: [{ title: "New" }] }));
  expectDomainError("PLAN_COMPLETED", () => reduce(completed, { action: "insert", tasks: [{ title: "New" }] }));
  assert.deepEqual(active, before);
});

test("semantic validation enforces non-empty fields and task limits", () => {
  expectDomainError("INVALID_GOAL", () => reduce(null, { ...planInput(), goal: "  " }));
  expectDomainError("INVALID_PLAN_TITLE", () => reduce(null, { action: "plan", goal: "Goal", tasks: [{ title: "Task" }] }));
  expectDomainError("INVALID_TASKS", () => reduce(null, { ...planInput(), tasks: [] }));
  expectDomainError("INVALID_REASON", () => reduce(reduce(null, planInput()).state!, { action: "block", reason: "  " }));
  expectDomainError("INVALID_TASK_TITLE", () => reduce(null, { ...planInput(), tasks: [{ title: "  " }] }));
  expectDomainError("INVALID_TASKS", () => reduce(null, planInput(Array.from({ length: 21 }, (_, index) => `Task ${index + 1}`))));
});

test("insert adds tasks at the requested position without moving the cursor", () => {
  const created = reduce(null, planInput()).state!;
  const advanced = reduce(created, { action: "advance", completions: [{ result: "explored" }] }).state!;
  const afterCurrent = reduce(advanced, { action: "insert", tasks: [{ title: "Hotfix", description: "Repair the newly found regression" }] }).state!;
  assert.deepEqual(afterCurrent.items.map((item) => item.title), ["Explore", "Implement", "Hotfix", "Verify"]);
  assert.equal(afterCurrent.items[2]?.description, "Repair the newly found regression");
  assert.equal(afterCurrent.cursor, advanced.cursor);
  assert.equal(afterCurrent.nextItemSeq, 5);
  assert.equal(afterCurrent.revision, advanced.revision + 1);
  const atEnd = reduce(afterCurrent, { action: "insert", position: "end", tasks: [{ title: "Polish" }] }).state!;
  assert.deepEqual(atEnd.items.map((item) => item.title), ["Explore", "Implement", "Hotfix", "Verify", "Polish"]);
  assert.equal(atEnd.cursor, advanced.cursor);
  assert.deepEqual(atEnd.items.map((item) => item.id), ["t1", "t2", "t4", "t3", "t5"]);
  assert.deepEqual(reduce(atEnd, { action: "undo" }).state?.items, afterCurrent.items);
});

test("insert and replan respect total plan limits and reject unknown positions", () => {
  const created = reduce(null, planInput()).state!;
  expectDomainError("INVALID_INPUT", () => reduce(created, { action: "insert", tasks: [{ title: "x" }], position: "middle" } as never));
  const full = reduce(null, planInput(Array.from({ length: 20 }, (_, index) => `Task ${index + 1}`))).state!;
  expectDomainError("INVALID_TASKS", () => reduce(full, { action: "insert", tasks: [{ title: "overflow" }], position: "end" }));
  const active = reduce(full, { action: "advance", completions: [{}] }).state!;
  expectDomainError("INVALID_TASKS", () => reduce(active, {
    action: "replan", reason: "Too much work", tasks: Array.from({ length: 20 }, () => ({ title: "Replacement" })),
  }));
});

test("undo restores the previous snapshot and is only available once", () => {
  const created = reduce(null, planInput()).state!;
  const advanced = reduce(created, { action: "advance", completions: [{ result: "done" }] }).state!;
  const undone = reduce(advanced, { action: "undo" }).state!;
  assert.deepEqual(undone.items, created.items);
  assert.equal(undone.cursor, 0);
  assert.equal(undone.items[0]!.result, undefined);
  assert.equal(undone.revision, advanced.revision + 1);
  assert.equal(undone.undo, undefined);
  expectDomainError("NOTHING_TO_UNDO", () => reduce(undone, { action: "undo" }));
});

test("undo reverts a replan and a plan creation", () => {
  const created = reduce(null, planInput()).state!;
  const replanned = reduce(created, { action: "replan", reason: "scope", tasks: [{ title: "Only" }] }).state!;
  const back = reduce(replanned, { action: "undo" }).state!;
  assert.deepEqual(back.items, created.items);
  assert.equal(back.goal, created.goal);
  assert.equal(back.title, created.title);
  expectDomainError("NOTHING_TO_UNDO", () => reduce(back, { action: "undo" }));
  assert.equal(reduce(created, { action: "undo" }).state, null);
});

test("undo preserves the task ID high-water mark before another insert or replan", () => {
  for (const action of ["insert", "replan"] as const) {
    for (const nextAction of ["insert", "replan"] as const) {
      const created = reduce(null, planInput()).state!;
      const active = reduce(created, { action: "advance", completions: [{ result: "Explored" }] }).state!;
      const changed = reduce(active, {
        action, tasks: [{ title: "Temporary A", description: "Temporary details" }, { title: "Temporary B" }],
        ...(action === "replan" ? { reason: "Temporary direction" } : {}),
      }).state!;
      const undone = reduce(changed, { action: "undo" }).state!;
      const label = `${action} -> undo -> ${nextAction}`;
      assert.deepEqual(undone.items, active.items, label);
      assert.equal(undone.nextItemSeq, changed.nextItemSeq, label);
      assert.equal(undone.revision, changed.revision + 1, label);
      assert.equal(undone.undo, undefined, label);
      assert.equal(changed.nextItemSeq, active.nextItemSeq + 2, label);
      const next = reduce(undone, {
        action: nextAction, tasks: [{ title: "Different task", description: "Different details" }],
        ...(nextAction === "replan" ? { reason: "Final direction" } : {}),
      }).state!;
      assert.equal(next.items.find((item) => item.title === "Different task")?.id, `t${changed.nextItemSeq}`, label);
      assert.equal(next.nextItemSeq, changed.nextItemSeq + 1, label);
      assert.equal(next.items[0]?.result, "Explored", label);
      assertTodoStateInvariant(next);
    }
  }
});

test("undoing a new plan keeps the restored plan's own ID sequence and metadata", () => {
  let completed = reduce(null, planInput()).state!;
  completed = reduce(completed, { action: "advance", completions: [{}, {}, {}] }).state!;
  const replacement = reduceTodo(completed, {
    action: "plan", title: "Complete different work", goal: "A different plan",
    tasks: Array.from({ length: 20 }, (_, index) => ({ title: `Task ${index + 1}` })),
  }, emptyTodoReducerDependencies("different-plan")).state!;
  const restored = reduce(replacement, { action: "undo" }).state!;
  assert.equal(restored.planId, completed.planId);
  assert.deepEqual(restored.items, completed.items);
  assert.equal(restored.title, completed.title);
  assert.equal(restored.goal, completed.goal);
  assert.equal(restored.nextItemSeq, completed.nextItemSeq);
});

test("actions reject fields they do not read instead of silently ignoring them", () => {
  const created = reduce(null, planInput()).state!;
  for (const input of [
    { action: "advance", tasks: [{ title: "x" }], completions: [{}] },
    { action: "advance", goal: "other", completions: [{}] },
    { action: "block", reason: "r", completions: [{ result: "o" }] },
    { action: "show", tasks: [{ title: "x" }] },
    { action: "resume", reason: "r" },
  ]) expectDomainError("INVALID_INPUT", () => reduce(created, input as TodoInput));
  assert.throws(() => reduce(created, { action: "advance", tasks: [{ title: "x" }], completions: [{}] }), /Use insert to add tasks or replan to replace the remaining plan/);
});

test("an empty replan without completed history is rejected", () => {
  const created = reduce(null, planInput()).state!;
  expectDomainError("INVALID_TASKS", () => reduce(created, { action: "replan", reason: "nothing left", tasks: [] }));
  assert.throws(() => reduce(created, { action: "replan", reason: "nothing left", tasks: [] }), /Use clear to discard the plan/);
  assert.equal(reduce(created, { action: "show" }).state?.phase, "active");
});
