import { isMainModule } from "./is-main.ts";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { initializeFixture, runCommand } from "./run-rpc-e2e.ts";
import { loadModelScenarioFile, type ModelScenarioDefinition, type ModelVerificationCommand } from "./model-scenarios.ts";
import { MODEL_PASS_THRESHOLD, scoreModelRun, type ModelScoreResult } from "./score-run.ts";

const E2E_DIR = dirname(fileURLToPath(import.meta.url));
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

async function runCommands(commands: ModelVerificationCommand[] | undefined, workspace: string) {
  const results: Array<{ name: string; code: number }> = [];
  for (const entry of commands ?? []) {
    const result = await runCommand(entry.command, entry.args, workspace, entry.timeoutMs ?? TIMEOUT_MS);
    results.push({ name: entry.name, code: result.code });
  }
  return { passed: results.every((result) => result.code === 0), results };
}

async function stage(scenario: ModelScenarioDefinition, workspace: string): Promise<void> {
  if (!scenario.acceptanceFixture) return;
  await mkdir(join(workspace, "acceptance"), { recursive: true });
  await cp(
    join(ACCEPTANCE_ROOT, scenario.acceptanceFixture, "check.test.ts"),
    join(workspace, "acceptance", "check.test.ts"),
    { force: true },
  );
}

interface ControlCase {
  id: string;
  finalResponse: string;
  applyReference: boolean;
  expectPassed: boolean;
}

const CONTROLS: ControlCase[] = [
  { id: "silent-noop", finalResponse: "", applyReference: false, expectPassed: false },
  { id: "honest-noop", finalResponse: "I did not change anything.", applyReference: false, expectPassed: false },
  { id: "false-claim", finalResponse: "Done. All tests pass and everything is verified.", applyReference: false, expectPassed: false },
  { id: "reference-solution", finalResponse: "Implemented the change and the acceptance tests pass.", applyReference: true, expectPassed: true },
];

interface ControlResult {
  scenario: string;
  control: ControlCase;
  score: ModelScoreResult;
  ok: boolean;
  detail: string;
}

async function runScenario(name: string, scenario: ModelScenarioDefinition, keep: boolean): Promise<ControlResult[]> {
  const workspace = await mkdtemp(join(tmpdir(), `linear-todo-control-${name}-`));
  try {
    await initializeFixture(workspace);
    await stage(scenario, workspace);

    // Baseline for every control: the pristine fixture must fail the oracle and pass the suite.
    const pristineAcceptance = await runCommands(scenario.acceptance, workspace);
    const pristineRegression = await runCommands(scenario.regression, workspace);

    const results: ControlResult[] = [];
    for (const control of CONTROLS) {
      if (control.applyReference) {
        await cp(join(ACCEPTANCE_ROOT, scenario.acceptanceFixture!, "reference"), workspace, {
          recursive: true,
          force: true,
        });
      }
      const acceptance = await runCommands(scenario.acceptance, workspace);
      const regression = await runCommands(scenario.regression, workspace);
      const score = scoreModelRun({
        model: "control/scripted",
        scenario: name,
        variant: "control",
        entries: [],
        expect: scenario.expect,
        acceptance,
        regression,
        preconditionFalsifiable: !pristineAcceptance.passed,
        oracle: scenario.oracle,
        wallTimeMs: 0,
        finalResponse: control.finalResponse,
        repoDiff: control.applyReference ? " M src" : "",
      });

      const problems: string[] = [];
      if (score.passed !== control.expectPassed) {
        problems.push(`passed=${String(score.passed)}, expected ${String(control.expectPassed)}`);
      }
      if (!control.expectPassed && score.score >= MODEL_PASS_THRESHOLD) {
        problems.push(`score ${String(score.score)} reached the pass threshold ${String(MODEL_PASS_THRESHOLD)}`);
      }
      if (!control.expectPassed && score.gates.acceptance) problems.push("acceptance gate unexpectedly passed");
      if (!pristineRegression.passed) problems.push("pristine regression suite is not green");
      if (control.expectPassed && !score.gates.acceptance) problems.push("reference solution failed the oracle");
      results.push({ scenario: name, control, score, ok: problems.length === 0, detail: problems.join("; ") });
    }
    return results;
  } finally {
    if (!keep) await rm(workspace, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const file = await loadModelScenarioFile(SCENARIO_FILE);
  const names = options.only.length > 0 ? options.only : Object.keys(file.scenarios);
  const results: ControlResult[] = [];
  for (const name of names) {
    const scenario = file.scenarios[name];
    if (!scenario) throw new Error(`Unknown scenario ${name}`);
    if (scenario.oracle !== "outcome") {
      process.stdout.write(`[control] ${name} ... SKIP (process oracle)\n`);
      continue;
    }
    const scenarioResults = await runScenario(name, scenario, options.keep);
    results.push(...scenarioResults);
    const failed = scenarioResults.filter((result) => !result.ok);
    process.stdout.write(
      `[control] ${name} ... ${failed.length === 0 ? "PASS" : "FAIL"} (${scenarioResults
        .map((result) => `${result.control.id}:${String(result.score.score)}`)
        .join(" ")})\n`,
    );
    for (const failure of failed) process.stdout.write(`  ${failure.control.id}: ${failure.detail}\n`);
  }

  const failed = results.filter((result) => !result.ok);
  process.stdout.write(`\nEvaluation controls: ${results.length - failed.length}/${results.length} behaved as required\n`);
  if (failed.length > 0) process.exitCode = 1;
}

if (isMainModule(import.meta.url)) await main();
