import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, initializeFixture, runCommand } from "../e2e/run-rpc-e2e.ts";
import { readWorkspaceChanges } from "../e2e/run-model-eval.ts";
import { assertActiveTodoAbort, assertNormalAssistantText, assertPromptContextReminder } from "../e2e/run-rpc-controls.ts";
import { createAbortProbe, SCRIPTED_ABORT_TOOL } from "../e2e/scripted-provider.ts";
import { emptyTodoReducerDependencies, reduceTodo } from "../reducer.ts";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { scoreModelRun, scoreRun } from "../e2e/score-run.ts";
import { loadScenarioFile } from "../e2e/scenario.ts";
import { fileURLToPath } from "node:url";
import type { TodoInput } from "../schema.ts";

function assistantError(message: string) {
  return { type: "message", message: { role: "assistant", stopReason: "error", errorMessage: message } };
}

test("script exhaustion is a hard failure even when all Todo expectations match", () => {
  const result = scoreRun({ todoToolCalls: 0, autoContinueMessages: 0, finalTodoPhase: "none" }, [
    assistantError("Scripted scenario compact exhausted at provider call 5."),
  ]);
  assert.equal(result.passed, false);
  assert.equal(result.hardFail, true);
  assert.equal(result.score, 0);
  assert.match(result.issues.join("\n"), /scripted provider exhausted/i);
});

test("intentional provider errors and aborts remain valid scripted scenarios", () => {
  for (const message of [
    { role: "assistant", stopReason: "error", errorMessage: "scripted provider failure" },
    { role: "assistant", stopReason: "aborted", errorMessage: "The scripted provider was aborted." },
    { role: "user", content: "Scripted scenario compact exhausted at provider call 5." },
  ]) {
    const result = scoreRun({ todoToolCalls: 0 }, [{ type: "message", message }]);
    assert.equal(result.passed, true);
    assert.equal(result.hardFail, false);
  }
});

test("compaction recovery accepts only the recovery prompt's first context and reminder", () => {
  const prompt = "Continue after the context compaction.";
  const goal = "Verify compaction recovery";
  const user = { role: "user", content: prompt };
  const reminder = { role: "user", content: `[Todo 0/2]\nGoal: ${goal}` };
  const trace = (...messages: unknown[][]) => messages.map((value, callIndex) => JSON.stringify({ callIndex, messages: value })).join("\n");
  assert.doesNotThrow(() => assertPromptContextReminder(trace([user, reminder]), prompt, goal));
  const detailed = { ...reminder, content: `[Todo 0/2]\nTitle: Recover staged work\nGoal: ${goal}\nDescription: Preserve the full execution scope` };
  const fields = [goal, "Recover staged work", "Preserve the full execution scope"];
  assert.doesNotThrow(() => assertPromptContextReminder(trace([user, detailed]), prompt, fields));
  assert.throws(() => assertPromptContextReminder(trace([user, reminder]), prompt, fields), /did not contain/);
  assert.throws(() => assertPromptContextReminder(trace([user, { ...detailed, content: detailed.content.replace(goal, "Recover staged work") }]), prompt, fields), /did not contain/);
  assert.doesNotThrow(() => assertPromptContextReminder(trace([user, { ...reminder, role: "custom" }]), prompt, goal));
  assert.throws(() => assertPromptContextReminder(trace([{ role: "user", content: "Earlier prompt" }, reminder], [user]), prompt, goal), /did not belong/);
  assert.throws(() => assertPromptContextReminder(trace([user], [user, reminder]), prompt, goal), /did not contain/);
  assert.throws(() => assertPromptContextReminder(trace([user, { ...reminder, role: "assistant" }]), prompt, goal), /did not contain/);
  assert.throws(() => assertPromptContextReminder("", prompt, goal), /did not belong/);
});

test("recovery response assertions reject missing, aborted or failed final responses", () => {
  const text = "The post-compaction request completed.";
  const record = (stopReason: string, errorMessage?: string) => ({ type: "message_end", message: {
    role: "assistant", stopReason, content: [{ type: "text", text }], ...(errorMessage ? { errorMessage } : {}),
  } });
  assert.doesNotThrow(() => assertNormalAssistantText([record("stop")], text));
  assert.throws(() => assertNormalAssistantText([], text), /normally completed/);
  assert.throws(() => assertNormalAssistantText([record("stop"), record("error", "Script exhausted")], text), /normally completed/);
  assert.throws(() => assertNormalAssistantText([record("aborted")], text), /normally completed/);
  assert.throws(() => assertNormalAssistantText([record("stop")], "Different expected response"), /normally completed/);
});

