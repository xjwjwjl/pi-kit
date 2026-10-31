import { isMainModule } from "./is-main.ts";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findSessionFile, git, initializeFixture, runCommand, writeAgentSettings } from "./run-rpc-e2e.ts";
import { writeArtifactBundle } from "./collect-artifacts.ts";
import { getScenario, loadScenarioFile, type ScenarioDefinition } from "./scenario.ts";
import { scoreRun, type ScoreResult } from "./score-run.ts";

const E2E_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = resolve(E2E_DIR, "..");
const DEFAULT_SCENARIO_FILE = join(E2E_DIR, "scenarios", "deterministic.json");
const DEFAULT_ARTIFACT_ROOT = join(PROJECT_DIR, ".e2e", "artifacts");
const DEFAULT_WORKSPACE_ROOT = join(PROJECT_DIR, ".e2e", "workspaces");
const DEFAULT_SESSION_ROOT = join(PROJECT_DIR, ".e2e", "sessions");
const PI_CLI = join(PROJECT_DIR, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
const MODES = ["json", "print"] as const;
type NonInteractiveMode = (typeof MODES)[number];

interface Options {
  scenario: string;
  repeat: number;
  timeoutMs: number;
  scenarioFile: string;
  artifactRoot: string;
  workspaceRoot: string;
  sessionRoot: string;
  piCli: string;
  keepWorkspaces: boolean;
}

interface JsonRecord {
  [key: string]: unknown;
}

interface CapturedProcess {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

interface ModeOutcome {
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

function parseOptions(args: string[]): Options {
  const options: Options = {
    scenario: "all",
    repeat: 1,
    timeoutMs: 30_000,
    scenarioFile: DEFAULT_SCENARIO_FILE,
    artifactRoot: DEFAULT_ARTIFACT_ROOT,
    workspaceRoot: DEFAULT_WORKSPACE_ROOT,
    sessionRoot: DEFAULT_SESSION_ROOT,
    piCli: PI_CLI,
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
    } else if (arg === "--keep-workspaces") {
      options.keepWorkspaces = true;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        [
          "Usage: npm run test:e2e:modes -- [options]",
          "",
          "  --scenario <name|all>       Scenario name (default: simple-text,plan-and-stop)",
          "  --repeat <n>                Repetitions per mode/scenario (default: 1)",
          "  --timeout-ms <n>            Per-run timeout (default: 30000)",
          "  --scenario-file <path>      Scenario JSON file",
          "  --artifacts <path>          Artifact root",
          "  --workspaces <path>         Isolated workspace root",
          "  --sessions <path>           Session root",
          "  --pi <path>                 Pi CLI bundle path",
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

function captureProcess(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<CapturedProcess> {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;

  return new Promise<CapturedProcess>((resolvePromise, rejectPromise) => {
    child.stdout.on("data", (chunk: Buffer | string) => stdout.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    child.stderr.on("data", (chunk: Buffer | string) => stderr.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.once("error", (error) => {
      if (timer) clearTimeout(timer);
      rejectPromise(error instanceof Error ? error : new Error(String(error)));
    });
    child.once("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      resolvePromise({
        code: timedOut ? 1 : code,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

function parseJsonLines(stdout: string): JsonRecord[] {
  const lines = stdout.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.map((line, index) => {
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (!line) throw new Error(`JSON mode emitted an empty record at line ${index + 1}`);
    const value = JSON.parse(line) as unknown;
    if (!isRecord(value)) throw new Error(`JSON mode emitted a non-object record at line ${index + 1}`);
    return value;
  });
}

async function readSessionEntries(sessionDir: string): Promise<{ entries: unknown[]; sessionText: string }> {
  const sessionFile = await findSessionFile(sessionDir);
  if (!sessionFile) return { entries: [], sessionText: "" };
  const sessionText = await readFile(sessionFile, "utf8");
  const entries = sessionText
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown)
    .filter((entry) => isRecord(entry) && entry.type !== "session");
  return { entries, sessionText };
}

function expectedText(definition: ScenarioDefinition): string | undefined {
  return definition.steps.find((step) => step.type === "text")?.text;
}

async function runModeScenario(
  options: Options,
  mode: NonInteractiveMode,
  scenarioName: string,
  definition: ScenarioDefinition,
  repeat: number,
): Promise<ModeOutcome> {
  const runId = `${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${mode}-${safeName(scenarioName)}-r${repeat}-p${process.pid}`;
  const workspace = join(options.workspaceRoot, runId);
  const sessionDir = join(options.sessionRoot, runId);
  const agentDir = join(options.artifactRoot, "agent", runId);
  const startedAt = new Date().toISOString();
  let runnerError: string | undefined;
  let captured: CapturedProcess | undefined;
  let records: JsonRecord[] = [];
  let entries: unknown[] = [];
  let sessionText = "";

  await mkdir(options.workspaceRoot, { recursive: true });
  await mkdir(options.sessionRoot, { recursive: true });
  await mkdir(options.artifactRoot, { recursive: true });
  await initializeFixture(workspace);
  await writeAgentSettings(agentDir);
  const before = await git(workspace, ["status", "--short", "--branch"]);

  const extensionPath = join(PROJECT_DIR, "index.ts");
  const providerPath = join(E2E_DIR, "scripted-provider.ts");
  const args = [
    options.piCli,
    ...(mode === "json" ? ["--mode", "json"] : ["--print"]),
    "--approve",
    "--no-extensions",
    "-e",
    extensionPath,
    "-e",
    providerPath,
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--provider",
    "linear-todo-scripted",
    "--model",
    "linear-todo-scripted/linear-todo-scripted",
    "--thinking",
    "off",
    "--tools",
    "todo",
    "--session-dir",
    sessionDir,
    "--name",
    runId,
    "--",
    definition.prompt,
  ];

  try {
    const child = spawn(process.execPath, args, {
      cwd: workspace,
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDir,
        PI_OFFLINE: "1",
        PI_SKIP_VERSION_CHECK: "1",
        PI_TELEMETRY: "0",
        LINEAR_TODO_E2E_SCENARIO: scenarioName,
        LINEAR_TODO_E2E_SCENARIO_FILE: options.scenarioFile,
        LINEAR_TODO_E2E_RUN_ID: runId,
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdin.end();
    captured = await captureProcess(child, options.timeoutMs);
    if (mode === "json") records = parseJsonLines(captured.stdout);
    const session = await readSessionEntries(sessionDir);
    entries = session.entries;
    sessionText = session.sessionText;
  } catch (error) {
    runnerError = error instanceof Error ? error.message : String(error);
  }

  const after = await git(workspace, ["diff", "--no-ext-diff"]);
  const verification = await runCommand(
    process.execPath,
    ["--experimental-strip-types", "--test", join(workspace, "tests", "auth.test.ts"), join(workspace, "tests", "cache.test.ts")],
    workspace,
    options.timeoutMs,
  );
  const expected = definition.expect ? { ...definition.expect, autoContinueMessages: 0 } : undefined;
  const score = scoreRun(expected, entries);
  if (mode === "print" && expectedText(definition) && !captured?.stdout.includes(expectedText(definition)!)) {
    score.issues.push("Print output did not contain the scripted response text");
    score.score = 0;
    score.passed = false;
  }
  if (runnerError) {
    score.issues.unshift(`runner error: ${runnerError}`);
    score.score = 0;
    score.passed = false;
    score.hardFail = true;
  }
  if ((captured?.code ?? 1) !== 0) {
    score.issues.push(`Pi ${mode} exited with code ${String(captured?.code ?? 1)}`);
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

  const artifactDirectory = await writeArtifactBundle(options.artifactRoot, runId, {
    run: {
      runId,
      scenario: scenarioName,
      repeat,
      variant: "todo-enabled",
      provider: "linear-todo-scripted",
      model: "linear-todo-scripted",
      thinking: "off",
      mode,
      cwd: workspace,
      startedAt,
      finishedAt: new Date().toISOString(),
      runnerError,
      processCode: captured?.code,
      processSignal: captured?.signal,
    },
    prompt: definition.prompt + "\n",
    events: records.map((record) => JSON.stringify(record)).join("\n") + (records.length > 0 ? "\n" : ""),
    session: sessionText,
    stdout: captured?.stdout ?? "",
    stderr: captured?.stderr ?? "",
    repoBefore: before.output,
    repoAfterDiff: after.output,
    verification: verification.output,
    todoTransitions: score.todoTransitions,
    score,
  });

  if (!options.keepWorkspaces && score.passed) await rm(workspace, { recursive: true, force: true });
  return { runId, artifactDirectory, passed: score.passed && !score.hardFail, score };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const scenarioFile = await loadScenarioFile(options.scenarioFile);
  const defaultNames = ["simple-text", "plan-and-stop"];
  const scenarioNames = options.scenario === "all" ? defaultNames : [options.scenario];
  const outcomes: ModeOutcome[] = [];

  for (const mode of MODES) {
    for (const scenarioName of scenarioNames) {
      const definition = getScenario(scenarioFile, scenarioName);
      for (let repeat = 1; repeat <= options.repeat; repeat += 1) {
        process.stdout.write(`[e2e:${mode}] ${scenarioName} repeat ${repeat}/${options.repeat} ... `);
        const outcome = await runModeScenario(options, mode, scenarioName, definition, repeat);
        outcomes.push(outcome);
        process.stdout.write(`${outcome.passed ? "PASS" : "FAIL"} (${outcome.artifactDirectory})\n`);
      }
    }
  }

  const failed = outcomes.filter((outcome) => !outcome.passed);
  process.stdout.write(`\nMode E2E: ${outcomes.length - failed.length}/${outcomes.length} passed\n`);
  if (failed.length > 0) {
    for (const outcome of failed) process.stdout.write(`- ${outcome.runId}: ${outcome.score.issues.join("; ")}\n`);
    process.exitCode = 1;
  }
}

if (isMainModule(import.meta.url)) await main();
