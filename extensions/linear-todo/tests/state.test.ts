import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { emptyTodoReducerDependencies, reduceTodo } from "../reducer.ts";
import {
  createTodoStateStore,
  recoverTodoFromBranch,
  stageKey,
  TODO_AUTO_CONTINUE_CUSTOM_TYPE,
} from "../state.ts";
import { TODO_MAX_AUTO_CONTINUES_PER_STAGE, type TodoInput, type TodoState, type TodoToolDetails } from "../schema.ts";
import { shouldAutoContinue } from "../reminder.ts";

function createState(titles = ["First", "Second"]): TodoState {
  return reduceTodo(
    null,
    {
      action: "plan",
      title: "Persist a plan",
      goal: "Persist a plan",
      tasks: titles.map((title) => ({ title, description: `Execute ${title} with the original scope` })),
    },
    emptyTodoReducerDependencies("persisted-plan"),
  ).state!;
}

function change(state: TodoState, input: TodoInput): TodoState {
  return reduceTodo(state, input, emptyTodoReducerDependencies("unused")).state!;
}

function todoResult(
  id: string,
  details: TodoToolDetails,
  parentId: string | null = null,
  isError = false,
): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date(1_000).toISOString(),
    message: {
      role: "toolResult",
      toolCallId: id,
      toolName: "todo",
      content: [{ type: "text", text: details.transition }],
      details,
      isError,
      timestamp: 1_000,
    },
  } as unknown as SessionEntry;
}

function autoContinue(
  id: string,
  key: string,
  parentId: string | null = null,
  position?: { planId: string; cursor: number },
): SessionEntry {
  return {
    type: "custom_message",
    id,
    parentId,
    timestamp: new Date(2_000).toISOString(),
    customType: TODO_AUTO_CONTINUE_CUSTOM_TYPE,
    content: "Continue",
    display: false,
    details: position === undefined ? { stageKey: key } : { stageKey: key, planId: position.planId, cursor: position.cursor },
  } as unknown as SessionEntry;
}

test("recovery uses the latest Todo snapshot on the supplied branch", () => {
  const first = createState();
  const second = reduceTodo(
    first,
    { action: "advance", completions: [{ result: "First complete" }] },
    emptyTodoReducerDependencies("unused"),
  ).state!;
  const branch = [
    todoResult("one", { action: "plan", state: first, transition: "created" }),
    todoResult("two", { action: "advance", state: second, transition: "advanced" }, "one"),
  ];

  const recovered = recoverTodoFromBranch(branch);
  assert.deepEqual(recovered.todo, second);
  assert.equal(recovered.compatibilityError, undefined);
  assert.equal(recovered.todo?.items[0]!.description, "Execute First with the original scope");
  assert.equal(recovered.todo?.undo?.state?.items[0]!.description, "Execute First with the original scope");
  recovered.todo!.items[0]!.description = "External mutation";
  assert.equal(second.items[0]!.description, "Execute First with the original scope");
});

test("a clear snapshot truncates older Todo history", () => {
  const state = createState();
  const branch = [
    todoResult("one", { action: "plan", state, transition: "created" }),
    todoResult("clear", { action: "clear", state: null, transition: "cleared" }, "one"),
  ];

  const recovered = recoverTodoFromBranch(branch);
  assert.equal(recovered.todo, null);
  assert.equal(recovered.compatibilityError, undefined);
});

test("recovery is branch-local because callers supply the active branch", () => {
  const state = createState();
  const advanced = reduceTodo(
    state,
    { action: "advance", completions: [{}] },
    emptyTodoReducerDependencies("unused"),
  ).state!;
  const primary = [todoResult("root", { action: "plan", state, transition: "created" })];
  const alternate = [
    ...primary,
    todoResult("advance", { action: "advance", state: advanced, transition: "advanced" }, "root"),
  ];

  assert.equal(recoverTodoFromBranch(primary).todo?.cursor, 0);
  assert.equal(recoverTodoFromBranch(alternate).todo?.cursor, 1);
});

