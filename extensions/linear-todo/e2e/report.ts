import { isMainModule } from "./is-main.ts";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MODEL_PASS_THRESHOLD } from "./score-run.ts";

interface RunMetadata {
  runId?: string;
  scenario?: string;
  variant?: string;
  provider?: string;
  model?: string;
  mode?: string;
}

interface ScoreFile {
  score?: number;
  passed?: boolean;
  hardFail?: boolean;
  infrastructurePassed?: boolean;
  behaviorPassed?: boolean;
  behaviorScore?: number;
  qualityScored?: boolean;
  acceptancePassed?: boolean;
  regressionPassed?: boolean;
  preconditionFalsifiable?: boolean;
  gates?: {
    acceptance?: boolean;
    regression?: boolean;
    precondition?: boolean;
    repoChange?: boolean;
    todoActivation?: boolean;
    integrity?: boolean;
  };
  expectationIssues?: string[];
  observations?: string[];
  metrics?: {
    todoToolCalls?: number;
    autoContinueMessages?: number;
  };
  processMetrics?: {
    todoCalls?: number;
    planSize?: number;
    planHasVerificationTask?: boolean;
    finalTodoPhase?: string;
    autoContinueMessages?: number;
    falseSuccessClaim?: boolean;
  };
  modelMetrics?: {
    tokensTotal?: number;
    toolCalls?: number;
    wallTimeMs?: number;
  };
}

interface RunRecord {
  metadata: RunMetadata;
  score: ScoreFile;
}

interface ReportOptions {
  root: string;
  output?: string;
}

function numericAverage(values: Array<number | undefined>): number | undefined {
  const present = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return present.length === 0 ? undefined : present.reduce((sum, value) => sum + value, 0) / present.length;
}

function formatNumber(value: number | undefined, digits = 1): string {
  return value === undefined ? "—" : value.toFixed(digits);
}

function yesNo(value: boolean | undefined): string {
  return value === undefined ? "—" : value ? "yes" : "no";
}

function parseOptions(args: string[]): ReportOptions {
  const options: ReportOptions = {
    root: fileURLToPath(new URL("../.e2e/artifacts", import.meta.url)),
  };
  let positionalRootUsed = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--root") {
      const value = args[++index];
      if (!value) throw new Error("--root requires a path");
      options.root = value;
    } else if (arg === "--output") {
      const value = args[++index];
      if (!value) throw new Error("--output requires a path");
      options.output = value;
    } else if (!arg.startsWith("--") && !positionalRootUsed) {
      options.root = arg;
      positionalRootUsed = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  options.root = resolve(options.root);
  if (options.output) options.output = resolve(options.output);
  return options;
}

async function loadRuns(root: string): Promise<RunRecord[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const runs: RunRecord[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const [metadata, score] = await Promise.all([
        readFile(join(root, entry.name, "run.json"), "utf8").then((value) => JSON.parse(value) as RunMetadata),
        readFile(join(root, entry.name, "score.json"), "utf8").then((value) => JSON.parse(value) as ScoreFile),
      ]);
      runs.push({ metadata: { runId: entry.name, ...metadata }, score });
    } catch {
      // Ignore incomplete or auxiliary directories such as artifacts/agent.
    }
  }
  return runs.sort((a, b) => (a.metadata.runId ?? "").localeCompare(b.metadata.runId ?? ""));
}

/** Model evaluation runs are the ones that carry a rubric score. Deterministic runs are verdicts. */
function isModelRun(score: ScoreFile): boolean {
  return score.gates !== undefined || score.qualityScored !== undefined || score.modelMetrics !== undefined;
}

function isQualityScored(score: ScoreFile): boolean {
  return isModelRun(score) && score.qualityScored !== false;
}

function passed(score: ScoreFile): boolean | undefined {
  if (score.passed !== undefined) return score.passed;
  return score.behaviorPassed ?? (score.expectationIssues === undefined ? undefined : score.expectationIssues.length === 0);
}

function modelLabel(metadata: RunMetadata): string {
  return metadata.provider && metadata.model ? `${metadata.provider}/${metadata.model}` : (metadata.model ?? "—");
}