function activeAbortFixture() {
  const state = reduceTodo(null, { action: "plan", title: "Implement and verify the staged change", goal: "Keep the plan while aborting", tasks: [{ title: "Implement", description: "Apply the requested behavior without unrelated changes" }, { title: "Verify", description: "Run the full regression suite" }] }, emptyTodoReducerDependencies("abort-plan")).state!;
  const entries = [{ type: "message", message: { role: "toolResult", toolName: "todo", details: { action: "plan", transition: "created", state } } }];
  const modelEnd = { type: "message_end", message: { role: "assistant", stopReason: "aborted" } };
  const toolEnd = { type: "tool_execution_end", toolName: SCRIPTED_ABORT_TOOL, isError: true, result: { details: { status: "aborted" } } };
  const settled = { type: "agent_settled", aborted: true };
  return { state, entries, modelEnd, toolEnd, settled };
}

test("scripted scenarios create only the new plan and task field protocol", async () => {
  const file = await loadScenarioFile(fileURLToPath(new URL("../e2e/scenarios/deterministic.json", import.meta.url)));
  for (const [name, scenario] of Object.entries(file.scenarios)) {
    for (const step of scenario.steps) {
      if (step.type !== "toolCall" || step.name !== "todo" || step.arguments.action !== "plan") continue;
      const planned = reduceTodo(null, step.arguments as TodoInput, emptyTodoReducerDependencies(`scenario-${name}`));
      assert.equal(planned.state?.schemaVersion, 3);
      assert.equal(planned.state?.title, step.arguments.title);
      assert.equal(planned.state?.goal, step.arguments.goal);
      assert.equal("displayTitle" in step.arguments, false);
    }
  }
});

test("scoring hard-fails old and corrupted state fields rather than accepting renamed compatibility data", () => {
  const { state, entries } = activeAbortFixture();
  assert.equal(scoreRun(undefined, entries).passed, true);
  for (const invalid of [
    { ...state, schemaVersion: 2 },
    { ...state, title: undefined },
    { ...state, displayTitle: "Old plan label" },
    { ...state, createdAt: 1_000 },
    { ...state, updatedAt: 2_000 },
    { ...state, items: [{ ...state.items[0], displayTitle: "Old task label" }, state.items[1]] },
    { ...state, items: [{ ...state.items[0], description: 123 }, state.items[1]] },
    { ...state, undo: { state: { ...state, schemaVersion: 2 } } },
  ]) {
    const malformed = structuredClone(entries);
    malformed[0]!.message.details.state = invalid as typeof state;
    const score = scoreRun(undefined, malformed);
    assert.equal(score.passed, false);
    assert.equal(score.hardFail, true);
    assert.match(score.issues.join("\n"), /valid state snapshot/);
  }
});

test("active Todo abort assertions require real cancellation and unchanged plan/allowance", () => {
  const { entries, modelEnd, toolEnd, settled } = activeAbortFixture();
  assert.doesNotThrow(() => assertActiveTodoAbort([modelEnd, settled], entries, entries, "model"));
  assert.doesNotThrow(() => assertActiveTodoAbort([toolEnd, settled], entries, entries, "tool"));
  const terminal = { role: "assistant", content: [], stopReason: "error", errorMessage: "This operation was aborted" };
  assert.doesNotThrow(() => assertActiveTodoAbort([toolEnd, { type: "message_start", message: terminal }, { type: "message_end", message: terminal }, settled], entries, entries, "tool"));
  assert.throws(() => assertActiveTodoAbort([modelEnd, settled], [], [], "model"), /preserve an active Todo/);
  assert.throws(() => assertActiveTodoAbort([modelEnd, settled], entries, [], "model"), /preserve an active Todo/);
  const changed = structuredClone(entries);
  changed[0]!.message.details.state = reduceTodo(changed[0]!.message.details.state, { action: "advance", completions: [{ result: "Unexpected progress" }] }, emptyTodoReducerDependencies("unused")).state!;
  assert.throws(() => assertActiveTodoAbort([modelEnd, settled], entries, changed, "model"), /preserve an active Todo/);
  const nudge = { type: "custom_message", customType: "linear-todo-auto-continue", details: { stageKey: "unexpected" } };
  assert.throws(() => assertActiveTodoAbort([modelEnd, settled], entries, [...entries, nudge], "model"), /preserve an active Todo/);
  assert.throws(() => assertActiveTodoAbort([modelEnd, { ...settled, aborted: false }], entries, entries, "model"), /did not settle as user-aborted/);
  assert.throws(() => assertActiveTodoAbort([{ ...modelEnd, message: { role: "assistant", stopReason: "error" } }, settled], entries, entries, "model"), /model response was not aborted/);
  assert.throws(() => assertActiveTodoAbort([settled], entries, entries, "tool"), /tool did not observe/);
  assert.throws(() => assertActiveTodoAbort([{ ...toolEnd, result: { details: { status: "completed" } } }, settled], entries, entries, "tool"), /tool did not observe/);
});

