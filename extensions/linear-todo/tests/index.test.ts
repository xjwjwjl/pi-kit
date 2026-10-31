import assert from "node:assert/strict";
import test from "node:test";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  ExtensionToolContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Component } from "@earendil-works/pi-tui";
import linearTodoExtension from "../index.ts";
import type { TodoInput, TodoToolDetails } from "../schema.ts";
import { TODO_AUTO_CONTINUE_CUSTOM_TYPE } from "../state.ts";

interface Harness {
  handlers: Map<string, Array<(event: any, ctx: any) => any>>;
  commands: Map<string, { handler: (args: string, ctx: any) => Promise<void> }>;
  tool: ToolDefinition<any, TodoToolDetails>;
  widgets: unknown[];
  statuses: unknown[];
  ctx: ExtensionContext & ExtensionToolContext;
  setBranch(branch: any[]): void;
}

function createHarness(mode: "tui" | "rpc" | "json" | "print"): Harness {
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
  const widgets: unknown[] = [];
  const statuses: unknown[] = [];
  let branch: any[] = [];
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    strikethrough: (text: string) => text,
  };
  const ctx = {
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    cwd: "D:/code/test",
    ui: {
      theme,
      setWidget: (_key: string, content: unknown) => widgets.push(content),
      setStatus: (_key: string, content: unknown) => statuses.push(content),
      notify: () => undefined,
      custom: async () => undefined,
    },
    sessionManager: {
      getBranch: () => branch,
    },
    hasPendingMessages: () => false,
    waitForIdle: async () => undefined,
    tools: [],
    executeTool: async () => {
      throw new Error("executeTool is not available in the harness");
    },
  } as unknown as ExtensionContext & ExtensionToolContext;
  const pi = {
    on(name: string, handler: (event: any, ctx: any) => any) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
    registerTool(definition: ToolDefinition<any, TodoToolDetails>) {
      harness.tool = definition;
    },
    registerCommand(name: string, options: { handler: (args: string, ctx: any) => Promise<void> }) {
      commands.set(name, options);
    },
  } as unknown as ExtensionAPI;
  const harness = {
    handlers,
    commands,
    tool: undefined as unknown as ToolDefinition<any, TodoToolDetails>,
    widgets,
    statuses,
    ctx,
    setBranch(next: any[]) {
      branch = next;
    },
  } satisfies Harness;

  linearTodoExtension(pi);
  return harness;
}

function handler(harness: Harness, name: string): (event: any, ctx: any) => any {
  const registered = harness.handlers.get(name)?.[0];
  assert.ok(registered, `missing handler ${name}`);
  return registered;
}

function assistant(stopReason: "stop" | "error" | "aborted"): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: stopReason === "stop" ? "I stopped." : "Failure" }],
    api: "test",
    provider: "test",
    model: "test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: 1_000,
  } as AgentMessage;
}

async function executePlan(harness: Harness): Promise<TodoToolDetails> {
  const input: TodoInput = {
    action: "plan",
    title: "Wire the extension",
    goal: "Wire the extension",
    tasks: [{ title: "Implement" }, { title: "Verify" }],
  };
  const result = await harness.tool.execute("call-1", input, undefined, undefined, harness.ctx);
  return result.details;
}

function resultText(result: AgentToolResult<TodoToolDetails>): string {
  return result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
}

test("extension registers a sequential todo tool and /todos command", () => {
  const harness = createHarness("tui");
  assert.equal(harness.tool.name, "todo");
  assert.equal(harness.tool.executionMode, "sequential");
  assert.equal(harness.tool.exposure, "model-only");
  const guidelines = harness.tool.promptGuidelines?.join("\n") ?? "";
  assert.match(guidelines, /latest user request/);
  assert.match(guidelines, /not every tool call/);
  assert.match(guidelines, /observed results/);
  assert.match(guidelines, /completions/);
  assert.match(guidelines, /result is optional/);
  assert.ok(harness.tool.parameters.properties.title, "the registered tool must expose the plan title to the model");
  assert.ok(harness.tool.parameters.properties.tasks.items.properties.title, "the registered tool must expose task titles");
  assert.ok(harness.tool.parameters.properties.tasks.items.properties.description, "the registered tool must expose execution details");
  assert.equal(harness.tool.parameters.properties.displayTitle, undefined);
  assert.equal(harness.tool.parameters.properties.tasks.items.properties.displayTitle, undefined);
  assert.match(guidelines, /Always provide a concise title/);
  assert.match(guidelines, /stable action-oriented overview of the whole plan/);
  assert.match(guidelines, /not the current step/);
  assert.match(guidelines, /every new task in plan\/replan\/insert/);
  assert.match(guidelines, /60 characters/);
  assert.match(guidelines, /do not copy paths, command lists, parameters or acceptance clauses/);
  assert.match(guidelines, /execution details in description/);
  assert.match(guidelines, /acceptance conditions/);
  assert.match(guidelines, /explicitly provide a new matching title/);
  assert.equal(harness.handlers.has("session_start"), true);
  assert.equal(harness.handlers.has("context"), true);
  assert.equal(harness.handlers.has("agent_before_settle"), true);
  assert.equal(harness.handlers.has("agent_settled"), true);
});

test("tool results carry the complete snapshot and context reminders are hidden", async () => {
  const harness = createHarness("tui");
  await handler(harness, "session_start")({ reason: "startup" }, harness.ctx);
  const details = await executePlan(harness);

  assert.equal(details.state?.cursor, 0);
  assert.equal(details.state?.items.length, 2);
  assert.equal(details.action, "plan");

  await handler(harness, "before_agent_start")(
    { type: "before_agent_start", messageType: "user", prompt: "Continue" },
    harness.ctx,
  );
  const contextResult = await handler(harness, "context")({ messages: [] }, harness.ctx);
  assert.equal(contextResult.messages.length, 1);
  assert.equal(contextResult.messages[0].role, "custom");
  assert.equal(contextResult.messages[0].display, false);
  assert.match(String(contextResult.messages[0].content), /Current: Implement/);
});

