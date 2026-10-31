import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters as strip } from "node:util";
import {
  initTheme,
  ToolExecutionComponent,
  type AgentToolResult,
  type ExtensionAPI,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type Component, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { theme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import linearTodoExtension from "../index.ts";
import { renderTodoCall, renderTodoResult } from "../render.ts";
import { emptyTodoReducerDependencies, reduceTodo } from "../reducer.ts";
import type { TodoInput, TodoState, TodoToolDetails } from "../schema.ts";

initTheme("dark", false);

let tool!: ToolDefinition<any, TodoToolDetails>;
linearTodoExtension({
  on() {},
  registerCommand() {},
  registerTool(definition: typeof tool) { tool = definition; },
} as unknown as ExtensionAPI);

const PLAN: TodoInput = {
  action: "plan",
  title: "Polish the tool row",
  goal: "Polish the tool row",
  tasks: [
    { title: "Inspect rendering", doneWhen: "Understand the render paths" },
    { title: "Refine styles", doneWhen: "Distinguish blocked and completed" },
    { title: "Check narrow terminals", doneWhen: "No overflow" },
  ],
};
type Result = AgentToolResult<TodoToolDetails> & { isError: boolean };

function apply(state: TodoState | null, args: TodoInput): Result {
  const transition = reduceTodo(state, args, emptyTodoReducerDependencies("tool-render-plan"));
  return {
    content: [{ type: "text", text: transition.summary }],
    details: { action: args.action, state: transition.state, transition: transition.summary },
    isError: false,
  };
}

function makeRow(args: unknown, result?: Result, outputPad = 0): ToolExecutionComponent {
  const row = new ToolExecutionComponent("todo", "render-call", args, { outputPad }, tool,
    { requestRender() {} } as unknown as TUI, process.cwd());
  row.setArgsComplete();
  if (result) row.updateResult(result);
  return row;
}

function plainLines(component: Component, width = 120): string[] {
  return component.render(width).map((line) => strip(line).trimEnd()).filter((line) => line.trim());
}

function plain(component: Component, width = 120): string {
  return plainLines(component, width).join("\n");
}

/** Expected single line for a summary that is short enough not to need truncation. */
function line(summary: string, progress?: string): string {
  return progress ? `Todo ${summary} · ${progress}` : `Todo ${summary}`;
}

function assertFits(component: Component, width: number): void {
  for (const rendered of component.render(width)) {
    assert.ok(visibleWidth(rendered) <= width, `overflow at ${width}: ${strip(rendered)}`);
    assert.doesNotMatch(strip(rendered), /[\x00-\x09\x0b-\x1f\x7f]/);
  }
}

test("native tool composition replaces the call with one lightweight result event", () => {
  assert.equal(tool.renderShell, "self");
  const row = makeRow(PLAN);
  assert.equal(plain(row), "Todo 正在创建计划：Polish the tool row");
  row.updateResult(apply(null, PLAN));
  assert.deepEqual(plainLines(row), [line("创建计划：Polish the tool row", "0/3")]);
  assert.equal(row.render(120).length, 2, "one host separator plus exactly one content line");
  assert.doesNotMatch(plain(row), /goal=|Created Todo|task\(s\)/);
  assert.equal(renderTodoCall(PLAN, theme, { isPartial: false }).render(120).length, 0);
});

test("headers put the concrete change first and anchor the counter on the right", () => {
  const args: TodoInput = {
    action: "plan", title: "打磨工具行", goal: "打磨工具行",
    tasks: [{ title: "梳理渲染路径" }, { title: "打磨状态样式" }, { title: "验证窄屏" }],
  };
  const planned = apply(null, args);
  assert.equal(plain(makeRow(args, planned), 60), line("创建计划：打磨工具行", "0/3"));
  const advanced = apply(planned.details.state, { action: "advance", completions: [{}] });
  assert.equal(plain(makeRow({ action: "advance", completions: [{}] }, advanced), 60), line("✓ 梳理渲染路径", "1/3"));
  const blocked = apply(advanced.details.state, { action: "block", reason: "等待确认布局" });
  assert.equal(plain(makeRow({ action: "block" }, blocked), 60), line("! 等待确认布局", "1/3"));
  const second = apply(advanced.details.state, { action: "advance", completions: [{}] });
  const completed = apply(second.details.state, { action: "advance", completions: [{}] });
  assert.equal(plain(makeRow({ action: "advance", completions: [{}] }, completed), 60), line("✓ 计划完成", "3/3"));
});

test("a changing counter never moves, and narrow widths drop it before the summary", () => {
  const planned = apply(null, PLAN);
  const row = makeRow({ action: "advance", completions: [{}] }, apply(planned.details.state, { action: "advance", completions: [{}] }));
  assert.equal(plain(row, 120), "Todo ✓ Inspect rendering · 1/3", "a wide terminal must not push the counter away");
  assert.equal(plain(row, 80), "Todo ✓ Inspect rendering · 1/3");
  for (const width of [40, 47]) {
    assert.equal(plain(row, width), "Todo ✓ Inspect rendering", `the counter must leave room below ${width}`);
  }
  assert.equal(plain(row, 48), "Todo ✓ Inspect rendering · 1/3", "48 columns is the first width that keeps the counter");
  const longArgs: TodoInput = { action: "plan", title: "T".repeat(60), goal: "Long summary plan", tasks: [{ title: "Only task" }] };
  const long = plain(makeRow({ action: "plan" }, apply(null, longArgs)), 48);
  assert.ok(long.endsWith("… · 0/1"), `the summary loses cells before the counter: ${long}`);
  assert.ok(visibleWidth(long) <= 48);
});

test("every operation remains traceable only in expanded details, including cleared and empty plans", () => {
  const planned = apply(null, PLAN);
  const blocked = apply(planned.details.state, { action: "block", reason: "Waiting" });
  const inputs: Array<{ args: TodoInput; state: TodoState | null }> = [
    { args: PLAN, state: null },
    { args: { action: "advance", completions: [{}] }, state: planned.details.state },
    { args: { action: "replan", reason: "New scope", tasks: [{ title: "Replacement" }] }, state: planned.details.state },
    { args: { action: "insert", tasks: [{ title: "Extra check" }] }, state: planned.details.state },
    { args: { action: "undo" }, state: planned.details.state },
    { args: { action: "block", reason: "Waiting" }, state: planned.details.state },
    { args: { action: "resume" }, state: blocked.details.state },
    { args: { action: "show" }, state: planned.details.state },
    { args: { action: "show" }, state: null },
    { args: { action: "clear" }, state: planned.details.state },
    { args: { action: "clear" }, state: null },
  ];
  for (const { args, state } of inputs) {
    const row = makeRow(args, apply(state, args));
    const header = plain(row);
    assert.equal(plainLines(row).length, 1);
    assert.doesNotMatch(header, /^Todo (?:plan|advance|replan|insert|undo|block|resume|show|clear)\b/);
    row.setExpanded(true);
    assert.match(plain(row), new RegExp(`├─ 操作\n {2}│ ${args.action}`));
    assert.equal(plainLines(row)[0], header);
  }
  assert.equal(plain(makeRow({ action: "show" }, apply(null, { action: "show" }))), "Todo 暂无计划");
});

test("tool rows draw no background block and no blank content rows", () => {
  const row = makeRow(PLAN);
  const checkPlain = () => {
    for (const width of [40, 80, 120]) {
      const lines = row.render(width);
      assert.equal(lines.length, 2, "one host separator plus exactly one content line");
      assert.equal(strip(lines[0]!).trim(), "", "the host separator stays outside our content");
      assert.ok(visibleWidth(lines[1]!) <= width);
      for (const token of ["toolPendingBg", "toolSuccessBg", "toolErrorBg"] as const) {
        assert.ok(!lines.join("\n").includes(theme.getBgAnsi(token)), `${token} must not be painted`);
      }
    }
  };
  checkPlain();
  const planned = apply(null, PLAN);
  row.updateResult(planned);
  checkPlain();
  assert.equal(plainLines(row).length, 1);
  row.setExpanded(true);
  assert.ok(row.render(120).length > 2);
  assert.ok(!row.render(120).join("\n").includes(theme.getBgAnsi("toolSuccessBg")));
  row.updateResult({ ...planned, isError: true });
  assert.ok(!row.render(120).join("\n").includes(theme.getBgAnsi("toolErrorBg")));
  row.setExpanded(false);
  assert.equal(plainLines(row).length, 1);
});

test("streaming calls tolerate malformed arguments without showing half-written fields", () => {
  const streaming = renderTodoCall({ action: "pl", tasks: "not-an-array" }, theme, { argsComplete: false });
  assert.equal(plain(streaming), "Todo …");
  assert.equal(plain(renderTodoCall({ action: "plan", goal: "unfinished" }, theme, { argsComplete: false })), "Todo …");
  for (const args of [null, [], "invalid", { tasks: 42, goal: 7, position: "middle" }]) {
    assert.equal(plain(renderTodoCall(args, theme)), "Todo …");
  }
  const row = makeRow({ action: "pl" });
  row.updateArgs(PLAN);
  assert.match(plain(row), /Polish the tool row/);
  const partial = apply(null, PLAN);
  assert.deepEqual(renderTodoResult(partial, { expanded: true, isPartial: true }, theme).render(80), []);
  row.updateResult(partial, true);
  assert.equal(plainLines(row).length, 1, "a partial result must not add a second header");
  row.updateResult(partial);
  assert.equal(plainLines(row).length, 1);
});

test("advancing shows only the completed task, with no next-task tail or result", () => {
  const planned = apply(null, PLAN);
  const args: TodoInput = { action: "advance", completions: [{ result: "OBSERVED_RESULT_ONLY" }] };
  const row = makeRow(args, apply(planned.details.state, args));
  assert.equal(plain(row), line("✓ Inspect rendering", "1/3"));
  assert.doesNotMatch(plain(row), /Refine styles|→|OBSERVED_RESULT_ONLY/);
  assert.ok(!row.render(120).join("\n").includes(theme.fg("success", "Inspect rendering")), "only the milestone text is success-colored, not every completed title");
  assert.doesNotMatch(plain(row, 40), /Refine styles|OBSERVED_RESULT_ONLY/);
});

test("batch events report the actual cursor delta and keep each optional result in the historical snapshot", () => {
  const planned = apply(null, PLAN);
  const args: TodoInput = { action: "advance", completions: [{ result: "FIRST_BATCH_RESULT" }, { result: "SECOND_BATCH_RESULT" }] };
  const advanced = apply(planned.details.state, args);
  const row = makeRow(args, advanced);
  assert.equal(plain(row, 60), line("✓ Refine styles", "2/3"), "a batch starting at zero must not repeat the counter numerator");
  assert.equal(plain(renderTodoCall(args, theme)), "Todo 2 项完成记录");
  assert.equal(plain(renderTodoCall(args, theme, { argsComplete: false })), "Todo …");
  for (const width of [1, 2, 12, 40, 80, 120]) {
    assert.equal(plainLines(row, width).length, 1);
    assertFits(row, width);
  }
  assert.doesNotMatch(plain(row), /FIRST_BATCH_RESULT|SECOND_BATCH_RESULT/);
  const historical = renderTodoResult(advanced, { expanded: false }, theme);
  assert.equal(plain(historical, 60), plain(row, 60), "batch size must not depend on call arguments");
  row.setExpanded(true);
  const before = plain(row);
  assert.match(before, /├─ 结果\n  │ ✓ Inspect rendering\n  │   FIRST_BATCH_RESULT\n  │ ✓ Refine styles\n  │   SECOND_BATCH_RESULT/);
  assert.match(before, /├─ 当前\n  │ → Check narrow terminals\n  ╰─ \/todos 查看完整计划$/);
  const finalArgs: TodoInput = { action: "advance", completions: [{}] };
  assert.equal(plain(makeRow(finalArgs, apply(advanced.details.state, finalArgs)), 60), line("✓ 计划完成", "3/3"));
  assert.equal(plain(row), before);
});

test("a final batch is one completed event without inventing results for empty records", () => {
  const planned = apply(null, PLAN);
  const args: TodoInput = { action: "advance", completions: [{}, {}, {}] };
  const row = makeRow(args, apply(planned.details.state, args));
  assert.equal(plain(row), line("✓ 计划完成", "3/3"));
  assert.ok(row.render(120).join("\n").includes(theme.fg("success", "计划完成")), "the milestone text shares the success color");
  row.setExpanded(true);
  assert.equal((plain(row).match(/│ ✓ [A-Z][a-z]+ /g) ?? []).length, 3);
  assert.doesNotMatch(plain(row), /验收|Done when/);
});

test("a batch is labelled only when it differs from the plan's absolute progress", () => {
  const args: TodoInput = {
    action: "plan", title: "Four tasks", goal: "Four tasks",
    tasks: [{ title: "One" }, { title: "Two" }, { title: "Three" }, { title: "Four" }],
  };
  const planned = apply(null, args);
  const first = apply(planned.details.state, { action: "advance", completions: [{}] });
  const batch = apply(first.details.state, { action: "advance", completions: [{}, {}] });
  assert.equal(plain(makeRow({ action: "advance", completions: [{}, {}] }, batch), 60), line("✓ Three 等 2 项", "3/4"));
  const shown = makeRow({ action: "show" }, apply(batch.details.state, { action: "show" }));
  assert.equal(plain(shown, 60), line("查看 Four", "3/4"), "read-only inspection states its own verb");
  shown.setExpanded(true);
  assert.match(plain(shown), /├─ 操作\n {2}│ show/);
  const undon = makeRow({ action: "undo" }, apply(batch.details.state, { action: "undo" }));
  assert.equal(plain(undon, 60), line("已撤销上次变更", "1/4"), "undo restores the pre-batch cursor");
  assert.doesNotMatch(plain(undon), /[+↶↻⌫→]/, "rare actions use words, not extra glyphs");
});

test("collapsed long Chinese and emoji output stays one line at every width", () => {
  const planned = apply(null, PLAN);
  const args: TodoInput = { action: "advance", completions: [{ result: "检查完成 👋 Café。".repeat(50) }] };
  const row = makeRow(args, apply(planned.details.state, args));
  for (const width of [1, 2, 12, 24, 40, 80, 120]) {
    assert.equal(plainLines(row, width).length, 1);
    assertFits(row, width);
  }
  assert.deepEqual(row.render(0), []);
  assert.doesNotMatch(plain(row), /检查完成/);
});

test("blocked states use warnings, including show and undo snapshots", () => {
  const planned = apply(null, PLAN);
  const args: TodoInput = { action: "block", reason: "Waiting for credentials" };
  const blocked = apply(planned.details.state, args);
  for (const [call, result] of [[args, blocked], [{ action: "show" }, apply(blocked.details.state, { action: "show" })]] as const) {
    const row = makeRow(call, result);
    assert.match(plain(row), /! Waiting for credentials/);
    assert.ok(row.render(120).join("\n").includes(theme.fg("warning", "!")));
    assert.doesNotMatch(plain(row), /✓/);
    assert.match(plain(row, 40), /Waiting for/);
    assert.doesNotMatch(plain(row, 40), /0\/3/, "diagnostics beat the counter on narrow screens");
  }
  const resumed = apply(blocked.details.state, { action: "resume" });
  const undone = makeRow({ action: "undo" }, apply(resumed.details.state, { action: "undo" }));
  assert.match(plain(undone), /! Waiting for credentials/);
});

test("domain errors and host errors never receive a success marker or a stale counter", () => {
  const planned = apply(null, PLAN);
  const error: Result = {
    content: [{ type: "text", text: "HOST_FAILURE_DETAIL" }],
    details: { action: "advance", state: planned.details.state, transition: "Rejected", error: "PLAN_BLOCKED: Resume first" },
    isError: true,
  };
  const row = makeRow({ action: "advance", completions: [{}] }, error);
  assert.match(plain(row), /✗ PLAN_BLOCKED: Resume first/);
  assert.doesNotMatch(plain(row), /0\/3/, "a rejected call did not move the plan");
  assert.ok(row.render(120).join("\n").includes(theme.fg("error", "✗")));
  assert.doesNotMatch(plain(row), /✓/);
  for (const details of [undefined, {}]) {
    const hostError = makeRow({ action: "show" }, { ...error, details } as Result);
    assert.match(plain(hostError), /Todo ✗ HOST_FAILURE_DETAIL/);
    hostError.setExpanded(true);
    assert.match(plain(hostError), /├─ 操作\n {2}│ show/);
    assert.match(plain(hostError), /├─ 错误\n {2}│ HOST_FAILURE_DETAIL/);
  }
  row.setExpanded(true);
  assert.match(plain(row), /├─ 错误\n  │ PLAN_BLOCKED: Resume first\n  ├─ 计划\n  │ Polish the tool row\n  ├─ 当前\n  │ → Inspect rendering\n  ╰─ \/todos 查看完整计划/);
});

test("compatibility errors and absent details retain a readable fallback", () => {
  const result: Result = {
    content: [{ type: "text", text: "schemaVersion 99 is unsupported" }],
    details: { action: "show", state: null, transition: "Rejected", compatibilityError: "schemaVersion 99 is unsupported" },
    isError: true,
  };
  const row = makeRow({ action: "show" }, result);
  assert.match(plain(row), /! 不可用：schemaVersion 99/);
  assert.ok(row.render(120).join("\n").includes(theme.fg("warning", "!")));
  row.setExpanded(true);
  assert.match(plain(row), /├─ 错误\n  │ schemaVersion 99 is unsupported\n  ╰─/);
  const fallback = makeRow({ action: "show" }, { ...result, details: undefined, isError: false } as unknown as Result);
  assert.match(plain(fallback), /schemaVersion 99/);
  assert.doesNotMatch(plain(fallback), /✓/);
});

test("expanded events use one label column and stop replaying unrelated tasks", () => {
  const planned = apply(null, PLAN);
  const args: TodoInput = { action: "advance", completions: [{ result: "Observed 12 passing checks" }] };
  const row = makeRow(args, apply(planned.details.state, args));
  row.setExpanded(true);
  const text = plain(row);
  assert.match(text, /  ├─ 操作\n  │ advance\n  ├─ 结果\n  │ ✓ Inspect rendering\n  │   Observed 12 passing checks\n  ├─ 计划\n  │ Polish the tool row\n  ├─ 目标\n  │ Polish the tool row\n  ├─ 当前\n  │ → Refine styles\n  ╰─ \/todos 查看完整计划$/);
  assert.doesNotMatch(text, /Understand the render paths|Distinguish blocked and completed|Check narrow terminals/);
  assert.equal((text.match(/Observed 12 passing checks/g) ?? []).length, 1);
  const styled = row.render(120).join("\n");
  assert.ok(styled.includes(theme.fg("success", "✓")));
  assert.ok(styled.includes(theme.fg("accent", "→")));
  assert.ok(styled.includes(theme.fg("borderMuted", "  ├─ ")));
  assert.ok(styled.includes(theme.fg("borderMuted", "  │ ")));
  assert.ok(styled.includes(theme.fg("borderMuted", "  ╰─")));
  row.setExpanded(false);
  assert.equal(plainLines(row).length, 1);
});

test("expanded sections drop the rail before squeezing the body", () => {
  const planned = apply(null, PLAN);
  const args: TodoInput = { action: "block", reason: "缺少 npm 访问权限，无法安装依赖" };
  const row = makeRow(args, apply(planned.details.state, args));
  row.setExpanded(true);
  for (const width of [1, 2, 12, 20, 23, 24, 40]) assertFits(row, width);
  const narrow = plain(row, 20);
  assert.doesNotMatch(narrow, /[├╰│]/);
  assert.match(narrow, /操作\n {2}block/);
  assert.match(narrow, /受阻\n {2}缺少 npm/);
  assert.match(plain(row, 24), /├─ 操作/);
});

test("native mouse regions still toggle expansion after the call slot becomes empty", () => {
  const row = makeRow(PLAN, apply(null, PLAN));
  const click = () => {
    const height = row.render(120).length;
    return row.handleMouse({
      type: "click", button: "left", x: 2, y: 1,
      screenX: 2, screenY: 2, width: 120, height,
      shift: false, alt: false, ctrl: false,
    });
  };
  assert.ok(click()?.handled);
  assert.match(plain(row), /验收 Understand the render paths/);
  assert.ok(click()?.handled);
  assert.equal(plainLines(row).length, 1);
});

test("expanded plans show this call's tasks and close with a continuation footer", () => {
  const args: TodoInput = {
    action: "plan", title: "Inspect the historical plan", goal: "Long historical plan",
    tasks: Array.from({ length: 20 }, (_unused, index) => ({ title: `任务 ${index + 1} 👋`, doneWhen: "核对验收条件" })),
  };
  const planned = apply(null, args);
  const row = makeRow(args, planned);
  row.setExpanded(true);
  assert.match(plain(row, 80), /\+ 任务 1 👋/);
  assert.match(plain(row, 80), /\+ 任务 20 👋/);
  assert.equal((plain(row, 80).match(/验收 核对验收条件/g) ?? []).length, 20);
  assert.match(plain(row, 80), /├─ 当前\n {2}│ → 任务 1 👋\n {2}╰─ \/todos 查看完整计划$/);
  for (const width of [40, 80, 120]) assertFits(row, width);
});

test("expanded events retain full Unicode evidence and fit after resizing", () => {
  const evidence = "中文 👋 Café 验证完成。".repeat(40);
  const planned = apply(null, PLAN);
  const args: TodoInput = { action: "advance", completions: [{ result: evidence }] };
  const row = makeRow(args, apply(planned.details.state, args));
  row.setExpanded(true);
  for (const width of [1, 2, 12, 40, 80, 120]) assertFits(row, width);
  const text = plain(row, 80).replace(/[│\s]/g, "");
  assert.ok(text.includes(evidence.replace(/\s/g, "")), "expanded evidence must not be truncated");
});

test("insert, replan, resume, undo, clear and final completion describe their own events", () => {
  const planned = apply(null, PLAN);
  for (const position of ["next", "end"] as const) {
    const args: TodoInput = { action: "insert", position, tasks: [{ title: "Additional check" }] };
    const row = makeRow(args, apply(planned.details.state, args));
    assert.ok(plain(row).includes(`补充 1 项任务（${position === "end" ? "追加到末尾" : "当前项之后"}）`));
    row.setExpanded(true);
    assert.match(plain(row), /├─ 结果\n {2}│ \+ Additional check\n {2}├─ 计划\n {2}│ Polish the tool row\n {2}├─ 目标\n {2}│ Polish the tool row\n {2}├─ 当前\n {2}│ → Inspect rendering\n {2}╰─ \/todos 查看完整计划/);
  }
  const args: TodoInput = { action: "replan", reason: "Keep the latest scope", tasks: [{ title: "Replacement" }] };
  const replanned = apply(planned.details.state, args);
  const row = makeRow(args, replanned);
  row.setExpanded(true);
  assert.match(plain(row), /├─ 原因\n {2}│ Keep the latest scope/);
  assert.match(plain(row), /\+ Replacement/);
  assert.doesNotMatch(plain(row), /\+ Inspect rendering/, "replan must not replay the retained completed prefix");
  assert.match(plain(makeRow({ action: "undo" }, apply(replanned.details.state, { action: "undo" }))), /Todo 已撤销上次变更/);
  const blocked = apply(planned.details.state, { action: "block", reason: "Waiting" });
  assert.match(plain(makeRow({ action: "resume" }, apply(blocked.details.state, { action: "resume" }))), /Todo 已恢复 Inspect rendering/);
  const cleared = makeRow({ action: "clear" }, apply(planned.details.state, { action: "clear" }));
  assert.match(plain(cleared), /Todo 已清空当前计划/);
  assert.doesNotMatch(plain(cleared), /✓|0\/3/);
  cleared.setExpanded(true);
  assert.match(plain(cleared), /├─ 结果\n {2}│ 已清空当前计划（3 项未完成）\n {2}╰─/);
  let state = planned.details.state;
  for (let index = 0; index < 3; index += 1) state = apply(state, { action: "advance", completions: [{}] }).details.state;
  const completed = makeRow({ action: "show" }, apply(state, { action: "show" }));
  assert.equal(plain(completed), line("✓ 计划完成", "3/3"));
});

test("outputPad insets tool rows, and terminal controls never break rendering", () => {
  const args: TodoInput = {
    ...PLAN,
    goal: "中文 👋 Café\n\t\u001b[31mVISIBLE\u001b[0m\u0007\u0008\u007f",
    tasks: PLAN.tasks!.map((item) => ({ ...item, title: `${item.title}\u0007\u0008\u007f` })),
  };
  const row = makeRow(args, apply(null, args), 2);
  assert.match(plain(row), /^ {2}Todo/, "self-rendered rows honour outputPad");
  for (const width of [1, 2, 12, 40, 80, 120]) assertFits(row, width);
  row.setExpanded(true);
  for (const width of [1, 2, 12, 40, 80, 120]) assertFits(row, width);
  const dark = row.render(120).join("\n");
  try {
    initTheme("light", false);
    row.invalidate();
    const light = row.render(120).join("\n");
    assert.notEqual(light, dark);
    assert.equal(strip(light), strip(dark));
    assert.match(strip(light), /中文 👋 Café VISIBLE/);
  } finally {
    initTheme("dark", false);
  }
});

test("expanded history keeps execution descriptions with their own acceptance and results", () => {
  const description = "检查路径 👩‍💻 e\u0301 与参数细节。".repeat(12);
  assert.ok(description.length <= 300);
  const args: TodoInput = {
    action: "plan", title: "Verify the rendering contract", goal: "Keep complete task execution information in historical snapshots",
    tasks: [
      { title: "Inspect source", description, doneWhen: "The cause is identified" },
      { title: "Verify behavior", description: "Run regression tests with the original fixture", doneWhen: "All checks pass" },
    ],
  };
  const planned = apply(null, args);
  const planRow = makeRow(args, planned);
  planRow.setExpanded(true);
  const planText = plain(planRow, 80);
  assert.ok(planText.replace(/[│\s]/g, "").includes(description.replace(/\s/g, "")), "historical descriptions must not be clipped");
  assert.match(planText, /说明 Run regression tests with the original fixture/);
  assert.match(planText, /验收 All checks pass/);
  for (const width of [1, 12, 40, 80, 120]) assertFits(planRow, width);

  const completed = apply(planned.details.state, { action: "advance", completions: [{ result: "Found the rendering cause" }] });
  const row = makeRow({ action: "advance" }, completed);
  assert.doesNotMatch(plain(row), /说明|验收|The cause is identified|Found the rendering cause/);
  row.setExpanded(true);
  const text = plain(row, 80);
  assert.match(text, /├─ 计划\n {2}│ Verify the rendering contract/);
  assert.match(text, /├─ 目标\n {2}│ Keep complete task execution information/);
  assert.match(text, /│ ✓ Inspect source/);
  assert.match(text, /│   Found the rendering cause/);
  assert.match(text, /├─ 当前\n {2}│ → Verify behavior/);
  assert.doesNotMatch(text, /Run regression tests with the original fixture/, "later tasks keep their details out of this call");
  for (const width of [1, 12, 40, 80, 120]) assertFits(row, width);
});

test("rendering later transitions cannot rewrite earlier result snapshots", () => {
  const planned = apply(null, PLAN);
  const before = JSON.stringify(planned);
  const firstRow = makeRow(PLAN, planned);
  firstRow.setExpanded(true);
  const firstText = plain(firstRow);
  const args: TodoInput = { action: "advance", completions: [{ result: "Only belongs to the newer result" }] };
  const secondRow = makeRow(args, apply(planned.details.state, args));
  secondRow.setExpanded(true);
  assert.match(plain(secondRow), /Only belongs to the newer result/);
  assert.equal(plain(firstRow), firstText);
  assert.equal(JSON.stringify(planned), before);
});
