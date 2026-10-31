import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters as strip } from "node:util";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { theme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { emptyTodoReducerDependencies, reduceTodo } from "../reducer.ts";
import { TodoListComponent } from "../render.ts";
import type { TodoState } from "../schema.ts";

const plainTheme = { fg: (_color: string, text: string) => text } as never;
const keys = { up: "\u001b[A", down: "\u001b[B", pageUp: "\u001b[5~", pageDown: "\u001b[6~", home: "\u001b[H", end: "\u001b[F" };

function plan(total = 20): TodoState {
  return reduceTodo(null, {
    action: "plan", title: "Inspect the full task history", goal: "Browse every task without changing the plan",
    tasks: Array.from({ length: total }, (_, i) => ({ title: `Task ${i + 1}` })),
  }, emptyTodoReducerDependencies("list-scroll")).state!;
}

function advance(state: TodoState, count: number): TodoState {
  return reduceTodo(state, {
    action: "advance", completions: Array.from({ length: count }, (_, i) => ({ result: `Observed result ${i + 1}` })),
  }, emptyTodoReducerDependencies("unused")).state!;
}

function position(lines: string[]): { start: number; end: number; total: number } {
  const match = /^Lines (\d+)–(\d+)\/(\d+)$/m.exec(lines.map(strip).join("\n"));
  assert.ok(match, "a long document needs a visible scroll position");
  return { start: Number(match[1]), end: Number(match[2]), total: Number(match[3]) };
}

/** Walk one visual row at a time and reconstruct the document, excluding fixed chrome. */
function readAll(component: TodoListComponent, width = 120): string[] {
  component.render(width);
  component.handleInput(keys.home);
  const document: string[] = [];
  for (let step = 0; step < 2000; step += 1) {
    const lines = component.render(width).map(strip);
    const page = position(lines);
    const bodyStart = lines.findIndex((line) => line.startsWith("Plan:")) + 2;
    const body = lines.slice(bodyStart, bodyStart + page.end - page.start + 1);
    for (const [index, line] of body.entries()) document[page.start - 1 + index] = line;
    if (page.end === page.total) return document;
    component.handleInput(keys.down);
  }
  throw new Error("the complete document must be reachable");
}

test("all twenty tasks are reachable by scrolling and the opened plan remains unchanged", () => {
  const state = advance(plan(), 15);
  const before = structuredClone(state);
  let renders = 0;
  const component = new TodoListComponent({ state }, plainTheme, () => {}, undefined, () => { renders += 1; });
  assert.match(component.render(120).join("\n"), /→ 16\. Task 16/);
  const complete = readAll(component).join("\n");
  for (let i = 1; i <= 20; i += 1) assert.match(complete, new RegExp(`(?:✓|→|○) ${i}\\. Task ${i}(?:\\n|$)`));
  assert.match(complete, /完成结果: Observed result 1\n/);
  assert.match(complete, /完成结果: Observed result 15\n/);
  assert.ok(renders > 0, "scrolling must request a host redraw");
  const end = component.render(120);
  component.handleInput(keys.down);
  assert.strictEqual(component.render(120), end, "scrolling beyond the end is a cached no-op");
  component.handleInput(keys.home);
  const start = component.render(120);
  component.handleInput(keys.up);
  assert.strictEqual(component.render(120), start, "scrolling above the start is a cached no-op");
  assert.deepEqual(state, before, "scrolling must not change revision, undo or domain data");
});

test("the first current task stays visible even when the complete goal wraps past a page", () => {
  const state = plan(2);
  state.goal = "完整目标与约束条件。".repeat(25);
  const component = new TodoListComponent({ state }, plainTheme, () => {});
  assert.match(component.render(24).join("\n"), /→ 1\. Task 1/);
  component.handleInput(keys.home);
  assert.match(component.render(24).join("\n"), /Goal: 完整目标/);
});

test("page navigation moves by the eight-line viewport and Home/End reach both boundaries", () => {
  const component = new TodoListComponent({ state: plan() }, plainTheme, () => {});
  component.render(120);
  component.handleInput(keys.home);
  assert.equal(position(component.render(120)).start, 1);
  component.handleInput(keys.pageDown);
  assert.equal(position(component.render(120)).start, 9);
  component.handleInput(keys.pageUp);
  assert.equal(position(component.render(120)).start, 1);
  component.handleInput(keys.end);
  const last = position(component.render(120));
  assert.equal(last.end, last.total);
  component.handleInput(keys.pageDown);
  assert.deepEqual(position(component.render(120)), last);
});

test("long completed descriptions, acceptance and results remain fully readable with Unicode wrapping", () => {
  const description = "执行详情 👩‍💻 e\u0301 ".repeat(15).trim();
  const doneWhen = "全部检查均通过，或明确记录缺失的验证条件。".repeat(4);
  const result = "观察到的结果与证据路径。".repeat(40);
  const initial = reduceTodo(null, {
    action: "plan", title: "阅读完整执行历史", goal: "保留所有字段而不是只显示预览",
    tasks: [{ title: "核查完整记录", description, doneWhen }, { title: "记录最终结论" }],
  }, emptyTodoReducerDependencies("full-details")).state!;
  const state = reduceTodo(initial, { action: "advance", completions: [{ result }, {}] }, emptyTodoReducerDependencies("unused")).state!;
  const component = new TodoListComponent({ state }, plainTheme, () => {});
  const text = readAll(component, 24).join("").replace(/\s/g, "");
  for (const field of [description, doneWhen, result]) assert.ok(text.includes(field.replace(/\s/g, "")), "full fields must survive wrapped page boundaries");
  assert.ok(text.includes("✓2.记录最终结论"));
});

test("navigation uses configured bindings, respects disabled actions, and close takes precedence", () => {
  const bindings: Record<string, string[]> = {
    "app.interrupt": ["x"], "tui.select.up": ["w"], "tui.select.down": ["s"],
    "tui.select.pageUp": ["u"], "tui.select.pageDown": ["d"],
    "tui.editor.cursorLineStart": ["t"], "tui.editor.cursorLineEnd": ["g"],
  };
  let closed = 0;
  const component = new TodoListComponent({ state: plan() }, plainTheme, () => { closed += 1; }, {
    matches: (data: string, binding: string) => (bindings[binding] ?? []).includes(data),
    getKeys: (binding: string) => bindings[binding] ?? [],
  });
  const first = component.render(120);
  assert.match(first.join("\n"), /Scroll: W \/ S \/ U \/ D \/ T \/ G/);
  component.handleInput(keys.down);
  component.handleInput("\u001b");
  assert.strictEqual(component.render(120), first, "unbound defaults must not scroll or close");
  assert.equal(closed, 0);
  component.handleInput("s");
  assert.equal(position(component.render(120)).start, 2);
  component.handleInput("g");
  const bottom = position(component.render(120));
  assert.equal(bottom.end, bottom.total);
  component.handleInput("t");
  assert.equal(position(component.render(120)).start, 1);
  bindings["tui.select.down"] = [];
  component.handleInput("s");
  assert.equal(position(component.render(120)).start, 1);
  bindings["tui.select.down"] = ["s"];
  bindings["app.interrupt"] = ["s"];
  component.handleInput("s");
  assert.equal(closed, 1);
  assert.equal(position(component.render(120)).start, 1, "close must not scroll when bindings overlap");
});

test("fallback cancellation still closes only the list after navigation", () => {
  let closed = 0;
  const component = new TodoListComponent({ state: plan() }, plainTheme, () => { closed += 1; });
  component.render(120);
  component.handleInput(keys.pageDown);
  component.render(120);
  assert.equal(closed, 0);
  component.handleInput("\u001b");
  component.handleInput("\u0003");
  assert.equal(closed, 2);
});

test("resizing and theme invalidation keep scroll bounded and all lines within terminal columns", () => {
  const state = advance(plan(), 10);
  state.items[10]!.description = "中文 👩🏽‍💻 e\u0301 ".repeat(10);
  const mutableTheme = { fg: (color: Parameters<typeof theme.fg>[0], text: string) => theme.fg(color, text) } as never;
  initTheme("dark", false);
  const component = new TodoListComponent({ state }, mutableTheme, () => {});
  const dark = component.render(80);
  assert.strictEqual(component.render(80), dark);
  try {
    initTheme("light", false);
    component.invalidate();
    const light = component.render(80);
    assert.notDeepEqual(light, dark);
    assert.deepEqual(light.map(strip), dark.map(strip));
    for (const width of [1, 2, 4, 12, 24, 40, 80, 120, 24]) {
      component.handleInput(keys.end);
      const lines = component.render(width);
      assert.ok(lines.length <= 20);
      for (const line of lines) assert.ok(visibleWidth(line) <= width, `width ${width}: ${JSON.stringify(line)}`);
    }
    component.handleInput(keys.home);
    assert.equal(position(component.render(120)).start, 1);
    assert.deepEqual(component.render(0), []);
  } finally {
    initTheme("dark", false);
  }
});

test("empty and protected snapshots stay navigable without reading unknown state", () => {
  const protectedView = new TodoListComponent({
    get state(): TodoState { throw new Error("unknown state must never be read"); },
    compatibilityError: "schemaVersion 99 is unsupported",
  }, plainTheme, () => {});
  for (const component of [protectedView, new TodoListComponent({ state: null }, plainTheme, () => {})]) {
    assert.doesNotThrow(() => component.render(40));
    component.handleInput(keys.end);
    component.handleInput(keys.home);
    assert.doesNotThrow(() => component.render(12));
  }
  assert.match(protectedView.render(80).join("\n"), /Todo unavailable/);
});