test("V1 task results enter version protection without being migrated", () => {
  const current = change(createState(), { action: "advance", completions: [{ result: "Recorded result" }] });
  const previous: Record<string, unknown> = {
    ...structuredClone(current), schemaVersion: 1,
    items: current.items.map((item) => ({ id: item.id, title: item.title, ...(item.result ? { outcome: item.result } : {}) })),
  };
  delete previous.undo;
  const before = structuredClone(previous);
  const entry = todoResult("previous", { action: "advance", state: previous as never, transition: "old snapshot" });
  const store = createTodoStateStore();
  store.recover([entry]);
  assert.equal(store.getState(), null);
  assert.match(store.getCompatibilityError() ?? "", /schemaVersion 1/);
  assert.deepEqual(previous, before);
  store.replace(null, "clear");
  assert.equal(store.getCompatibilityError(), undefined);
  store.replace(createState(), "plan");
  assert.equal(store.getState()?.schemaVersion, 3);
});

test("V2 and removed fields enter protection until an explicit clear", () => {
  const state = createState();
  const invalidStates = [
    { ...state, schemaVersion: 2 },
    { ...state, displayTitle: "Legacy overview" },
    { ...state, createdAt: 1, updatedAt: 2 },
    { ...state, items: state.items.map((item) => ({ ...item, displayTitle: "Legacy action" })) },
    { ...state, undo: { state: { ...state, updatedAt: 2 } } },
  ];
  for (const invalid of invalidStates) {
    const store = createTodoStateStore();
    store.recover([todoResult("invalid", { action: "plan", state: invalid as never, transition: "old fields" })]);
    assert.equal(store.getState(), null);
    assert.match(store.getCompatibilityError() ?? "", /not supported/);
    store.replace(null, "clear");
    store.replace(state, "plan");
    assert.deepEqual(store.getState(), state);
  }
});

test("unknown or malformed snapshots enter compatibility protection", () => {
  const unknown = todoResult(
    "unknown",
    {
      action: "plan",
      state: { schemaVersion: 99, planId: "future" } as never,
      transition: "future",
    },
  );
  const recovered = recoverTodoFromBranch([unknown]);
  assert.equal(recovered.todo, null);
  assert.match(recovered.compatibilityError ?? "", /schemaVersion 99/);

  const malformed = todoResult(
    "malformed",
    { action: "plan", state: { schemaVersion: 3 } as never, transition: "malformed" },
  );
  assert.match(recoverTodoFromBranch([malformed]).compatibilityError ?? "", /not supported|cannot/);

  const persistedProtection = todoResult(
    "protected",
    {
      action: "show",
      state: null,
      transition: "protected",
      error: "future state",
      compatibilityError: "future state",
    },
  );
  assert.equal(recoverTodoFromBranch([persistedProtection]).todo, null);
  assert.equal(recoverTodoFromBranch([persistedProtection]).compatibilityError, "future state");
});

test("host-generated error results are skipped instead of locking recovery", () => {
  const state = createState();
  const planned = todoResult("one", { action: "plan", state, transition: "created" });
  // Thrown errors, rejected arguments, and aborted calls land as isError + empty details.
  const hostError = todoResult("two", { action: "plan", transition: "Rejected: aborted" } as TodoToolDetails, "one", true);
  const emptyError = todoResult("two-b", {} as TodoToolDetails, "one", true);

  const recovered = recoverTodoFromBranch([planned, emptyError, hostError]);
  assert.equal(recovered.todo?.planId, state.planId);
  assert.equal(recovered.compatibilityError, undefined);

  const onlyError = recoverTodoFromBranch([hostError, emptyError]);
  assert.equal(onlyError.todo, null);
  assert.equal(onlyError.compatibilityError, undefined);

  // A successful result without a snapshot is still a real compatibility problem.
  const foreign = todoResult("three", { action: "plan", transition: "foreign" } as never);
  assert.match(recoverTodoFromBranch([foreign]).compatibilityError ?? "", /supported state snapshot/);
});