test("mutating actions return the next working context and observed results in every mode", async () => {
  for (const mode of ["tui", "rpc", "json", "print"] as const) {
    const harness = createHarness(mode);
    await handler(harness, "session_start")({}, harness.ctx);
    const execute = (input: TodoInput) => harness.tool.execute("feedback", input, undefined, undefined, harness.ctx);
    const planned = await execute({
      action: "plan",
      title: "Deliver a verified change",
      goal: "Deliver a verified change",
      tasks: [
        { title: "Explore", description: "Reproduce the failure with the existing fixture", doneWhen: "The cause is known" },
        { title: "Implement", description: "Patch the boundary without changing the public API", doneWhen: "The regression is fixed" },
        { title: "Verify", doneWhen: "All checks pass" },
      ],
    });
    assert.match(resultText(planned), /Plan: Deliver a verified change/);
    assert.match(resultText(planned), /Goal: Deliver a verified change/);
    assert.match(resultText(planned), /Description: Reproduce the failure with the existing fixture/);
    assert.match(resultText(planned), /Current: Explore/);
    assert.match(resultText(planned), /Done when: The cause is known/);
    assert.match(resultText(planned), /Next: Implement/);
    assert.doesNotMatch(resultText(planned), /Verify/);

    const advanced = await execute({ action: "advance", completions: [{ result: "Reproduced the failing case" }] });
    assert.match(resultText(advanced), /Reproduced the failing case/);
    assert.match(resultText(advanced), /Current: Implement/);
    assert.match(resultText(advanced), /Description: Patch the boundary without changing the public API/);
    assert.match(resultText(advanced), /Done when: The regression is fixed/);
    assert.match(resultText(advanced), /Next: Verify/);
    assert.equal(resultText(advanced).match(/Current:/g)?.length, 1, "the transition must not repeat the working view");

    const blocked = await execute({ action: "block", reason: "Need the fixture" });
    assert.match(resultText(blocked), /Blocked: Need the fixture/);
    assert.match(resultText(blocked), /Done when: The regression is fixed/);
    const resumed = await execute({ action: "resume" });
    assert.match(resultText(resumed), /Current: Implement/);
    assert.doesNotMatch(resultText(resumed), /Blocked:/);

    const inserted = await execute({ action: "insert", tasks: [{ title: "Review" }] });
    assert.match(resultText(inserted), /Current: Implement/);
    assert.match(resultText(inserted), /Next: Review/);
    const undone = await execute({ action: "undo" });
    assert.match(resultText(undone), /Next: Verify/);
    assert.doesNotMatch(resultText(undone), /Review/);
    const replanned = await execute({
      action: "replan", reason: "A narrower implementation is sufficient",
      tasks: [{ title: "Patch", doneWhen: "The case passes" }, { title: "Check" }],
    });
    assert.match(resultText(replanned), /Current: Patch/);
    assert.match(resultText(replanned), /Done when: The case passes/);
    assert.match(resultText(replanned), /Next: Check/);

    await execute({ action: "advance", completions: [{ result: "The regression now passes" }] });
    const completed = await execute({ action: "advance", completions: [{ result: "All 12 checks passed" }] });
    assert.match(resultText(completed), /All 12 checks passed/);
    assert.match(resultText(completed), /completed/);
    assert.doesNotMatch(resultText(completed), /Current:|Next:/);
    const cleared = await execute({ action: "clear" });
    assert.equal(cleared.details.state, null);
    assert.doesNotMatch(resultText(cleared), /Goal:|Current:|Next:/);
  }
});

test("batch feedback returns every new result and the final working context in every mode", async () => {
  for (const mode of ["tui", "rpc", "json", "print"] as const) {
    const harness = createHarness(mode);
    await handler(harness, "session_start")({}, harness.ctx);
    const execute = (input: TodoInput) => harness.tool.execute("batch-feedback", input, undefined, undefined, harness.ctx);
    const planned = await execute({
      action: "plan", title: "Deliver the batch change", goal: "Batch feedback",
      tasks: [{ title: "Explore" }, { title: "Implement" }, { title: "Verify", doneWhen: "All checks pass" }],
    });
    const batch = await execute({ action: "advance", completions: [{ result: "CAUSE_FOUND" }, { result: "PATCH_READY" }] });
    assert.equal(batch.isError, undefined);
    assert.equal(batch.details.state?.cursor, 2);
    assert.equal(batch.details.state?.revision, planned.details.state!.revision + 1);
    assert.match(resultText(batch), /CAUSE_FOUND/);
    assert.match(resultText(batch), /PATCH_READY/);
    assert.match(resultText(batch), /Current: Verify/);
    assert.match(resultText(batch), /Done when: All checks pass/);
    assert.equal(resultText(batch).match(/Current:/g)?.length, 1);
    const rejected = await execute({ action: "advance", completions: [{}, {}] });
    assert.equal(rejected.isError, true);
    assert.match(resultText(rejected), /INVALID_COMPLETIONS/);
    assert.deepEqual(rejected.details.state, batch.details.state);
    const completed = await execute({ action: "advance", completions: [{ result: "CHECKS_PASSED" }] });
    assert.equal(completed.details.state?.phase, "completed");
    assert.match(resultText(completed), /CHECKS_PASSED/);
    assert.doesNotMatch(resultText(completed), /Current:|Next:/);
    const undone = await execute({ action: "undo" });
    assert.equal(undone.details.state?.cursor, 2);
    assert.deepEqual(undone.details.state?.items, batch.details.state?.items);
  }
});

test("show returns the full plan to the model without changing state in any mode", async () => {
  for (const mode of ["tui", "rpc", "json", "print"] as const) {
    const harness = createHarness(mode);
    await handler(harness, "session_start")({}, harness.ctx);
    const execute = (input: TodoInput) => harness.tool.execute("show-test", input, undefined, undefined, harness.ctx);
    const empty = await execute({ action: "show" });
    assert.deepEqual(empty.content, [{ type: "text", text: "No active Todo plan." }]);
    assert.equal(empty.details.state, null);
    await execute({
      action: "plan",
      title: "Deliver a verified feature",
      goal: "Deliver a fully verified feature",
      tasks: [
        { title: "Explore", description: "Read the tool lifecycle and reducer integration", doneWhen: "Integration points are known" },
        { title: "Implement", doneWhen: "The feature works" },
        { title: "Verify", doneWhen: "All checks pass" },
        { title: "Document", doneWhen: "Usage is documented" },
      ],
    });
    await execute({ action: "advance", completions: [{ result: "Found the required APIs" }] });
    const blocked = await execute({ action: "block", reason: "Missing test credentials" });
    const shown = await execute({ action: "show" });
    const content = resultText(shown);

    assert.match(content, /Todo 1\/4 done — BLOCKED/);
    assert.match(content, /Plan: Deliver a verified feature/);
    assert.match(content, /Goal: Deliver a fully verified feature/);
    assert.match(content, /description: Read the tool lifecycle and reducer integration/);
    assert.match(content, /Blocked: Missing test credentials/);
    assert.match(content, /✓ 1\. Explore.*done when: Integration points are known.*result: Found the required APIs/);
    assert.match(content, /! 2\. Implement.*done when: The feature works/);
    assert.match(content, /○ 3\. Verify.*done when: All checks pass/);
    assert.match(content, /○ 4\. Document.*done when: Usage is documented/);
    assert.deepEqual(shown.details.state, blocked.details.state);

    await execute({ action: "resume" });
    await execute({ action: "advance", completions: [{}] });
    await execute({ action: "advance", completions: [{}] });
    const completed = await execute({ action: "advance", completions: [{ result: "Usage added" }] });
    const completedShow = await execute({ action: "show" });
    const completedContent = resultText(completedShow);
    assert.match(completedContent, /Todo 4\/4 done — completed/);
    assert.match(completedContent, /✓ 4\. Document.*result: Usage added/);
    assert.deepEqual(completedShow.details.state, completed.details.state);
  }
});

