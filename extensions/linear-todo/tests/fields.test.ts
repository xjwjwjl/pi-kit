import assert from "node:assert/strict";
import test from "node:test";
import { Check } from "typebox/value";
import { emptyTodoReducerDependencies, reduceTodo, TodoDomainError } from "../reducer.ts";
import {
  cloneTodoItem,
  cloneTodoState,
  cloneTodoStateForUndo,
  isTodoState,
  TODO_DESCRIPTION_MAX_LENGTH,
  TODO_GOAL_MAX_LENGTH,
  TODO_SCHEMA_VERSION,
  TODO_TITLE_MAX_LENGTH,
  TodoInputSchema,
  TodoTaskInputSchema,
  type TodoInput,
  type TodoState,
} from "../schema.ts";

const TITLE = "Migrate and verify the cache";
const GOAL = "Migrate the complete cache invalidation scope without changing callers";
const TASKS = [
  { title: "Inspect callers", description: "Inspect cache invalidation and compatibility paths", doneWhen: "All affected callers are identified" },
  { title: "Migrate the cache", description: "Implement the migration without changing callers" },
  { title: "Verify invalidation", description: "Verify invalidation and legacy caller behavior" },
];
const INVALID_TITLES: unknown[] = [null, 42, false, {}, [], "", " \n\t ", "x".repeat(61)];
const INVALID_DESCRIPTIONS: unknown[] = [null, 42, false, {}, [], "", " \n\t ", "x".repeat(301)];

function planInput(): TodoInput {
  return { action: "plan", title: TITLE, goal: GOAL, tasks: structuredClone(TASKS) };
}

function transition(previous: TodoState | null, input: TodoInput) {
  return reduceTodo(previous, input, emptyTodoReducerDependencies("fields-plan"));
}

function plan(): TodoState {
  return transition(null, planInput()).state!;
}

function change(state: TodoState, input: TodoInput): TodoState {
  const next = transition(state, input);
  assert.equal(next.changed, true);
  assert.ok(next.state);
  assert.equal(isTodoState(next.state), true);
  return next.state;
}

function domainError(code: TodoDomainError["code"], run: () => unknown): void {
  assert.throws(run, (error: unknown) => error instanceof TodoDomainError && error.code === code);
}

test("V3 schemas expose short titles and optional execution descriptions in closed objects", () => {
  assert.equal(TODO_SCHEMA_VERSION, 3);
  assert.equal(TODO_TITLE_MAX_LENGTH, 60);
  assert.equal(TODO_DESCRIPTION_MAX_LENGTH, 300);
  assert.equal(TODO_GOAL_MAX_LENGTH, 300);
  for (const schema of [TodoInputSchema, TodoTaskInputSchema]) {
    const jsonSchema = JSON.parse(JSON.stringify(schema));
    assert.equal(jsonSchema.additionalProperties, false);
    assert.equal(jsonSchema.properties.title.type, "string");
    assert.equal(jsonSchema.properties.title.minLength, 1);
    assert.equal(jsonSchema.properties.title.maxLength, 60);
    assert.equal(Object.hasOwn(jsonSchema.properties, "displayTitle"), false);
  }
  assert.equal(Check(TodoInputSchema, planInput()), true);
  assert.equal(Check(TodoTaskInputSchema, { title: "Task" }), true);
  // The multi-action schema leaves root title optional; the reducer requires it for plan.
  const noTitle = planInput();
  delete noTitle.title;
  assert.equal(Check(TodoInputSchema, noTitle), true);
  domainError("INVALID_PLAN_TITLE", () => transition(null, noTitle));
  assert.equal(Check(TodoInputSchema, { action: "advance", completions: [{}] }), true);
});

