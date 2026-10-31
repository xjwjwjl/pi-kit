import { isMainModule } from "./is-main.ts";
import { writeFileSync } from "node:fs";
import { copyFile, cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  findSessionFile,
  git,
  initializeFixture,
  runCommand,
  StrictJsonlClient,
  writeAgentSettings,
} from "./run-rpc-e2e.ts";
import { writeArtifactBundle } from "./collect-artifacts.ts";
import {
  getModelScenario,
  loadModelScenarioFile,
  type ModelScenarioDefinition,
  type ModelTurn,
  type ModelVerificationCommand,
} from "./model-scenarios.ts";
import { scoreModelRun, type ModelScoreResult, type ModelVerificationOutcome } from "./score-run.ts";

const E2E_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = resolve(E2E_DIR, "..");
const DEFAULT_SCENARIO_FILE = join(E2E_DIR, "scenarios", "model-eval.json");
const DEFAULT_ARTIFACT_ROOT = join(PROJECT_DIR, ".e2e", "artifacts");
const DEFAULT_WORKSPACE_ROOT = join(PROJECT_DIR, ".e2e", "workspaces");
const DEFAULT_SESSION_ROOT = join(PROJECT_DIR, ".e2e", "sessions");
const ACCEPTANCE_ROOT = join(E2E_DIR, "fixtures", "acceptance");
const PI_CLI = join(PROJECT_DIR, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
const TODO_EXTENSION = join(PROJECT_DIR, "index.ts");
const AUTH_BRIDGE_EXTENSION = join(E2E_DIR, "auth-bridge.ts");
const SMOKE_SCENARIOS = ["M01", "M03", "M06", "M08", "M11", "M14", "M15"] as const;
const VARIANTS = ["baseline", "todo-enabled"] as const;
type ModelVariant = (typeof VARIANTS)[number];

type EvaluationPreset = "smoke" | "full";
type EvaluationOrder = "interleaved" | "baseline-first";

interface ModelTarget {
  raw: string;
  provider: string;
  modelId: string;
}

interface Options {
  preset: EvaluationPreset;
  models: ModelTarget[];
  scenarioNames?: string[];
  repeats: number;
  variants: ModelVariant[];
  order: EvaluationOrder;
  thinking: string;
  timeoutMs: number;
  scenarioFile: string;
  artifactRoot: string;
  workspaceRoot: string;
  sessionRoot: string;
  piCli: string;
  keepWorkspaces: boolean;
  dryRun: boolean;
}

interface JsonRecord {
  [key: string]: unknown;
}

interface CapturedSession {
  entries: unknown[];
  state: unknown;
  messages: unknown;
  stats: unknown;
  sessionText: string;
  finalResponse?: string;
}

interface EvaluationOutcome {
  runId: string;
  artifactDirectory: string;
  score: ModelScoreResult;
}

interface ResolvedModelAuth {
  provider: string;
  authType?: "api_key" | "oauth";
  credential: string;
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

function parseModelTarget(rawValue: string): ModelTarget {
  const raw = rawValue.trim();
  const slash = raw.indexOf("/");
  if (slash <= 0 || slash === raw.length - 1) throw new Error(`Model must use provider/model format: ${JSON.stringify(raw)}`);
  return { raw, provider: raw.slice(0, slash), modelId: raw.slice(slash + 1) };
}

function parseVariants(value: string): ModelVariant[] {
  const requested = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (requested.length === 0) return [...VARIANTS];
  if (requested.includes("both")) {
    if (requested.length !== 1) throw new Error(`Variants cannot combine both with another value: ${value}`);
    return [...VARIANTS];
  }
  const variants = [...new Set(requested)].filter((item): item is ModelVariant => VARIANTS.includes(item as ModelVariant));
  if (variants.length !== requested.length) throw new Error(`Variants must be both, baseline, or todo-enabled: ${value}`);
  return variants;
}

function parseOptions(args: string[]): Options {
  const options: Options = {
    preset: "smoke",
    models: [],
    repeats: 1,
    variants: [...VARIANTS],
    order: "interleaved",
    thinking: "medium",
    timeoutMs: 300_000,
    scenarioFile: DEFAULT_SCENARIO_FILE,
    artifactRoot: DEFAULT_ARTIFACT_ROOT,
    workspaceRoot: DEFAULT_WORKSPACE_ROOT,
    sessionRoot: DEFAULT_SESSION_ROOT,
    piCli: PI_CLI,
    keepWorkspaces: false,
    dryRun: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--preset") {
      const [value, nextIndex] = valueAfter(args, index, arg);
      if (value !== "smoke" && value !== "full") throw new Error(`${arg} must be smoke or full`);
      options.preset = value;
      options.repeats = value === "full" ? 3 : 1;
      index = nextIndex;
    } else if (arg === "--models") {
      const [value, nextIndex] = valueAfter(args, index, arg);
      options.models = value.split(",").map(parseModelTarget);
      index = nextIndex;
    } else if (arg === "--scenarios") {
      const [value, nextIndex] = valueAfter(args, index, arg);
      options.scenarioNames = value.split(",").map((item) => item.trim()).filter(Boolean);
      index = nextIndex;
    } else if (arg === "--repeats" || arg === "--repeat") {
      const [value, nextIndex] = valueAfter(args, index, arg);
      options.repeats = positiveInteger(value, arg);
      index = nextIndex;
    } else if (arg === "--variants") {
      const [value, nextIndex] = valueAfter(args, index, arg);
      options.variants = parseVariants(value);
      index = nextIndex;
    } else if (arg === "--thinking") {
      [options.thinking, index] = valueAfter(args, index, arg);
    } else if (arg === "--order") {
      const [value, nextIndex] = valueAfter(args, index, arg);
      if (value !== "interleaved" && value !== "baseline-first") throw new Error(`${arg} must be interleaved or baseline-first`);
      options.order = value;
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
    } else if (arg === "--keep-workspaces") {
      options.keepWorkspaces = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        [
          "Usage: npm run eval:smoke -- --models provider/model[,provider/model] [options]",
          "",
          "  --preset <smoke|full>       Smoke: 7 scenarios/1 repeat; full: all/3 repeats",
          "  --models <list>             Comma-separated provider/model IDs",
          "  --scenarios <list>          Override scenario IDs (M01..M15)",
          "  --repeats <n>               Repetitions per scenario/variant",
          "  --variants <list>           both, baseline, or todo-enabled",
          "  --thinking <level>          off/minimal/low/medium/high/xhigh/max",
          "  --order <mode>              interleaved or baseline-first",
          "  --timeout-ms <n>            Per-run timeout (default: 300000)",
          "  --scenario-file <path>      Model scenario JSON file",
          "  --artifacts <path>          Artifact root",
          "  --workspaces <path>         Isolated workspace root",
          "  --sessions <path>           Session root",
          "  --pi <path>                 Pi CLI bundle path",
          "  --keep-workspaces           Keep successful workspaces",
          "  --dry-run                   Validate and print the run matrix only",
        ].join("\n") + "\n",
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (options.models.length === 0) throw new Error("--models is required, for example --models anthropic/claude-sonnet-4-5");
  return options;
}

function parseLastJsonObject(output: string): JsonRecord | undefined {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const value = JSON.parse(lines[index]!) as unknown;
      if (isRecord(value)) return value;
    } catch {
      // Ignore non-JSON diagnostics and keep scanning backwards.
    }
  }
  return undefined;
}

async function resolveModelAuth(options: Options, model: ModelTarget): Promise<ResolvedModelAuth> {
  const result = await runCommand(
    process.execPath,
    [options.piCli, "auth", "check", "--model", model.raw, "--json", "--credentials"],
    PROJECT_DIR,
    30_000,
  );
  const payload = parseLastJsonObject(result.output);
  const status = payload?.status;
  const provider = typeof payload?.provider === "string" ? payload.provider : model.provider;
  if (result.code !== 0 || status !== "ready" || typeof payload?.credentials !== "string" || !payload.credentials) {
    const reason = typeof payload?.reason === "string" ? payload.reason : "credential unavailable";
    throw new Error(`Model auth preflight failed for ${model.raw}: ${reason}`);
  }
  const authType = payload.authType === "api_key" || payload.authType === "oauth" ? payload.authType : undefined;
  return { provider, credential: payload.credentials, ...(authType === undefined ? {} : { authType }) };
}

async function copyOptional(source: string, destination: string): Promise<void> {
  try {
    await copyFile(source, destination);
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
    if (code !== "ENOENT") throw error;
  }
}

async function prepareRuntimeAgentDir(
  agentDir: string,
  options: { compactionKeepRecentTokens?: number },
): Promise<void> {
  await writeAgentSettings(agentDir, options);
  const sourceAgentDir = getAgentDir();
  await Promise.all([
    copyOptional(join(sourceAgentDir, "models.json"), join(agentDir, "models.json")),
    copyOptional(join(sourceAgentDir, "models-store.json"), join(agentDir, "models-store.json")),
  ]);
}

function buildRunMatrix(options: Options, scenarioNames: string[]): Array<{ model: ModelTarget; scenario: string; variant: ModelVariant; repeat: number }> {
  const matrix: Array<{ model: ModelTarget; scenario: string; variant: ModelVariant; repeat: number }> = [];
  const add = (variant: ModelVariant) => {
    for (let repeat = 1; repeat <= options.repeats; repeat += 1) {
      for (const model of options.models) {
        for (const scenario of scenarioNames) matrix.push({ model, scenario, variant, repeat });
      }
    }
  };

  if (options.order === "baseline-first") {
    for (const variant of options.variants) add(variant);
  } else {
    for (let repeat = 1; repeat <= options.repeats; repeat += 1) {
      for (const model of options.models) {
        for (const scenario of scenarioNames) {
          for (const variant of options.variants) matrix.push({ model, scenario, variant, repeat });
        }
      }
    }
  }
  return matrix;
}

function spawnModelPi(
  options: Options,
  model: ModelTarget,
  variant: ModelVariant,
  workspace: string,
  sessionDir: string,
  agentDir: string,
  runId: string,
  auth: ResolvedModelAuth,
  sessionPath?: string,
): StrictJsonlClient {
  const args = [
    options.piCli,
    "--mode",
    "rpc",
    "--approve",
    "--no-extensions",
    "-e",
    AUTH_BRIDGE_EXTENSION,
    ...(variant === "todo-enabled" ? ["-e", TODO_EXTENSION] : []),
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--model",
    model.raw,
    "--thinking",
    options.thinking,
    "--tools",
    variant === "todo-enabled" ? "read,bash,edit,write,todo" : "read,bash,edit,write",
    "--session-dir",
    sessionDir,
    ...(sessionPath ? ["--session", sessionPath] : []),
    "--name",
    runId,
  ];
  // The credential travels as a short-lived file inside the throwaway agent directory: the child
  // environment is inherited by the agent's own bash tool, so it must never hold the secret.
  // It is rewritten before every spawn because the bridge deletes it as soon as it starts.
  const credentialFile = join(agentDir, "eval-credential");
  writeFileSync(credentialFile, auth.credential, { mode: 0o600 });

  const child = spawn(process.execPath, args, {
    cwd: workspace,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
      LINEAR_TODO_EVAL_MODEL: model.raw,
      LINEAR_TODO_EVAL_VARIANT: variant,
      LINEAR_TODO_EVAL_AUTH_PROVIDER: auth.provider,
      LINEAR_TODO_EVAL_AUTH_CREDENTIAL_FILE: credentialFile,
      LINEAR_TODO_EVAL_RUN_ID: runId,
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  return new StrictJsonlClient(child);
}

async function requestPrompt(client: StrictJsonlClient, message: string, timeoutMs: number): Promise<void> {
  const response = await client.request({ type: "prompt", message }, timeoutMs);
  if (response.success !== true) throw new Error(`Pi RPC prompt failed: ${String(response.error ?? "unknown error")}`);
}

async function requestTurn(client: StrictJsonlClient, turn: ModelTurn, timeoutMs: number): Promise<void> {
  const delivery = turn.delivery ?? "prompt";
  const command = delivery === "steer" ? "steer" : delivery === "followUp" ? "follow_up" : "prompt";
  const response = await client.request({ type: command, message: turn.message }, timeoutMs);
  if (response.success !== true) throw new Error(`Pi RPC ${command} failed: ${String(response.error ?? "unknown error")}`);
}

async function snapshot(client: StrictJsonlClient, sessionDir: string, timeoutMs: number): Promise<CapturedSession> {
  const entriesData = await client.data({ type: "get_entries" }, timeoutMs);
  if (!isRecord(entriesData) || !Array.isArray(entriesData.entries)) throw new Error("Pi RPC get_entries returned no entries array.");
  const state = await client.data({ type: "get_state" }, timeoutMs);
  const messages = await client.data({ type: "get_messages" }, timeoutMs);
  const stats = await client.data({ type: "get_session_stats" }, timeoutMs);
  const finalText = await client.data({ type: "get_last_assistant_text" }, timeoutMs);
  const sessionFile = isRecord(state) && typeof state.sessionFile === "string" ? state.sessionFile : await findSessionFile(sessionDir);
  if (!sessionFile) throw new Error("Pi RPC did not expose a persisted session file.");
  return {
    entries: entriesData.entries,
    state,
    messages,
    stats,
    sessionText: await readFile(sessionFile, "utf8"),
    ...(isRecord(finalText) && typeof finalText.text === "string" ? { finalResponse: finalText.text } : {}),
  };
}

async function runCommands(
  commands: ModelVerificationCommand[] | undefined,
  workspace: string,
  timeoutMs: number,
): Promise<{ passed: boolean; output: string; results: Array<{ name: string; code: number }> }> {
  const list = commands ?? [];
  if (list.length === 0) return { passed: true, output: "No commands configured.\n", results: [] };
  const results: Array<{ name: string; code: number }> = [];
  const outputs: string[] = [];
  for (const entry of list) {
    const result = await runCommand(entry.command, entry.args, workspace, entry.timeoutMs ?? timeoutMs);
    results.push({ name: entry.name, code: result.code });
    outputs.push(`## ${entry.name}\n$ ${entry.command} ${entry.args.join(" ")}\nexit: ${String(result.code)}\n${result.output}`);
  }
  return {
    passed: results.every((result) => result.code === 0),
    output: outputs.join("\n\n") + "\n",
    results,
  };
}

/** Copies the scenario's acceptance tests into the isolated index baseline, without a commit. */
async function stageAcceptance(scenario: ModelScenarioDefinition, workspace: string): Promise<void> {
  if (!scenario.acceptanceFixture) return;
  const source = join(ACCEPTANCE_ROOT, scenario.acceptanceFixture, "check.test.ts");
  await mkdir(join(workspace, "acceptance"), { recursive: true });
  await cp(source, join(workspace, "acceptance", "check.test.ts"));
  const staged = await git(workspace, ["add", "acceptance"]);
  if (staged.code !== 0) throw new Error(`git add acceptance failed: ${staged.output}`);
}

/** Compare against an immutable tree, not HEAD or the model's potentially changed index. */
export async function readWorkspaceChanges(workspace: string, baselineTree: string): Promise<{
  diff: string;
  status: string;
  untracked: string;
  diagnostics: string;
}> {
  const diff = await git(workspace, ["diff", "--no-ext-diff", baselineTree, "--"]);
  const status = await git(workspace, ["status", "--porcelain", "-uall"]);
  const untracked = await git(workspace, ["ls-files", "--others", "--exclude-standard"]);
  for (const result of [diff, status, untracked]) {
    if (result.code !== 0) throw new Error(`Could not inspect evaluation workspace: ${result.output}`);
  }
  return {
    diff: diff.stdout,
    status: status.stdout,
    untracked: untracked.stdout,
    diagnostics: diff.stderr + status.stderr + untracked.stderr,
  };
}

/**
 * Restores the acceptance tests from the pristine fixture. A model may read them (that is the
 * contract it is asked to satisfy) but editing them cannot buy points.
 */
async function restoreAcceptance(scenario: ModelScenarioDefinition, workspace: string): Promise<void> {
  if (!scenario.acceptanceFixture) return;
  const source = join(ACCEPTANCE_ROOT, scenario.acceptanceFixture, "check.test.ts");
  await mkdir(join(workspace, "acceptance"), { recursive: true });
  await cp(source, join(workspace, "acceptance", "check.test.ts"), { force: true });
}

async function runModelCase(
  options: Options,
  model: ModelTarget,
  scenarioName: string,
  scenario: ModelScenarioDefinition,
  variant: ModelVariant,
  repeat: number,
  auth: ResolvedModelAuth,
): Promise<EvaluationOutcome> {
  const runId = `${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${safeName(model.raw)}-${scenarioName}-${variant}-r${repeat}-p${process.pid}`;
  const workspace = join(options.workspaceRoot, runId);
  const sessionDir = join(options.sessionRoot, runId);
  const agentDir = await mkdtemp(join(tmpdir(), "linear-todo-eval-"));
  const startedAt = Date.now();
  const clients: StrictJsonlClient[] = [];
  let runnerError: string | undefined;
  let finalSnapshot: CapturedSession | undefined;
  let sessionPath: string | undefined;
  let baselineTree: string | undefined;
  let preconditionAcceptance: ModelVerificationOutcome = { passed: true, results: [] };
  let preconditionRegression: ModelVerificationOutcome = { passed: true, results: [] };

  await mkdir(options.workspaceRoot, { recursive: true });
  await mkdir(options.sessionRoot, { recursive: true });
  await mkdir(options.artifactRoot, { recursive: true });
  let before = { code: 1, output: "Fixture setup did not complete.\n" };

  try {
    await initializeFixture(workspace);
    await stageAcceptance(scenario, workspace);
    const baseline = await git(workspace, ["write-tree"]);
    if (baseline.code !== 0) throw new Error(`Could not capture evaluation baseline: ${baseline.output}`);
    baselineTree = baseline.stdout.trim();
    await prepareRuntimeAgentDir(
      agentDir,
      scenario.compactAfterTurn === undefined ? {} : { compactionKeepRecentTokens: 1 },
    );
    before = await git(workspace, ["status", "--short", "--branch"]);
    // The oracle must be able to tell "done" from "not done": it has to fail before the run.
    preconditionAcceptance = await runCommands(scenario.acceptance, workspace, options.timeoutMs);
    preconditionRegression = await runCommands(scenario.regression, workspace, options.timeoutMs);
    let current = spawnModelPi(options, model, variant, workspace, sessionDir, agentDir, runId, auth);
    clients.push(current);

    if (scenario.abortAfterMs !== undefined) {
      const firstTurn = scenario.turns[0]!;
      await requestPrompt(current, firstTurn.message, options.timeoutMs);
      await sleep(scenario.abortAfterMs);
      const abort = await current.request({ type: "abort" }, options.timeoutMs);
      if (abort.success !== true) throw new Error(`Pi RPC abort failed: ${String(abort.error ?? "unknown error")}`);
      await current.waitUntilSettled(options.timeoutMs);
    } else {
      let turnIndex = 0;
      while (turnIndex < scenario.turns.length) {
        const turn = scenario.turns[turnIndex]!;
        const next = scenario.turns[turnIndex + 1];
        const canInterrupt = turnIndex === 0 && next && (next.delivery === "steer" || next.delivery === "followUp") && next.afterMs !== undefined;
        if (canInterrupt) {
          await requestPrompt(current, turn.message, options.timeoutMs);
          await sleep(next.afterMs!);
          await requestTurn(current, next, options.timeoutMs);
          await current.waitUntilSettled(options.timeoutMs);
          turnIndex += 2;
        } else {
          if ((turn.delivery ?? "prompt") === "prompt") await requestPrompt(current, turn.message, options.timeoutMs);
          else {
            if (turn.afterMs !== undefined) await sleep(turn.afterMs);
            await requestTurn(current, turn, options.timeoutMs);
          }
          await current.waitUntilSettled(options.timeoutMs);
          turnIndex += 1;
        }

        if (scenario.restartAfterTurn === turnIndex) {
          const state = await current.data({ type: "get_state" }, options.timeoutMs);
          if (!isRecord(state) || typeof state.sessionFile !== "string") throw new Error("Model evaluation restart could not find a persisted session file.");
          sessionPath = state.sessionFile;
          await current.close(1_000);
          current = spawnModelPi(options, model, variant, workspace, sessionDir, agentDir, runId, auth, sessionPath);
          clients.push(current);
          continue;
        }
        if (scenario.compactAfterTurn === turnIndex) {
          const compact = await current.request({ type: "compact", customInstructions: "Preserve the active Todo title and complete goal, current task title and execution description, acceptance condition, and next action. Never replace the full goal with its short title." }, options.timeoutMs);
          if (compact.success !== true) throw new Error(`Pi RPC compact failed: ${String(compact.error ?? "unknown error")}`);
        }
      }
    }

    finalSnapshot = await snapshot(current, sessionDir, options.timeoutMs);
  } catch (error) {
    runnerError = error instanceof Error ? error.message : String(error);
  } finally {
    for (const client of clients) await client.close(1_000);
    await rm(agentDir, { recursive: true, force: true });
  }

  let changes = { diff: "", status: "", untracked: "", diagnostics: "" };
  try {
    await restoreAcceptance(scenario, workspace);
    if (baselineTree) changes = await readWorkspaceChanges(workspace, baselineTree);
  } catch (error) {
    runnerError ??= error instanceof Error ? error.message : String(error);
  }
  const acceptance = await runCommands(scenario.acceptance, workspace, options.timeoutMs);
  const regression = await runCommands(scenario.regression, workspace, options.timeoutMs);
  const score = scoreModelRun({
    model: model.raw,
    scenario: scenarioName,
    variant,
    entries: finalSnapshot?.entries ?? [],
    expect: scenario.expect,
    acceptance,
    regression,
    preconditionFalsifiable: scenario.oracle === "outcome" ? !preconditionAcceptance.passed : true,
    oracle: scenario.oracle,
    stats: finalSnapshot?.stats,
    wallTimeMs: Date.now() - startedAt,
    finalResponse: finalSnapshot?.finalResponse,
    repoDiff: `${changes.untracked}${changes.diff}`,
  });
  if (runnerError) {
    score.issues.unshift(`runner error: ${runnerError}`);
    score.score = 0;
    score.passed = false;
    score.hardFail = true;
  }
  const artifactDirectory = await writeArtifactBundle(options.artifactRoot, runId, {
    run: {
      runId,
      scenario: scenarioName,
      category: scenario.category,
      repeat,
      variant,
      provider: model.provider,
      model: model.modelId,
      modelSelector: model.raw,
      thinking: options.thinking,
      authType: auth.authType,
      mode: "rpc",
      cwd: workspace,
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date().toISOString(),
      runnerError,
      sessionPath,
      rpcState: finalSnapshot?.state,
      rpcStats: finalSnapshot?.stats,
      rpcMessages: finalSnapshot?.messages,
      verification: acceptance.results,
      regression: regression.results,
      precondition: { acceptance: preconditionAcceptance.results, regression: preconditionRegression.results },
      modelMetrics: score.modelMetrics,
      expectationIssues: score.expectationIssues,
      repositoryDiagnostics: changes.diagnostics,
    },
    prompt: scenario.turns.map((turn) => turn.message).join("\n---\n") + "\n",
    events: clients.flatMap((client) => client.records).map((record) => JSON.stringify(record)).join("\n") + (clients.length > 0 ? "\n" : ""),
    session: finalSnapshot?.sessionText ?? "",
    stdout: clients.map((client) => client.stdout).join("\n"),
    stderr: clients.map((client) => client.stderr).join("\n"),
    repoBefore: before.output,
    repoAfterDiff: changes.diff,
    repoAfterStatus: changes.status,
    verification: acceptance.output + regression.output,
    todoTransitions: score.todoTransitions,
    score,
    finalResponse: finalSnapshot?.finalResponse,
  });

  if (!options.keepWorkspaces && !score.hardFail) await rm(workspace, { recursive: true, force: true });
  return { runId, artifactDirectory, score };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const scenarioFile = await loadModelScenarioFile(options.scenarioFile);
  const scenarioNames = options.scenarioNames ?? (options.preset === "full" ? Object.keys(scenarioFile.scenarios) : [...SMOKE_SCENARIOS]);
  if (scenarioNames.length === 0) throw new Error("At least one model evaluation scenario is required.");
  for (const scenarioName of scenarioNames) getModelScenario(scenarioFile, scenarioName);
  const matrix = buildRunMatrix(options, scenarioNames);

  if (options.dryRun) {
    process.stdout.write(`Model evaluation matrix: ${matrix.length} runs\n`);
    for (const item of matrix) process.stdout.write(`${item.repeat}\t${item.model.raw}\t${item.scenario}\t${item.variant}\n`);
    return;
  }

  const authByModel = new Map<string, ResolvedModelAuth>();
  for (const model of options.models) {
    if (authByModel.has(model.raw)) continue;
    process.stdout.write(`[auth] ${model.raw} ... `);
    const auth = await resolveModelAuth(options, model);
    authByModel.set(model.raw, auth);
    process.stdout.write(`ready (${auth.authType ?? "credential"})\n`);
  }

  const outcomes: EvaluationOutcome[] = [];
  for (const item of matrix) {
    const scenario = getModelScenario(scenarioFile, item.scenario);
    process.stdout.write(`[eval] ${item.model.raw} ${item.scenario} ${item.variant} r${item.repeat}/${options.repeats} ... `);
    const auth = authByModel.get(item.model.raw)!;
    const outcome = await runModelCase(options, item.model, item.scenario, scenario, item.variant, item.repeat, auth);
    outcomes.push(outcome);
    const status = outcome.score.hardFail ? "HARD-FAIL" : outcome.score.expectationIssues.length > 0 ? `RECORDED/${outcome.score.score}` : `OK/${outcome.score.score}`;
    process.stdout.write(`${status} (${outcome.artifactDirectory})\n`);
  }

  const hardFailures = outcomes.filter((outcome) => outcome.score.hardFail);
  const behaviorIssues = outcomes.filter((outcome) => outcome.score.expectationIssues.length > 0);
  process.stdout.write(`\nModel evaluation: ${outcomes.length - hardFailures.length}/${outcomes.length} infrastructure runs passed; ${behaviorIssues.length} behavior deviations\n`);
  if (hardFailures.length > 0) {
    for (const outcome of hardFailures) process.stdout.write(`- ${outcome.runId}: ${outcome.score.issues.join("; ")}\n`);
    process.exitCode = 1;
  }
}

if (isMainModule(import.meta.url)) await main();