test("abort assertions reject work restarting even without a persisted Todo nudge", () => {
  const { entries, modelEnd, settled } = activeAbortFixture();
  for (const restarted of [
    { type: "agent_start" },
    { type: "message_end", message: { role: "assistant", stopReason: "stop" } },
    { type: "message_end", message: { role: "assistant", stopReason: "toolUse" } },
    { type: "entry_appended", entry: { customType: "linear-todo-auto-continue" } },
  ]) {
    assert.throws(() => assertActiveTodoAbort([modelEnd, restarted, settled], entries, entries, "model"), /started after the user aborted/);
  }
});

test("the bounded tool probe observes in-flight and already-aborted signals", async () => {
  for (const preAborted of [false, true]) {
    const controller = new AbortController();
    if (preAborted) controller.abort();
    const updates: unknown[] = [];
    const run = createAbortProbe().execute("abort-probe", {}, controller.signal, (update) => updates.push(update), {} as ExtensionToolContext);
    assert.equal(updates.length, preAborted ? 0 : 1);
    controller.abort();
    const result = await run;
    assert.equal((result.details as { status: string }).status, "aborted");
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /received cancellation/);
  }
});

test("the tool probe rejects a missing abort signal instead of pretending to be cancellable", async () => {
  await assert.rejects(createAbortProbe().execute("missing-signal", {}, undefined, undefined, {} as ExtensionToolContext), /requires a tool abort signal/);
});

test("command data stays separate from diagnostics on success and failure", async () => {
  for (const code of [0, 3]) {
    const result = await runCommand(process.execPath, ["-e", `process.stdout.write('data'); process.stderr.write('diagnostic'); process.exit(${code});`], tmpdir());
    assert.equal(result.code, code);
    assert.equal(result.stdout, "data");
    assert.equal(result.stderr, "diagnostic");
    assert.match(result.output, /datadiagnostic/);
  }
});

test("commit-free model baselines ignore staged fixtures but detect final tracked and untracked edits", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "linear-todo-model-baseline-"));
  try {
    await initializeFixture(workspace);
    const baseline = await git(workspace, ["write-tree"]);
    assert.equal(baseline.code, 0);
    const changes = () => readWorkspaceChanges(workspace, baseline.output.trim());
    const pristine = await changes();
    assert.equal(pristine.diff + pristine.untracked, "");
    assert.notEqual(pristine.status, "", "a commit-free baseline is staged but is not a model change");
    const score = scoreModelRun({
      model: "provider/model", scenario: "M01", variant: "baseline", entries: [], oracle: "process",
      expect: { repoChange: "none", todo: "avoid" },
      acceptance: { passed: true, results: [] }, regression: { passed: true, results: [] },
      preconditionFalsifiable: true, wallTimeMs: 0, finalResponse: "The cache stores values.",
      repoDiff: pristine.diff + pristine.untracked,
    });
    assert.equal(score.processMetrics.repoChanged, false);
    assert.equal(score.gates.repoChange, true);

    const source = join(workspace, "src", "cache.ts");
    const original = await readFile(source, "utf8");
    await writeFile(source, original + "\n// A tracked change.\n");
    assert.match((await changes()).diff, /A tracked change/);
    assert.equal((await git(workspace, ["add", "src/cache.ts"])).code, 0);
    assert.match((await changes()).diff, /A tracked change/, "staging must not hide a model edit");
    await writeFile(source, original);
    assert.equal((await changes()).diff, "", "restored content matches the immutable tree even when the index differs");
    await writeFile(join(workspace, "new-file.txt"), "New content");
    assert.match((await changes()).untracked, /new-file\.txt/);
    await rm(source);
    assert.match((await changes()).diff, /deleted file mode/);
    assert.notEqual((await git(workspace, ["rev-parse", "--verify", "HEAD"])).code, 0);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("fixture initialization uses an isolated index without creating a commit", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "linear-todo-fixture-test-"));
  try {
    await initializeFixture(workspace);
    const head = await git(workspace, ["rev-parse", "--verify", "HEAD"]);
    assert.notEqual(head.code, 0, "fixture setup must not create a commit");
    const staged = await git(workspace, ["diff", "--cached", "--name-only"]);
    assert.equal(staged.code, 0);
    assert.match(staged.output, /src\/cache\.ts/);
    assert.equal((await git(workspace, ["diff", "--no-ext-diff"])).output, "");
    const source = join(workspace, "src", "cache.ts");
    await writeFile(source, (await readFile(source, "utf8")) + "\n// Changed by the fixture test.\n");
    assert.match((await git(workspace, ["diff", "--no-ext-diff"])).output, /Changed by the fixture test/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
