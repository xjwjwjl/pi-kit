import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionCommandContextActions,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ScriptedStep } from "../e2e/scenario.ts";
import { SCRIPTED_MODEL } from "../e2e/scripted-provider.ts";
import { recoverTodoFromBranch, TODO_AUTO_CONTINUE_CUSTOM_TYPE } from "../state.ts";
import type { TodoToolDetails } from "../schema.ts";

const PROJECT_DIR = fileURLToPath(new URL("..", import.meta.url));
const PLAN = { action: "plan", title: "Implement and verify the change", goal: "Persist the direct plan", tasks: [{ title: "Implement", description: "Implement the requested behavior" }, { title: "Verify", description: "Run the existing regression suite" }] };

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function withScriptedSession(
  mode: "rpc" | "json",
  steps: ScriptedStep[],
  customTools: ToolDefinition[],
  verify: (session: AgentSession, manager: SessionManager, widgets: Array<string[] | undefined>) => Promise<void>,
): Promise<void> {
  const agentDir = await mkdtemp(join(tmpdir(), "linear-todo-sdk-regression-"));
  let session: AgentSession | undefined;
  try {
    const scenarioFile = join(agentDir, "scenario.json");
    await writeFile(scenarioFile, JSON.stringify({ schemaVersion: 1, scenarios: { regression: { prompt: "Run the regression.", steps } } }));
    const settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: false, maxRetries: 0 },
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd: agentDir,
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      additionalExtensionPaths: [join(PROJECT_DIR, "index.ts"), join(PROJECT_DIR, "e2e", "scripted-provider.ts")],
    });
    // The provider reads these only during loading. Tests in this file run sequentially;
    // restore the environment before starting a session or invoking any tools.
    const previousFile = process.env.LINEAR_TODO_E2E_SCENARIO_FILE;
    const previousScenario = process.env.LINEAR_TODO_E2E_SCENARIO;
    process.env.LINEAR_TODO_E2E_SCENARIO_FILE = scenarioFile;
    process.env.LINEAR_TODO_E2E_SCENARIO = "regression";
    try {
      await resourceLoader.reload();
    } finally {
      if (previousFile === undefined) delete process.env.LINEAR_TODO_E2E_SCENARIO_FILE;
      else process.env.LINEAR_TODO_E2E_SCENARIO_FILE = previousFile;
      if (previousScenario === undefined) delete process.env.LINEAR_TODO_E2E_SCENARIO;
      else process.env.LINEAR_TODO_E2E_SCENARIO = previousScenario;
    }

    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
    });
    const manager = SessionManager.inMemory(agentDir);
    const created = await createAgentSession({
      cwd: agentDir,
      agentDir,
      settingsManager,
      modelRuntime,
      model: SCRIPTED_MODEL,
      thinkingLevel: "off",
      tools: ["todo", ...customTools.map((tool) => tool.name)],
      customTools,
      resourceLoader,
      sessionManager: manager,
    });
    session = created.session;
    assert.deepEqual(created.extensionsResult.errors, []);
    const unsupported = async (): Promise<never> => { throw new Error("Session navigation is not used in this test"); };
    const commandContextActions: ExtensionCommandContextActions = {
      waitForIdle: () => created.session.waitForIdle(),
      newSession: unsupported,
      fork: unsupported,
      navigateTree: unsupported,
      switchSession: unsupported,
      reload: unsupported,
    };
    await session.bindExtensions({ mode, commandContextActions });
    const widgets: Array<string[] | undefined> = [];
    if (mode === "rpc") {
      const runner = session.extensionRunner;
      runner.setUIContext({
        ...runner.getUIContext(),
        setWidget: (_key, content) => {
          assert.ok(content === undefined || Array.isArray(content), "RPC widgets must be text lines");
          widgets.push(content);
        },
      }, mode);
    }
    await verify(session, manager, widgets);
  } finally {
    if (session) {
      await session.abort();
      session.dispose();
    }
    await rm(agentDir, { recursive: true, force: true });
  }
}