test("the nudge ledger restores only valid stage keys from the active branch", () => {
  const state = createState();
  const key = stageKey(state);
  assert.equal(key, JSON.stringify(["linear-todo-nudge", 1, "persisted-plan", 0, 0]));
  const recovered = recoverTodoFromBranch([
    todoResult("one", { action: "plan", state, transition: "created" }),
    autoContinue("nudge", key, "one"),
    autoContinue("invalid", "", "nudge"),
  ]);

  assert.equal(recovered.nudgedStageKeys.has(key), true);
  assert.equal(recovered.nudgedStageKeys.size, 1);
});

test("results from a foreign tool named todo never lock recovery", () => {
  const state = createState();
  const planned = todoResult("one", { action: "plan", state, transition: "created" });
  // Another extension can register a tool with the same name; its details are not our snapshot.
  const foreign = todoResult("two", { files: ["a.ts"], ok: true } as never, "one");

  const recovered = recoverTodoFromBranch([planned, foreign]);
  assert.equal(recovered.todo?.planId, state.planId);
  assert.equal(recovered.compatibilityError, undefined);

  const onlyForeign = recoverTodoFromBranch([foreign]);
  assert.equal(onlyForeign.todo, null);
  assert.equal(onlyForeign.compatibilityError, undefined);

  // A result that mimics our action/transition signature is indistinguishable from our own
  // snapshot, so an unsupported state stays a real compatibility problem.
  const mimic = todoResult("three", { action: "plan", state: { unexpected: true }, transition: "x" } as never, "two");
  assert.match(recoverTodoFromBranch([mimic]).compatibilityError ?? "", /not supported/);
});

test("per-position auto-continue counts survive a restart", () => {
  const state = createState();
  const recovered = recoverTodoFromBranch([
    todoResult("one", { action: "plan", state, transition: "created" }),
    autoContinue("a", "persisted-plan:1", "one", { planId: "persisted-plan", cursor: 0 }),
    autoContinue("b", "persisted-plan:2", "a", { planId: "persisted-plan", cursor: 0 }),
    autoContinue("c", "persisted-plan:3", "b", { planId: "persisted-plan", cursor: 1 }),
    autoContinue("legacy", "persisted-plan:4", "c"),
  ]);

  assert.equal(recovered.nudgedStageKeys.size, 6, "preserve four raw keys and two canonical aliases");
  assert.equal(recovered.nudgedStageKeys.has(stageKey(state)), true);
  assert.equal(recovered.nudgeCounts.get("persisted-plan:0"), 2);
  assert.equal(recovered.nudgeCounts.get("persisted-plan:1"), 1);

  const store = createTodoStateStore();
  store.recover([
    todoResult("one", { action: "plan", state, transition: "created" }),
    autoContinue("a", "persisted-plan:1", "one", { planId: "persisted-plan", cursor: 0 }),
  ]);
  assert.equal(store.nudgesAt("persisted-plan", 0), 1);
  assert.equal(store.nudgesAt("persisted-plan", 5), 0);
  assert.equal(store.runtime.paused, false);
});

test("state store clones snapshots and isolates UI refresh failures", () => {
  let refreshes = 0;
  const store = createTodoStateStore(() => {
    refreshes += 1;
    throw new Error("UI unavailable");
  });
  const state = createState();

  store.replace(state);
  const snapshot = store.getState()!;
  snapshot.items[0]!.title = "mutated outside store";
  snapshot.items[0]!.description = "mutated details";

  assert.equal(store.getState()!.items[0]!.title, "First");
  assert.equal(store.getState()!.items[0]!.description, "Execute First with the original scope");
  assert.equal(store.runtime.skipNextContextReminder, true);
  assert.equal(refreshes, 1);
});