test("raw JSON schemas reject invalid fields, removed labels, timestamps and task results", () => {
  for (const title of INVALID_TITLES.filter((value) => value !== " \n\t ")) {
    assert.equal(Check(TodoInputSchema, { ...planInput(), title }), false);
    assert.equal(Check(TodoTaskInputSchema, { title }), false);
  }
  for (const description of INVALID_DESCRIPTIONS.filter((value) => value !== " \n\t ")) {
    assert.equal(Check(TodoTaskInputSchema, { title: "Task", description }), false);
  }
  for (const input of [
    { ...planInput(), displayTitle: "Removed" },
    { ...planInput(), createdAt: 0 },
    { ...planInput(), updatedAt: 1 },
    { ...planInput(), description: "Not a root field" },
    { ...planInput(), outcome: "Removed" },
    { ...planInput(), tasks: [{ title: "Task", displayTitle: "Removed" }] },
    { ...planInput(), tasks: [{ title: "Task", result: "Only advance may write results" }] },
    { ...planInput(), tasks: [{ title: "Task", createdAt: 0 }] },
    { ...planInput(), tasks: [{ title: "Task", extra: true }] },
  ]) assert.equal(Check(TodoInputSchema, input), false);
});

test("plan normalizes distinct title, goal, description and acceptance fields without mutating input", () => {
  const input: TodoInput = {
    ...planInput(), title: "  Migrate\n and verify\t the cache  ",
    tasks: [
      { title: "  Inspect\t callers\n", description: "  Inspect\n invalidation and compatibility paths  ", doneWhen: "  All\n callers are identified  " },
      { title: `  ${"x".repeat(60)}  `, description: `  ${"d".repeat(300)}  ` },
    ],
  };
  const before = structuredClone(input);
  const state = transition(null, input).state!;
  assert.equal(state.title, TITLE);
  assert.equal(state.goal, GOAL);
  assert.deepEqual(state.items[0], {
    id: "t1", title: "Inspect callers", description: "Inspect invalidation and compatibility paths", doneWhen: "All callers are identified",
  });
  assert.equal(state.items[1]?.title, "x".repeat(60));
  assert.equal(state.items[1]?.description, "d".repeat(300));
  assert.equal(Object.hasOwn(state.items[0]!, "result"), false);
  assert.equal(isTodoState(state), true);
  assert.deepEqual(input, before);
});

test("invalid plan titles fail atomically and never allocate a plan id", () => {
  const state = plan();
  const before = structuredClone(state);
  let allocations = 0;
  for (const title of [undefined, ...INVALID_TITLES]) {
    domainError("INVALID_PLAN_TITLE", () => reduceTodo(null, { ...planInput(), title } as TodoInput, {
      createPlanId: () => { allocations += 1; return "must-not-be-used"; },
    }));
    if (title !== undefined) {
      domainError("INVALID_PLAN_TITLE", () => transition(state, {
        action: "replan", title, reason: "New approach", tasks: [{ title: "Replacement" }],
      } as TodoInput));
    }
    assert.deepEqual(state, before);
  }
  assert.equal(allocations, 0);
});

test("malformed task titles and descriptions reject the entire plan, replan or insert", () => {
  const state = plan();
  const before = structuredClone(state);
  for (const [field, invalidValues, code] of [
    ["title", [undefined, ...INVALID_TITLES], "INVALID_TASK_TITLE"],
    ["description", INVALID_DESCRIPTIONS, "INVALID_DESCRIPTION"],
  ] as const) {
    for (const value of invalidValues) {
      for (const action of ["plan", "replan", "insert"] as const) {
        const input = {
          action, ...(action === "plan" ? { title: TITLE, goal: GOAL } : {}),
          ...(action === "replan" ? { reason: "New approach" } : {}),
          tasks: [{ title: "Valid first", description: "Valid details" }, { title: "Invalid second", [field]: value }],
        };
        domainError(code, () => transition(action === "plan" ? null : state, input as TodoInput));
      }
      assert.deepEqual(state, before);
    }
  }
  let allocations = 0;
  domainError("INVALID_DESCRIPTION", () => reduceTodo(null, {
    ...planInput(), tasks: [{ title: "Valid" }, { title: "Invalid", description: " " }],
  }, { createPlanId: () => { allocations += 1; return "unused"; } }));
  assert.equal(allocations, 0);
});

