import assert from "node:assert/strict";
import test from "node:test";
import { emptyTodoReducerDependencies, reduceTodo } from "../reducer.ts";
import { formatTodoListLines, TodoListComponent } from "../render.ts";
import type { TodoState } from "../schema.ts";

test("full list output includes completion, blocked, and early-stop information", () => {
  const planned = reduceTodo(
    null,
    { action: "plan", title: "Render Todo state", goal: "Render all state", tasks: [{ title: "Current", description: "Inspect rendering details", doneWhen: "Visible in all views" }, { title: "Next" }] },
    emptyTodoReducerDependencies("render-plan"),
  ).state!;
  const blocked = reduceTodo(planned, { action: "block", reason: "Waiting" }, emptyTodoReducerDependencies("unused")).state!;
  const lines = formatTodoListLines({ state: blocked, earlyStopWarning: true });

  assert.match(lines.join("\n"), /Todo 0\/2 done — BLOCKED/);
  assert.match(lines.join("\n"), /Blocked: Waiting/);
  assert.match(lines.join("\n"), /Plan: Render Todo state/);
  assert.match(lines.join("\n"), /Goal: Render all state/);
  assert.match(lines.join("\n"), /! 1\. Current — description: Inspect rendering details — done when: Visible in all views/);
  const overlay = new TodoListComponent({ state: blocked }, plainTheme, () => {}).render(200).join("\n");
  assert.match(overlay, /description: Inspect rendering details/);
  assert.match(overlay, /done when: Visible in all views/);
  assert.match(lines.join("\n"), /Warning: agent stopped/);
});

test("compatibility errors are visible without attempting to render unknown state", () => {
  const lines = formatTodoListLines({ state: null, compatibilityError: "schemaVersion 99 is unsupported" });
  assert.deepEqual(lines, [
    "Todo unavailable",
    "schemaVersion 99 is unsupported",
    "Use the todo clear action to start a new plan.",
  ]);
});

const plainTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  dim: (text: string) => text,
} as never;

test("completed overlay details retain both acceptance and observed results", () => {
  const state = reduceTodo(
    null,
    { action: "plan", title: "Ship the change", goal: "Ship it", tasks: [{ title: "First", doneWhen: "Verified" }, { title: "Second", doneWhen: "Shipped" }] },
    emptyTodoReducerDependencies("render-plan"),
  ).state!;
  const advanced = reduceTodo(state, { action: "advance", completions: [{ result: "Verified it" }] }, emptyTodoReducerDependencies("unused")).state!;
  const text = new TodoListComponent({ state: advanced }, plainTheme, () => {}).render(200).join("\n");

  assert.match(text, /Todo 1\/2 done — ACTIVE/);
  assert.match(text, /✓ 1\. First\n  done when: Verified\n  完成结果: Verified it/);
  assert.match(text, /→ 2\. Second\n  done when: Shipped/);
});

test("the overlay windows long plans instead of overflowing a small terminal", () => {
  const tasks = Array.from({ length: 20 }, (_unused, index) => ({ title: `Task ${index + 1}` }));
  let state = reduceTodo(null, { action: "plan", title: "Verify the full plan", goal: "Long plan", tasks }, emptyTodoReducerDependencies("long")).state!;
  for (let index = 0; index < 15; index += 1) {
    state = reduceTodo(state, { action: "advance", completions: [{ result: `Did ${index + 1}` }] }, emptyTodoReducerDependencies("unused")).state!;
  }

  const component = new TodoListComponent({ state }, plainTheme, () => {});
  const lines = component.render(200);
  const text = lines.join("\n");
  assert.match(text, /→ 16\. Task 16/);
  assert.match(text, /Lines \d+–\d+\/36/);
  component.handleInput("\u001b[H");
  assert.match(component.render(200).join("\n"), /✓ 1\. Task 1\n/);
  component.handleInput("\u001b[F");
  assert.match(component.render(200).join("\n"), /○ 20\. Task 20\n/);
  // Header, window, hints and padding stay inside a 20-row terminal.
  assert.ok(lines.length <= 20, `overlay rendered ${lines.length} lines`);
});

function planState(): TodoState {
  return reduceTodo(
    null,
    { action: "plan", title: "Render tool calls", goal: "Render calls", tasks: [{ title: "Current" }, { title: "Next" }] },
    emptyTodoReducerDependencies("render-plan"),
  ).state!;
}

test("the /todos overlay follows injected keybindings instead of hardcoding Escape", () => {
  const closed: string[] = [];
  const keybindings = {
    matches: (data: string, keybinding: string) => keybinding === "app.interrupt" && data === "q",
    getKeys: (keybinding: string) => (keybinding === "app.interrupt" ? ["q"] : []),
  };

  const component = new TodoListComponent({ state: planState() }, plainTheme, () => closed.push("close"), keybindings);
  assert.match(component.render(120).join("\n"), /Press Q to close/);
  component.handleInput("q");
  assert.deepEqual(closed, ["close"]);

  // Escape is no longer bound, so it must not close the overlay.
  component.handleInput("\u001b");
  assert.deepEqual(closed, ["close"]);
});

test("the /todos overlay keeps a working fallback when no keybindings are injected", () => {
  const closed: string[] = [];
  const component = new TodoListComponent({ state: planState() }, plainTheme, () => closed.push("close"));
  assert.match(component.render(120).join("\n"), /Press Esc to close/);
  component.handleInput("\u001b");
  assert.deepEqual(closed, ["close"]);
});