test("completed widget dismissal follows completion, replacement undo and recovery", () => {
  const store = createTodoStateStore();
  const active = createState();
  const completed = change(active, { action: "advance", completions: [{}, {}] });
  assert.equal(completed.phase, "completed");

  store.replace(active, "plan");
  assert.equal(store.runtime.completedDismissed, false);
  store.replace(completed, "advance");
  assert.equal(store.runtime.completedDismissed, false, "the completing mutation keeps the widget until settlement");

  const partiallyDone = change(active, { action: "advance", completions: [{}] });
  const finishedByReplan = change(partiallyDone, {
    action: "replan", reason: "The remaining work is no longer required", tasks: [],
  });
  assert.equal(finishedByReplan.phase, "completed");
  store.replace(finishedByReplan, "replan");
  assert.equal(store.runtime.completedDismissed, false, "a replan completion keeps the widget until settlement");

  const reopened = change(completed, { action: "undo" });
  assert.equal(reopened.phase, "active");
  store.replace(reopened, "undo");
  assert.equal(store.runtime.completedDismissed, false, "undo to an active plan re-arms the widget");

  const replacement = change(completed, {
    action: "plan", title: "Next plan", goal: "Next plan", tasks: [{ title: "Next task" }],
  });
  assert.notEqual(replacement.planId, completed.planId);
  store.replace(replacement, "plan");
  assert.equal(store.runtime.completedDismissed, false, "a new active plan owns the widget");

  const restored = change(replacement, { action: "undo" });
  assert.equal(restored.phase, "completed");
  assert.equal(restored.planId, completed.planId);
  store.replace(restored, "undo");
  assert.equal(store.runtime.completedDismissed, true, "undo to a completed pre-image stays released");

  store.recover([todoResult("completed", { action: "advance", state: completed, transition: "completed" })]);
  assert.equal(store.runtime.completedDismissed, true, "a recovered completed plan belongs to a settled run");
  store.recover([todoResult("active", { action: "plan", state: active, transition: "created" })]);
  assert.equal(store.runtime.completedDismissed, false);
});

test("canonical stage keys depend on position and explicit resume, not mutation revision or task IDs", () => {
  const state = createState();
  const edited = change(state, { action: "replan", reason: "New approach", tasks: [{ title: "Replacement" }] });
  assert.notEqual(edited.revision, state.revision);
  assert.notEqual(edited.items[0]!.id, state.items[0]!.id);
  assert.equal(stageKey(edited), stageKey(state));
  assert.notEqual(stageKey(change(state, { action: "advance", completions: [{}] })), stageKey(state));
  assert.notEqual(stageKey(state, 3), stageKey(state));
  const unusualId = { ...state, planId: 'quoted:"plan:0' };
  assert.deepEqual(JSON.parse(stageKey(unusualId, 3)), ["linear-todo-nudge", 1, unusualId.planId, 0, 3]);
});

test("edits and undo never replenish a consumed correction allowance", () => {
  const store = createTodoStateStore();
  let state = createState();
  store.replace(state, "plan");
  const key = store.getStageKey(state);
  store.markNudged(key, state.planId, state.cursor);
  const edits: TodoInput[] = [
    { action: "insert", tasks: [{ title: "Urgent" }] },
    { action: "undo" },
    { action: "insert", position: "end", tasks: [{ title: "Later" }] },
    { action: "undo" },
    { action: "replan", title: "Revise the work", goal: "Revised goal", reason: "New direction", tasks: [{ title: "Replacement" }] },
    { action: "undo" },
    { action: "block", reason: "Waiting" },
    { action: "undo" },
    { action: "show" },
  ];
  for (const input of edits) {
    state = change(state, input);
    store.replace(state, input.action);
    assert.equal(store.getStageKey(state), key, input.action);
    assert.equal(store.isNudged(key), true, input.action);
    assert.equal(store.nudgesAt(state.planId, state.cursor), 1, input.action);
    assert.equal(store.runtime.resumeRevisions.size, 0);
  }
});