test("rejected Todo calls are reported as tool errors and keep the previous snapshot", async () => {
  const harness = createHarness("tui");
  await handler(harness, "session_start")({ reason: "startup" }, harness.ctx);
  const planned = await executePlan(harness);

  const rejected = await harness.tool.execute(
    "call-2",
    { action: "plan", title: "Start other work", goal: "Second plan", tasks: [{ title: "Other" }] },
    undefined,
    undefined,
    harness.ctx,
  );
  assert.equal(rejected.isError, true);
  assert.match(String((rejected.content[0] as { text?: string }).text), /Todo error: PLAN_ALREADY_ACTIVE/);
  assert.ok(rejected.details.error);
  assert.equal(rejected.details.state?.planId, planned.state?.planId);
  assert.equal(rejected.details.state?.revision, planned.state?.revision);
  assert.match(resultText(rejected), /Goal: Wire the extension/);
  assert.match(resultText(rejected), /Current: Implement/);
});

async function boundary(
  harness: Harness,
  outcome: "completed" | "aborted" | "error" = "completed",
  entries: any[] = [],
): Promise<{ entries: any[]; continue?: boolean } | undefined> {
  return handler(harness, "agent_before_settle")(
    { type: "agent_before_settle", outcome, entries, continue: false, context: { canContinue: false } },
    harness.ctx,
  );
}

async function stopRun(
  harness: Harness,
  outcome: "completed" | "aborted" | "error" = "completed",
): Promise<{ entries: any[]; continue?: boolean } | undefined> {
  await handler(harness, "agent_end")(
    { messages: [assistant(outcome === "completed" ? "stop" : outcome)] },
    harness.ctx,
  );
  return boundary(harness, outcome);
}

function lastWidgetLines(harness: Harness): string {
  const factory = harness.widgets.at(-1) as
    | ((tui: unknown, theme: any) => { render(width: number): string[] })
    | undefined;
  assert.ok(factory, "expected a widget render factory");
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
  return factory({}, theme).render(120).join("\n");
}

test("agent_before_settle auto-continues once per stage and then warns", async () => {
  const harness = createHarness("tui");
  await handler(harness, "session_start")({ reason: "startup" }, harness.ctx);
  await executePlan(harness);

  const first = await stopRun(harness);
  assert.ok(first, "the first stop should continue the run");
  assert.equal(first.continue, true);
  assert.equal(first.entries.length, 1);
  const draft = first.entries[0]!;
  assert.equal(draft.type, "custom_message");
  assert.equal(draft.customType, TODO_AUTO_CONTINUE_CUSTOM_TYPE);
  assert.equal(draft.display, false);
  assert.match(draft.content, /Goal: Wire the extension/);
  assert.match(draft.content, /Current: Implement/);
  assert.match(draft.content, /latest user request/);
  assert.deepEqual(JSON.parse(draft.details.stageKey), ["linear-todo-nudge", 1, draft.details.planId, 0, 0]);

  const second = await stopRun(harness);
  assert.equal(second, undefined, "the same stage must not nudge twice");
  await handler(harness, "agent_settled")({}, harness.ctx);
  assert.match(lastWidgetLines(harness), /提前停止/);
});

test("block and resume re-open auto continuation for the resumed stage", async () => {
  const harness = createHarness("tui");
  await handler(harness, "session_start")({ reason: "startup" }, harness.ctx);
  await executePlan(harness);

  const first = await stopRun(harness);
  assert.ok(first);
  const firstStageKey = first.entries[0]!.details.stageKey;

  await harness.tool.execute("block-call", { action: "block", reason: "Waiting on credentials" }, undefined, undefined, harness.ctx);
  const resumed = await harness.tool.execute("resume-call", { action: "resume" }, undefined, undefined, harness.ctx);
  assert.equal(resumed.details.state?.cursor, 0);

  const second = await stopRun(harness);
  assert.ok(second, "resume must regain one auto-continue attempt");
  assert.equal(second.continue, true);
  assert.equal(second.entries.length, 1);
  assert.notEqual(second.entries[0]!.details.stageKey, firstStageKey);

  await handler(harness, "agent_settled")({}, harness.ctx);
  assert.doesNotMatch(lastWidgetLines(harness), /提前停止/);
});

test("a repeated boundary in the same stage is deduplicated without a message_end", async () => {
  const harness = createHarness("tui");
  await handler(harness, "session_start")({ reason: "startup" }, harness.ctx);
  await executePlan(harness);

  const first = await boundary(harness);
  assert.ok(first);
  assert.equal(first.continue, true);

  // Boundary drafts never produce a message_end, so the ledger must already be marked.
  const repeat = await boundary(harness);
  assert.equal(repeat, undefined);
  await handler(harness, "agent_settled")({}, harness.ctx);
  assert.match(lastWidgetLines(harness), /提前停止/);
});

test("clear exits persisted compatibility protection before a new plan", async () => {
  const harness = createHarness("tui");
  harness.setBranch([
    {
      type: "message",
      id: "future",
      parentId: null,
      timestamp: new Date(1_000).toISOString(),
      message: {
        role: "toolResult",
        toolCallId: "future-call",
        toolName: "todo",
        content: [{ type: "text", text: "future" }],
        details: {
          action: "show",
          state: null,
          transition: "protected",
          error: "future state",
          compatibilityError: "future state",
        },
        isError: false,
        timestamp: 1_000,
      },
    },
  ]);
  await handler(harness, "session_start")({ reason: "startup" }, harness.ctx);

  const rejected = await harness.tool.execute("blocked-call", { action: "advance", completions: [{}] }, undefined, undefined, harness.ctx);
  assert.equal(rejected.isError, true);
  assert.match(rejected.details.compatibilityError ?? "", /future state/);

  const cleared = await harness.tool.execute("clear-call", { action: "clear" }, undefined, undefined, harness.ctx);
  assert.equal(cleared.details.state, null);
  const planned = await executePlan(harness);
  assert.equal(planned.state?.planId.length, 36);
});

test("JSON and Print modes keep the tool usable but never auto-continue", async () => {
  for (const mode of ["json", "print"] as const) {
    const harness = createHarness(mode);
    await handler(harness, "session_start")({ reason: "startup" }, harness.ctx);
    await executePlan(harness);
    await handler(harness, "agent_end")({ messages: [assistant("stop")] }, harness.ctx);
    const result = await stopRun(harness);
    assert.equal(result, undefined, `${mode} should not continue the run`);
    await handler(harness, "agent_settled")({}, harness.ctx);
  }
});

