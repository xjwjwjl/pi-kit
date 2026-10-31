import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters as strip } from "node:util";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { theme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { emptyTodoReducerDependencies, reduceTodo } from "../reducer.ts";
import type { TodoInput, TodoState } from "../schema.ts";
import type { TodoRenderSnapshot } from "../src/render-shared.ts";
import { buildTodoWidgetModel, formatTodoWidgetLines, TodoWidget } from "../src/widget.ts";

const TITLES = ["梳理现状", "定义缓存键", "实现缓存失效", "补充回归测试", "验证兼容性"];
const plainTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never;

function railText(lines: string[]): string[] {
  return lines.map((line, index) => {
    const prefix = index === 0 ? "╭─ " : index === lines.length - 1 ? "╰─ " : "│  ";
    const content = index === 0
      ? line.replace(/^计划：/, "").replace(/ · (\d+\/\d+)$/, "（$1）")
      : line.startsWith("  … 另有") ? line.slice(4) : line.slice(2);
    return prefix + content;
  });
}

function assertRailContent(lines: string[], rpc: string[]): void {
  assert.deepEqual(lines.map(strip), railText(rpc));
  assert.ok(lines.every((line) => !/[╮╯]/.test(strip(line))));
  assert.match(strip(lines[0]!), /^╭─ /);
  assert.match(strip(lines.at(-1)!), /^╰─ /);
}

function captureTheme() {
  const colors: Array<[string, string]> = [];
  const boldTexts: string[] = [];
  const theme = {
    fg: (color: string, text: string) => { colors.push([color, text]); return text; },
    bold: (text: string) => { boldTexts.push(strip(text)); return text; },
  } as never;
  return { theme, colors, boldTexts };
}

function plan(titles = TITLES, title = "重构缓存", goal = title): TodoState {
  return reduceTodo(null, { action: "plan", title, goal, tasks: titles.map((title) => ({ title })) }, emptyTodoReducerDependencies("widget-plan")).state!;
}

function apply(state: TodoState, input: TodoInput): TodoState {
  const result = reduceTodo(state, input, emptyTodoReducerDependencies("unused"));
  assert.equal(result.changed, true);
  assert.ok(result.state);
  return result.state;
}

function advance(state: TodoState, count: number): TodoState {
  return apply(state, { action: "advance", completions: Array.from({ length: count }, () => ({})) });
}

function planModel(state: TodoState, flags: Omit<TodoRenderSnapshot, "state"> = {}) {
  const model = buildTodoWidgetModel({ state, ...flags });
  assert.ok(model.kind === "plan");
  return model;
}

test("the structured model separates the title, numeric progress, selected rows and alerts", () => {
  const state = plan();
  const model = planModel(state);
  assert.equal(model.title, "重构缓存");
  assert.deepEqual(model.progress, { completed: 0, total: 5 });
  assert.deepEqual(model.rows, [
    { title: TITLES[0], kind: "current" },
    { title: TITLES[1], kind: "pending" },
    { title: TITLES[2], kind: "pending" },
  ]);
  assert.equal(model.hiddenCompleted, 0);
  assert.equal(model.hiddenPending, 2);
  assert.deepEqual(model.alerts, { blocked: false, blockedReason: undefined, paused: false, earlyStop: false });
});

test("recent completed history stays visible and completion counts are not task ordinals", () => {
  const model = planModel(advance(plan(), 2));
  assert.deepEqual(model.progress, { completed: 2, total: 5 });
  assert.deepEqual(model.rows.map((row) => row.title), TITLES);
  assert.deepEqual(Object.keys(model.rows[0]!).sort(), ["kind", "title"]);
  assert.equal(model.hiddenPending, 0);
  assert.equal(model.hiddenCompleted, 0);
  assert.match(formatTodoWidgetLines(model)[1]!, /^  ✓ /);
});

test("every plan position retains recent completions and accounts for every hidden item", () => {
  for (let total = 1; total <= 20; total += 1) {
    const titles = Array.from({ length: total }, (_, index) => `Task ${index + 1}`);
    const initial = plan(titles);
    for (let cursor = 0; cursor <= total; cursor += 1) {
      const state = cursor === 0 ? initial : advance(initial, cursor);
      const model = planModel(state);
      assert.deepEqual(model.rows.map((row) => row.title), titles.slice(Math.max(0, cursor - 2), cursor + 3));
      assert.deepEqual(model.progress, { completed: cursor, total });
      assert.equal(model.rows.filter((row) => row.kind === "current").length, cursor < total ? 1 : 0);
      if (cursor < total) assert.equal(model.rows.find((row) => row.kind === "current")!.title, titles[cursor]);
      const visibleCompleted = model.rows.filter((row) => row.kind === "completed").length;
      assert.equal(visibleCompleted, Math.min(2, cursor));
      assert.equal(model.hiddenCompleted, Math.max(0, cursor - 2));
      assert.equal(model.hiddenCompleted + visibleCompleted, cursor);
      assert.equal(model.hiddenPending, Math.max(0, total - cursor - 3));
      assert.equal(model.rows.length - visibleCompleted + model.hiddenPending, total - cursor);
      assert.ok(model.rows.every((row) => Object.keys(row).length === 2));
    }
  }
});

test("batch completion, replan, insert and undo produce fresh models without altering older models", () => {
  const initial = plan();
  const original = planModel(initial);
  const batch = advance(initial, 2);
  assert.equal(planModel(batch).rows.find((row) => row.kind === "current")!.title, TITLES[2]);
  assert.deepEqual(planModel(apply(batch, { action: "undo" })).rows, original.rows);
  const revised = apply(batch, { action: "replan", title: "完成新目标", goal: "新目标", reason: "范围调整", tasks: [{ title: "修复失效策略" }] });
  assert.equal(planModel(revised).title, "完成新目标");
  assert.deepEqual(planModel(revised).progress, { completed: 2, total: 3 });
  const inserted = apply(revised, { action: "insert", tasks: [{ title: "额外检查" }] });
  assert.deepEqual(planModel(inserted).rows.map((row) => row.title), [...TITLES.slice(0, 2), "修复失效策略", "额外检查"]);
  assert.equal(original.title, "重构缓存");
  assert.deepEqual(original.rows.map((row) => row.title), TITLES.slice(0, 3));
});

test("no plan hides the panel, while finished plans keep recent history without stale alerts", () => {
  const empty = buildTodoWidgetModel({ state: null, paused: true, earlyStopWarning: true });
  assert.deepEqual(empty, { kind: "hidden" });
  assert.deepEqual(formatTodoWidgetLines(empty), []);
  assert.deepEqual(new TodoWidget(empty, plainTheme).render(80), []);
  for (const total of [1, 2, 5, 20]) {
    const titles = Array.from({ length: total }, (_, index) => `Task ${index + 1}`);
    const model = planModel(advance(plan(titles), total), { paused: true, earlyStopWarning: true });
    assert.deepEqual(model.rows, titles.slice(-2).map((title) => ({ title, kind: "completed" })));
    assert.equal(model.hiddenCompleted, Math.max(0, total - 2));
    assert.equal(model.hiddenPending, 0);
    assert.deepEqual(model.alerts, { blocked: false, blockedReason: undefined, paused: false, earlyStop: false });
    const rpc = formatTodoWidgetLines(model);
    assert.doesNotMatch(rpc.join("\n"), /→|○|待办|暂停|提前停止/);
    assertRailContent(new TodoWidget(model, plainTheme).render(80), rpc);
  }
});

test("a settled completed plan hides without discarding its state", () => {
  const done = advance(plan(), TITLES.length);
  assert.equal(done.phase, "completed");
  const beforeSettle = buildTodoWidgetModel({ state: done });
  assert.equal(beforeSettle.kind, "plan");
  const dismissed = buildTodoWidgetModel({ state: done, completedDismissed: true });
  assert.deepEqual(dismissed, { kind: "hidden" });
  assert.deepEqual(formatTodoWidgetLines(dismissed), []);
  assert.deepEqual(new TodoWidget(dismissed, plainTheme).render(80), []);
  assert.equal(done.phase, "completed");
  assert.equal(done.cursor, TITLES.length);
  assert.deepEqual(buildTodoWidgetModel({ state: done, completedDismissed: false }), beforeSettle);
});

test("compatibility errors have priority without reading an unknown state", () => {
  const model = buildTodoWidgetModel({
    get state(): TodoState { throw new Error("unknown state must not be read"); },
    compatibilityError: "schemaVersion 99 is unsupported",
  });
  assert.deepEqual(model, { kind: "unavailable", message: "schemaVersion 99 is unsupported" });
  assert.deepEqual(formatTodoWidgetLines(model), ["Todo 不可用：schemaVersion 99 is unsupported"]);
  assert.deepEqual(new TodoWidget(model, plainTheme).render(120), formatTodoWidgetLines(model));
});

test("pausing or stopping does not turn the plan position into execution telemetry", () => {
  for (const paused of [false, true]) {
    for (const earlyStopWarning of [false, true]) {
      const model = planModel(plan(), { paused, earlyStopWarning });
      assert.equal(model.rows[0]!.kind, "current");
      assert.equal(model.alerts.blocked, false);
      assert.equal(model.alerts.paused, paused);
      assert.equal(model.alerts.earlyStop, earlyStopWarning);
      assert.match(formatTodoWidgetLines(model)[1]!, /^  → /);
      assert.doesNotMatch(formatTodoWidgetLines(model)[1]!, /〈当前〉|当前：/);
      assert.doesNotMatch(formatTodoWidgetLines(model).join("\n"), /正在执行|Running|▶/);
    }
  }
});

test("blocked current rows stay distinct from pending rows and carry a separate reason", () => {
  const blocked = apply(plan(), { action: "block", reason: "缺少 Redis 测试环境" });
  const model = planModel(blocked);
  assert.equal(model.rows[0]!.kind, "current");
  assert.equal(model.rows[1]!.kind, "pending");
  assert.equal(model.alerts.blocked, true);
  assert.equal(model.alerts.blockedReason, "缺少 Redis 测试环境");
  assert.match(formatTodoWidgetLines(model)[1]!, /^  → 梳理现状$/);
  assert.equal(formatTodoWidgetLines(model).at(-1), "  ! 阻塞：缺少 Redis 测试环境");
});

test("model construction and both renderers leave frozen source state untouched", () => {
  const state = advance(plan(), 2);
  const before = structuredClone(state);
  state.items.forEach(Object.freeze);
  Object.freeze(state.items);
  Object.freeze(state);
  const snapshot = Object.freeze({ state, paused: true });
  const model = buildTodoWidgetModel(snapshot);
  assert.ok(model.kind === "plan");
  assert.notStrictEqual(model.rows[0], state.items[state.cursor]);
  formatTodoWidgetLines(model);
  new TodoWidget(model, plainTheme).render(40);
  assert.deepEqual(state, before);
  assert.equal(state.schemaVersion, 3);
});

test("TUI uses a rounded left half-frame while RPC keeps its plain layout and matching history", () => {
  const model = planModel(advance(plan(), 2));
  const expected = ["计划：重构缓存 · 2/5", "  ✓ 梳理现状", "  ✓ 定义缓存键", "  → 实现缓存失效", "  ○ 补充回归测试", "  ○ 验证兼容性"];
  assert.deepEqual(formatTodoWidgetLines(model), expected);
  for (const width of [30, 39, 40, 80, 120]) {
    const lines = new TodoWidget(model, plainTheme).render(width);
    assertRailContent(lines, expected);
    assert.ok(lines.every((line) => line === line.trimEnd()), "short content must not receive right padding");
  }
});

test("the light panel has no border rows and keeps more-pending before alerts", () => {
  const blocked = apply(plan(), { action: "block", reason: "缺少测试环境" });
  const models = [
    planModel(plan(["Only task"])),
    planModel(plan(["First", "Second"])),
    planModel(advance(plan(), 2)),
    planModel(plan()),
    planModel(plan(), { paused: true }),
    planModel(blocked, { paused: true, earlyStopWarning: true }),
  ];
  for (const model of models) {
    const lines = new TodoWidget(model, plainTheme).render(80);
    assertRailContent(lines, formatTodoWidgetLines(model));
    assert.ok(lines.every((line) => line.trim() !== ""));
    assert.ok(lines.length <= 6);
  }
  assert.deepEqual(new TodoWidget(models[0]!, plainTheme).render(80), [
    "╭─ 重构缓存（0/1）", "╰─ → Only task",
  ]);
  assert.equal(new TodoWidget(models[1]!, plainTheme).render(80).at(-1), "╰─ ○ Second");
  const withMore = new TodoWidget(models[3]!, plainTheme).render(80);
  assert.equal(withMore.length, 5);
  assert.equal(withMore.at(-1), "╰─ 另有 2 项待办");
  const paused = new TodoWidget(models[4]!, plainTheme).render(80);
  assert.equal(paused.at(-2), "│  另有 2 项待办");
  assert.equal(paused.at(-1), "╰─ ! 自动续跑已暂停 · /todos resume");
});

test("body text uses available width without the former 72-cell cap or right-side padding", () => {
  const model = planModel(plan([`${"任务".repeat(22)} 👩🏽‍💻 e\u0301`, "下一项"]));
  const widget = new TodoWidget(model, plainTheme);
  for (const width of [12, 16, 24, 40, 72, 80, 120, 240]) {
    const lines = widget.render(width);
    assert.ok(lines.every((line) => /^(╭─ |│  |╰─ )/.test(line) && visibleWidth(line) <= width));
    assert.ok(lines.every((line) => line.trimEnd() === line && !/[╮╯]/.test(line)));
  }
  const wide = widget.render(120)[1]!;
  assert.ok(visibleWidth(wide) > 72);
  assert.equal(wide, `│  → ${model.rows[0]!.title}`);
  assert.match(strip(widget.render(80)[1]!), /…$/);
});

test("tiny terminals drop the left rail without losing rows or column bounds", () => {
  const model = planModel(plan(), { paused: true });
  const widget = new TodoWidget(model, plainTheme);
  for (const width of [1, 2, 5, 9, 11]) {
    const lines = widget.render(width);
    assert.equal(lines.length, 6);
    assert.ok(lines.every((line) => !/[╭╮│╰╯─]/.test(line)));
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
    assert.deepEqual(widget.render(width), lines);
  }
  assert.ok(widget.render(12).every((line) => /^(╭─ |│  |╰─ )/.test(line)));
});

test("short action titles leave paths and commands in execution descriptions, not the widget", () => {
  const fullGoal = "对 D:/code/lab/wifi-audit 做结构整理与质量检查，产出问题清单并做低风险修复";
  const fullTitles = ["通读 README 与全部脚本，建立功能清单", "跑语法与静态检查（bash -n / shellcheck / python 编译）", "核对 README 与脚本的一致性", "检查跨脚本共享约定", "完成低风险修复", "汇总回归报告"];
  const labels = ["梳理文档与脚本", "语法与静态检查", "核对文档与实现", "检查跨脚本约定", "低风险修复", "回归与报告"];
  const initial = reduceTodo(null, {
    action: "plan", goal: fullGoal, title: "检查并整理 wifi-audit",
    tasks: fullTitles.map((description, index) => ({ title: labels[index]!, description })),
  }, emptyTodoReducerDependencies("light-labels")).state!;
  const state = advance(initial, 1);
  const before = structuredClone(state);
  const model = planModel(state);
  const lines = new TodoWidget(model, plainTheme).render(80);
  assert.deepEqual(lines, [
    "╭─ 检查并整理 wifi-audit（1/6）",
    "│  ✓ 梳理文档与脚本", "│  → 语法与静态检查", "│  ○ 核对文档与实现", "│  ○ 检查跨脚本约定", "╰─ 另有 2 项待办",
  ]);
  assert.doesNotMatch(lines.join("\n"), /D:\/|bash|shellcheck|python/);
  assertRailContent(lines, formatTodoWidgetLines(model));
  assert.equal(formatTodoWidgetLines(model).at(-1), "  … 另有 2 项待办");
  assert.deepEqual(state, before);
  assert.equal(state.goal, fullGoal);
  assert.deepEqual(state.items.map((item) => item.description), fullTitles);
  assert.deepEqual(state.items.map((item) => item.title), labels);
});

test("long valid titles follow available width without summaries, fallback or silent rewrites", () => {
  const goal = "对 D:/code/lab/wifi-audit 做结构整理与质量检查，产出问题清单并做低风险修复";
  const title = "跑语法与静态检查（bash -n / shellcheck / python 编译）";
  const state = plan([title, "核对文档与实现"], goal);
  const before = structuredClone(state);
  const model = planModel(state);
  assert.equal(model.title, goal);
  assert.equal(model.rows[0]!.title, title);
  const fullHeader = `╭─ ${goal}（0/2）`;
  const fullWidth = visibleWidth(fullHeader);
  const widget = new TodoWidget(model, plainTheme);
  const narrow = widget.render(fullWidth - 1);
  assert.match(strip(narrow[0]!), /…（0\/2）$/);
  const lines = widget.render(fullWidth);
  assert.equal(strip(lines[0]!), fullHeader, "an exact fit must not be truncated");
  assert.equal(strip(widget.render(fullWidth + 40)[0]!), fullHeader, "wide headers must not gain right-alignment padding");
  assert.deepEqual(widget.render(fullWidth - 1), narrow, "shrinking after expansion must recompute the header");
  assert.equal(lines[1], `│  → ${title}`);
  assert.equal(formatTodoWidgetLines(model)[0], `计划：${goal} · 0/2`);
  assert.deepEqual(state, before);
  assert.equal(state.title, goal);
  assert.equal(Object.hasOwn(state, "displayTitle"), false);
  assert.equal(Object.hasOwn(state.items[0]!, "displayTitle"), false);
});

test("the action overview stays stable across cursor changes and blocking, separate from current tasks", () => {
  const fullGoal = "检查整个 wifi-audit 的结构与质量，产出问题清单并做低风险修复";
  const overview = "检查并整理 wifi-audit";
  const initial = plan(["梳理现状", "语法与静态检查", "核对实现"], overview, fullGoal);
  const advanced = advance(initial, 1);
  const blocked = apply(advanced, { action: "block", reason: "等待运行环境" });
  for (const state of [initial, advanced, blocked]) {
    const before = structuredClone(state);
    const model = planModel(state);
    assert.equal(model.title, overview);
    assert.equal(new TodoWidget(model, plainTheme).render(80)[0], `╭─ ${overview}（${state.cursor}/3）`);
    assert.equal(formatTodoWidgetLines(model)[0], `计划：${overview} · ${state.cursor}/3`);
    assert.equal(state.goal, fullGoal);
    assert.deepEqual(state, before);
  }
});

test("long plans show an explicit unseen-pending count and short plans do not", () => {
  const long = planModel(plan());
  assert.equal(formatTodoWidgetLines(long).length, 5);
  assert.equal(formatTodoWidgetLines(long).at(-1), "  … 另有 2 项待办");
  const short = planModel(plan(["Only task"]));
  assert.deepEqual(formatTodoWidgetLines(short), [
    "计划：重构缓存 · 0/1",
    "  → Only task",
  ]);
});

test("plan titles use dynamic width across real themes, Unicode and repeated resizing", () => {
  const title = "终端宽度动态显示 👩‍💻 e\u0301 ".repeat(2).trim();
  const state = plan(["检查布局"], title, "保留完整执行目标");
  const before = structuredClone(state);
  const model = planModel(state);
  const expected = `╭─ ${title}（0/1）`;
  const fullWidth = visibleWidth(expected);
  assert.ok(visibleWidth(title) > 40);
  for (const name of ["dark", "light"] as const) {
    initTheme(name, true);
    const widget = new TodoWidget(model, theme);
    const plain = new TodoWidget(model, plainTheme);
    for (const width of [30, fullWidth - 1, fullWidth, fullWidth + 40, 30]) {
      const lines = widget.render(width);
      assert.deepEqual(lines.map(strip), plain.render(width).map(strip));
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
      assert.equal(lines.length, 2);
      if (width >= fullWidth) assert.equal(strip(lines[0]!), expected);
      else assert.match(strip(lines[0]!), /…（0\/1）$/);
    }
  }
  assert.deepEqual(state, before);
});

test("long titles truncate before completion progress without adding right-alignment padding", () => {
  const model = planModel(advance(plan(TITLES, "重构缓存并验证数据一致性".repeat(5)), 2));
  for (const width of [30, 40, 80, 120]) {
    const line = new TodoWidget(model, plainTheme).render(width)[0]!;
    assert.ok(visibleWidth(line) <= width);
    assert.match(strip(line), /^╭─ .*…（2\/5）$/);
    if (width > 62) assert.ok(visibleWidth(line) > 62, "long goals must use the extra available space");
  }
  const large = planModel(advance(plan(Array.from({ length: 20 }, (_, index) => `Task ${index + 1}`)), 19));
  assert.deepEqual(large.progress, { completed: 19, total: 20 });
  assert.equal(new TodoWidget(large, plainTheme).render(12)[0], "╭─ 19/20");
});

test("long current titles keep only a left arrow with CJK, emoji and combining characters", () => {
  const title = `${"实现缓存失效 ".repeat(6)}👩🏽‍💻 e\u0301`;
  const model = planModel(plan([title, "后续任务"]));
  const widget = new TodoWidget(model, plainTheme);
  for (const width of [24, 30, 40, 80, 120]) {
    const line = widget.render(width)[1]!;
    assert.ok(visibleWidth(line) <= width);
    assert.match(strip(line), /^│  → /);
    assert.doesNotMatch(strip(line), /〈当前〉|当前：/);
    const content = strip(line).slice(3);
    if (visibleWidth(title) + 5 > width) assert.match(content, /^→ .*…$/);
    else assert.equal(content, `→ ${title}`);
  }
  assert.match(strip(widget.render(11)[1]!), /^→ /);
  assert.ok(formatTodoWidgetLines(model)[1]!.includes(title), "RPC must retain the full title");
});

test("alerts keep their existing meanings and merge into exactly one extra row", () => {
  const initial = plan();
  const paused = planModel(initial, { paused: true });
  assert.equal(formatTodoWidgetLines(paused).at(-1), "  ! 自动续跑已暂停 · /todos resume");
  const stopped = planModel(initial, { earlyStopWarning: true });
  assert.equal(formatTodoWidgetLines(stopped).at(-1), "  ! 提前停止");
  const blocked = apply(initial, { action: "block", reason: "缺少测试环境".repeat(30) });
  const combined = planModel(blocked, { paused: true, earlyStopWarning: true });
  const full = formatTodoWidgetLines(combined);
  assert.equal(full.length, 6);
  assert.match(full.at(-1)!, /^  ! 阻塞 · 自动续跑已暂停 · 提前停止 · 原因：/);
  assert.doesNotMatch(full.at(-1)!, /\/todos resume/);
  for (const width of [39, 40, 80, 120]) {
    const lines = new TodoWidget(combined, plainTheme).render(width);
    assert.equal(lines.length, 6);
    assert.match(lines.at(-1)!, /阻塞 · 自动续跑已暂停/);
    if (width >= 40) assert.match(lines.at(-1)!, /提前停止/);
  }
});

test("the dim left rail preserves readable content while only the current item is bold/accent", () => {
  const { theme, colors, boldTexts } = captureTheme();
  const model = planModel(plan(), { paused: true });
  assertRailContent(new TodoWidget(model, theme).render(80), formatTodoWidgetLines(model));
  assert.ok(colors.some(([color, text]) => color === "dim" && text === "╭─ "));
  assert.equal(colors.some(([_color, text]) => text === "计划："), false);
  assert.ok(colors.some(([color, text]) => color === "text" && text === "重构缓存"));
  assert.ok(colors.some(([color, text]) => color === "muted" && text === "（"));
  assert.ok(colors.some(([color, text]) => color === "muted" && text === "）"));
  assert.ok(colors.some(([color, text]) => color === "text" && text === "0/5"));
  for (const title of TITLES.slice(1, 3)) assert.ok(colors.some(([color, text]) => color === "text" && text === title));
  assert.deepEqual(new Set(colors.filter(([color]) => color === "accent").map(([_color, text]) => text)), new Set([TITLES[0], "→ "]));
  assert.deepEqual(boldTexts, [TITLES[0]]);
  assert.ok(colors.filter(([color]) => color === "dim").every(([_color, text]) => ["╭─ ", "│  ", "╰─ "].includes(text)));
  assert.ok(colors.some(([color, text]) => color === "muted" && text === "另有 2 项待办"));
  assert.ok(colors.some(([color, text]) => color === "warning" && text === "! 自动续跑已暂停"));
  assert.ok(colors.some(([color, text]) => color === "muted" && text === " · /todos resume"));
  assert.equal(colors.some(([_color, text]) => text.includes("〈当前〉") || text.startsWith("当前：")), false);
});

test("progress digits use success only after actual completion, including compact headers", () => {
  for (const completed of [0, 1, 2]) {
    const model = planModel(completed === 0 ? plan() : advance(plan(), completed));
    for (const width of [12, 16, 30, 80]) {
      const { theme, colors } = captureTheme();
      const lines = new TodoWidget(model, theme).render(width);
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
      const count = `${completed}/5`;
      assert.ok(colors.some(([color, text]) => color === (completed > 0 ? "success" : "text") && text === count));
      assert.deepEqual(colors.filter(([color]) => color === "success").map(([_color, text]) => text), completed > 0 ? [count, ...Array(Math.min(2, completed)).fill("✓ ")] : []);
    }
  }
});

test("blocked arrows and status labels use warning without coloring or bolding the whole reason", () => {
  const blocked = apply(plan(), { action: "block", reason: "缺少 Redis 测试环境" });
  const model = planModel(blocked, { paused: true, earlyStopWarning: true });
  const { theme, colors, boldTexts } = captureTheme();
  assertRailContent(new TodoWidget(model, theme).render(80), formatTodoWidgetLines(model));
  assert.ok(colors.some(([color, text]) => color === "warning" && text === "→ "));
  assert.ok(colors.some(([color, text]) => color === "text" && text === TITLES[0]));
  assert.equal(colors.some(([color, text]) => color === "accent" && text === TITLES[0]), false);
  assert.ok(colors.some(([color, text]) => color === "warning" && text === "! 阻塞 · 自动续跑已暂停 · 提前停止"));
  assert.ok(colors.some(([color, text]) => color === "text" && text === " · 原因：缺少 Redis 测试环境"));
  assert.equal(colors.some(([color, text]) => color === "warning" && text.includes("Redis")), false);
  assert.deepEqual(boldTexts, [TITLES[0]]);
});

test("unavailable plans emphasize only the warning prefix and keep diagnostics readable", () => {
  const model = buildTodoWidgetModel({ state: null, compatibilityError: "Unsupported schemaVersion" });
  const { theme, colors, boldTexts } = captureTheme();
  assert.deepEqual(new TodoWidget(model, theme).render(80), formatTodoWidgetLines(model));
  assert.deepEqual(colors, [["warning", "Todo 不可用："], ["text", "Unsupported schemaVersion"]]);
  assert.deepEqual(boldTexts, []);
});

test("the shared text sanitizer removes terminal controls from all displayed model fields", () => {
  const state = plan(["实现\u001b[31m缓存\u001b[0m\r\n失效\t👋\u0007"], "重构\n缓存\u007f");
  const blocked = apply(state, { action: "block", reason: "缺少\u001b]8;;https://example.invalid\u0007Redis\u001b]8;;\u0007\r\n环境\u007f" });
  const model = planModel(blocked);
  assert.equal(model.title, "重构 缓存");
  assert.equal(model.rows[0]!.title, "实现缓存 失效 👋");
  assert.equal(model.alerts.blockedReason, "缺少Redis 环境");
  const unavailable = buildTodoWidgetModel({ state: null, compatibilityError: "\u001b[31mUnsupported\u001b[0m\nversion\u0007" });
  assert.deepEqual(unavailable, { kind: "unavailable", message: "Unsupported version" });
  for (const current of [model, unavailable]) {
    for (const line of formatTodoWidgetLines(current)) assert.doesNotMatch(line, /[\x00-\x1f\x7f-\x9f]/);
    for (const line of new TodoWidget(current, plainTheme).render(80)) assert.doesNotMatch(strip(line), /[\x00-\x1f\x7f-\x9f]/);
  }
});

test("all widths preserve the same selected rows, bounded height and terminal column limits", () => {
  const blocked = apply(plan(), { action: "block", reason: "缺少测试环境".repeat(20) });
  const models = [
    planModel(plan()),
    planModel(advance(plan(Array.from({ length: 20 }, (_, i) => `Task ${i + 1}`)), 5), { paused: true }),
    planModel(advance(plan(), 5)),
    planModel(blocked, { paused: true, earlyStopWarning: true }),
    buildTodoWidgetModel({ state: null, compatibilityError: "Unsupported version" }),
    buildTodoWidgetModel({ state: null }),
  ];
  for (const model of models) {
    const widget = new TodoWidget(model, plainTheme);
    assert.deepEqual(widget.render(0), []);
    for (let width = 1; width <= 120; width += 1) {
      const lines = widget.render(width);
      assert.equal(lines.length, formatTodoWidgetLines(model).length);
      assert.ok(lines.length <= 9);
      if (width >= 12 && model.kind === "plan") {
        assert.ok(lines.every((line) => /^(╭─ |│  |╰─ )/.test(line)));
        assert.match(lines[0]!, /^╭─ /);
        assert.match(lines.at(-1)!, /^╰─ /);
      }
      for (const line of lines) {
        assert.ok(visibleWidth(line) <= width, `width ${width}: ${JSON.stringify(line)}`);
        assert.doesNotMatch(line, /[\r\n]/);
      }
    }
  }
});

test("real theme colors and bold styles never change text, layout or width at narrow sizes", () => {
  const blocked = apply(plan(), { action: "block", reason: "缺少 Redis 测试环境" });
  const unicode = plan([`${"中文 👩🏽‍💻 e\u0301 ".repeat(4)}`, "后续验证"], "长标题与对象 ".repeat(8));
  const models = [
    planModel(plan()),
    planModel(advance(plan(), 3)),
    planModel(advance(plan(), 5)),
    planModel(blocked, { paused: true, earlyStopWarning: true }),
    planModel(unicode),
    buildTodoWidgetModel({ state: null, compatibilityError: "Unknown schemaVersion" }),
  ];
  try {
    for (const name of ["dark", "light"] as const) {
      initTheme(name, false);
      for (const model of models) {
        const styled = new TodoWidget(model, theme);
        const plain = new TodoWidget(model, plainTheme);
        for (const width of [1, 2, 4, 12, 24, 40, 80, 120]) {
          const lines = styled.render(width);
          assert.deepEqual(lines.map(strip), plain.render(width).map(strip), `${name}, width ${width}`);
          for (const line of lines) assert.ok(visibleWidth(line) <= width);
        }
      }
    }
  } finally {
    initTheme("dark", false);
  }
});

test("dark and light themes preserve content, resizing and invalidatable render caching", () => {
  initTheme("dark", false);
  const mutableTheme = {
    fg: (color: Parameters<typeof theme.fg>[0], text: string) => theme.fg(color, text),
    bold: (text: string) => theme.bold(text),
  } as never;
  const widget = new TodoWidget(planModel(plan(), { paused: true }), mutableTheme);
  const dark = widget.render(80);
  assert.strictEqual(widget.render(80), dark);
  try {
    initTheme("light", false);
    widget.invalidate();
    const light = widget.render(80);
    assert.notDeepEqual(light, dark);
    assert.deepEqual(light.map(strip), dark.map(strip));
    assert.equal(widget.render(12).length, 6);
    assert.equal(widget.render(120).length, 6);
    for (const line of widget.render(120)) assert.ok(visibleWidth(line) <= 120);
  } finally {
    initTheme("dark", false);
  }
});