test("advance gives a new position but undo restores its previously consumed allowance", () => {
  const store = createTodoStateStore();
  const first = createState();
  store.replace(first, "plan");
  store.markNudged(store.getStageKey(first), first.planId, first.cursor);
  const second = change(first, { action: "advance", completions: [{}] });
  store.replace(second, "advance");
  assert.equal(store.isNudged(store.getStageKey(second)), false);
  store.markNudged(store.getStageKey(second), second.planId, second.cursor);
  const restored = change(second, { action: "undo" });
  store.replace(restored, "undo");
  assert.equal(store.getStageKey(restored), store.getStageKey(first));
  assert.equal(store.isNudged(store.getStageKey(restored)), true);
  assert.equal(store.nudgesAt(first.planId, 0), 1);
  assert.equal(store.nudgesAt(first.planId, 1), 1);
  const secondAgain = change(restored, { action: "advance", completions: [{}] });
  store.replace(secondAgain, "advance");
  assert.equal(store.isNudged(store.getStageKey(secondAgain)), true, "revisiting a position is not a refund");
});

test("batch snapshots recover atomically and undo never refunds either visited position", () => {
  const store = createTodoStateStore();
  const first = createState(["First", "Second", "Third"]);
  store.replace(first, "plan");
  const firstKey = store.getStageKey(first);
  store.markNudged(firstKey, first.planId, first.cursor);
  const batch = change(first, { action: "advance", completions: [{ result: "First done" }, { result: "Second done" }] });
  store.replace(batch, "advance");
  const batchKey = store.getStageKey(batch);
  assert.equal(batch.cursor, 2);
  assert.equal(store.isNudged(batchKey), false);
  store.markNudged(batchKey, batch.planId, batch.cursor);
  const restored = change(batch, { action: "undo" });
  store.replace(restored, "undo");
  assert.equal(restored.cursor, 0);
  assert.deepEqual(restored.items, first.items);
  assert.equal(store.isNudged(firstKey), true);
  assert.equal(store.nudgesAt(first.planId, 0), 1);
  assert.equal(store.nudgesAt(first.planId, 1), 0, "no intermediate position was visited");
  assert.equal(store.nudgesAt(first.planId, 2), 1);
  const entries = [
    todoResult("plan", { action: "plan", state: first, transition: "created" }),
    autoContinue("nudge-0", firstKey, "plan", { planId: first.planId, cursor: 0 }),
    todoResult("batch", { action: "advance", state: batch, transition: "batch complete" }, "nudge-0"),
    autoContinue("nudge-2", batchKey, "batch", { planId: batch.planId, cursor: 2 }),
  ];
  assert.deepEqual(recoverTodoFromBranch(entries).todo, batch);
  const recovered = recoverTodoFromBranch([
    ...entries, todoResult("undo", { action: "undo", state: restored, transition: "undone" }, "nudge-2"),
  ]);
  assert.deepEqual(recovered.todo, restored);
  assert.equal(recovered.nudgeCounts.get(`${first.planId}:0`), 1);
  assert.equal(recovered.nudgeCounts.has(`${first.planId}:1`), false);
  assert.equal(recovered.nudgeCounts.get(`${first.planId}:2`), 1);
});