function reportSummary(runs: RunRecord[]): string[] {
  const modelRuns = runs.filter((run) => isModelRun(run.score));
  const quality = modelRuns.filter((run) => isQualityScored(run.score));
  const lines = [
    "## Summary",
    "",
    `- Total artifacts: ${runs.length}`,
    `- Quality-scored runs: ${quality.length} (process-only runs: ${modelRuns.length - quality.length})`,
  ];
  if (quality.length > 0) {
    const scores = quality.map((run) => run.score.score);
    lines.push(
      `- Passed (score >= ${MODEL_PASS_THRESHOLD} and every gate green): ${quality.filter((run) => passed(run.score) === true).length}/${quality.length}`,
      `- Mean score: ${formatNumber(numericAverage(scores))}`,
      `- Acceptance oracle passed: ${quality.filter((run) => run.score.gates?.acceptance === true).length}/${quality.length}`,
      `- Regression passed: ${quality.filter((run) => run.score.gates?.regression === true).length}/${quality.length}`,
    );
  }
  const hardFailures = runs.filter((run) => run.score.hardFail === true);
  lines.push(`- Hard failures: ${hardFailures.length}`);
  return lines;
}

function reportRuns(runs: RunRecord[]): string[] {
  const lines = [
    "## Runs",
    "",
    "| Run | Model | Scenario | Variant | Score | Scored | Acceptance | Regression | Gates | Tokens | Todo | Auto |",
    "|---|---|---|---|---:|:---:|:---:|:---:|:---:|---:|---:|---:|",
  ];
  for (const run of runs) {
    const metadata = run.metadata;
    const score = run.score;
    if (!isModelRun(score)) {
      lines.push(
        `| ${metadata.runId ?? "—"} | — | ${metadata.scenario ?? "—"} | ${metadata.variant ?? "—"} | ${formatNumber(score.score)} | no | — | — | ${score.passed === false ? "fail" : "pass"} | — | ${score.metrics?.todoToolCalls ?? "—"} | ${score.metrics?.autoContinueMessages ?? "—"} |`,
      );
      continue;
    }
    const gates = score.gates;
    const gatesLabel = gates
      ? [gates.acceptance ? "A" : "a", gates.regression ? "R" : "r", gates.precondition ? "" : "P", gates.repoChange ? "" : "C", gates.todoActivation ? "" : "T", gates.integrity ? "" : "I"]
          .filter(Boolean)
          .join("") || "ok"
      : "—";
    lines.push(
      `| ${metadata.runId ?? "—"} | ${modelLabel(metadata)} | ${metadata.scenario ?? "—"} | ${metadata.variant ?? "—"} | ${formatNumber(score.score)} | ${yesNo(isQualityScored(score))} | ${yesNo(score.gates?.acceptance)} | ${yesNo(score.gates?.regression)} | ${gatesLabel} | ${formatNumber(score.modelMetrics?.tokensTotal, 0)} | ${score.processMetrics?.todoCalls ?? "—"} | ${score.processMetrics?.autoContinueMessages ?? "—"} |`,
    );
  }
  return lines;
}

function reportAb(abRuns: RunRecord[]): string[] {
  const groups = new Map<string, { baseline: RunRecord[]; todo: RunRecord[] }>();
  for (const run of abRuns) {
    const metadata = run.metadata;
    const key = `${modelLabel(metadata)}\u0000${metadata.scenario ?? "—"}`;
    const group = groups.get(key) ?? { baseline: [], todo: [] };
    if (metadata.variant === "baseline") group.baseline.push(run);
    if (metadata.variant === "todo-enabled") group.todo.push(run);
    groups.set(key, group);
  }

  const lines = [
    "## A/B Summary (quality-scored scenarios only, identical rubric)",
    "",
    "| Model | Scenario | Baseline | Todo | Baseline Pass | Todo Pass | Baseline Tokens | Todo Tokens | Token Delta |",
    "|---|---|---:|---:|:---:|:---:|---:|---:|---:|",
  ];
  for (const [key, group] of groups) {
    const [model, scenario] = key.split("\u0000");
    const baselineScores = group.baseline.filter((run) => isQualityScored(run.score)).map((run) => run.score.score);
    const todoScores = group.todo.filter((run) => isQualityScored(run.score)).map((run) => run.score.score);
    if (baselineScores.length === 0 && todoScores.length === 0) continue;
    const baselineTokens = numericAverage(group.baseline.map((run) => run.score.modelMetrics?.tokensTotal));
    const todoTokens = numericAverage(group.todo.map((run) => run.score.modelMetrics?.tokensTotal));
    const tokenDelta =
      baselineTokens !== undefined && todoTokens !== undefined && baselineTokens > 0
        ? ((todoTokens - baselineTokens) / baselineTokens) * 100
        : undefined;
    const passRatio = (runs: RunRecord[]) => {
      const scored = runs.filter((run) => isQualityScored(run.score));
      if (scored.length === 0) return "—";
      return `${scored.filter((run) => passed(run.score) === true).length}/${scored.length}`;
    };
    lines.push(
      `| ${model} | ${scenario} | ${formatNumber(numericAverage(baselineScores))} | ${formatNumber(numericAverage(todoScores))} | ${passRatio(group.baseline)} | ${passRatio(group.todo)} | ${formatNumber(baselineTokens, 0)} | ${formatNumber(todoTokens, 0)} | ${tokenDelta === undefined ? "—" : `${formatNumber(tokenDelta)}%`} |`,
    );
  }
  return lines;
}

