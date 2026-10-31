import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { emptyTodoReducerDependencies, reduceTodo, type TodoTransition } from "../reducer.ts";
import { recoverTodoFromBranch } from "../state.ts";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { SCRIPTED_MODEL } from "../e2e/scripted-provider.ts";
import type { TodoState } from "../schema.ts";

const PROJECT_DIR = resolve(fileURLToPath(new URL("..", import.meta.url)));

function extensionPaths(): string[] {
  return [join(PROJECT_DIR, "index.ts"), join(PROJECT_DIR, "e2e", "scripted-provider.ts")];
}

test("SDK loads the real extension, binds its tool/command, and persists scripted results", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "linear-todo-sdk-"));
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
    additionalExtensionPaths: extensionPaths(),
  });
  await resourceLoader.reload();

  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
  });
  const sessionManager = SessionManager.inMemory(agentDir);
  const { session, extensionsResult } = await createAgentSession({
    cwd: agentDir,
    agentDir,
    modelRuntime,
    model: SCRIPTED_MODEL,
    thinkingLevel: "off",
    tools: ["todo"],
    resourceLoader,
    sessionManager,
    settingsManager,
  });

  try {
    await session.bindExtensions({ mode: "json" });

    assert.deepEqual(extensionsResult.errors, []);
    const todoExtension = extensionsResult.extensions.find((extension) => extension.tools.has("todo"));
    assert.ok(todoExtension, "todo extension was not loaded");
    assert.equal(todoExtension.commands.has("todos"), true);
    for (const eventName of ["session_start", "session_tree", "session_compact", "context", "agent_settled", "session_shutdown"]) {
      assert.equal(todoExtension.handlers.has(eventName), true, `missing ${eventName} handler`);
    }

    const registeredTool = extensionsResult.runtime.getAllTools().find((tool) => tool.name === "todo");
    assert.ok(registeredTool, "todo was not exposed through the runtime registry");
    assert.equal(registeredTool.exposure, "model-only");
    assert.equal(session.agent.state.tools.filter((tool) => tool.name === "todo").length, 1);
    assert.equal(extensionsResult.runtime.getCommands().some((command) => command.name === "todos"), true);

    await session.prompt("Run the scripted plan.");

    const todoResults = sessionManager
      .getBranch()
      .filter((entry) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "todo")
      .map((entry) => (entry.type === "message" && entry.message.role === "toolResult" ? entry.message.details as { action?: string; state?: { phase?: string } | null } : undefined));
    assert.deepEqual(todoResults.map((result) => result?.action), ["plan", "advance", "advance"]);
    assert.equal(todoResults.at(-1)?.state?.phase, "completed");
  } finally {
    session.dispose();
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("SDK SessionManager keeps Todo recovery branch-local", () => {
  const plan = reduceTodo(
    null,
    {
      action: "plan",
      title: "Preserve branch-local work",
      goal: "Branch-local recovery",
      tasks: [{ title: "First", description: "Inspect the original branch" }, { title: "Second", description: "Verify the selected branch" }],
    },
    emptyTodoReducerDependencies("branch-plan"),
  ).state!;
  const advanced = reduceTodo(plan, { action: "advance", completions: [{ result: "First is complete" }] }, emptyTodoReducerDependencies("unused")).state!;
  const sessionManager = SessionManager.inMemory(process.cwd());
  const planEntryId = sessionManager.appendMessage({
    role: "toolResult",
    toolCallId: "plan-call",
    toolName: "todo",
    content: [{ type: "text", text: "created" }],
    details: { action: "plan", state: plan, transition: "created" } as never,
    isError: false,
    timestamp: 1_000,
  });
  const advancedEntryId = sessionManager.appendMessage({
    role: "toolResult",
    toolCallId: "advance-call",
    toolName: "todo",
    content: [{ type: "text", text: "advanced" }],
    details: { action: "advance", state: advanced, transition: "advanced" } as never,
    isError: false,
    timestamp: 2_000,
  });

  sessionManager.branch(planEntryId);
  assert.equal(recoverTodoFromBranch(sessionManager.getBranch()).todo?.cursor, 0);
  sessionManager.branch(advancedEntryId);
  const restored = recoverTodoFromBranch(sessionManager.getBranch()).todo!;
  assert.equal(restored.cursor, 1);
  assert.equal(restored.title, "Preserve branch-local work");
  assert.equal(restored.items[0]?.description, "Inspect the original branch");
  assert.equal(restored.undo?.state?.title, restored.title);
  assert.equal(restored.undo?.state?.items[1]?.description, "Verify the selected branch");
});

test("SDK disk sessions retain titles, full scope, descriptions and undo across processes while rejecting V1/V2", { timeout: 15_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "linear-todo-sdk-disk-"));
  try {
    const plan = reduceTodo(null, {
      action: "plan",
      title: "Implement and verify cache behavior",
      goal: "Inspect cache expiry behavior, implement the requested fix, and run the complete regression suite without unrelated changes",
      tasks: [
        { title: "Implement expiry handling", description: "Trace expiry comparisons and update the affected cache paths", doneWhen: "Boundary behavior matches the requested scope" },
        { title: "Verify cache behavior", description: "Run existing cache tests and check the exact expiry boundary", doneWhen: "All regression cases pass" },
      ],
    }, emptyTodoReducerDependencies("disk-plan")).state!;
    const advanced = reduceTodo(plan, { action: "advance", completions: [{ result: "Expiry boundary handling was implemented" }] }, emptyTodoReducerDependencies("unused")).state!;
    const legacy = {
      schemaVersion: 2, planId: plan.planId, goal: plan.goal, displayTitle: plan.title,
      revision: 1, cursor: 0, nextItemSeq: 3, phase: "active",
      items: plan.items.map(({ id, title, description, doneWhen }) => ({ id, title: description, displayTitle: title, doneWhen })),
      createdAt: 1_000, updatedAt: 1_000,
    };
    for (const snapshot of [advanced, legacy, { ...legacy, schemaVersion: 1 }]) {
      const manager = SessionManager.create(directory, directory);
      manager.appendMessage({ role: "user", content: "Restore the full execution scope.", timestamp: 1_000 });
      manager.appendMessage({
        role: "toolResult", toolCallId: "persisted-call", toolName: "todo",
        content: [{ type: "text", text: "Persisted Todo checkpoint" }],
        details: { action: "advance", transition: "advanced", state: snapshot } as never,
        isError: false, timestamp: 2_000,
      });
      const childSource = `
        import { SessionManager } from "@earendil-works/pi-coding-agent";
        import { recoverTodoFromBranch } from ${JSON.stringify(new URL("../state.ts", import.meta.url).href)};
        import { reduceTodo, emptyTodoReducerDependencies } from ${JSON.stringify(new URL("../reducer.ts", import.meta.url).href)};
        const manager = SessionManager.open(process.argv[1], process.argv[2]);
        const recovered = recoverTodoFromBranch(manager.getBranch());
        const undo = recovered.todo ? reduceTodo(recovered.todo, { action: "undo" }, emptyTodoReducerDependencies("unused")) : null;
        process.stdout.write(JSON.stringify({ todo: recovered.todo, compatibilityError: recovered.compatibilityError, undo }));
      `;
      const { stdout } = await promisify(execFile)(process.execPath,
        ["--experimental-strip-types", "--input-type=module", "-e", childSource, manager.getSessionFile()!, directory],
        { cwd: PROJECT_DIR, timeout: 10_000, env: { ...process.env, PI_OFFLINE: "1", PI_TELEMETRY: "0" } });
      const restored = JSON.parse(stdout) as { todo: TodoState | null; compatibilityError?: string; undo: TodoTransition | null };
      if (snapshot.schemaVersion !== 3) {
        assert.equal(restored.todo, null);
        assert.match(restored.compatibilityError!, new RegExp(`schemaVersion ${snapshot.schemaVersion} .*not supported`));
        assert.match(restored.compatibilityError!, /Clear Todo/);
        assert.equal(restored.undo, null, "legacy snapshots must not become executable plans");
        continue;
      }
      assert.deepEqual(restored.todo, advanced, "cross-process recovery must retain every state and undo field");
      assert.notEqual(restored.todo!.title, restored.todo!.goal);
      assert.equal(restored.undo?.changed, true);
      assert.equal(restored.undo?.state?.title, plan.title);
      assert.equal(restored.undo?.state?.goal, plan.goal);
      assert.deepEqual(restored.undo?.state?.items, plan.items);
      assert.equal(restored.undo?.state?.cursor, 0);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