test("TUI and RPC publish the same plan panel window without changing task state", async () => {
  for (const mode of ["tui", "rpc"] as const) {
    const harness = createHarness(mode);
    await handler(harness, "session_start")({}, harness.ctx);
    await harness.tool.execute("panel-plan", {
      action: "plan", title: "重构缓存", goal: "重构缓存",
      tasks: ["梳理现状", "定义缓存键", "实现缓存失效", "补充回归测试", "验证兼容性", "更新说明", "检查交付"].map((title) => ({ title })),
    }, undefined, undefined, harness.ctx);
    const panel = () => mode === "tui" ? lastWidgetLines(harness) : (harness.widgets.at(-1) as string[]).join("\n");
    assert.match(panel(), mode === "tui" ? /重构缓存（0\/7）/ : /计划：重构缓存 · 0\/7/);
    assert.match(panel(), /另有 4 项待办/);
    const advanced = await harness.tool.execute("panel-advance", {
      action: "advance", completions: [{}, {}, {}],
    }, undefined, undefined, harness.ctx);
    const expected = [
      "计划：重构缓存 · 3/7",
      "  … 较早已完成 1 项",
      "  ✓ 定义缓存键",
      "  ✓ 实现缓存失效",
      "  → 补充回归测试",
      "  ○ 验证兼容性",
      "  ○ 更新说明",
      "  … 另有 1 项待办",
    ];
    const assertPanel = (raw: string[]) => {
      if (mode === "rpc") { assert.equal(panel(), raw.join("\n")); return; }
      const lines = panel().split("\n");
      assert.deepEqual(lines, raw.map((line, index) => {
        const prefix = index === 0 ? "╭─ " : index === raw.length - 1 ? "╰─ " : "│  ";
        const content = index === 0
          ? line.replace(/^计划：/, "").replace(/ · (\d+\/\d+)$/, "（$1）")
          : line.slice(2).replace(/^… (另有 )/, "$1");
        return prefix + content;
      }));
      assert.equal(lines.length, raw.length);
      assert.ok(lines.every((line) => !/[╮╯]/.test(line)));
    };
    assertPanel(expected);
    await harness.commands.get("todos")!.handler("pause", harness.ctx);
    assertPanel([...expected, "  ! 自动续跑已暂停 · /todos resume"]);
    const shown = await harness.tool.execute("panel-read-state", { action: "show" }, undefined, undefined, harness.ctx);
    assert.deepEqual(shown.details.state, advanced.details.state);
    await harness.tool.execute("panel-finish", {
      action: "advance", completions: [{}, {}, {}, {}],
    }, undefined, undefined, harness.ctx);
    const completed = [
      "计划：重构缓存 · 7/7",
      "  … 较早已完成 5 项",
      "  ✓ 更新说明",
      "  ✓ 检查交付",
    ];
    assertPanel(completed);
    assert.doesNotMatch(panel(), /自动续跑已暂停|提前停止|→|○|另有/);
    await handler(harness, "agent_settled")({}, harness.ctx);
    assert.equal(harness.widgets.at(-1), undefined, "settlement must release the completed widget");
    assert.equal(harness.statuses.at(-1), undefined);
  }
});

test("a settled completed plan hides its widget while keeping state available for show, undo and recovery", async () => {
  for (const mode of ["tui", "rpc"] as const) {
    const harness = createHarness(mode);
    await handler(harness, "session_start")({ reason: "startup" }, harness.ctx);
    assert.equal(harness.widgets.at(-1), undefined, "a null plan has no widget");
    await executePlan(harness);
    assert.ok(harness.widgets.at(-1), `${mode}: an active plan must show a widget`);
    if (mode === "tui") {
      // The widget already carries progress and phase; the footer stays free for other extensions.
      assert.deepEqual(harness.statuses, [], "tui must not duplicate the widget in the status bar");
    } else {
      assert.equal(harness.statuses.at(-1), "todo 0/2 done", "rpc clients may ignore widgets");
    }

    assert.equal((await stopRun(harness))?.continue, true);
    assert.equal(await stopRun(harness), undefined);
    await handler(harness, "agent_settled")({}, harness.ctx);
    const earlyPanel = mode === "tui" ? lastWidgetLines(harness) : (harness.widgets.at(-1) as string[]).join("\n");
    assert.match(earlyPanel, /提前停止/);

    await harness.tool.execute("advance-1", { action: "advance", completions: [{ result: "Implemented" }] }, undefined, undefined, harness.ctx);
    assert.ok(harness.widgets.at(-1), `${mode}: the second task keeps the widget`);

    await harness.tool.execute("advance-2", { action: "advance", completions: [{ result: "Verified" }] }, undefined, undefined, harness.ctx);
    const panel = () => mode === "tui" ? lastWidgetLines(harness) : (harness.widgets.at(-1) as string[]).join("\n");
    const completedPanel = panel();
    assert.match(completedPanel, mode === "tui" ? /Wire the extension（2\/2）/ : /计划：Wire the extension · 2\/2/);
    assert.match(completedPanel, /✓ Implement/);
    assert.match(completedPanel, /✓ Verify/);
    assert.doesNotMatch(completedPanel, /自动续跑已暂停|提前停止|→|○/);
    assert.equal(harness.statuses.at(-1), undefined, `${mode}: a completed plan must clear the status`);

    assert.equal(await stopRun(harness), undefined, "completion must not auto-continue");
    assert.equal(panel(), completedPanel, "the completing run keeps its final progress until settlement");
    await handler(harness, "agent_settled")({}, harness.ctx);
    assert.equal(harness.widgets.at(-1), undefined, "agent_settled must release a completed widget");
    assert.equal(harness.statuses.at(-1), undefined);

    const shown = await harness.tool.execute("show-done", { action: "show" }, undefined, undefined, harness.ctx);
    assert.match(resultText(shown), /Todo 2\/2 done — completed/);
    assert.equal(harness.widgets.at(-1), undefined, "a read-only show must not revive the settled widget");
    harness.setBranch([{
      type: "message", message: { role: "toolResult", toolName: "todo", details: shown.details, isError: false },
    }]);
    for (const event of ["session_start", "session_tree", "session_compact"]) {
      await handler(harness, event)({}, harness.ctx);
      assert.equal(harness.widgets.at(-1), undefined, `${event}: recovered completed plans stay hidden`);
      assert.equal(harness.statuses.at(-1), undefined);
    }

    const undone = await harness.tool.execute("undo-completed", { action: "undo" }, undefined, undefined, harness.ctx);
    assert.equal(undone.details.state?.phase, "active");
    assert.ok(harness.widgets.at(-1), `${mode}: undo must re-arm the widget`);
    assert.match(panel(), /→ Verify/);
    if (mode === "rpc") assert.equal(harness.statuses.at(-1), "todo 1/2 done");

    const recompleted = await harness.tool.execute("recomplete", { action: "advance", completions: [{}] }, undefined, undefined, harness.ctx);
    assert.equal(recompleted.details.state?.phase, "completed");
    await handler(harness, "agent_settled")({}, harness.ctx);
    assert.equal(harness.widgets.at(-1), undefined);

    const replacement = await harness.tool.execute("replace-done", {
      action: "plan", title: "Ship the next change", goal: "Ship another change", tasks: [{ title: "Review next change" }],
    }, undefined, undefined, harness.ctx);
    assert.notEqual(replacement.isError, true);
    assert.notEqual(replacement.details.state?.planId, shown.details.state?.planId);
    assert.match(panel(), /Ship the next change/);
    assert.match(panel(), /→ Review next change/);
    assert.doesNotMatch(panel(), /Wire the extension|✓ Implement|✓ Verify/);
    await harness.tool.execute("clear-replacement", { action: "clear" }, undefined, undefined, harness.ctx);
    assert.equal(harness.widgets.at(-1), undefined, "clear must hide the widget");
    assert.equal(harness.statuses.at(-1), undefined);

    await handler(harness, "session_tree")({}, harness.ctx);
    assert.equal(harness.widgets.at(-1), undefined, "selecting the completed branch must keep its widget hidden");
    await harness.tool.execute("clear-completed", { action: "clear" }, undefined, undefined, harness.ctx);
    assert.equal(harness.widgets.at(-1), undefined, "clear must also hide a completed plan");
    assert.equal(harness.statuses.at(-1), undefined);
    harness.setBranch([]);
    await handler(harness, "session_tree")({}, harness.ctx);
    assert.equal(harness.widgets.at(-1), undefined, "a null recovered plan must hide the widget");
  }
});

