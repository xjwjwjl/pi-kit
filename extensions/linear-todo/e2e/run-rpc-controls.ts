import { isMainModule } from "./is-main.ts";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  findSessionFile,
  git,
  initializeFixture,
  runCommand,
  spawnPi,
  StrictJsonlClient,
  writeAgentSettings,
  type RunOptions,
} from "./run-rpc-e2e.ts";
import { writeArtifactBundle } from "./collect-artifacts.ts";
import { getScenario, loadScenarioFile, type ScenarioDefinition } from "./scenario.ts";
import { scoreRun, type ScoreResult } from "./score-run.ts";
import { SCRIPTED_ABORT_TOOL } from "./scripted-provider.ts";

const E2E_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = resolve(E2E_DIR, "..");
const DEFAULT_SCENARIO_FILE = join(E2E_DIR, "scenarios", "deterministic.json");
const DEFAULT_ARTIFACT_ROOT = join(PROJECT_DIR, ".e2e", "artifacts");
const DEFAULT_WORKSPACE_ROOT = join(PROJECT_DIR, ".e2e", "workspaces");
const DEFAULT_SESSION_ROOT = join(PROJECT_DIR, ".e2e", "sessions");
const PI_CLI = join(PROJECT_DIR, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
const CONTROL_SCENARIOS = ["abort", "abort-during-model", "abort-during-tool", "pending-follow-up", "compact", "pause-during-model", "fork-switch-recovery", "recover", "host-error-recovery", "error"] as const;

type ControlScenario = (typeof CONTROL_SCENARIOS)[number];

interface ControlOptions {
  scenario: string;
  repeat: number;
  timeoutMs: number;
  scenarioFile: string;
  artifactRoot: string;
  workspaceRoot: string;
  sessionRoot: string;
  piCli: string;
  tools: string;
  keepWorkspaces: boolean;
}

interface JsonRecord {
  [key: string]: unknown;
}

interface SessionSnapshot {
  entries: unknown[];
  state: unknown;
  messages: unknown;
  stats: unknown;
  sessionText: string;
}

interface ControlOutcome {
  runId: string;
  artifactDirectory: string;
  passed: boolean;
  score: ScoreResult;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "run";
}

function contextRecords(trace: string): JsonRecord[] {
  return trace.split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    const record = JSON.parse(line) as unknown;
    return isRecord(record) ? [record] : [];
  });
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => {
    if (typeof block === "string") return block;
    if (isRecord(block) && block.type === "text") return String(block.text ?? "");
    return "";
  }).join("");
}

function traceContainsReminder(trace: string, phrase: string | string[]): boolean {
  const phrases = typeof phrase === "string" ? [phrase] : phrase;
  return contextRecords(trace).some((record) =>
    Array.isArray(record.messages) && record.messages.some((message) => {
      if (!isRecord(message)) return false;
      const text = contentText(message.content);
      return (message.role === "custom" || message.role === "user") && text.startsWith("[Todo ") && phrases.every((value) => text.includes(value));
    }),
  );
}

// The supplied trace must start after compact returned, not at the beginning of the run.
export function assertPromptContextReminder(trace: string, prompt: string, phrase: string | string[]): void {
  const first = contextRecords(trace)[0];
  const users = first && Array.isArray(first.messages) ? first.messages.filter((message) => isRecord(message) && message.role === "user") : [];
  // Pi projects custom reminders as user messages before invoking a provider.
  const lastInput = users.filter((message) => isRecord(message) && !contentText(message.content).startsWith("[Todo ")).at(-1);
  if (!isRecord(lastInput) || contentText(lastInput.content) !== prompt) {
    throw new Error("The first post-compaction provider context did not belong to the recovery prompt.");
  }
  if (!traceContainsReminder(JSON.stringify(first), phrase)) {
    throw new Error("The recovery prompt's provider context did not contain the post-compaction Todo reminder.");
  }
}

export function assertNormalAssistantText(records: JsonRecord[], expected: string): void {
  const last = records.filter((record) => record.type === "message_end" && isRecord(record.message) && record.message.role === "assistant").at(-1);
  const message = last?.message;
  if (!isRecord(message) || message.stopReason !== "stop" || message.errorMessage || contentText(message.content) !== expected) {
    throw new Error(`Expected a normally completed assistant response: ${JSON.stringify(expected)}.`);
  }
}

