import assert from "node:assert/strict";
import test from "node:test";
import { validateToolArguments, type ToolCall } from "@earendil-works/pi-ai";
import { emptyTodoReducerDependencies, reduceTodo, TodoDomainError } from "../reducer.ts";
import {
  cloneTodoStateForUndo,
  isTodoState,
  TODO_MAX_ITEMS,
  TODO_RESULT_MAX_LENGTH,
  TodoInputSchema,
  type TodoInput,
  type TodoState,
} from "../schema.ts";

function reduce(state: TodoState | null, input: TodoInput) {
  return reduceTodo(state, input, emptyTodoReducerDependencies("batch-plan"));
}

function plan(titles = ["Explore", "Implement", "Verify", "Document"]): TodoState {
  return reduce(null, {
    action: "plan", title: "Complete consecutive work", goal: "Complete and verify the entire feature",
    tasks: titles.map((title) => ({ title, description: `Execute ${title} for the feature`, doneWhen: `${title} is complete` })),
  }).state!;
}

function domainError(code: TodoDomainError["code"], execute: () => unknown): void {
  assert.throws(execute, (error: unknown) => error instanceof TodoDomainError && error.code === code);
}

test("single completion records allow optional results without an implicit single-item fallback", () => {
  const state = plan();
  for (const result of [undefined, "", "  Found\n the integration point.  "]) {
    const transition = reduce(state, { action: "advance", completions: [result === undefined ? {} : { result }] });
    assert.equal(transition.state?.cursor, 1);
    assert.equal(transition.state?.revision, state.revision + 1);
    assert.equal(transition.state?.items[0]?.result, result?.trim() ? "Found the integration point." : undefined);
  }
  domainError("INVALID_COMPLETIONS", () => reduce(state, { action: "advance" }));
});

test("one batch records optional results in order and advances the cursor only once", () => {
  const state = plan();
  const before = structuredClone(state);
  const input: TodoInput = { action: "advance", completions: [{ result: "  Located\n the entry point  " }, {}] };
  const originalInput = structuredClone(input);
  const transition = reduce(state, input);
  const next = transition.state!;
  assert.equal(transition.changed, true);
  assert.equal(next.cursor, 2);
  assert.equal(next.phase, "active");
  assert.equal(next.revision, state.revision + 1);
  assert.equal(Object.hasOwn(next, "createdAt"), false);
  assert.equal(Object.hasOwn(next, "updatedAt"), false);
  assert.equal(next.nextItemSeq, state.nextItemSeq);
  assert.equal(next.title, state.title);
  assert.equal(next.goal, state.goal);
  assert.deepEqual(next.items.map((item) => item.id), state.items.map((item) => item.id));
  assert.deepEqual(next.items.map((item) => item.description), state.items.map((item) => item.description));
  assert.equal(next.items[0]?.result, "Located the entry point");
  assert.equal(next.items[1]?.result, undefined);
  assert.deepEqual(next.items.slice(2), state.items.slice(2));
  assert.deepEqual(next.undo?.state, cloneTodoStateForUndo(state));
  assert.equal(isTodoState(next), true);
  assert.match(transition.summary, /Completed 2\/4: 2 tasks in this call/);
  assert.match(transition.summary, /1\. Explore\. Result: Located the entry point\n2\. Implement\./);
  assert.doesNotMatch(transition.summary, /undefined|null|Plan completed/);
  assert.deepEqual(state, before);
  assert.deepEqual(input, originalInput);
});

test("a final batch preserves earlier history and returns every newly reported result", () => {
  const state = reduce(plan(), { action: "advance", completions: [{ result: "EARLIER_RESULT" }] }).state!;
  const transition = reduce(state, {
    action: "advance", completions: [{ result: "Implementation ready" }, {}, { result: "Usage documented" }],
  });
  assert.equal(transition.state?.cursor, 4);
  assert.equal(transition.state?.phase, "completed");
  assert.equal(transition.state?.revision, state.revision + 1);
  assert.equal(transition.state?.items[0]?.result, "EARLIER_RESULT");
  assert.equal(transition.state?.items[1]?.result, "Implementation ready");
  assert.equal(transition.state?.items[2]?.result, undefined);
  assert.equal(transition.state?.items[3]?.result, "Usage documented");
  assert.match(transition.summary, /Completed 4\/4: 3 tasks in this call\. Plan completed/);
  assert.match(transition.summary, /2\. Implement\. Result: Implementation ready\n3\. Verify\.\n4\. Document\. Result: Usage documented/);
  assert.doesNotMatch(transition.summary, /EARLIER_RESULT/);
});

test("undo restores the entire batch and descriptions, including after final completion", () => {
  for (const count of [2, 4]) {
    const state = plan();
    const completed = reduce(state, {
      action: "advance", completions: Array.from({ length: count }, (_unused, index) => ({ result: `Result ${index + 1}` })),
    }).state!;
    const restored = reduce(completed, { action: "undo" }).state!;
    assert.equal(restored.cursor, state.cursor);
    assert.equal(restored.phase, "active");
    assert.deepEqual(restored.items, state.items);
    assert.equal(restored.title, state.title);
    assert.equal(restored.goal, state.goal);
    assert.equal(restored.nextItemSeq, state.nextItemSeq);
    assert.equal(restored.revision, completed.revision + 1);
    assert.equal(restored.undo, undefined);
    domainError("NOTHING_TO_UNDO", () => reduce(restored, { action: "undo" }));
  }
});