test("SDK preserves plan and task titles plus full descriptions through completion, undo and recovery", { timeout: 15_000 }, async () => {
  const fullGoal = "Inspect the complete repository scope and perform only verified low-risk fixes";
  const descriptions = ["Read the README and every script to build a complete capability inventory", "Run syntax and static checks and report any unavailable verification"];
  const titles = ["Inspect repository capabilities", "Verify repository checks"];
  const planTitle = "Inspect and verify the repository";
  for (const mode of ["json", "rpc"] as const) {
    await withScriptedSession(mode, [
      { type: "toolCall", name: "todo", arguments: {
        action: "plan", title: planTitle, goal: fullGoal,
        tasks: titles.map((title, index) => ({ title, description: descriptions[index]!, doneWhen: `Stage ${index + 1} is verified` })),
      } },
      { type: "toolCall", name: "todo", arguments: { action: "advance", completions: [{}] } },
      { type: "toolCall", name: "todo", arguments: { action: "undo" } },
      { type: "toolCall", name: "todo", arguments: { action: "advance", completions: [{}, {}] } },
      { type: "text", text: "Short title regression complete." },
    ], [], async (session, manager, widgets) => {
      await session.prompt("Complete the full scope while retaining the compact UI labels.");
      const branch = manager.getBranch();
      const states = branch.flatMap((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "todo"
        ? [(entry.message.details as unknown as TodoToolDetails).state!] : []);
      assert.equal(states.length, 4);
      for (const state of states) {
        assert.equal(state.schemaVersion, 3);
        assert.equal(state.goal, fullGoal);
        assert.notEqual(state.goal, planTitle, "the short plan title must never replace the full goal");
        assert.equal(state.title, planTitle);
        assert.deepEqual(state.items.map((item) => item.title), titles);
        assert.deepEqual(state.items.map((item) => item.description), descriptions);
        assert.deepEqual(state.items.map((item) => item.doneWhen), ["Stage 1 is verified", "Stage 2 is verified"]);
        assert.equal("displayTitle" in state || "createdAt" in state || "updatedAt" in state, false);
        assert.ok(state.items.every((item) => !("displayTitle" in item)));
        if (state.undo?.state) {
          assert.equal(state.undo.state.title, planTitle);
          assert.equal(state.undo.state.goal, fullGoal);
          assert.deepEqual(state.undo.state.items.map((item) => item.description), descriptions);
        }
      }
      assert.equal(states[2]!.cursor, 0);
      assert.equal(recoverTodoFromBranch(branch).todo?.title, planTitle);
      assert.deepEqual(recoverTodoFromBranch(branch).todo?.items.map((item) => item.description), descriptions);
      const modelText = branch.flatMap((entry) => entry.type === "message" && entry.message.role === "toolResult"
        ? entry.message.content.map((block) => block.type === "text" ? block.text : "") : []).join("\n");
      assert.ok(modelText.includes(fullGoal));
      assert.ok(modelText.includes(planTitle));
      for (const text of [...titles, ...descriptions]) assert.ok(modelText.includes(text), `model feedback lost ${text}`);
      if (mode === "rpc") {
        const notices: string[] = [];
        const runner = session.extensionRunner;
        runner.setUIContext({ ...runner.getUIContext(), notify: (text) => { notices.push(text); } }, mode);
        await session.prompt("/todos list");
        assert.ok(notices.at(-1)?.includes(fullGoal));
        assert.ok(notices.at(-1)?.includes(planTitle));
        for (const description of descriptions) assert.ok(notices.at(-1)?.includes(description), "inspection lost a completed task description");
        assert.ok(widgets.some((lines) => lines?.[0] === `计划：${planTitle} · 0/2` && lines[1] === `  → ${titles[0]}`));
        const completedLines = [
          `计划：${planTitle} · 2/2`,
          `  ✓ ${titles[0]}`,
          `  ✓ ${titles[1]}`,
        ];
        assert.ok(widgets.some((lines) => JSON.stringify(lines) === JSON.stringify(completedLines)),
          "the completing run must publish its final progress before settlement");
        assert.equal(widgets.at(-1), undefined, "a settled SDK session must release the completed widget");
      }
      assert.equal(session.getLastAssistantText(), "Short title regression complete.");
    });
  }
});

test("SDK rejects removed fields and requires a new title when replanning changes the full goal", { timeout: 10_000 }, async () => {
  const nextGoal = "Implement the revised behavior and verify its complete scope";
  await withScriptedSession("json", [
    { type: "toolCall", name: "todo", arguments: { ...PLAN, displayTitle: "Legacy label" } },
    { type: "toolCall", name: "todo", arguments: { ...PLAN, tasks: [{ title: "Implement", displayTitle: "Legacy task" }] } },
    { type: "toolCall", name: "todo", arguments: { ...PLAN, tasks: [{ title: "Implement", result: "Premature result" }] } },
    { type: "toolCall", name: "todo", arguments: { ...PLAN, createdAt: 1_000, updatedAt: 2_000 } },
    { type: "toolCall", name: "todo", arguments: { action: "plan", goal: PLAN.goal, tasks: PLAN.tasks } },
    { type: "toolCall", name: "todo", arguments: PLAN },
    { type: "toolCall", name: "todo", arguments: { action: "replan", reason: "Refine execution details", tasks: PLAN.tasks } },
    { type: "toolCall", name: "todo", arguments: { action: "replan", reason: "The requested scope changed", goal: nextGoal, tasks: PLAN.tasks } },
    { type: "toolCall", name: "todo", arguments: { action: "replan", reason: "The requested scope changed", title: "Implement and verify revised behavior", goal: nextGoal, tasks: PLAN.tasks } },
    { type: "toolCall", name: "todo", arguments: { action: "advance", completions: [{ result: "Revised implementation delivered" }] } },
    { type: "toolCall", name: "todo", arguments: { action: "replan", reason: "No remaining work is required", tasks: [] } },
    { type: "text", text: "New field protocol verified." },
  ], [], async (session, manager) => {
    await session.prompt("Verify the new protocol without accepting legacy fields.");
    const results = manager.getBranch().flatMap((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "todo" ? [entry.message] : []);
    assert.equal(results.length, 11);
    assert.deepEqual(results.map((result) => result.isError), [true, true, true, true, true, false, false, true, false, false, false]);
    const details = results.map((result) => result.details as unknown as TodoToolDetails);
    assert.match(details[4]!.error!, /title/i);
    assert.equal(details[4]!.state, null);
    assert.equal(details[6]!.state?.title, PLAN.title);
    assert.equal(details[6]!.state?.goal, PLAN.goal);
    assert.deepEqual(details[6]!.state?.items.map((item) => item.description), PLAN.tasks.map((item) => item.description));
    assert.match(details[7]!.error!, /title/i);
    assert.deepEqual(details[7]!.state, details[6]!.state, "rejected goal changes must leave the complete state untouched");
    assert.equal(details[8]!.state?.title, "Implement and verify revised behavior");
    assert.equal(details[8]!.state?.goal, nextGoal);
    assert.equal(details[10]!.state?.phase, "completed");
    assert.equal(details[10]!.state?.title, details[8]!.state?.title);
    assert.equal(details[10]!.state?.goal, nextGoal);
    assert.equal(recoverTodoFromBranch(manager.getBranch()).compatibilityError, undefined);
  });
});

test("SDK validates and persists batch completion and whole-batch undo in JSON and RPC modes", { timeout: 15_000 }, async () => {
  for (const mode of ["json", "rpc"] as const) {
    await withScriptedSession(mode, [
      { type: "toolCall", name: "todo", arguments: PLAN },
      { type: "toolCall", name: "todo", arguments: {
        action: "advance", completions: [{ result: "Implementation ready" }, { result: "Verification passed" }],
      } },
      { type: "toolCall", name: "todo", arguments: { action: "undo" } },
      { type: "toolCall", name: "todo", arguments: { action: "advance", completions: [{}, { result: "Final verification passed" }] } },
      { type: "text", text: "Batch regression complete." },
    ], [], async (session, manager, widgets) => {
      await session.prompt("Run the batch regression.");
      const entries = manager.getBranch();
      const results = entries.flatMap((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "todo" ? [entry.message] : []);
      assert.equal(results.length, 4);
      assert.ok(results.every((result) => !result.isError));
      const details = results.map((result) => result.details as unknown as TodoToolDetails);
      assert.deepEqual(details.map((result) => result.action), ["plan", "advance", "undo", "advance"]);
      assert.deepEqual(details.map((result) => result.state?.cursor), [0, 2, 0, 2]);
      assert.deepEqual(details.map((result) => result.state?.revision), [1, 2, 3, 4]);
      assert.deepEqual(details[1]?.state?.items.map((item) => item.result), ["Implementation ready", "Verification passed"]);
      assert.ok(details[2]?.state?.items.every((item) => item.result === undefined));
      assert.deepEqual(details[3]?.state?.items.map((item) => item.result), [undefined, "Final verification passed"]);
      assert.equal(recoverTodoFromBranch(entries).todo?.phase, "completed");
      assert.equal(entries.filter((entry) => entry.type === "custom_message" && entry.customType === TODO_AUTO_CONTINUE_CUSTOM_TYPE).length, 0);
      if (mode === "rpc") {
        const completedLines = [`计划：${PLAN.title} · 2/2`, "  ✓ Implement", "  ✓ Verify"];
        const firstCompletion = widgets.findIndex((lines) => JSON.stringify(lines) === JSON.stringify(completedLines));
        assert.ok(firstCompletion >= 0, "the completing run must publish its final progress before settlement");
        assert.ok(widgets.slice(firstCompletion + 1).some((lines) =>
          lines?.[0] === `计划：${PLAN.title} · 0/2` && lines[1] === "  → Implement"),
        "whole-batch undo must restore the active widget after completion");
        assert.equal(widgets.at(-1), undefined, "the settled session must release the completed widget");
      }
    });
  }
});

test("SDK auto-continuation after a partial batch visits only the final cursor position", { timeout: 10_000 }, async () => {
  await withScriptedSession("rpc", [
    { type: "toolCall", name: "todo", arguments: { ...PLAN, tasks: [...PLAN.tasks, { title: "Document" }] } },
    { type: "toolCall", name: "todo", arguments: { action: "advance", completions: [{}, {}] } },
    { type: "text", text: "The first two tasks are complete; one remains." },
    { type: "toolCall", name: "todo", arguments: { action: "advance", completions: [{}] } },
    { type: "text", text: "The remaining task is complete." },
  ], [], async (session, manager) => {
    await session.prompt("Run the partial batch regression.");
    const entries = manager.getBranch();
    const results = entries.flatMap((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "todo" ? [entry.message] : []);
    assert.ok(results.every((result) => !result.isError));
    const details = results.map((result) => result.details as unknown as TodoToolDetails);
    assert.deepEqual(details.map((result) => result.state?.cursor), [0, 2, 3]);
    const nudges = entries.flatMap((entry) => entry.type === "custom_message" && entry.customType === TODO_AUTO_CONTINUE_CUSTOM_TYPE ? [entry] : []);
    assert.equal(nudges.length, 1);
    assert.equal((nudges[0]!.details as unknown as { cursor: number }).cursor, 2);
    const recovered = recoverTodoFromBranch(entries);
    assert.equal(recovered.todo?.phase, "completed");
    assert.equal(recovered.nudgeCounts.get(`${recovered.todo!.planId}:2`), 1);
    assert.equal(recovered.nudgeCounts.has(`${recovered.todo!.planId}:1`), false);
  });
});

test("SDK rejects nested Todo calls but persists subsequent direct calls", { timeout: 10_000 }, async () => {
  let nestedRejected = false;
  let listedAsCallable = true;
  const probe: ToolDefinition = {
    name: "review_nested",
    label: "Review nested",
    description: "Attempt a nested Todo call",
    parameters: Type.Object({}),
    async execute(_id, _params, signal, _update, ctx) {
      listedAsCallable = ctx.tools.some((tool) => tool.name === "todo");
      const outcome = await ctx.executeTool("todo", PLAN, { signal });
      nestedRejected = outcome.isError;
      return { content: [{ type: "text", text: "Nested probe completed." }], details: {} };
    },
  };
  await withScriptedSession("json", [
    { type: "toolCall", name: probe.name, arguments: {} },
    { type: "toolCall", name: "todo", arguments: PLAN },
    { type: "text", text: "Direct plan persisted." },
  ], [probe], async (session, manager) => {
    await session.prompt("Probe nested and direct Todo calls.");
    assert.equal(listedAsCallable, false, "model-only Todo must not be listed for nested callers");
    assert.equal(nestedRejected, true, "a nested call must fail before mutating Todo state");
    const results = manager.getBranch().flatMap((entry) =>
      entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : [],
    );
    assert.deepEqual(results.map((result) => [result.toolName, result.isError]), [[probe.name, false], ["todo", false]]);
    const recovered = recoverTodoFromBranch(manager.getBranch()).todo;
    assert.equal(recovered?.goal, PLAN.goal);
    assert.equal(recovered?.cursor, 0);
    assert.equal(recovered?.items.length, 2);
  });
});

test("SDK replanning after an early-stop correction does not emit another correction at the same position", { timeout: 10_000 }, async () => {
  await withScriptedSession("rpc", [
    { type: "toolCall", name: "todo", arguments: PLAN },
    { type: "text", text: "Stopped before completing the first task." },
    {
      type: "toolCall", name: "todo",
      arguments: { action: "replan", reason: "Use a different approach", tasks: [{ title: "Implement differently" }, { title: "Verify" }] },
    },
    { type: "text", text: "Replanned but the first task is still unfinished." },
    { type: "text", text: "UNEXPECTED_SECOND_CORRECTION" },
  ], [], async (session, manager) => {
    await session.prompt("Create a plan, stop early, then revise it without completing a task.");
    const branch = manager.getBranch();
    const nudges = branch.filter((entry) => entry.type === "custom_message" && entry.customType === TODO_AUTO_CONTINUE_CUSTOM_TYPE);
    assert.equal(nudges.length, 1, "an edit must not rearm a consumed correction allowance");
    const results = branch.flatMap((entry) =>
      entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "todo" ? [entry.message] : [],
    );
    assert.deepEqual(results.map((result) => (result.details as { action: string }).action), ["plan", "replan"]);
    assert.equal(results.every((result) => !result.isError), true);
    assert.equal(session.getLastAssistantText(), "Replanned but the first task is still unfinished.");
    const recovered = recoverTodoFromBranch(branch);
    assert.equal(recovered.todo?.phase, "active");
    assert.equal(recovered.todo.cursor, 0);
    assert.equal(recovered.todo.items[0]!.title, "Implement differently");
    assert.equal(recovered.nudgeCounts.get(`${recovered.todo.planId}:0`), 1);
    assert.equal(recovered.resumeRevisions.size, 0);
  });
});

test("SDK Todo inspection responds during model streaming and running tools without interrupting work", { timeout: 15_000 }, async () => {
  for (const phase of ["model", "tool"] as const) {
    const entered = deferred();
    const release = deferred();
    let toolCompleted = false;
    const barrier: ToolDefinition = {
      name: "inspection_barrier",
      label: "Inspection barrier",
      description: "Hold a tool open while the user inspects Todo",
      parameters: Type.Object({}),
      async execute() {
        entered.resolve();
        await release.promise;
        toolCompleted = true;
        return { content: [{ type: "text", text: "Tool completed normally." }], details: {} };
      },
    };
    await withScriptedSession("rpc", [
      { type: "toolCall", name: "todo", arguments: PLAN },
      ...(phase === "tool" ? [{ type: "toolCall", name: barrier.name, arguments: {} } as ScriptedStep] : []),
      { type: "toolCall", name: "todo", arguments: { action: "advance", completions: [{}, {}] }, delayMs: phase === "model" ? 1_000 : undefined },
      { type: "text", text: "Inspection did not interrupt the work." },
    ], phase === "tool" ? [barrier] : [], async (session, manager) => {
      const notifications: string[] = [];
      const runner = session.extensionRunner;
      runner.setUIContext({ ...runner.getUIContext(), notify: (text) => { notifications.push(text); } }, "rpc");
      let assistantStarts = 0;
      const unsubscribe = session.subscribe((event) => {
        if (phase === "model" && event.type === "message_start" && event.message.role === "assistant" && ++assistantStarts === 2) entered.resolve();
      });
      const run = session.prompt("Create the plan and finish the work while I inspect it.");
      let listing: Promise<void> | undefined;
      try {
        await entered.promise;
        assert.equal(session.isIdle, false);
        const before = recoverTodoFromBranch(manager.getBranch()).todo;
        for (const command of ["/todos", "/todos list", "/todos show"]) {
          const previousCount = notifications.length;
          listing = session.prompt(command);
          await new Promise<void>((resolve) => setImmediate(resolve));
          assert.equal(notifications.length, previousCount + 1, `${phase}: inspection must respond before the run finishes`);
          assert.match(notifications.at(-1)!, /Todo 0\/2 done/);
          await listing;
          assert.equal(session.isIdle, false, `${phase}: inspection must not wait for or stop the run`);
          assert.deepEqual(recoverTodoFromBranch(manager.getBranch()).todo, before);
        }
        release.resolve();
        await run;
        if (phase === "tool") assert.equal(toolCompleted, true);
        assert.equal(session.getLastAssistantText(), "Inspection did not interrupt the work.");
        const branch = manager.getBranch();
        assert.equal(recoverTodoFromBranch(branch).todo?.phase, "completed");
        assert.equal(branch.filter((entry) => entry.type === "custom_message" && entry.customType === TODO_AUTO_CONTINUE_CUSTOM_TYPE).length, 0);
        assert.equal(branch.some((entry) => entry.type === "message" && entry.message.role === "assistant" && ["error", "aborted"].includes(entry.message.stopReason)), false);
      } finally {
        unsubscribe();
        release.resolve();
        await session.abort();
        await Promise.allSettled([run, ...(listing ? [listing] : [])]);
      }
    });
  }
});

test("SDK pause during the correction's model call neither aborts it nor reports an early stop", { timeout: 10_000 }, async () => {
  await withScriptedSession("rpc", [
    { type: "toolCall", name: "todo", arguments: PLAN },
    { type: "text", text: "Stopped before completing the task." },
    { type: "text", text: "The in-flight response completed normally.", delayMs: 1_000 },
    { type: "toolCall", name: "todo", arguments: { action: "show" } },
    { type: "text", text: "Pause status inspected." },
  ], [], async (session, manager, widgets) => {
    const modelEntered = deferred();
    let assistantStarts = 0;
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "message_start" && event.message.role === "assistant" && ++assistantStarts === 3) modelEntered.resolve();
    });
    const run = session.prompt("Create a plan, stop early, then continue the response.");
    try {
      await modelEntered.promise;
      assert.equal(session.isIdle, false);
      await session.prompt("/todos pause");
      assert.equal(session.isIdle, false, "pause must not abort or wait for the model response");
      await run;
      assert.equal(session.getLastAssistantText(), "The in-flight response completed normally.");
      const settledWidget = widgets.at(-1)?.join("\n") ?? "";
      assert.match(settledWidget, /自动续跑已暂停/);
      assert.doesNotMatch(settledWidget, /提前停止/);
      const beforeShow = recoverTodoFromBranch(manager.getBranch()).todo;
      await session.prompt("Show the current plan without resuming work.");
      const branch = manager.getBranch();
      assert.equal(branch.filter((entry) => entry.type === "custom_message" && entry.customType === TODO_AUTO_CONTINUE_CUSTOM_TYPE).length, 1);
      const shown = branch.flatMap((entry) =>
        entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "todo" ? [entry.message] : [],
      ).at(-1)!;
      const text = shown.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
      assert.equal((shown.details as { action: string }).action, "show");
      assert.match(text, /Auto-continue paused/);
      assert.doesNotMatch(text, /Warning: agent stopped/);
      assert.deepEqual(recoverTodoFromBranch(branch).todo, beforeShow);
      assert.equal(branch.some((entry) => entry.type === "message" && entry.message.role === "assistant" && ["error", "aborted"].includes(entry.message.stopReason)), false);
    } finally {
      unsubscribe();
      await session.abort();
      await run;
    }
  });
});

test("SDK pause during a running tool prevents the next auto-continue without aborting the tool", { timeout: 10_000 }, async () => {
  const entered = deferred();
  const release = deferred();
  let toolCompleted = false;
  const barrier: ToolDefinition = {
    name: "review_barrier",
    label: "Review barrier",
    description: "Hold a tool open while the user pauses Todo",
    parameters: Type.Object({}),
    async execute() {
      entered.resolve();
      await release.promise;
      toolCompleted = true;
      return { content: [{ type: "text", text: "Tool completed normally." }], details: {} };
    },
  };
  await withScriptedSession("rpc", [
    { type: "toolCall", name: "todo", arguments: PLAN },
    { type: "toolCall", name: barrier.name, arguments: {} },
    { type: "text", text: "Stopped with the task unfinished." },
    { type: "text", text: "Unexpected continuation stopped again." },
  ], [barrier], async (session, manager) => {
    const run = session.prompt("Create a plan, run the tool, and stop.");
    try {
      await entered.promise;
      assert.equal(session.isIdle, false);
      const pause = session.prompt("/todos pause");
      release.resolve();
      await Promise.all([run, pause]);
      assert.equal(toolCompleted, true, "pause must not abort the running tool");
      const branch = manager.getBranch();
      assert.equal(branch.filter((entry) => entry.type === "custom_message" && entry.customType === TODO_AUTO_CONTINUE_CUSTOM_TYPE).length, 0);
      assert.equal(branch.some((entry) => entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "error"), false);
      assert.equal(recoverTodoFromBranch(branch).todo?.phase, "active");
    } finally {
      release.resolve();
      await session.abort();
      await run;
    }
  });
});