export function assertActiveTodoAbort(
  records: JsonRecord[],
  beforeEntries: unknown[],
  afterEntries: unknown[],
  target: "model" | "tool",
): void {
  const before = scoreRun({ todoActions: ["plan"], todoToolCalls: 1, autoContinueMessages: 0, finalTodoPhase: "active" }, beforeEntries);
  const after = scoreRun(undefined, afterEntries);
  if (!before.passed || !after.passed || JSON.stringify(before.metrics) !== JSON.stringify(after.metrics) ||
      JSON.stringify(before.todoTransitions.at(-1)?.state) !== JSON.stringify(after.todoTransitions.at(-1)?.state)) {
    throw new Error("Aborting must preserve an active Todo snapshot and leave its correction allowance unspent.");
  }
  const settled = records.filter((record) => record.type === "agent_settled").at(-1);
  if (!settled || settled.aborted !== true) throw new Error("The active Todo run did not settle as user-aborted.");
  if (records.some((record) => record.type === "agent_start" ||
      (record.type === "message_end" && isRecord(record.message) && record.message.role === "assistant" &&
        (record.message.stopReason === "stop" || record.message.stopReason === "toolUse")) ||
      (record.type === "entry_appended" && isRecord(record.entry) && record.entry.customType === "linear-todo-auto-continue"))) {
    throw new Error("Model work or automatic continuation started after the user aborted.");
  }
  if (target === "model") {
    const last = records.filter((record) => record.type === "message_end" && isRecord(record.message) && record.message.role === "assistant").at(-1);
    if (!isRecord(last?.message) || last.message.stopReason !== "aborted") throw new Error("The in-flight model response was not aborted.");
  } else {
    const end = records.find((record) => record.type === "tool_execution_end" && record.toolName === SCRIPTED_ABORT_TOOL);
    if (!end || end.isError !== true || !isRecord(end.result) || !isRecord(end.result.details) || end.result.details.status !== "aborted") {
      throw new Error("The in-flight tool did not observe its abort signal.");
    }
  }
}

async function waitForActiveAbortTarget(rpc: StrictJsonlClient, tracePath: string, target: "model" | "tool", timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (target === "tool") {
      if (rpc.records.some((record) => record.type === "tool_execution_update" && record.toolName === SCRIPTED_ABORT_TOOL &&
          isRecord(record.partialResult) && isRecord(record.partialResult.details) && record.partialResult.details.status === "waiting")) return;
    } else {
      try {
        if (contextRecords(await readFile(tracePath, "utf8")).some((record) => record.callIndex === 1)) return;
      } catch (error) {
        if (!isRecord(error) || error.code !== "ENOENT") throw error;
      }
    }
    await sleep(25);
  }
  throw new Error(`The active Todo's ${target} abort target did not become ready.`);
}

async function waitForNudgeModel(rpc: StrictJsonlClient, tracePath: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let trace = "";
    try {
      trace = await readFile(tracePath, "utf8");
    } catch (error) {
      if (!isRecord(error) || error.code !== "ENOENT") throw error;
    }
    const nudgeDelivered = rpc.records.some((record) => record.type === "entry_appended" && isRecord(record.entry) && record.entry.customType === "linear-todo-auto-continue");
    if (nudgeDelivered && contextRecords(trace).some((record) => record.callIndex === 2)) return;
    await sleep(25);
  }
  throw new Error("The delayed model request did not start after the first Todo nudge.");
}

async function readTodoList(rpc: StrictJsonlClient, timeoutMs: number): Promise<string> {
  const start = rpc.records.length;
  const result = await rpc.data({ type: "prompt", message: "/todos list" }, timeoutMs);
  if (!isRecord(result) || result.disposition !== "handled") throw new Error("The Todo inspection command started model work instead of being handled.");
  const notification = rpc.records.slice(start).find((record) => record.type === "extension_ui_request" && record.method === "notify" && typeof record.message === "string" && record.message.startsWith("Todo "));
  if (!notification || typeof notification.message !== "string") throw new Error("The restored runtime did not expose a Todo list.");
  return notification.message;
}

function positiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

function valueAfter(args: string[], index: number, flag: string): [string, number] {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return [value, index + 1];
}