test("explicit resume changes eligibility without resetting the three-attempt positional budget", () => {
  const store = createTodoStateStore();
  let state = createState();
  store.replace(state, "plan");
  for (let attempt = 0; attempt < TODO_MAX_AUTO_CONTINUES_PER_STAGE; attempt += 1) {
    const key = store.getStageKey(state);
    assert.equal(store.isNudged(key), false);
    store.markNudged(key, state.planId, state.cursor);
    const blocked = change(state, { action: "block", reason: "Need credentials" });
    store.replace(blocked, "block");
    state = change(blocked, { action: "resume" });
    store.replace(state, "resume");
    assert.equal(store.runtime.resumeRevisions.get(`${state.planId}:0`), state.revision);
    assert.equal(store.getStageKey(state), stageKey(state, state.revision));
    assert.equal(store.nudgesAt(state.planId, 0), attempt + 1);
  }
  assert.equal(shouldAutoContinue({
    mode: "rpc", state, hasPendingMessages: false, lastRunWasUserAbort: false,
    alreadyNudged: store.isNudged(store.getStageKey(state)), nudgesAtStage: store.nudgesAt(state.planId, 0),
  }), false);
});

test("undoing a resume does not erase its allowance history or let a replan create another", () => {
  const store = createTodoStateStore();
  const initial = createState();
  const blocked = change(initial, { action: "block", reason: "Wait" });
  store.replace(blocked, "block");
  const resumed = change(blocked, { action: "resume" });
  store.replace(resumed, "resume");
  const key = store.getStageKey(resumed);
  store.markNudged(key, resumed.planId, resumed.cursor);
  const undone = change(resumed, { action: "undo" });
  store.replace(undone, "undo");
  assert.equal(undone.phase, "blocked");
  const replanned = change(undone, { action: "replan", reason: "Changed approach", tasks: [{ title: "Replacement" }] });
  store.replace(replanned, "replan");
  assert.equal(replanned.phase, "active");
  assert.equal(store.getStageKey(replanned), key);
  assert.equal(store.isNudged(key), true);
  assert.equal(store.nudgesAt(initial.planId, 0), 1);
});

test("a blocked-to-active replan and an unchanged resume snapshot do not grant a resume epoch", () => {
  const state = createState();
  const store = createTodoStateStore();
  store.replace(state, "plan");
  store.replace(state, "resume");
  assert.equal(store.runtime.resumeRevisions.size, 0);
  const blocked = change(state, { action: "block", reason: "Wait" });
  store.replace(blocked, "block");
  const replanned = change(blocked, { action: "replan", reason: "Other approach", tasks: [{ title: "Other" }] });
  store.replace(replanned, "replan");
  assert.equal(store.getStageKey(replanned), stageKey(state));
  assert.equal(store.runtime.resumeRevisions.size, 0);
});

test("mixed legacy and canonical nudges are associated with their chronological resume epochs", () => {
  const first = createState();
  const edited = change(first, { action: "insert", tasks: [{ title: "Urgent" }] });
  const blocked = change(edited, { action: "block", reason: "Wait" });
  const resumed = change(blocked, { action: "resume" });
  const blockedAgain = change(resumed, { action: "block", reason: "Wait again" });
  const resumedAgain = change(blockedAgain, { action: "resume" });
  const branch = [
    todoResult("plan", { action: "plan", state: first, transition: "created" }),
    autoContinue("legacy-only", `${first.planId}:${first.revision}`, "plan"),
    todoResult("insert", { action: "insert", state: edited, transition: "inserted" }, "legacy-only"),
    autoContinue("legacy-position", `${edited.planId}:${edited.revision}`, "insert", edited),
    todoResult("block", { action: "block", state: blocked, transition: "blocked" }, "legacy-position"),
    todoResult("resume", { action: "resume", state: resumed, transition: "resumed" }, "block"),
    autoContinue("canonical", stageKey(resumed, resumed.revision), "resume", resumed),
    todoResult("block-again", { action: "block", state: blockedAgain, transition: "blocked" }, "canonical"),
    todoResult("resume-again", { action: "resume", state: resumedAgain, transition: "resumed" }, "block-again"),
  ];
  const store = createTodoStateStore();
  store.recover(branch);
  assert.equal(store.isNudged(`${first.planId}:${first.revision}`), true, "legacy raw key is retained");
  assert.equal(store.isNudged(`${edited.planId}:${edited.revision}`), true);
  assert.equal(store.isNudged(stageKey(first)), true);
  assert.equal(store.isNudged(stageKey(resumed, resumed.revision)), true);
  assert.equal(store.isNudged(store.getStageKey(resumedAgain)), false, "later unused resume must not inherit an old nudge");
  assert.equal(store.runtime.resumeRevisions.get(`${first.planId}:0`), resumedAgain.revision);
  assert.equal(store.nudgesAt(first.planId, 0), 3, "one count per message, not per alias");
  assert.deepEqual(store.getState(), resumedAgain);
  assert.equal(shouldAutoContinue({
    mode: "rpc", state: resumedAgain, hasPendingMessages: false, lastRunWasUserAbort: false,
    alreadyNudged: false, nudgesAtStage: store.nudgesAt(first.planId, 0),
  }), false, "a fresh resume key cannot bypass the positional cap after restart");
});