function reportProcess(runs: RunRecord[]): string[] {
  const modelRuns = runs.filter((run) => isModelRun(run.score));
  if (modelRuns.length === 0) return [];
  const lines = [
    "## Process Metrics (reported, never scored)",
    "",
    "| Variant | Runs | Mean Todo calls | Mean plan size | Completed | Mean auto-continues | False success claims |",
    "|---|---:|---:|---:|---:|---:|---:|",
  ];
  for (const variant of ["baseline", "todo-enabled", "control"]) {
    const group = modelRuns.filter((run) => run.metadata.variant === variant);
    if (group.length === 0) continue;
    const plans = group.map((run) => run.score.processMetrics?.planSize);
    const completed = group.filter((run) => run.score.processMetrics?.finalTodoPhase === "completed").length;
    lines.push(
      `| ${variant} | ${group.length} | ${formatNumber(numericAverage(group.map((run) => run.score.processMetrics?.todoCalls ?? run.score.metrics?.todoToolCalls)), 2)} | ${formatNumber(numericAverage(plans), 2)} | ${completed}/${group.length} | ${formatNumber(numericAverage(group.map((run) => run.score.processMetrics?.autoContinueMessages ?? run.score.metrics?.autoContinueMessages)), 2)} | ${group.filter((run) => run.score.processMetrics?.falseSuccessClaim === true).length} |`,
    );
  }
  return lines;
}

function reportDeviations(runs: RunRecord[]): string[] {
  const failures = runs.flatMap((run) =>
    (run.score.expectationIssues ?? []).map((issue) => `${run.metadata.runId ?? "unknown"}: ${issue}`),
  );
  const observations = runs.flatMap((run) =>
    (run.score.observations ?? []).map((issue) => `${run.metadata.runId ?? "unknown"}: ${issue}`),
  );
  const sections: string[] = [];
  if (failures.length > 0) sections.push("## Gate Failures", "", ...failures.map((issue) => `- ${issue}`));
  if (observations.length > 0) {
    sections.push("## Process Observations (not scored)", "", ...observations.map((issue) => `- ${issue}`));
  }
  return sections;
}

export async function buildReport(root: string): Promise<string> {
  const runs = await loadRuns(root);
  const abRuns = runs.filter((run) => run.metadata.variant === "baseline" || run.metadata.variant === "todo-enabled");
  const sections = [
    "# Linear Todo Evaluation Report",
    "",
    `- Artifact root: ${root}`,
    `- Pass threshold: ${MODEL_PASS_THRESHOLD} (acceptance ${70} + regression ${20}; every gate must also be green)`,
    "",
    ...reportSummary(runs),
    "",
    ...reportRuns(runs),
    "",
    ...reportAb(abRuns),
    "",
    ...reportProcess(runs),
    "",
    ...reportDeviations(runs),
  ];
  return sections.join("\n").replace(/\n{3,}/g, "\n\n") + "\n";
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const report = await buildReport(options.root);
  if (options.output) {
    await mkdir(dirname(options.output), { recursive: true });
    await writeFile(options.output, report, "utf8");
    process.stdout.write(`Wrote evaluation report: ${options.output}\n`);
    return;
  }
  process.stdout.write(report);
}

if (isMainModule(import.meta.url)) await main();