test("removed properties and task result input cannot be silently accepted, even when undefined", () => {
  const state = plan();
  const before = structuredClone(state);
  for (const field of ["displayTitle", "createdAt", "updatedAt", "result"]) {
    for (const value of ["Removed", undefined]) {
      domainError("INVALID_INPUT", () => transition(null, { ...planInput(), [field]: value } as TodoInput));
      for (const action of ["plan", "replan", "insert"] as const) {
        domainError("INVALID_TASKS", () => transition(action === "plan" ? null : state, {
          action, ...(action === "plan" ? { title: TITLE, goal: GOAL } : {}),
          ...(action === "replan" ? { reason: "New approach" } : {}),
          tasks: [{ title: "Valid" }, { title: "Legacy", [field]: value }],
        } as TodoInput));
      }
    }
  }
  domainError("INVALID_TASKS", () => transition(null, { ...planInput(), tasks: new Array(2) }));
  assert.deepEqual(state, before);
});

test("plan title is applicable only to plan/replan and never substitutes for goal or task titles", () => {
  const state = plan();
  domainError("INVALID_GOAL", () => transition(null, { action: "plan", title: TITLE, tasks: TASKS }));
  domainError("INVALID_TASK_TITLE", () => transition(null, {
    ...planInput(), tasks: [{ description: "Only execution details" }],
  } as unknown as TodoInput));
  for (const action of ["advance", "insert", "undo", "block", "resume", "show", "clear"] as const) {
    domainError("INVALID_INPUT", () => transition(state, { action, title: "Not accepted here" }));
  }
  domainError("INVALID_REASON", () => transition(state, { action: "replan", title: "Revised", tasks: [{ title: "Replacement" }] }));
  domainError("INVALID_TASKS", () => transition(state, { action: "replan", title: "Revised", reason: "No replacement tasks supplied" }));
});

test("replan preserves the title for an unchanged normalized goal but requires an explicit title for new scope", () => {
  const state = plan();
  const before = structuredClone(state);
  const base: TodoInput = { action: "replan", reason: "Revise the work", tasks: [{ title: "Replacement", description: "Updated execution details" }] };
  for (const goal of [undefined, GOAL, `  ${GOAL.replaceAll(" ", "\n\t")}  `]) {
    const next = change(state, { ...base, ...(goal === undefined ? {} : { goal }) });
    assert.equal(next.title, TITLE);
    assert.equal(next.goal, GOAL);
    assert.equal(next.items[0]?.description, "Updated execution details");
  }
  assert.equal(change(state, { ...base, title: "  Verify\t and migrate cache " }).title, "Verify and migrate cache");
  domainError("INVALID_PLAN_TITLE", () => transition(state, { ...base, goal: "A different complete scope" }));
  for (const title of INVALID_TITLES) {
    domainError("INVALID_PLAN_TITLE", () => transition(state, { ...base, goal: "A different complete scope", title } as TodoInput));
  }
  const revised = change(state, { ...base, goal: "A different complete scope", title: "Execute the new scope" });
  assert.equal(revised.goal, "A different complete scope");
  assert.equal(revised.title, "Execute the new scope");
  const restored = change(revised, { action: "undo" });
  assert.equal(restored.title, TITLE);
  assert.equal(restored.goal, GOAL);
  assert.deepEqual(restored.items, state.items);
  assert.deepEqual(state, before);
});

test("all clone helpers detach titles, descriptions and one-step undo snapshots", () => {
  const state = change(plan(), { action: "advance", completions: [{ result: "Identified all callers" }] });
  const item = cloneTodoItem(state.items[0]!);
  assert.deepEqual(item, state.items[0]);
  item.description = "External item edit";
  assert.equal(state.items[0]!.description, TASKS[0]!.description);
  const clone = cloneTodoState(state);
  assert.deepEqual(clone, state);
  assert.notEqual(clone.items, state.items);
  assert.notEqual(clone.undo!.state, state.undo!.state);
  clone.title = "External root edit";
  clone.items[0]!.description = "External task edit";
  clone.undo!.state!.title = "External undo root edit";
  clone.undo!.state!.items[0]!.description = "External undo task edit";
  assert.equal(state.title, TITLE);
  assert.equal(state.items[0]!.description, TASKS[0]!.description);
  assert.equal(state.undo!.state!.title, TITLE);
  assert.equal(state.undo!.state!.items[0]!.description, TASKS[0]!.description);
  const undo = cloneTodoStateForUndo(state);
  const expected = structuredClone(state);
  delete expected.undo;
  assert.deepEqual(undo, expected);
  assert.equal(Object.hasOwn(undo, "undo"), false);
  assert.deepEqual(cloneTodoStateForUndo(JSON.parse(JSON.stringify(state))), expected);
});