test("a revision-only legacy nudge after resume consumes that resume epoch", () => {
  const first = createState();
  const blocked = change(first, { action: "block", reason: "Wait" });
  const resumed = change(blocked, { action: "resume" });
  const edited = change(resumed, { action: "insert", tasks: [{ title: "Later" }] });
  const store = createTodoStateStore();
  store.recover([
    todoResult("plan", { action: "plan", state: first, transition: "created" }),
    todoResult("block", { action: "block", state: blocked, transition: "blocked" }, "plan"),
    todoResult("resume", { action: "resume", state: resumed, transition: "resumed" }, "block"),
    autoContinue("legacy", `${resumed.planId}:${resumed.revision}`, "resume"),
    todoResult("insert", { action: "insert", state: edited, transition: "inserted" }, "legacy"),
  ]);
  assert.equal(store.getStageKey(edited), stageKey(resumed, resumed.revision));
  assert.equal(store.isNudged(store.getStageKey(edited)), true);
  assert.equal(store.nudgesAt(first.planId, 0), 1);
});

test("resume epochs and spent budgets are independent across positions and plans", () => {
  const store = createTodoStateStore();
  const first = createState();
  const blocked = change(first, { action: "block", reason: "Wait" });
  store.replace(blocked, "block");
  const resumed = change(blocked, { action: "resume" });
  store.replace(resumed, "resume");
  store.markNudged(store.getStageKey(resumed), resumed.planId, resumed.cursor);
  const second = change(resumed, { action: "advance", completions: [{}] });
  store.replace(second, "advance");
  assert.equal(store.getStageKey(second), stageKey(second), "a resume at cursor zero does not change cursor one's epoch");
  assert.equal(store.nudgesAt(first.planId, 1), 0);
  store.replace(null, "clear");
  const fresh = reduceTodo(null, {
    action: "plan", title: "Start new work", goal: "New plan", tasks: [{ title: "New work" }],
  }, emptyTodoReducerDependencies("another-plan")).state!;
  store.replace(fresh, "plan");
  assert.equal(store.getStageKey(fresh), stageKey(fresh));
  assert.equal(store.isNudged(store.getStageKey(fresh)), false);
  assert.equal(store.nudgesAt(fresh.planId, 0), 0);
  assert.equal(store.nudgesAt(first.planId, 0), 1);
  assert.equal(store.runtime.resumeRevisions.get(`${first.planId}:0`), resumed.revision);
});

test("unknown legacy keys are preserved but never assigned a guessed position", () => {
  const state = createState();
  const recovered = recoverTodoFromBranch([
    autoContinue("before-snapshot", `${state.planId}:${state.revision}`),
    todoResult("plan", { action: "plan", state, transition: "created" }),
    autoContinue("unknown", `${state.planId}:999`, "plan"),
  ]);
  assert.equal(recovered.nudgedStageKeys.size, 2);
  assert.equal(recovered.nudgedStageKeys.has(stageKey(state)), false);
  assert.equal(recovered.nudgeCounts.size, 0);
});