function parseOptions(args: string[]): ControlOptions {
  const options: ControlOptions = {
    scenario: "all",
    repeat: 1,
    timeoutMs: 30_000,
    scenarioFile: DEFAULT_SCENARIO_FILE,
    artifactRoot: DEFAULT_ARTIFACT_ROOT,
    workspaceRoot: DEFAULT_WORKSPACE_ROOT,
    sessionRoot: DEFAULT_SESSION_ROOT,
    piCli: PI_CLI,
    tools: "todo",
    keepWorkspaces: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--scenario") {
      [options.scenario, index] = valueAfter(args, index, arg);
    } else if (arg === "--repeat") {
      const [value, nextIndex] = valueAfter(args, index, arg);
      options.repeat = positiveInteger(value, arg);
      index = nextIndex;
    } else if (arg === "--timeout-ms") {
      const [value, nextIndex] = valueAfter(args, index, arg);
      options.timeoutMs = positiveInteger(value, arg);
      index = nextIndex;
    } else if (arg === "--scenario-file") {
      [options.scenarioFile, index] = valueAfter(args, index, arg);
      options.scenarioFile = resolve(options.scenarioFile);
    } else if (arg === "--artifacts") {
      [options.artifactRoot, index] = valueAfter(args, index, arg);
      options.artifactRoot = resolve(options.artifactRoot);
    } else if (arg === "--workspaces") {
      [options.workspaceRoot, index] = valueAfter(args, index, arg);
      options.workspaceRoot = resolve(options.workspaceRoot);
    } else if (arg === "--sessions") {
      [options.sessionRoot, index] = valueAfter(args, index, arg);
      options.sessionRoot = resolve(options.sessionRoot);
    } else if (arg === "--pi") {
      [options.piCli, index] = valueAfter(args, index, arg);
      options.piCli = resolve(options.piCli);
    } else if (arg === "--tools") {
      [options.tools, index] = valueAfter(args, index, arg);
    } else if (arg === "--keep-workspaces") {
      options.keepWorkspaces = true;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        [
          "Usage: npm run test:e2e:controls -- [options]",
          "",
          "  --scenario <name|all>       Control scenario (default: all)",
          "  --repeat <n>                Repetitions per scenario (default: 1)",
          "  --timeout-ms <n>            Per-run timeout (default: 30000)",
          "  --scenario-file <path>      Scenario JSON file",
          "  --artifacts <path>          Artifact root",
          "  --workspaces <path>         Isolated workspace root",
          "  --sessions <path>           Session root",
          "  --pi <path>                 Pi CLI bundle path",
          "  --tools <list>              Active tools (default: todo)",
          "  --keep-workspaces           Keep successful workspaces",
        ].join("\n") + "\n",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

async function snapshot(rpc: StrictJsonlClient, sessionDir: string, timeoutMs: number): Promise<SessionSnapshot> {
  const entriesData = await rpc.data({ type: "get_entries" }, timeoutMs);
  if (!isRecord(entriesData) || !Array.isArray(entriesData.entries)) throw new Error("Pi RPC get_entries returned no entries array.");
  const state = await rpc.data({ type: "get_state" }, timeoutMs);
  const messages = await rpc.data({ type: "get_messages" }, timeoutMs);
  const stats = await rpc.data({ type: "get_session_stats" }, timeoutMs);
  const sessionFile = isRecord(state) && typeof state.sessionFile === "string" ? state.sessionFile : await findSessionFile(sessionDir);
  if (!sessionFile) throw new Error("Pi RPC did not expose a persisted session file.");
  return {
    entries: entriesData.entries,
    state,
    messages,
    stats,
    sessionText: await readFile(sessionFile, "utf8"),
  };
}

async function promptAndSettle(rpc: StrictJsonlClient, message: string, timeoutMs: number): Promise<void> {
  const response = await rpc.request({ type: "prompt", message }, timeoutMs);
  if (response.success !== true) throw new Error(`Pi RPC prompt failed: ${String(response.error ?? "unknown error")}`);
  await rpc.waitUntilSettled(timeoutMs);
}

async function runFixtureVerification(workspace: string, timeoutMs: number): Promise<{ code: number; output: string }> {
  return runCommand(
    process.execPath,
    [
      "--experimental-strip-types",
      "--test",
      join(workspace, "tests", "auth.test.ts"),
      join(workspace, "tests", "cache.test.ts"),
    ],
    workspace,
    timeoutMs,
  );
}

async function runControlScenario(
  options: ControlOptions,
  scenarioName: ControlScenario,
  definition: ScenarioDefinition,
  repeat: number,
): Promise<ControlOutcome> {
  const runId = `${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${safeName(scenarioName)}-r${repeat}-p${process.pid}`;
  const workspace = join(options.workspaceRoot, runId);
  const sessionDir = join(options.sessionRoot, runId);
  const agentDir = join(options.artifactRoot, "agent", runId);
  const contextTracePath = join(agentDir, "context-trace.jsonl");
  const startedAt = new Date().toISOString();
  const clients: StrictJsonlClient[] = [];
  let runnerError: string | undefined;
  let finalSnapshot: SessionSnapshot | undefined;
  let sessionPath: string | undefined;
  let restartTracePath: string | undefined;
  let compactTraceOffset: number | undefined;
  let forkSessionPath: string | undefined;

  await mkdir(options.workspaceRoot, { recursive: true });
  await mkdir(options.sessionRoot, { recursive: true });
  await mkdir(options.artifactRoot, { recursive: true });
  await initializeFixture(workspace);
  await writeAgentSettings(agentDir, scenarioName === "compact" ? { compactionKeepRecentTokens: 1 } : {});
  const before = await git(workspace, ["status", "--short", "--branch"]);

  try {
    const first = spawnPi(options, workspace, sessionDir, agentDir, scenarioName, runId, 0, undefined, contextTracePath);
    clients.push(first);
    await first.waitForStartup(options.timeoutMs);

    switch (scenarioName) {
      case "abort": {
        const response = await first.request({ type: "prompt", message: definition.prompt }, options.timeoutMs);
        if (response.success !== true) throw new Error(`Pi RPC prompt failed: ${String(response.error ?? "unknown error")}`);
        await sleep(50);
        const abort = await first.request({ type: "abort" }, options.timeoutMs);
        if (abort.success !== true) throw new Error(`Pi RPC abort failed: ${String(abort.error ?? "unknown error")}`);
        await first.waitUntilSettled(options.timeoutMs);
        break;
      }
      case "abort-during-model":
      case "abort-during-tool": {
        const target = scenarioName === "abort-during-model" ? "model" : "tool";
        const response = await first.request({ type: "prompt", message: definition.prompt }, options.timeoutMs);
        if (response.success !== true) throw new Error(`Pi RPC prompt failed: ${String(response.error ?? "unknown error")}`);
        await waitForActiveAbortTarget(first, contextTracePath, target, options.timeoutMs);
        const checkpoint = await snapshot(first, sessionDir, options.timeoutMs);
        if (!isRecord(checkpoint.state) || checkpoint.state.isStreaming !== true) throw new Error("Abort must run while the active plan's request is still streaming.");
        if (target === "tool" && first.records.some((record) => record.type === "tool_execution_end" && record.toolName === SCRIPTED_ABORT_TOOL)) {
          throw new Error("The abort probe finished before the user could cancel it.");
        }
        const providerCallsBeforeAbort = contextRecords(await readFile(contextTracePath, "utf8")).length;
        const abortStart = first.records.length;
        const abort = await first.request({ type: "abort" }, options.timeoutMs);
        if (abort.success !== true) throw new Error(`Pi RPC abort failed: ${String(abort.error ?? "unknown error")}`);
        await first.waitUntilSettled(options.timeoutMs);
        const aborted = await snapshot(first, sessionDir, options.timeoutMs);
        assertActiveTodoAbort(first.records.slice(abortStart), checkpoint.entries, aborted.entries, target);
        // Pi may emit an empty terminal error after cancelling a tool. That is not a new
        // model request: the provider trace, rather than message_start alone, is decisive.
        if (contextRecords(await readFile(contextTracePath, "utf8")).length !== providerCallsBeforeAbort) {
          throw new Error("The provider received another model request after the user aborted.");
        }
        const list = await readTodoList(first, options.timeoutMs);
        const plannedState = scoreRun(undefined, checkpoint.entries).todoTransitions.at(-1)?.state;
        if (!plannedState || !list.includes(`Goal: ${String(plannedState.goal)}`) || !list.includes("Todo 0/2 done — ACTIVE") ||
            list.includes("Warning:") || list.includes("Auto-continue paused.")) {
          throw new Error("The aborted runtime lost its active plan or exposed a pause/early-stop warning.");
        }
        // A new user request, not abort itself, is allowed to run again. The original
        // position must still have its initial correction; abort cannot consume it or pause the plan.
        const resumeStart = first.records.length;
        await promptAndSettle(first, "Resume the response using the existing active plan without changing its progress.", options.timeoutMs);
        const expected = definition.steps.at(-1);
        if (expected?.type !== "text") throw new Error("Abort recovery requires a final text step.");
        assertNormalAssistantText(first.records.slice(resumeStart), expected.text);
        const resumed = await snapshot(first, sessionDir, options.timeoutMs);
        const resumedScore = scoreRun(definition.expect, resumed.entries);
        if (!resumedScore.passed || JSON.stringify(resumedScore.todoTransitions.at(-1)?.state) !== JSON.stringify(plannedState)) {
          throw new Error("Explicitly resuming after abort lost the original plan or its unspent correction.");
        }
        break;
      }
      case "pending-follow-up": {
        const response = await first.request({ type: "prompt", message: definition.prompt }, options.timeoutMs);
        if (response.success !== true) throw new Error(`Pi RPC prompt failed: ${String(response.error ?? "unknown error")}`);
        await sleep(50);
        const followUp = await first.request({ type: "follow_up", message: "Keep the active plan and finish the queued request." }, options.timeoutMs);
        if (followUp.success !== true) throw new Error(`Pi RPC follow_up failed: ${String(followUp.error ?? "unknown error")}`);
        await first.waitUntilSettled(options.timeoutMs);
        break;
      }
      case "compact": {
        await promptAndSettle(first, definition.prompt, options.timeoutMs);
        const saved = scoreRun(undefined, (await snapshot(first, sessionDir, options.timeoutMs)).entries);
        const savedState = saved.todoTransitions.at(-1)?.state;
        if (!saved.passed || !savedState || !Array.isArray(savedState.items)) throw new Error("Compaction requires a valid active Todo snapshot.");
        const current = savedState.items[Number(savedState.cursor)];
        const compact = await first.request({ type: "compact", customInstructions: "Preserve the active Todo state and current stage." }, options.timeoutMs);
        if (compact.success !== true) throw new Error(`Pi RPC compact failed: ${String(compact.error ?? "unknown error")}`);
        // Both history and split-turn summaries have finished. Only the next request may
        // satisfy the recovery assertion; earlier contexts already contain the same goal.
        compactTraceOffset = (await readFile(contextTracePath, "utf8")).length;
        const responseStart = first.records.length;
        await promptAndSettle(first, "Continue after the context compaction.", options.timeoutMs);
        const expected = definition.steps.at(-1);
        if (expected?.type !== "text") throw new Error("Compaction recovery requires a final text step.");
        assertNormalAssistantText(first.records.slice(responseStart), expected.text);
        assertPromptContextReminder(
          (await readFile(contextTracePath, "utf8")).slice(compactTraceOffset),
          "Continue after the context compaction.",
          [String(savedState.title), String(savedState.goal), ...(isRecord(current) && typeof current.description === "string" ? [current.description] : [])],
        );
        const afterCompact = scoreRun(undefined, (await snapshot(first, sessionDir, options.timeoutMs)).entries);
        if (JSON.stringify(afterCompact.todoTransitions.at(-1)?.state) !== JSON.stringify(savedState)) {
          throw new Error("Compaction changed the saved plan title, full goal, descriptions or undo.");
        }
        break;
      }
      case "pause-during-model": {
        const response = await first.request({ type: "prompt", message: definition.prompt }, options.timeoutMs);
        if (response.success !== true) throw new Error(`Pi RPC prompt failed: ${String(response.error ?? "unknown error")}`);
        await waitForNudgeModel(first, contextTracePath, options.timeoutMs);
        const active = await first.data({ type: "get_state" }, options.timeoutMs);
        if (!isRecord(active) || active.isStreaming !== true) throw new Error("Pause must be exercised while the nudged model response is running.");
        const pauseStart = first.records.length;
        const pause = await first.data({ type: "prompt", message: "/todos pause" }, options.timeoutMs);
        if (!isRecord(pause) || pause.disposition !== "handled") throw new Error("Pause was queued instead of handled immediately.");
        const afterPause = await first.data({ type: "get_state" }, options.timeoutMs);
        if (!isRecord(afterPause) || afterPause.isStreaming !== true) throw new Error("Pause aborted or waited for the in-flight model response.");
        await first.waitUntilSettled(options.timeoutMs);
        const tail = first.records.slice(pauseStart);
        const expected = definition.steps.at(-1);
        if (expected?.type !== "text") throw new Error("Pause recovery requires a final text step.");
        assertNormalAssistantText(tail, expected.text);
        if (tail.some((record) => record.type === "entry_appended" && isRecord(record.entry) && record.entry.customType === "linear-todo-auto-continue")) {
          throw new Error("Todo continued automatically after the user paused it.");
        }
        if (!tail.some((record) => record.type === "agent_settled" && record.aborted === false)) throw new Error("The paused run did not settle normally.");
        const widgets = tail.filter((record) => record.type === "extension_ui_request" && record.method === "setWidget" && record.widgetKey === "linear-todo" && Array.isArray(record.widgetLines));
        if (widgets.length === 0 || !JSON.stringify(widgets.at(-1)?.widgetLines).includes("自动续跑已暂停")) throw new Error("The settled Todo widget did not remain paused.");
        if (widgets.some((record) => JSON.stringify(record.widgetLines).includes("提前停止"))) throw new Error("A user-paused Todo incorrectly displayed an early-stop warning.");
        const list = await readTodoList(first, options.timeoutMs);
        if (!list.includes("Auto-continue paused.") || list.includes("Warning:")) throw new Error("The paused Todo list contained an inconsistent pause or warning state.");
        break;
      }
      case "fork-switch-recovery": {
        await promptAndSettle(first, definition.prompt, options.timeoutMs);
        const checkpoint = await snapshot(first, sessionDir, options.timeoutMs);
        const checkpointScore = scoreRun(definition.expect, checkpoint.entries);
        if (!checkpointScore.passed) throw new Error(`Invalid branch checkpoint: ${checkpointScore.issues.join("; ")}`);
        const advancePrompt = "Advance only the first task on the original branch.";
        const responseStart = first.records.length;
        await promptAndSettle(first, advancePrompt, options.timeoutMs);
        const expected = definition.steps.at(-1);
        if (expected?.type !== "text") throw new Error("Branch progression requires a final text step.");
        assertNormalAssistantText(first.records.slice(responseStart), expected.text);
        const original = await snapshot(first, sessionDir, options.timeoutMs);
        const originalScore = scoreRun({ ...definition.expect, todoActions: ["plan", "advance"], todoToolCalls: 2, autoContinueMessages: 2, finalTodoCursor: 1 }, original.entries);
        if (!originalScore.passed) throw new Error(`Invalid original branch: ${originalScore.issues.join("; ")}`);
        if (!isRecord(original.state) || typeof original.state.sessionFile !== "string") throw new Error("The original branch did not expose its session file.");
        sessionPath = original.state.sessionFile;
        const forkPoint = original.entries.find((entry) => isRecord(entry) && entry.type === "message" && isRecord(entry.message) && entry.message.role === "user" && contentText(entry.message.content) === advancePrompt);
        if (!isRecord(forkPoint) || typeof forkPoint.id !== "string") throw new Error("The original branch did not persist its forkable user message.");

        const assertRestored = async (expectedScore: ScoreResult): Promise<void> => {
          const restored = await snapshot(first, sessionDir, options.timeoutMs);
          const actual = scoreRun(undefined, restored.entries);
          const wantedState = expectedScore.todoTransitions.at(-1)?.state;
          if (JSON.stringify(actual.todoTransitions.at(-1)?.state) !== JSON.stringify(wantedState) || JSON.stringify(actual.metrics) !== JSON.stringify(expectedScore.metrics)) {
            throw new Error("Switching branches leaked a Todo snapshot or its persisted continuation ledger.");
          }
          if (!wantedState || typeof wantedState.cursor !== "number" || !Array.isArray(wantedState.items)) throw new Error("The expected branch state was not active.");
          const current = wantedState.items[wantedState.cursor];
          const list = await readTodoList(first, options.timeoutMs);
          if (!isRecord(current) || !list.includes(`Todo ${wantedState.cursor}/${wantedState.items.length}`) || !list.includes(`Goal: ${String(wantedState.goal)}`) || !list.includes(`→ ${wantedState.cursor + 1}. ${String(current.title)}`)) {
            throw new Error("The restored runtime's Todo list did not match the selected branch.");
          }
          const taskResults = wantedState.items.filter(isRecord).flatMap((item) => typeof item.result === "string" ? [item.result] : []);
          if (taskResults.some((result) => !list.includes(`result: ${result}`)) || (taskResults.length === 0 && list.includes(" — result: "))) {
            throw new Error("The restored runtime exposed a task result from the wrong branch.");
          }
        };

        // RPC has fork/switch_session, not the TUI's in-file /tree navigation.
        // Fork before the second user prompt: the new runtime must restore cursor 0,
        // whereas the original session has already advanced to cursor 1.
        const fork = await first.data({ type: "fork", entryId: forkPoint.id }, options.timeoutMs);
        if (!isRecord(fork) || fork.cancelled !== false) throw new Error("The native RPC fork was cancelled.");
        const forkState = await first.data({ type: "get_state" }, options.timeoutMs);
        if (!isRecord(forkState) || typeof forkState.sessionFile !== "string" || forkState.sessionFile === sessionPath) throw new Error("RPC fork did not create an independent session file.");
        forkSessionPath = forkState.sessionFile;
        await assertRestored(checkpointScore);
        const toOriginal = await first.data({ type: "switch_session", sessionPath }, options.timeoutMs);
        if (!isRecord(toOriginal) || toOriginal.cancelled !== false) throw new Error("Switching to the original session was cancelled.");
        await assertRestored(originalScore);
        const toFork = await first.data({ type: "switch_session", sessionPath: forkSessionPath }, options.timeoutMs);
        if (!isRecord(toFork) || toFork.cancelled !== false) throw new Error("Switching to the forked session was cancelled.");
        await assertRestored(checkpointScore);
        break;
      }
      case "host-error-recovery":
      case "recover": {
        await promptAndSettle(first, definition.prompt, options.timeoutMs);
        const checkpoint = await snapshot(first, sessionDir, options.timeoutMs);
        const savedScore = scoreRun(undefined, checkpoint.entries);
        const savedState = savedScore.todoTransitions.at(-1)?.state;
        if (!savedScore.passed || !savedState) throw new Error("Recovery scenario did not persist a valid plan before restarting.");
        if (!isRecord(checkpoint.state) || typeof checkpoint.state.sessionFile !== "string") throw new Error("Recovery scenario could not find the initial session file.");
        sessionPath = checkpoint.state.sessionFile;
        if (scenarioName === "recover" && (!isRecord(savedState.undo) || !isRecord(savedState.undo.state))) {
          throw new Error("Recovery must exercise a non-empty persisted undo pre-image.");
        }
        await first.close(1_000);

        // Trace the restarted process separately: the first process already injected reminders for
        // the same plan, so a shared trace would make the post-restart assertion vacuous.
        // The restarted process resumes after the steps the first process consumed.
        const restartStepOffset = 4;
        restartTracePath = contextTracePath.replace(/\.jsonl$/, "-restart.jsonl");
        const second = spawnPi(options, workspace, sessionDir, agentDir, scenarioName, runId, restartStepOffset, sessionPath, restartTracePath);
        clients.push(second);
        await second.waitForStartup(options.timeoutMs);
        const restored = await snapshot(second, sessionDir, options.timeoutMs);
        const restoredScore = scoreRun(undefined, restored.entries);
        if (!restoredScore.passed || JSON.stringify(restoredScore.todoTransitions.at(-1)?.state) !== JSON.stringify(savedState) ||
            JSON.stringify(restoredScore.metrics) !== JSON.stringify(savedScore.metrics)) {
          throw new Error("The restarted process lost the saved title, goal, task descriptions, undo or continuation ledger.");
        }
        const list = await readTodoList(second, options.timeoutMs);
        const savedItems = Array.isArray(savedState.items) ? savedState.items.filter(isRecord) : [];
        const details = [savedState.title, savedState.goal, ...savedItems.flatMap((item) => [item.title, item.description])]
          .filter((value): value is string => typeof value === "string");
        if (details.some((value) => !list.includes(value))) throw new Error("The restored Todo list lost a title, full goal or task description.");
        const current = savedItems[Number(savedState.cursor)];
        const expectedHeader = `计划：${String(savedState.title)} · ${savedState.cursor}/${savedItems.length}`;
        const restoredPanel = second.records.filter((record) => record.type === "extension_ui_request"
          && record.method === "setWidget" && record.widgetKey === "linear-todo").at(-1)?.widgetLines;
        const cursor = Number(savedState.cursor);
        const completedRows = savedItems.slice(Math.max(0, cursor - 2), cursor).map((item) => `  ✓ ${String(item.title)}`);
        if (!Array.isArray(restoredPanel) || restoredPanel[0] !== expectedHeader ||
            !restoredPanel.includes(`  → ${String(current?.title)}`) || completedRows.some((row) => !restoredPanel.includes(row))) {
          throw new Error("The restarted process did not restore the saved plan, recent completions and current task in its Widget.");
        }
        const recoveryPrompt = "Resume the current stage from the restored session.";
        const responseStart = second.records.length;
        await promptAndSettle(second, recoveryPrompt, options.timeoutMs);
        const expected = definition.steps.at(-1);
        if (expected?.type !== "text") throw new Error("Restart recovery requires a final text step.");
        assertNormalAssistantText(second.records.slice(responseStart), expected.text);
        assertPromptContextReminder(await readFile(restartTracePath, "utf8"), recoveryPrompt,
          [String(savedState.title), String(savedState.goal), ...(typeof current?.description === "string" ? [current.description] : [])]);
        if (scenarioName === "recover") {
          const afterUndo = scoreRun(definition.expect, (await snapshot(second, sessionDir, options.timeoutMs)).entries);
          const undoState = isRecord(savedState.undo) ? savedState.undo.state : undefined;
          const actual = afterUndo.todoTransitions.at(-1)?.state;
          if (!afterUndo.passed || !actual || !isRecord(undoState) || actual.title !== undoState.title || actual.goal !== undoState.goal ||
              actual.cursor !== undoState.cursor || JSON.stringify(actual.items) !== JSON.stringify(undoState.items)) {
            throw new Error("Undo after restart failed to restore the complete persisted task pre-image and plan scope.");
          }
        }
        break;
      }
      case "error":
        await promptAndSettle(first, definition.prompt, options.timeoutMs);
        break;
    }

    const last = clients[clients.length - 1]!;
    finalSnapshot = await snapshot(last, sessionDir, options.timeoutMs);
    const finalTodo = scoreRun(undefined, finalSnapshot.entries).todoTransitions.at(-1)?.state;
    if (finalTodo?.phase === "completed") {
      const finalPanel = last.records.filter((record) => record.type === "extension_ui_request"
        && record.method === "setWidget" && record.widgetKey === "linear-todo").at(-1)?.widgetLines;
      if (finalPanel !== undefined) {
        throw new Error("The settled completed plan must clear its Widget while keeping the completed state in the session.");
      }
    }
  } catch (error) {
    runnerError = error instanceof Error ? error.message : String(error);
  } finally {
    for (const client of clients) await client.close(1_000);
  }

  const after = await git(workspace, ["diff", "--no-ext-diff"]);
  const verification = await runFixtureVerification(workspace, options.timeoutMs);
  const entries = finalSnapshot?.entries ?? [];
  const score = scoreRun(definition.expect, entries);
  if (runnerError) {
    score.issues.unshift(`runner error: ${runnerError}`);
    score.score = 0;
    score.passed = false;
    score.hardFail = true;
  }
  if (verification.code !== 0) {
    score.issues.push(`fixture verification failed with exit code ${String(verification.code)}`);
    score.score = 0;
    score.passed = false;
    score.hardFail = true;
  }

  let contextTrace = "";
  try {
    contextTrace = await readFile(restartTracePath ?? contextTracePath, "utf8");
  } catch {
    // Context tracing is optional for scenarios that do not reach a provider request.
  }
  const requiredReminder =
    scenarioName === "recover"
      ? "Restore the active session plan"
      : scenarioName === "host-error-recovery"
        ? "Keep the plan readable after a host error"
        : undefined;
  if (requiredReminder && !traceContainsReminder(contextTrace, requiredReminder)) {
    score.issues.push(`expected Todo reminder was not observed after ${scenarioName}`);
    score.score = 0;
    score.passed = false;
  }

  const artifactDirectory = await writeArtifactBundle(options.artifactRoot, runId, {
    run: {
      runId,
      scenario: scenarioName,
      repeat,
      variant: "todo-enabled",
      provider: "linear-todo-scripted",
      model: "linear-todo-scripted",
      thinking: "off",
      mode: "rpc",
      cwd: workspace,
      startedAt,
      finishedAt: new Date().toISOString(),
      runnerError,
      sessionPath,
      forkSessionPath,
      compactTraceOffset,
      rpcState: finalSnapshot?.state,
      rpcStats: finalSnapshot?.stats,
      rpcMessages: finalSnapshot?.messages,
    },
    prompt: definition.prompt + "\n",
    events: clients.flatMap((client) => client.records).map((record) => JSON.stringify(record)).join("\n") + (clients.length > 0 ? "\n" : ""),
    session: finalSnapshot?.sessionText ?? "",
    stdout: clients.map((client) => client.stdout).join("\n"),
    stderr: clients.map((client) => client.stderr).join("\n"),
    repoBefore: before.output,
    repoAfterDiff: after.output,
    verification: verification.output,
    todoTransitions: score.todoTransitions,
    score,
    contextTrace,
  });

  if (!options.keepWorkspaces && score.passed) await rm(workspace, { recursive: true, force: true });
  return { runId, artifactDirectory, passed: score.passed && !score.hardFail, score };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const scenarioFile = await loadScenarioFile(options.scenarioFile);
  const names = options.scenario === "all" ? [...CONTROL_SCENARIOS] : [options.scenario as ControlScenario];
  const outcomes: ControlOutcome[] = [];

  for (const scenarioName of names) {
    if (!CONTROL_SCENARIOS.includes(scenarioName as ControlScenario)) {
      throw new Error(`Unknown control scenario ${JSON.stringify(scenarioName)}. Available: ${CONTROL_SCENARIOS.join(", ")}`);
    }
    const definition = getScenario(scenarioFile, scenarioName);
    for (let repeat = 1; repeat <= options.repeat; repeat += 1) {
      process.stdout.write(`[e2e:controls] ${scenarioName} repeat ${repeat}/${options.repeat} ... `);
      const outcome = await runControlScenario(options, scenarioName as ControlScenario, definition, repeat);
      outcomes.push(outcome);
      process.stdout.write(`${outcome.passed ? "PASS" : "FAIL"} (${outcome.artifactDirectory})\n`);
    }
  }

  const failed = outcomes.filter((outcome) => !outcome.passed);
  process.stdout.write(`\nControl E2E: ${outcomes.length - failed.length}/${outcomes.length} passed\n`);
  if (failed.length > 0) {
    for (const outcome of failed) process.stdout.write(`- ${outcome.runId}: ${outcome.score.issues.join("; ")}\n`);
    process.exitCode = 1;
  }
}

if (isMainModule(import.meta.url)) await main();
