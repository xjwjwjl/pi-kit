import assert from "node:assert/strict";
import test from "node:test";
import { reduceTodo, emptyTodoReducerDependencies } from "../reducer.ts";
import { buildTodoWidgetModel, formatTodoWidgetLines, TodoWidget } from "../src/widget.ts";

function model(total: number, completed: number, blocked = false) {
  let state = reduceTodo(null, {
    action: "plan", title: "Inspect the workspace", goal: "Keep task history visible without changing the plan",
    tasks: Array.from({ length: total }, (_, i) => ({ title: `Task ${i + 1}` })),
  }, emptyTodoReducerDependencies("history-window")).state!;
  state = reduceTodo(state, { action: "advance", completions: Array.from({ length: completed }, () => ({})) }, emptyTodoReducerDependencies("unused")).state!;
  if (blocked) state = reduceTodo(state, { action: "block", reason: "Need a fixture" }, emptyTodoReducerDependencies("unused")).state!;
  const view = buildTodoWidgetModel({ state, paused: blocked, earlyStopWarning: blocked });
  assert.ok(view.kind === "plan");
  return view;
}

const plainTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never;

test("the 5/8 history window matches the approved half-frame layout and chronological order", () => {
  const view = model(8, 5);
  assert.deepEqual(new TodoWidget(view, plainTheme).render(80), [
    "╭─ Inspect the workspace（5/8）",
    "│  … 较早已完成 3 项",
    "│  ✓ Task 4",
    "│  ✓ Task 5",
    "│  → Task 6",
    "│  ○ Task 7",
    "╰─ ○ Task 8",
  ]);
  assert.deepEqual(formatTodoWidgetLines(view), [
    "计划：Inspect the workspace · 5/8",
    "  … 较早已完成 3 项",
    "  ✓ Task 4", "  ✓ Task 5", "  → Task 6", "  ○ Task 7", "  ○ Task 8",
  ]);
});

test("two separate history/pending summaries precede the final warning and height stays bounded", () => {
  const view = model(20, 5, true);
  const lines = new TodoWidget(view, plainTheme).render(120);
  assert.equal(lines.length, 9);
  assert.equal(lines[1], "│  … 较早已完成 3 项");
  assert.equal(lines.at(-2), "│  另有 12 项待办");
  assert.equal(lines.at(-1), "╰─ ! 阻塞 · 自动续跑已暂停 · 提前停止 · 原因：Need a fixture");
  assert.equal(view.hiddenCompleted + view.rows.filter((row) => row.kind === "completed").length, 5);
  assert.equal(view.hiddenPending + view.rows.filter((row) => row.kind === "pending").length + 1, 15);
});

test("completed titles are muted without strike-through or bold, and only their checks are success", () => {
  for (const completed of [2, 5]) {
    const colors: Array<[string, string]> = [];
    const bold: string[] = [];
    const theme = {
      fg: (color: string, text: string) => { colors.push([color, text]); return text; },
      bold: (text: string) => { bold.push(text); return text; },
    } as never;
    const view = model(5, completed);
    new TodoWidget(view, theme).render(80);
    for (const row of view.rows.filter((row) => row.kind === "completed")) {
      assert.ok(colors.some(([color, text]) => color === "muted" && text === row.title));
      assert.ok(!bold.includes(row.title));
    }
    assert.equal(colors.filter(([color, text]) => color === "success" && text === "✓ ").length, 2);
    assert.deepEqual(bold, completed < 5 ? ["Task 3"] : []);
    assert.ok(colors.filter(([color]) => color === "dim").every(([, text]) => ["╭─ ", "│  ", "╰─ "].includes(text)));
  }
});
