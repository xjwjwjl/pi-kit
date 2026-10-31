import { isMainModule } from "./is-main.ts";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { initializeFixture, runCommand } from "./run-rpc-e2e.ts";
import { loadModelScenarioFile, type ModelScenarioDefinition } from "./model-scenarios.ts";

const E2E_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = resolve(E2E_DIR, "..");
const SCENARIO_FILE = join(E2E_DIR, "scenarios", "model-eval.json");
const ACCEPTANCE_ROOT = join(E2E_DIR, "fixtures", "acceptance");
const TIMEOUT_MS = 60_000;

interface Options {
  keep: boolean;
  only: string[];
}

function parseOptions(args: string[]): Options {
  const options: Options = { keep: false, only: [] };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--keep") options.keep = true;
    else if (arg === "--scenario") {
      const value = args[++index];
      if (!value) throw new Error("--scenario requires a name");
      options.only.push(value);
    } else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

interface CommandResult {
  code: number;
  output: string;
}

async function runCommands(
  commands: Array<{ name: string; command: string; args: string[]; timeoutMs?: number }> | undefined,
  workspace: string,
): Promise<CommandResult> {
  const list = commands ?? [];
  if (list.length === 0) return { code: 0, output: "no commands configured" };
  const outputs: string[] = [];
  let code = 0;
  for (const command of list) {
    const result = await runCommand(command.command, command.args, workspace, command.timeoutMs ?? TIMEOUT_MS);
    if (result.code !== 0 && code === 0) code = result.code;
    outputs.push(`$ ${command.command} ${command.args.join(" ")}\nexit: ${String(result.code)}\n${result.output}`);
  }
  return { code, output: outputs.join("\n") };
}

async function stageAcceptance(scenario: ModelScenarioDefinition, workspace: string): Promise<void> {
  const fixture = scenario.acceptanceFixture;
  if (!fixture) throw new Error("outcome scenario has no acceptanceFixture");
  await mkdir(join(workspace, "acceptance"), { recursive: true });
  await cp(join(ACCEPTANCE_ROOT, fixture, "check.test.ts"), join(workspace, "acceptance", "check.test.ts"));
}

async function applyReference(scenario: ModelScenarioDefinition, workspace: string): Promise<void> {
  const fixture = scenario.acceptanceFixture;
  if (!fixture) throw new Error("outcome scenario has no acceptanceFixture");
  await cp(join(ACCEPTANCE_ROOT, fixture, "reference"), workspace, { recursive: true, force: true });
}

interface Row {
  scenario: string;
  preconditionFails: boolean;
  referencePasses: boolean;
  regressionGreen: boolean;
  detail: string;
}

async function verifyScenario(name: string, scenario: ModelScenarioDefinition, keep: boolean): Promise<Row> {
  const workspace = await mkdtemp(join(tmpdir(), `linear-todo-acceptance-${name}-`));
  try {
    await initializeFixture(workspace);
    await stageAcceptance(scenario, workspace);

    const pristineAcceptance = await runCommands(scenario.acceptance, workspace);
    const pristineRegression = await runCommands(scenario.regression, workspace);

    await applyReference(scenario, workspace);
    const referenceAcceptance = await runCommands(scenario.acceptance, workspace);
    const referenceRegression = await runCommands(scenario.regression, workspace);

    const row: Row = {
      scenario: name,
      preconditionFails: pristineAcceptance.code !== 0,
      referencePasses: referenceAcceptance.code === 0,
      regressionGreen: pristineRegression.code === 0 && referenceRegression.code === 0,
      detail: "",
    };
    const problems: string[] = [];
    if (!row.preconditionFails) problems.push("acceptance passed on the pristine fixture (oracle cannot discriminate)");
    if (!row.referencePasses) problems.push(`acceptance failed on the reference implementation:\n${referenceAcceptance.output.slice(-1_500)}`);
    if (pristineRegression.code !== 0) problems.push(`regression failed on the pristine fixture:\n${pristineRegression.output.slice(-800)}`);
    if (referenceRegression.code !== 0) problems.push(`regression failed on the reference implementation:\n${referenceRegression.output.slice(-800)}`);
    row.detail = problems.join("\n");
    return row;
  } finally {
    if (!keep) await rm(workspace, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const file = await loadModelScenarioFile(SCENARIO_FILE);
  const names = options.only.length > 0 ? options.only : Object.keys(file.scenarios);
  const rows: Row[] = [];
  for (const name of names) {
    const scenario = file.scenarios[name];
    if (!scenario) throw new Error(`Unknown scenario ${name}`);
    if (scenario.oracle !== "outcome") {
      process.stdout.write(`[acceptance] ${name} ... SKIP (process oracle)\n`);
      continue;
    }
    const row = await verifyScenario(name, scenario, options.keep);
    rows.push(row);
    const ok = row.preconditionFails && row.referencePasses && row.regressionGreen;
    process.stdout.write(`[acceptance] ${name} ... ${ok ? "PASS" : "FAIL"}\n`);
    if (!ok) process.stdout.write(`${row.detail}\n`);
  }

  const failed = rows.filter((row) => !(row.preconditionFails && row.referencePasses && row.regressionGreen));
  process.stdout.write(`\nAcceptance self-test: ${rows.length - failed.length}/${rows.length} oracles sound\n`);
  if (failed.length > 0) {
    process.stdout.write(`Failing: ${failed.map((row) => row.scenario).join(", ")}\n`);
    process.exitCode = 1;
  }
}

if (isMainModule(import.meta.url)) await main();