test("a settled completed plan stays hidden through replacement undo and aborted stops", async () => {
  for (const mode of ["tui", "rpc"] as const) {
    const harness = createHarness(mode);
    await handler(harness, "session_start")({ reason: "startup" }, harness.ctx);
    const planned = await executePlan(harness);
    const execute = (input: TodoInput) => harness.tool.execute("lifecycle", input, undefined, undefined, harness.ctx);
    await execute({ action: "advance", completions: [{}] });
    const completed = await execute({ action: "advance", completions: [{}] });
    assert.equal(completed.details.state?.phase, "completed");
    assert.ok(harness.widgets.at(-1), `${mode}: completed progress stays visible during the run`);
    assert.equal(harness.statuses.at(-1), undefined);

    await stopRun(harness, "aborted");
    await handler(harness, "agent_settled")({ aborted: true }, harness.ctx);
    assert.equal(harness.widgets.at(-1), undefined, `${mode}: an aborted settlement releases the completed widget`);
    assert.equal(harness.statuses.at(-1), undefined);

    const rejected = await execute({ action: "insert", tasks: [{ title: "Late" }] });
    assert.equal(rejected.isError, true);
    assert.equal(harness.widgets.at(-1), undefined, `${mode}: a rejected mutation must not revive the widget`);

    const replacement = await execute({
      action: "plan", title: "Replacement plan", goal: "Replacement plan", tasks: [{ title: "Replacement task" }],
    });
    assert.equal(replacement.isError, undefined);
    assert.notEqual(replacement.details.state?.planId, planned.state?.planId);
    assert.ok(harness.widgets.at(-1), `${mode}: the new active plan owns the widget`);

    const restored = await execute({ action: "undo" });
    assert.equal(restored.details.state?.phase, "completed");
    assert.equal(restored.details.state?.planId, planned.state?.planId);
    assert.equal(harness.widgets.at(-1), undefined, `${mode}: undoing the replacement must not revive the settled completion`);
    assert.equal(harness.statuses.at(-1), undefined);
  }
});

test("a replan that completes remaining work keeps the widget until settlement", async () => {
  for (const mode of ["tui", "rpc"] as const) {
    const harness = createHarness(mode);
    await handler(harness, "session_start")({ reason: "startup" }, harness.ctx);
    await executePlan(harness);
    const execute = (input: TodoInput) => harness.tool.execute("replan-lifecycle", input, undefined, undefined, harness.ctx);
    await execute({ action: "advance", completions: [{}] });
    const completed = await execute({
      action: "replan", reason: "The remaining work is no longer required", tasks: [],
    });
    assert.equal(completed.details.state?.phase, "completed");
    assert.equal(completed.details.state?.items.length, 1);
    assert.ok(harness.widgets.at(-1), `${mode}: a replan completion stays visible during the run`);
    const panel = mode === "tui" ? lastWidgetLines(harness) : (harness.widgets.at(-1) as string[]).join("\n");
    assert.match(panel, mode === "tui" ? /Wire the extension（1\/1）/ : /计划：Wire the extension · 1\/1/);
    assert.equal(harness.statuses.at(-1), undefined);

    await handler(harness, "agent_settled")({}, harness.ctx);
    assert.equal(harness.widgets.at(-1), undefined, `${mode}: settlement releases the replan completion`);
    assert.equal(harness.statuses.at(-1), undefined);

    const undone = await execute({ action: "undo" });
    assert.equal(undone.details.state?.phase, "active");
    assert.ok(harness.widgets.at(-1), `${mode}: undo re-arms the restored active plan`);
    if (mode === "rpc") assert.equal(harness.statuses.at(-1), "todo 1/2 done");
  }
});

test("the rpc fallback status mirrors progress, pause and blocking", async () => {
  const harness = createHarness("rpc");
  await handler(harness, "session_start")({ reason: "startup" }, harness.ctx);
  await executePlan(harness);

  const command = harness.commands.get("todos")!;
  await command.handler("pause", harness.ctx);
  assert.equal(harness.statuses.at(-1), "todo 0/2 done paused");
  await command.handler("resume", harness.ctx);
  assert.equal(harness.statuses.at(-1), "todo 0/2 done");

  await harness.tool.execute("block-call", { action: "block", reason: "Waiting" }, undefined, undefined, harness.ctx);
  assert.equal(harness.statuses.at(-1), "todo 0/2 done · blocked");
});

test("/todos pause stops auto-continue until resume", async () => {
  const harness = createHarness("tui");
  await handler(harness, "session_start")({ reason: "startup" }, harness.ctx);
  await executePlan(harness);

  const command = harness.commands.get("todos");
  assert.ok(command, "expected the /todos command");
  await command.handler("pause", harness.ctx);
  assert.equal(await stopRun(harness), undefined, "a paused plan must not auto-continue");
  assert.match(lastWidgetLines(harness), /自动续跑已暂停/);

  await command.handler("resume", harness.ctx);
  const resumed = await stopRun(harness);
  assert.equal(resumed?.continue, true);
});