test("invalid completion records and unsupported arguments reject the entire batch without mutation", () => {
  const state = plan();
  const before = structuredClone(state);
  const invalid: Array<[unknown, TodoDomainError["code"]]> = [
    [{}, "INVALID_COMPLETIONS"],
    [{ outcome: "Removed input" }, "INVALID_INPUT"],
    [{ completions: [{ outcome: "Removed field" }] }, "INVALID_COMPLETIONS"],
    [{ completions: [] }, "INVALID_COMPLETIONS"],
    [{ completions: null }, "INVALID_COMPLETIONS"],
    [{ completions: "two" }, "INVALID_COMPLETIONS"],
    [{ completions: Array.from({ length: 5 }, () => ({})) }, "INVALID_COMPLETIONS"],
    [{ completions: [null] }, "INVALID_COMPLETIONS"],
    [{ completions: ["done"] }, "INVALID_COMPLETIONS"],
    [{ completions: [[]] }, "INVALID_COMPLETIONS"],
    [{ completions: [{ result: "First result" }, { id: "t3" }] }, "INVALID_COMPLETIONS"],
    [{ completions: [{ title: "Skip current" }] }, "INVALID_COMPLETIONS"],
    [{ completions: [{ description: "Not a completion field" }] }, "INVALID_COMPLETIONS"],
    [{ completions: [{ status: "completed" }] }, "INVALID_COMPLETIONS"],
    [{ completions: [{ result: "First result" }, { result: 7 }] }, "INVALID_RESULT"],
    [{ completions: [{ result: null }] }, "INVALID_RESULT"],
    [{ completions: [{}, { result: "x".repeat(TODO_RESULT_MAX_LENGTH + 1) }] }, "INVALID_RESULT"],
    [{ completions: new Array(2) }, "INVALID_COMPLETIONS"],
    [{ completions: [{}], result: "Unsupported top-level result" }, "INVALID_INPUT"],
    [{ completions: [{}], result: "" }, "INVALID_INPUT"],
    [{ count: 2 }, "INVALID_INPUT"],
    [{ results: ["First", "Second"] }, "INVALID_INPUT"],
  ];
  for (const [fields, code] of invalid) {
    const input = { action: "advance", ...(fields as object) } as TodoInput;
    domainError(code, () => reduce(state, input));
    assert.deepEqual(state, before, JSON.stringify(fields));
  }
  const partlyDone = reduce(state, { action: "advance", completions: [{}, {}, {}] }).state!;
  domainError("INVALID_COMPLETIONS", () => reduce(partlyDone, { action: "advance", completions: [{}, {}] }));
});

test("batch completion retains the existing plan lifecycle guards and action-specific fields", () => {
  const state = plan();
  const batch: TodoInput = { action: "advance", completions: [{}, {}] };
  domainError("NO_PLAN", () => reduce(null, batch));
  const blocked = reduce(state, { action: "block", reason: "Waiting for input" }).state!;
  domainError("PLAN_BLOCKED", () => reduce(blocked, batch));
  const completed = reduce(state, { action: "advance", completions: [{}, {}, {}, {}] }).state!;
  domainError("PLAN_COMPLETED", () => reduce(completed, batch));
  for (const action of ["plan", "replan", "insert", "undo", "block", "resume", "show", "clear"] as const) {
    domainError("INVALID_INPUT", () => reduce(state, { action, completions: [{}] }));
  }
});

test("the maximum-size batch remains a valid V3 snapshot with one undo pre-image", () => {
  const state = plan(Array.from({ length: TODO_MAX_ITEMS }, (_unused, index) => `Task ${index + 1}`));
  const next = reduce(state, { action: "advance", completions: Array.from({ length: TODO_MAX_ITEMS }, () => ({})) }).state!;
  assert.equal(next.schemaVersion, 3);
  assert.equal(next.cursor, TODO_MAX_ITEMS);
  assert.equal(next.revision, 2);
  assert.equal(next.phase, "completed");
  assert.equal(next.undo?.state?.undo, undefined);
  assert.equal(isTodoState(JSON.parse(JSON.stringify(next))), true);
});

test("the public tool schema accepts empty completion records and rejects malformed batch shapes", () => {
  const validate = (args: ToolCall["arguments"]) => validateToolArguments(
    { name: "todo", description: "Maintain a plan", parameters: TodoInputSchema },
    { type: "toolCall", id: "batch-schema", name: "todo", arguments: args },
  );
  const args: ToolCall["arguments"] = { action: "advance", completions: [{}, { result: "Observed result" }] };
  assert.deepEqual(validate(structuredClone(args)), args);
  assert.throws(() => validate({ action: "advance", outcome: "Removed field" }));
  assert.throws(() => validate({ action: "advance", result: "Not a top-level parameter" }));
  assert.throws(() => validate({ action: "advance", completions: [{ outcome: "Removed field" }] }));
  for (const completions of [[], [null], ["done"], [{ id: "t2" }], [{ description: "Wrong field" }], Array.from({ length: TODO_MAX_ITEMS + 1 }, () => ({}))]) {
    assert.throws(() => validate({ action: "advance", completions }));
  }
  assert.throws(() => validate({ action: "advance", count: 2 }));
});

test("old snapshots and removed task fields are rejected rather than migrated", () => {
  const state = plan();
  for (const schemaVersion of [1, 2, 99]) {
    const previous = { ...structuredClone(state), schemaVersion };
    assert.equal(isTodoState(previous), false);
    domainError("UNKNOWN_SCHEMA_VERSION", () => reduce(previous as unknown as TodoState, { action: "advance", completions: [{}] }));
  }
  assert.equal(isTodoState({ ...state, items: state.items.map((item) => ({ ...item, outcome: "Removed field" })) }), false);
});