test("whole-batch advance and single undo retain all execution details", () => {
  const original = plan();
  const completed = change(original, {
    action: "advance", completions: [{ result: "All callers found" }, { result: "Migration implemented" }, {}],
  });
  assert.equal(completed.phase, "completed");
  assert.equal(completed.cursor, 3);
  assert.equal(completed.title, TITLE);
  assert.equal(completed.goal, GOAL);
  assert.deepEqual(completed.items.map((item) => item.description), TASKS.map((item) => item.description));
  assert.equal(completed.items[0]!.doneWhen, TASKS[0]!.doneWhen);
  assert.equal(completed.items[0]!.result, "All callers found");
  const restored = change(completed, { action: "undo" });
  assert.deepEqual(restored, { ...cloneTodoStateForUndo(original), revision: completed.revision + 1 });
  assert.deepEqual(original, plan());
});

test("V3 snapshot validation rejects old versions and removed properties at every persisted location", () => {
  const valid = change(plan(), { action: "advance", completions: [{}] });
  assert.equal(isTodoState(JSON.parse(JSON.stringify(valid))), true);
  for (const schemaVersion of [1, 2, 4]) {
    const unsupported = { ...structuredClone(valid), schemaVersion };
    assert.equal(isTodoState(unsupported), false);
    domainError("UNKNOWN_SCHEMA_VERSION", () => transition(unsupported as unknown as TodoState, { action: "show" }));
  }
  for (const field of ["displayTitle", "createdAt", "updatedAt", "outcome"]) {
    for (const location of ["root", "task", "undo-root", "undo-task", "undo-wrapper"] as const) {
      for (const value of ["Removed", undefined]) {
        const corrupt = structuredClone(valid);
        const target = location.startsWith("undo-") ? corrupt.undo!.state! : corrupt;
        Object.assign(location === "undo-wrapper" ? corrupt.undo! : location.endsWith("task") ? target.items[0]! : target, { [field]: value });
        const before = structuredClone(corrupt);
        assert.equal(isTodoState(corrupt), false, `${location}.${field}`);
        for (const action of ["show", "undo"] as const) {
          domainError("INVALID_STATE", () => transition(corrupt, { action }));
        }
        assert.deepEqual(corrupt, before);
      }
    }
  }
});

test("persisted titles and descriptions are required or bounded throughout root, tasks and undo", () => {
  const valid = change(plan(), { action: "advance", completions: [{}] });
  for (const location of ["root", "task", "undo-root", "undo-task"] as const) {
    for (const title of [undefined, ...INVALID_TITLES]) {
      const corrupt = structuredClone(valid);
      const target = location.startsWith("undo-") ? corrupt.undo!.state! : corrupt;
      Object.assign(location.endsWith("task") ? target.items[0]! : target, { title });
      assert.equal(isTodoState(corrupt), false);
      domainError("INVALID_STATE", () => transition(corrupt, { action: "show" }));
    }
  }
  for (const description of INVALID_DESCRIPTIONS) {
    for (const undo of [false, true]) {
      const corrupt = structuredClone(valid);
      const target = undo ? corrupt.undo!.state! : corrupt;
      Object.assign(target.items[0]!, { description });
      assert.equal(isTodoState(corrupt), false);
      domainError("INVALID_STATE", () => transition(corrupt, { action: "undo" }));
    }
  }
});