test("pausing a consumed correction suppresses the early-stop warning without refunding it", async () => {
  for (const mode of ["tui", "rpc"] as const) {
    const harness = createHarness(mode);
    await handler(harness, "session_start")({}, harness.ctx);
    const planned = await executePlan(harness);
    assert.equal((await stopRun(harness))?.continue, true);
    const command = harness.commands.get("todos")!;
    await command.handler("pause", harness.ctx);
    assert.equal(await stopRun(harness), undefined);
    await handler(harness, "agent_settled")({}, harness.ctx);
    const paused = await harness.tool.execute("show-paused", { action: "show" }, undefined, undefined, harness.ctx);
    assert.match(resultText(paused), /Auto-continue paused/);
    assert.doesNotMatch(resultText(paused), /Warning: agent stopped/);
    assert.deepEqual(paused.details.state, planned.state);
    if (mode === "tui") assert.doesNotMatch(lastWidgetLines(harness), /提前停止/);

    await command.handler("resume", harness.ctx);
    assert.equal(await stopRun(harness), undefined, "a user control must not refund the consumed correction");
    const stopped = await harness.tool.execute("show-stopped", { action: "show" }, undefined, undefined, harness.ctx);
    assert.match(resultText(stopped), /Warning: agent stopped/);
  }
});

test("normal-stop warnings are cleared for errors, aborts, deferral and queued input", async () => {
  for (const reason of ["error", "aborted", "deferred", "pending"] as const) {
    const harness = createHarness("tui");
    await handler(harness, "session_start")({}, harness.ctx);
    await executePlan(harness);
    await stopRun(harness);
    await stopRun(harness);
    const before = await harness.tool.execute("show-warning", { action: "show" }, undefined, undefined, harness.ctx);
    assert.match(resultText(before), /Warning: agent stopped/);

    if (reason === "pending") {
      harness.ctx.hasPendingMessages = () => true;
      await stopRun(harness);
    } else {
      const message = reason === "deferred" ? { ...assistant("stop"), stopReason: "deferred" } : assistant(reason);
      await handler(harness, "agent_end")({ messages: [message] }, harness.ctx);
      assert.equal(await boundary(harness, reason === "deferred" ? "completed" : reason === "aborted" ? "aborted" : "error"), undefined);
    }
    await handler(harness, "agent_settled")({}, harness.ctx);
    assert.doesNotMatch(lastWidgetLines(harness), /提前停止/, reason);
    const after = await harness.tool.execute("show-normal-stop", { action: "show" }, undefined, undefined, harness.ctx);
    assert.doesNotMatch(resultText(after), /Warning: agent stopped/, reason);
  }
});

test("/todos pause and resume take effect without waiting for the running agent", async () => {
  const harness = createHarness("tui");
  await handler(harness, "session_start")({}, harness.ctx);
  await executePlan(harness);
  let releaseIdle!: () => void;
  const idle = new Promise<void>((resolve) => { releaseIdle = resolve; });
  let idleWaits = 0;
  const busyContext = {
    ...harness.ctx,
    waitForIdle: () => { idleWaits += 1; return idle; },
  };
  const command = harness.commands.get("todos")!;
  const pause = command.handler("pause", busyContext);
  try {
    assert.equal(await stopRun(harness), undefined, "pause must prevent the next continuation while still busy");
    await pause;
    assert.match(lastWidgetLines(harness), /自动续跑已暂停/);
    await command.handler("resume", busyContext);
    assert.equal((await stopRun(harness))?.continue, true, "resume must also take effect immediately");
    assert.equal(idleWaits, 0);
  } finally {
    releaseIdle();
    await pause;
  }
});

test("paused control is visible to the model without asking it to run user commands", async () => {
  const harness = createHarness("rpc");
  await handler(harness, "session_start")({}, harness.ctx);
  const planned = await executePlan(harness);
  await harness.commands.get("todos")!.handler("pause", harness.ctx);
  const shown = await harness.tool.execute("show-paused", { action: "show" }, undefined, undefined, harness.ctx);
  assert.match(resultText(shown), /Auto-continue paused/);
  assert.doesNotMatch(resultText(shown), /Run \/todos/);
  assert.deepEqual(shown.details.state, planned.state);
  await handler(harness, "before_agent_start")({ messageType: "user", prompt: "Explain the issue" }, harness.ctx);
  const context = await handler(harness, "context")({ messages: [] }, harness.ctx);
  assert.match(context.messages[0].content, /Auto-continue: paused/);
  assert.equal(await stopRun(harness), undefined);
});

test("/todos opens its snapshot immediately and closing it does not undo background progress", async () => {
  for (const args of ["", "list", "show"]) {
    const harness = createHarness("tui");
    await handler(harness, "session_start")({}, harness.ctx);
    await executePlan(harness);
    let releaseIdle!: () => void;
    let close!: () => void;
    const idle = new Promise<void>((resolve) => { releaseIdle = resolve; });
    const closed = new Promise<void>((resolve) => { close = resolve; });
    let idleWaits = 0;
    const view: { component?: Component } = {};
    const context = {
      ...harness.ctx,
      waitForIdle: () => { idleWaits += 1; return idle; },
      ui: {
        ...harness.ctx.ui,
        custom: async (factory: any) => {
          view.component = factory({ requestRender: () => undefined }, harness.ctx.ui.theme, undefined, close);
          await closed;
        },
      },
    };
    const listing = harness.commands.get("todos")!.handler(args, context);
    try {
      assert.equal(idleWaits, 0, "inspection must not wait for the agent");
      assert.ok(view.component, "the list must open before idle resolves");
      const openedSnapshot = view.component.render(120).join("\n");
      assert.match(openedSnapshot, /Todo 0\/2 done/);
      const advanced = await harness.tool.execute("background-progress", {
        action: "advance", completions: [{ result: "Background work finished" }],
      }, undefined, undefined, harness.ctx);
      assert.equal(advanced.details.state?.cursor, 1);
      const snapshotText = view.component.render(120).join("\n");
      assert.equal(snapshotText, openedSnapshot, "an open inspector must retain its original snapshot");
      assert.doesNotMatch(snapshotText, /Background work finished/);
      assert.ok(view.component.handleInput);
      view.component.handleInput("\u001b");
      await listing;
      const shown = await harness.tool.execute("after-list", { action: "show" }, undefined, undefined, harness.ctx);
      assert.deepEqual(shown.details.state, advanced.details.state);
    } finally {
      close();
      releaseIdle();
      await listing;
    }
  }
});