test("error, unchanged, foreign, blocked, and unsupported resume snapshots never grant eligibility", () => {
  const first = createState();
  const blocked = change(first, { action: "block", reason: "Wait" });
  const resumed = change(blocked, { action: "resume" });
  const planned = todoResult("plan", { action: "plan", state: first, transition: "created" });
  const invalidResumes = [
    todoResult("error", { action: "resume", state: resumed, transition: "rejected" }, "plan", true),
    todoResult("details-error", { action: "resume", state: resumed, transition: "rejected", error: "Rejected" }, "plan"),
    todoResult("unchanged", { action: "resume", state: first, transition: "unchanged" }, "plan"),
    todoResult("blocked", { action: "resume", state: blocked, transition: "invalid phase" }, "plan"),
    todoResult("foreign", { action: "resume", state: resumed } as TodoToolDetails, "plan"),
    todoResult("unsupported", { action: "resume", state: { schemaVersion: 99 } as never, transition: "future" }, "plan"),
  ];
  for (const invalid of invalidResumes) {
    const recovered = recoverTodoFromBranch([planned, invalid]);
    assert.equal(recovered.resumeRevisions.size, 0, invalid.id);
  }
  const recovered = recoverTodoFromBranch([
    planned,
    todoResult("block", { action: "block", state: blocked, transition: "blocked" }, "plan"),
    todoResult("resume", { action: "resume", state: resumed, transition: "resumed" }, "block"),
    todoResult("failed-again", { action: "resume", state: resumed, transition: "rejected", error: "Already active" }, "resume", true),
  ]);
  assert.equal(recovered.resumeRevisions.get(`${first.planId}:0`), resumed.revision, "errors do not erase successful resume history");
});

test("recovery preserves undo history, isolates sibling ledgers, and retains latest-state compatibility protection", () => {
  const first = createState();
  const blocked = change(first, { action: "block", reason: "Wait" });
  const resumed = change(blocked, { action: "resume" });
  const undone = change(resumed, { action: "undo" });
  const root = todoResult("plan", { action: "plan", state: first, transition: "created" });
  const shared = [root, autoContinue("initial", stageKey(first), "plan", first)];
  const sibling = [
    ...shared,
    todoResult("block", { action: "block", state: blocked, transition: "blocked" }, "initial"),
    todoResult("resume", { action: "resume", state: resumed, transition: "resumed" }, "block"),
    autoContinue("resumed-nudge", stageKey(resumed, resumed.revision), "resume", resumed),
    todoResult("undo", { action: "undo", state: undone, transition: "undone" }, "resumed-nudge"),
  ];
  const store = createTodoStateStore();
  store.recover(sibling);
  assert.deepEqual(store.getState(), undone);
  assert.equal(store.getStageKey(undone), stageKey(resumed, resumed.revision));
  assert.equal(store.nudgesAt(first.planId, 0), 2);
  store.recover(shared);
  assert.equal(store.runtime.resumeRevisions.size, 0);
  assert.equal(store.nudgesAt(first.planId, 0), 1);
  assert.equal(store.isNudged(stageKey(resumed, resumed.revision)), false);
  const future = todoResult("future", { action: "show", state: { schemaVersion: 99 } as never, transition: "future" });
  store.recover([...sibling, future]);
  assert.equal(store.getState(), null);
  assert.match(store.getCompatibilityError() ?? "", /schemaVersion 99/);
  assert.equal(store.nudgesAt(first.planId, 0), 2);
  store.recover([...sibling, future, todoResult("clear", { action: "clear", state: null, transition: "cleared" })]);
  assert.equal(store.getCompatibilityError(), undefined);
  assert.equal(store.getState(), null);
  assert.equal(store.nudgesAt(first.planId, 0), 2, "clear does not rewrite spent history");
});
