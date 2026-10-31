import { isMainModule } from "./is-main.ts";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, cp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { StringDecoder } from "node:string_decoder";
import { SCRIPTED_ABORT_TOOL, SCRIPTED_MODEL_ID, SCRIPTED_PROVIDER_ID } from "./scripted-provider.ts";
import { writeArtifactBundle } from "./collect-artifacts.ts";
import { getScenario, loadScenarioFile, type ScenarioDefinition } from "./scenario.ts";
import { scoreRun, type ScoreResult } from "./score-run.ts";

const execFileAsync = promisify(execFile);
const E2E_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = resolve(E2E_DIR, "..");
const DEFAULT_SCENARIO_FILE = join(E2E_DIR, "scenarios", "deterministic.json");
const FIXTURE_DIR = join(E2E_DIR, "fixtures", "sample-app");
const DEFAULT_ARTIFACT_ROOT = join(PROJECT_DIR, ".e2e", "artifacts");
const DEFAULT_WORKSPACE_ROOT = join(PROJECT_DIR, ".e2e", "workspaces");
const DEFAULT_SESSION_ROOT = join(PROJECT_DIR, ".e2e", "sessions");
const PI_CLI = join(PROJECT_DIR, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");

interface JsonRecord {
  [key: string]: unknown;
}

export interface RunOptions {
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

interface CommandResult {
  code: number;
  output: string;
  stdout: string;
  stderr: string;
}

interface RunOutcome {
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

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

function takeValue(args: string[], index: number, flag: string): [string, number] {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return [value, index + 1];
}

function parseOptions(args: string[]): RunOptions {
  const options: RunOptions = {
    scenario: "all",
    repeat: 1,
    timeoutMs: 20_000,
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
      [options.scenario, index] = takeValue(args, index, arg);
    } else if (arg === "--repeat") {
      const [value, nextIndex] = takeValue(args, index, arg);
      options.repeat = parsePositiveInteger(value, arg);
      index = nextIndex;
    } else if (arg === "--timeout-ms") {
      const [value, nextIndex] = takeValue(args, index, arg);
      options.timeoutMs = parsePositiveInteger(value, arg);
      index = nextIndex;
    } else if (arg === "--scenario-file") {
      [options.scenarioFile, index] = takeValue(args, index, arg);
      options.scenarioFile = resolve(options.scenarioFile);
    } else if (arg === "--artifacts") {
      [options.artifactRoot, index] = takeValue(args, index, arg);
      options.artifactRoot = resolve(options.artifactRoot);
    } else if (arg === "--workspaces") {
      [options.workspaceRoot, index] = takeValue(args, index, arg);
      options.workspaceRoot = resolve(options.workspaceRoot);
    } else if (arg === "--sessions") {
      [options.sessionRoot, index] = takeValue(args, index, arg);
      options.sessionRoot = resolve(options.sessionRoot);
    } else if (arg === "--pi") {
      [options.piCli, index] = takeValue(args, index, arg);
      options.piCli = resolve(options.piCli);
    } else if (arg === "--tools") {
      [options.tools, index] = takeValue(args, index, arg);
    } else if (arg === "--keep-workspaces") {
      options.keepWorkspaces = true;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        [
          "Usage: npm run test:e2e -- [options]",
          "",
          "  --scenario <name|all>       Scenario name (default: all)",
          "  --repeat <n>                Repetitions per scenario (default: 1)",
          "  --timeout-ms <n>            Per-run timeout (default: 20000)",
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

export async function runCommand(command: string, args: string[], cwd: string, timeoutMs = 20_000): Promise<CommandResult> {
  try {
    const result = await execFileAsync(command, args, {
      cwd,
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr, output: `${result.stdout}${result.stderr}` };
  } catch (error) {
    const failure = error as { code?: number | string; stdout?: string; stderr?: string; message?: string };
    const code = typeof failure.code === "number" ? failure.code : 1;
    const stdout = failure.stdout ?? "";
    const stderr = failure.stderr ?? "";
    const output = [stdout, stderr, failure.message].filter((part): part is string => Boolean(part)).join("");
    return { code, output, stdout, stderr };
  }
}

export async function git(cwd: string, args: string[]): Promise<CommandResult> {
  return runCommand("git", ["-C", cwd, ...args], cwd);
}

export async function initializeFixture(workspace: string): Promise<void> {
  await cp(FIXTURE_DIR, workspace, { recursive: true });
  const init = await git(workspace, ["init", "--quiet"]);
  if (init.code !== 0) throw new Error(`git init failed: ${init.output}`);
  // Keep the pristine fixture in this isolated index: offline runners only need a diff
  // against it, not a commit or an author identity. Never touch the project's index.
  const add = await git(workspace, ["add", "."]);
  if (add.code !== 0) throw new Error(`git add failed: ${add.output}`);
}

export async function writeAgentSettings(agentDir: string, options: { compactionKeepRecentTokens?: number } = {}): Promise<void> {
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify(
      {
        retry: { enabled: false, maxRetries: 0 },
        compaction: {
          enabled: false,
          ...(options.compactionKeepRecentTokens === undefined ? {} : { keepRecentTokens: options.compactionKeepRecentTokens }),
        },
        defaultProjectTrust: "always",
        enableInstallTelemetry: false,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
}

export class StrictJsonlClient {
  readonly records: JsonRecord[] = [];
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";
  private readonly pending = new Map<string, { resolve: (record: JsonRecord) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private readonly closePromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  private resolveClose!: (value: { code: number | null; signal: NodeJS.Signals | null }) => void;
  private requestSeq = 0;
  private parserError: Error | undefined;
  private readonly stdoutChunks: Buffer[] = [];
  private readonly stderrChunks: Buffer[] = [];
  private readonly child: ChildProcessWithoutNullStreams;

  constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    this.closePromise = new Promise((resolvePromise) => {
      this.resolveClose = resolvePromise;
    });

    child.stdout.on("data", (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      this.stdoutChunks.push(bytes);
      this.feed(bytes);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      this.stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.stdout.on("end", () => {
      try {
        this.buffer += this.decoder.end();
        if (this.buffer.length > 0) this.handleLine(this.buffer.endsWith("\r") ? this.buffer.slice(0, -1) : this.buffer);
        this.buffer = "";
      } catch (error) {
        this.failParser(error);
      }
    });
    child.on("error", (error) => this.failAll(error instanceof Error ? error : new Error(String(error))));
    child.on("close", (code, signal) => {
      const error = this.parserError ?? new Error(`Pi RPC exited before the request completed (code=${String(code)}, signal=${String(signal)})`);
      for (const request of this.pending.values()) {
        clearTimeout(request.timer);
        request.reject(error);
      }
      this.pending.clear();
      this.resolveClose({ code, signal });
    });
  }

  get stdout(): string {
    return Buffer.concat(this.stdoutChunks).toString("utf8");
  }

  get stderr(): string {
    return Buffer.concat(this.stderrChunks).toString("utf8");
  }

  private feed(chunk: Buffer): void {
    if (this.parserError) return;
    this.buffer += this.decoder.write(chunk);
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      let line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    if (!line) {
      this.failParser(new Error("Pi RPC emitted an empty JSONL record."));
      return;
    }

    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch (error) {
      this.failParser(new Error(`Invalid Pi RPC JSONL record: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    if (!isRecord(value)) {
      this.failParser(new Error("Pi RPC emitted a non-object JSONL record."));
      return;
    }

    this.records.push(value);
    if (value.type === "response" && typeof value.id === "string") {
      const request = this.pending.get(value.id);
      if (request) {
        this.pending.delete(value.id);
        clearTimeout(request.timer);
        request.resolve(value);
      }
      return;
    }

    if (value.type === "extension_ui_request" && typeof value.id === "string") {
      const method = value.method;
      if (method === "select" || method === "confirm" || method === "input" || method === "editor") {
        this.writeRaw({ type: "extension_ui_response", id: value.id, cancelled: true });
      }
    }
  }

  private writeRaw(value: JsonRecord): void {
    if (this.child.stdin.destroyed || this.child.stdin.writableEnded) return;
    this.child.stdin.write(JSON.stringify(value) + "\n");
  }

  private failParser(error: unknown): void {
    const parsed = error instanceof Error ? error : new Error(String(error));
    this.parserError ??= parsed;
    this.failAll(parsed);
  }

  private failAll(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }

  async request(command: JsonRecord, timeoutMs: number): Promise<JsonRecord> {
    if (this.parserError) throw this.parserError;
    if (this.child.stdin.destroyed || this.child.stdin.writableEnded) throw new Error("Pi RPC stdin is closed.");

    const id = `e2e-${++this.requestSeq}`;
    const message = { ...command, id };
    return new Promise<JsonRecord>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectPromise(new Error(`Timed out waiting for Pi RPC response to ${String(command.type)}.`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer });
      try {
        this.child.stdin.write(JSON.stringify(message) + "\n");
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        rejectPromise(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async data(command: JsonRecord, timeoutMs: number): Promise<unknown> {
    const response = await this.request(command, timeoutMs);
    if (response.success !== true) throw new Error(`Pi RPC ${String(command.type)} failed: ${String(response.error ?? "unknown error")}`);
    return response.data;
  }

  async waitForStartup(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        await this.data({ type: "get_state" }, Math.min(1_000, Math.max(100, deadline - Date.now())));
        return;
      } catch (error) {
        lastError = error;
        if (this.child.exitCode !== null) break;
        await sleep(50);
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Pi RPC did not become ready.");
  }

  async waitUntilSettled(timeoutMs: number, quietMs = 150): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let scanIndex = 0;
    let sawSettled = false;

    while (Date.now() < deadline) {
      while (scanIndex < this.records.length) {
        const record = this.records[scanIndex++]!;
        if (record.type === "agent_start") sawSettled = false;
        if (record.type === "agent_settled") sawSettled = true;
      }

      if (sawSettled) {
        const state = await this.data({ type: "get_state" }, Math.min(1_000, Math.max(100, deadline - Date.now())));
        if (isRecord(state) && state.isStreaming === false && Number(state.pendingMessageCount ?? 0) === 0) {
          const checkpoint = this.records.length;
          await sleep(quietMs);
          const tail = this.records.slice(checkpoint);
          if (!tail.some((record) => record.type === "agent_start")) {
            const finalState = await this.data({ type: "get_state" }, Math.min(1_000, Math.max(100, deadline - Date.now())));
            if (isRecord(finalState) && finalState.isStreaming === false && Number(finalState.pendingMessageCount ?? 0) === 0) return;
          } else {
            sawSettled = false;
          }
        }
      }

      await sleep(25);
    }
    throw new Error(`Pi RPC run did not settle within ${timeoutMs}ms.`);
  }

  async close(timeoutMs: number): Promise<void> {
    if (this.child.exitCode === null && !this.child.stdin.writableEnded) this.child.stdin.end();
    if (this.child.exitCode === null) {
      await Promise.race([this.closePromise, sleep(timeoutMs)]);
    }
    if (this.child.exitCode === null) {
      this.child.kill();
      await Promise.race([this.closePromise, sleep(timeoutMs)]);
    }
  }
}

export function spawnPi(
  options: RunOptions,
  workspace: string,
  sessionDir: string,
  agentDir: string,
  scenarioName: string,
  runId: string,
  stepOffset = 0,
  sessionPath?: string,
  contextTracePath?: string,
): StrictJsonlClient {
  const extensionPath = join(PROJECT_DIR, "index.ts");
  const providerPath = join(E2E_DIR, "scripted-provider.ts");
  const args = [
    options.piCli,
    "--mode",
    "rpc",
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
    SCRIPTED_PROVIDER_ID,
    "--model",
    `${SCRIPTED_PROVIDER_ID}/${SCRIPTED_MODEL_ID}`,
    "--thinking",
    "off",
    "--tools",
    scenarioName === "abort-during-tool" ? `${options.tools},${SCRIPTED_ABORT_TOOL}` : options.tools,
    "--session-dir",
    sessionDir,
    ...(sessionPath ? ["--session", sessionPath] : []),
    "--name",
    runId,
  ];
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
      LINEAR_TODO_E2E_STEP_OFFSET: String(stepOffset),
      ...(contextTracePath ? { LINEAR_TODO_E2E_CONTEXT_TRACE: contextTracePath } : {}),
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  return new StrictJsonlClient(child);
}

export async function findSessionFile(directory: string): Promise<string | undefined> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isFile() && entry.name.endsWith(".jsonl")) return path;
      if (entry.isDirectory()) {
        const nested = await findSessionFile(path);
        if (nested) return nested;
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function runScenario(options: RunOptions, scenarioName: string, definition: ScenarioDefinition, repeat: number): Promise<RunOutcome> {
  const runId = `${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${safeName(scenarioName)}-r${repeat}-p${process.pid}`;
  const workspace = join(options.workspaceRoot, runId);
  const sessionDir = join(options.sessionRoot, runId);
  const agentDir = join(options.artifactRoot, "agent", runId);
  const startedAt = new Date().toISOString();
  let runnerError: string | undefined;
  let rpc: StrictJsonlClient | undefined;
  let entries: unknown[] = [];
  let sessionText = "";
  let rpcState: unknown;
  let rpcMessages: unknown;
  let rpcStats: unknown;

  await mkdir(options.workspaceRoot, { recursive: true });
  await mkdir(options.sessionRoot, { recursive: true });
  await mkdir(options.artifactRoot, { recursive: true });
  await initializeFixture(workspace);
  await writeAgentSettings(agentDir);
  const before = await git(workspace, ["status", "--short", "--branch"]);

  try {
    rpc = spawnPi(options, workspace, sessionDir, agentDir, scenarioName, runId);
    await rpc.waitForStartup(options.timeoutMs);
    const promptResponse = await rpc.request({ type: "prompt", message: definition.prompt }, options.timeoutMs);
    if (promptResponse.success !== true) throw new Error(`Pi RPC prompt failed: ${String(promptResponse.error ?? "unknown error")}`);
    await rpc.waitUntilSettled(options.timeoutMs);

    const entriesData = await rpc.data({ type: "get_entries" }, options.timeoutMs);
    if (!isRecord(entriesData) || !Array.isArray(entriesData.entries)) {
      throw new Error("Pi RPC get_entries returned no entries array.");
    }
    entries = entriesData.entries;
    rpcState = await rpc.data({ type: "get_state" }, options.timeoutMs);
    rpcMessages = await rpc.data({ type: "get_messages" }, options.timeoutMs);
    rpcStats = await rpc.data({ type: "get_session_stats" }, options.timeoutMs);
    const sessionFile = isRecord(rpcState) && typeof rpcState.sessionFile === "string" ? rpcState.sessionFile : await findSessionFile(sessionDir);
    if (!sessionFile) throw new Error("Pi RPC did not expose a persisted session file.");
    sessionText = await readFile(sessionFile, "utf8");
  } catch (error) {
    runnerError = error instanceof Error ? error.message : String(error);
  } finally {
    if (rpc) await rpc.close(1_000);
  }

  const afterDiff = await git(workspace, ["diff", "--no-ext-diff"]);
  const verification = await runCommand(
    process.execPath,
    [
      "--experimental-strip-types",
      "--test",
      join(workspace, "tests", "auth.test.ts"),
      join(workspace, "tests", "cache.test.ts"),
    ],
    workspace,
    options.timeoutMs,
  );
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

  const finishedAt = new Date().toISOString();
  const artifactDirectory = await writeArtifactBundle(options.artifactRoot, runId, {
    run: {
      runId,
      scenario: scenarioName,
      repeat,
      variant: "todo-enabled",
      provider: SCRIPTED_PROVIDER_ID,
      model: SCRIPTED_MODEL_ID,
      thinking: "off",
      mode: "rpc",
      cwd: workspace,
      startedAt,
      finishedAt,
      runnerError,
      verificationExitCode: verification.code,
      rpcState,
      rpcStats,
      rpcMessages,
    },
    prompt: definition.prompt + "\n",
    events: rpc ? rpc.records.map((record) => JSON.stringify(record)).join("\n") + "\n" : "",
    session: sessionText,
    stdout: rpc?.stdout ?? "",
    stderr: rpc?.stderr ?? "",
    repoBefore: before.output,
    repoAfterDiff: afterDiff.output,
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
  const scenarioNames = options.scenario === "all" ? Object.keys(scenarioFile.scenarios) : [options.scenario];
  const outcomes: RunOutcome[] = [];

  for (const scenarioName of scenarioNames) {
    const definition = getScenario(scenarioFile, scenarioName);
    for (let repeat = 1; repeat <= options.repeat; repeat += 1) {
      process.stdout.write(`[e2e] ${scenarioName} repeat ${repeat}/${options.repeat} ... `);
      const outcome = await runScenario(options, scenarioName, definition, repeat);
      outcomes.push(outcome);
      process.stdout.write(`${outcome.passed ? "PASS" : "FAIL"} (${outcome.artifactDirectory})\n`);
    }
  }

  const failed = outcomes.filter((outcome) => !outcome.passed);
  process.stdout.write(`\nE2E: ${outcomes.length - failed.length}/${outcomes.length} passed\n`);
  if (failed.length > 0) {
    for (const outcome of failed) {
      process.stdout.write(`- ${outcome.runId}: ${outcome.score.issues.join("; ")}\n`);
    }
    process.exitCode = 1;
  }
}

if (isMainModule(import.meta.url)) await main();