test("/todos navigation requests host redraws without mutating the saved plan", async () => {
  const harness = createHarness("tui");
  await handler(harness, "session_start")({}, harness.ctx);
  const planned = await harness.tool.execute("scroll-plan", {
    action: "plan", title: "Browse every task", goal: "Verify readonly navigation",
    tasks: Array.from({ length: 20 }, (_, index) => ({ title: `Task ${index + 1}` })),
  }, undefined, undefined, harness.ctx);
  let redraws = 0;
  let closed = 0;
  const context = {
    ...harness.ctx,
    ui: {
      ...harness.ctx.ui,
      custom: async (factory: any) => {
        const component = factory({ requestRender: () => { redraws += 1; } }, harness.ctx.ui.theme, undefined, () => { closed += 1; });
        component.render(120);
        component.handleInput("\u001b[F");
        assert.match(component.render(120).join("\n"), /20\. Task 20/);
        assert.ok(redraws > 0);
        component.handleInput("\u001b");
      },
    },
  };
  await harness.commands.get("todos")!.handler("", context);
  assert.equal(closed, 1);
  const shown = await harness.tool.execute("after-navigation", { action: "show" }, undefined, undefined, harness.ctx);
  assert.deepEqual(shown.details.state, planned.details.state);
});

test("/todos inspection does not wait in RPC, JSON or Print modes", async () => {
  for (const mode of ["rpc", "json", "print"] as const) {
    for (const args of ["", "list", "show"]) {
      const harness = createHarness(mode);
      await handler(harness, "session_start")({}, harness.ctx);
      const planned = await executePlan(harness);
      const notifications: string[] = [];
      const context = {
        ...harness.ctx,
        waitForIdle: async () => { throw new Error("inspection must never wait for idle"); },
        ui: {
          ...harness.ctx.ui,
          notify: (text: string) => { notifications.push(text); },
          custom: async () => { throw new Error("terminal UI is unavailable in this mode"); },
        },
      };
      await harness.commands.get("todos")!.handler(args, context);
      if (mode === "rpc") {
        assert.equal(notifications.length, 1);
        assert.match(notifications[0]!, /Todo 0\/2 done/);
      } else {
        assert.deepEqual(notifications, []);
      }
      const shown = await harness.tool.execute("inspection-state", { action: "show" }, undefined, undefined, harness.ctx);
      assert.deepEqual(shown.details.state, planned.state);
    }
  }
});

test("RPC /todos inspection returns every task and full details without interactive clipping", async () => {
  const harness = createHarness("rpc");
  await handler(harness, "session_start")({}, harness.ctx);
  const tasks = Array.from({ length: 16 }, (_, index) => ({
    title: `Stage ${index + 1}`,
    description: `Complete execution details for stage ${index + 1}: ${"required context ".repeat(10)}End.`,
    doneWhen: `Acceptance for stage ${index + 1}`,
  }));
  const planned = await harness.tool.execute("long-plan", {
    action: "plan", title: "Inspect the full plan", goal: "Keep all execution details readable", tasks,
  }, undefined, undefined, harness.ctx);
  const advanced = await harness.tool.execute("long-advance", {
    action: "advance", completions: [{ result: "First observed result" }, {}, {}],
  }, undefined, undefined, harness.ctx);
  assert.notEqual(planned.isError, true);
  assert.notEqual(advanced.isError, true);
  const notifications: string[] = [];
  const context = {
    ...harness.ctx,
    waitForIdle: async () => { throw new Error("inspection must not wait"); },
    ui: {
      ...harness.ctx.ui,
      notify: (text: string) => { notifications.push(text); },
      custom: async () => { throw new Error("RPC inspection must not open a terminal component"); },
    },
  };
  for (const args of ["", "list", "show"]) {
    await harness.commands.get("todos")!.handler(args, context);
    const text = notifications.at(-1)!;
    assert.match(text, /Todo 3\/16 done/);
    assert.match(text, /First observed result/);
    for (const task of tasks) {
      assert.ok(text.includes(task.title));
      assert.ok(text.includes(task.description), `inspection clipped ${task.title}'s description`);
      assert.ok(text.includes(task.doneWhen));
    }
  }
  assert.equal(notifications.length, 3);
  const shown = await harness.tool.execute("long-show", { action: "show" }, undefined, undefined, harness.ctx);
  assert.deepEqual(shown.details.state, advanced.details.state);
});

test("/todos rejects unknown arguments and still lists the plan", async () => {
  const harness = createHarness("rpc");
  await handler(harness, "session_start")({ reason: "startup" }, harness.ctx);
  await executePlan(harness);
  const command = harness.commands.get("todos")!;

  await command.handler("bogus", harness.ctx);
  await command.handler("", harness.ctx);
  await command.handler("list", harness.ctx);
});

test("plan edits and undo do not re-arm correction at an already nudged position", async () => {
  const insert: TodoInput = { action: "insert", tasks: [{ title: "Review" }] };
  const replan: TodoInput = {
    action: "replan", title: "Revise the implementation", goal: "A revised goal", reason: "Refined approach", tasks: [{ title: "Patch" }, { title: "Check" }],
  };
  const cases: TodoInput[][] = [
    [replan], [insert], [{ ...insert, position: "end" }],
    [insert, { action: "undo" }], [replan, { action: "undo" }],
    [{ action: "block", reason: "Need a fixture" }, { action: "undo" }],
    [{ action: "block", reason: "Need a fixture" }, replan],
  ];
  for (const edits of cases) {
    const harness = createHarness("tui");
    await handler(harness, "session_start")({}, harness.ctx);
    await executePlan(harness);
    assert.equal((await stopRun(harness))?.continue, true);
    for (const input of edits) {
      const result = await harness.tool.execute("edit", input, undefined, undefined, harness.ctx);
      assert.notEqual(result.isError, true);
      assert.equal(result.details.state?.cursor, 0);
    }
    assert.equal(await stopRun(harness), undefined, JSON.stringify(edits));
    await handler(harness, "agent_settled")({}, harness.ctx);
    assert.match(lastWidgetLines(harness), /提前停止/);
  }
});

test("task completion opens the next correction but undo never refunds a spent position", async () => {
  const harness = createHarness("tui");
  await handler(harness, "session_start")({}, harness.ctx);
  await executePlan(harness);
  assert.equal((await stopRun(harness))?.continue, true);
  await harness.tool.execute("advance", { action: "advance", completions: [{ result: "Implemented" }] }, undefined, undefined, harness.ctx);
  assert.equal((await stopRun(harness))?.continue, true, "a newly reached task has its own allowance");
  await harness.tool.execute("undo", { action: "undo" }, undefined, undefined, harness.ctx);
  assert.equal(await stopRun(harness), undefined, "undo must not refund the previous position");
});

test("explicit block/resume grants bounded recovery even if the resumed plan is edited", async () => {
  const harness = createHarness("tui");
  await handler(harness, "session_start")({}, harness.ctx);
  await executePlan(harness);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.equal((await stopRun(harness))?.continue, true, `attempt ${attempt + 1}`);
    await harness.tool.execute("block", { action: "block", reason: "Need a fixture" }, undefined, undefined, harness.ctx);
    await harness.tool.execute("resume", { action: "resume" }, undefined, undefined, harness.ctx);
    await harness.tool.execute("edit", {
      action: "replan", reason: "Refined approach", tasks: [{ title: "Implement" }, { title: "Verify" }],
    }, undefined, undefined, harness.ctx);
  }
  assert.equal(await stopRun(harness), undefined, "even explicit resumes cannot exceed the positional cap");
});

test("failed resume, user input and user pause controls do not replenish corrections", async () => {
  const harness = createHarness("tui");
  await handler(harness, "session_start")({}, harness.ctx);
  await executePlan(harness);
  assert.equal((await stopRun(harness))?.continue, true);
  const rejected = await harness.tool.execute("resume", { action: "resume" }, undefined, undefined, harness.ctx);
  assert.equal(rejected.isError, true);
  await handler(harness, "before_agent_start")({ messageType: "user", prompt: "Continue" }, harness.ctx);
  await harness.commands.get("todos")!.handler("pause", harness.ctx);
  await harness.commands.get("todos")!.handler("resume", harness.ctx);
  assert.equal(await stopRun(harness), undefined);
});

test("insert adds a task without moving the cursor and undo reverts it", async () => {
  const harness = createHarness("tui");
  await handler(harness, "session_start")({ reason: "startup" }, harness.ctx);
  await executePlan(harness);

  const inserted = await harness.tool.execute(
    "insert-1",
    { action: "insert", tasks: [{ title: "Hotfix" }] },
    undefined,
    undefined,
    harness.ctx,
  );
  assert.equal(inserted.details.state?.cursor, 0);
  assert.deepEqual(
    inserted.details.state?.items.map((item) => item.title),
    ["Implement", "Hotfix", "Verify"],
  );

  const undone = await harness.tool.execute("undo-1", { action: "undo" }, undefined, undefined, harness.ctx);
  assert.deepEqual(
    undone.details.state?.items.map((item) => item.title),
    ["Implement", "Verify"],
  );
  assert.ok((undone.details.state?.revision ?? 0) > (inserted.details.state?.revision ?? 0));
});

test("advance rejects tasks instead of silently ignoring them", async () => {
  const harness = createHarness("tui");
  await handler(harness, "session_start")({ reason: "startup" }, harness.ctx);
  await executePlan(harness);

  const rejected = await harness.tool.execute(
    "advance-with-tasks",
    { action: "advance", tasks: [{ title: "Urgent" }], completions: [{}] },
    undefined,
    undefined,
    harness.ctx,
  );
  assert.equal(rejected.isError, true);
  assert.match(String((rejected.content[0] as { text?: string }).text), /INVALID_INPUT.*insert/s);
  assert.equal(rejected.details.state?.cursor, 0);
  assert.equal(rejected.details.state?.items.length, 2);
});

test("branch recovery and compaction restore the current acceptance context in every mode", async () => {
  for (const mode of ["tui", "rpc", "json", "print"] as const) {
    const harness = createHarness(mode);
    await handler(harness, "session_start")({}, harness.ctx);
    const planned = await harness.tool.execute("plan", {
      action: "plan", title: "Ship the verified fix", goal: "Ship the verified fix",
      tasks: [{ title: "Implement", description: "Repair the boundary", doneWhen: "The case passes" }, { title: "Verify", description: "Run unit and integration checks", doneWhen: "All checks pass" }],
    }, undefined, undefined, harness.ctx);
    const advanced = await harness.tool.execute("advance", { action: "advance", completions: [{ result: "Fixed the case" }] }, undefined, undefined, harness.ctx);
    harness.setBranch([planned, advanced].map((result) => ({
      type: "message", message: { role: "toolResult", toolName: "todo", details: result.details, isError: false },
    })));
    await handler(harness, "session_tree")({}, harness.ctx);
    for (const restoredBy of ["tree", "compaction"]) {
      if (restoredBy === "compaction") await handler(harness, "session_compact")({}, harness.ctx);
      const context = await handler(harness, "context")({ messages: [] }, harness.ctx);
      const text = context.messages[0].content;
      assert.match(text, /Plan: Ship the verified fix/);
      assert.match(text, /Goal: Ship the verified fix/);
      assert.match(text, /Description: Run unit and integration checks/);
      assert.match(text, /Done when: All checks pass/);
      assert.match(text, /\[>\] Verify/);
      assert.doesNotMatch(text, /Fixed the case/);
      assert.equal(await handler(harness, "context")({ messages: [] }, harness.ctx), undefined, "recovery reminder is consumed once");
    }
    const shown = await harness.tool.execute("show", { action: "show" }, undefined, undefined, harness.ctx);
    assert.deepEqual(shown.details.state, advanced.details.state);
  }
});

test("only a user turn arms the next context reminder", async () => {
  const harness = createHarness("tui");
  await handler(harness, "session_start")({ reason: "startup" }, harness.ctx);
  await executePlan(harness);
  // Consume the suppression that follows a Todo tool result.
  assert.equal(await handler(harness, "context")({ messages: [] }, harness.ctx), undefined);

  await handler(harness, "before_agent_start")(
    { type: "before_agent_start", messageType: "custom", message: { customType: "x", content: "continue" } },
    harness.ctx,
  );
  assert.equal(
    await handler(harness, "context")({ messages: [] }, harness.ctx),
    undefined,
    "an auto-continue run must not be treated as a fresh user turn",
  );

  await handler(harness, "before_agent_start")(
    { type: "before_agent_start", messageType: "user", prompt: "keep going" },
    harness.ctx,
  );
  const reminded = await handler(harness, "context")({ messages: [] }, harness.ctx);
  assert.match(String(reminded.messages[0].content), /Current: Implement/);
});

test("a new user turn clears the early-stop warning", async () => {
  const harness = createHarness("tui");
  await handler(harness, "session_start")({ reason: "startup" }, harness.ctx);
  await executePlan(harness);

  assert.equal((await stopRun(harness))?.continue, true);
  assert.equal(await stopRun(harness), undefined);
  await handler(harness, "agent_settled")({}, harness.ctx);
  assert.match(lastWidgetLines(harness), /提前停止/);

  await handler(harness, "before_agent_start")(
    { type: "before_agent_start", messageType: "custom", message: { customType: "x", content: "continue" } },
    harness.ctx,
  );
  await handler(harness, "agent_settled")({}, harness.ctx);
  assert.match(lastWidgetLines(harness), /提前停止/, "custom runs keep the warning");

  await handler(harness, "before_agent_start")(
    { type: "before_agent_start", messageType: "user", prompt: "what now?" },
    harness.ctx,
  );
  await handler(harness, "agent_settled")({}, harness.ctx);
  assert.doesNotMatch(lastWidgetLines(harness), /提前停止/);
});
