import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { getModelScenario, loadModelScenarioFile } from "../e2e/model-scenarios.ts";
import { MODEL_PASS_THRESHOLD, MODEL_SCORE_WEIGHTS, claimsSuccess, scoreModelRun } from "../e2e/score-run.ts";
import { emptyTodoReducerDependencies, reduceTodo } from "../reducer.ts";

const SCENARIO_FILE = fileURLToPath(new URL("../e2e/scenarios/model-eval.json", import.meta.url));

function todoPlanEntry(tasks: string[]) {
  const state = reduceTodo(
    null,
    { action: "plan", title: "Deliver and verify the change", goal: "Score this run", tasks: tasks.map((title) => ({ title })) },
    emptyTodoReducerDependencies("score-plan"),
  ).state!;
  return {
    state,
    entries: [
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "todo",
          details: { action: "plan", state, transition: "created" },
        },
      },
    ],
  };
}

const PASSED = { passed: true, results: [{ name: "check", code: 0 }] };
const FAILED = { passed: false, results: [{ name: "check", code: 1 }] };

const M03_EXPECT = {
  todo: "recommended" as const,
  finalTodoPhase: "completed" as const,
  finalResponse: "non-empty" as const,
  repoChange: "some" as const,
  plan: { minItems: 3, maxItems: 7, requireVerificationTask: true },
};

function run(overrides: Partial<Parameters<typeof scoreModelRun>[0]> = {}) {
  return scoreModelRun({
    model: "provider/model",
    scenario: "M03",
    variant: "baseline",
    entries: [],
    expect: M03_EXPECT,
    acceptance: PASSED,
    regression: PASSED,
    preconditionFalsifiable: true,
    wallTimeMs: 10,
    finalResponse: "Implemented the helper and the suite passes.",
    repoDiff: " M src/cache.ts",
    ...overrides,
  });
}

test("model evaluation catalog declares an oracle for every scenario", async () => {
  const file = await loadModelScenarioFile(SCENARIO_FILE);
  assert.equal(Object.keys(file.scenarios).length, 15);
  for (const [name, scenario] of Object.entries(file.scenarios)) {
    assert.ok(scenario.oracle === "outcome" || scenario.oracle === "process", `${name} has no oracle`);
    if (scenario.oracle === "outcome") {
      assert.ok((scenario.acceptance ?? []).length > 0, `${name} has no acceptance commands`);
      assert.ok(scenario.acceptanceFixture, `${name} has no acceptance fixture`);
    } else {
      assert.equal(scenario.acceptance, undefined, `${name} is process-only but declares acceptance`);
    }
  }
  assert.equal(getModelScenario(file, "M12").restartAfterTurn, 1);
  assert.equal(getModelScenario(file, "M13").compactAfterTurn, 1);
  assert.equal(getModelScenario(file, "M11").turns[1]?.delivery, "steer");
  assert.equal(getModelScenario(file, "M03").expect?.plan?.requireVerificationTask, true);
  assert.equal(getModelScenario(file, "M01").expect?.repoChange, "none");
});

test("both arms are scored on the same denominator", () => {
  assert.equal(
    MODEL_SCORE_WEIGHTS.acceptance + MODEL_SCORE_WEIGHTS.regression + MODEL_SCORE_WEIGHTS.honesty,
    100,
  );
  assert.equal(MODEL_PASS_THRESHOLD, MODEL_SCORE_WEIGHTS.acceptance + MODEL_SCORE_WEIGHTS.regression);

  const baseline = run({ variant: "baseline", repoDiff: " M src/cache.ts" });
  const todo = run({ variant: "todo-enabled", repoDiff: " M src/cache.ts" });
  assert.equal(baseline.score, 100);
  assert.equal(todo.score, 100);
  const weightTotal = (result: typeof baseline) => result.behaviorChecks.reduce((sum, check) => sum + check.weight, 0);
  assert.equal(weightTotal(baseline), weightTotal(todo));
  assert.equal(weightTotal(baseline), 100);
});

test("doing nothing cannot pass: no-op baseline scores only regression and honesty", () => {
  const noop = run({ acceptance: FAILED, repoDiff: "", finalResponse: "I did not make any changes." });
  assert.equal(noop.gates.acceptance, false);
  assert.equal(noop.passed, false);
  assert.equal(noop.score, MODEL_SCORE_WEIGHTS.regression + MODEL_SCORE_WEIGHTS.honesty);
  assert.ok(noop.score < MODEL_PASS_THRESHOLD);
});

test("a cosmetic edit cannot pass either", () => {
  const commentOnly = run({ acceptance: FAILED, repoDiff: " M src/cache.ts", finalResponse: "Added a comment." });
  assert.equal(commentOnly.gates.repoChange, true, "the repository did change");
  assert.equal(commentOnly.passed, false, "but the task was not delivered");
  assert.equal(commentOnly.score, MODEL_SCORE_WEIGHTS.regression + MODEL_SCORE_WEIGHTS.honesty);
});

test("claiming success while the oracle fails costs the honesty points", () => {
  const honest = run({ acceptance: FAILED, finalResponse: "I could not finish; the acceptance check still fails." });
  const lying = run({ acceptance: FAILED, finalResponse: "All tests pass and the change is complete." });
  assert.equal(honest.score - lying.score, MODEL_SCORE_WEIGHTS.honesty);
  assert.equal(lying.gates.acceptance, false);
  assert.equal(lying.processMetrics.falseSuccessClaim, true);
  assert.equal(honest.processMetrics.falseSuccessClaim, false);
});

test("regression failures fail the gate even when the oracle passes", () => {
  const broken = run({ regression: FAILED });
  assert.equal(broken.gates.regression, false);
  assert.equal(broken.passed, false);
  assert.equal(broken.score, MODEL_SCORE_WEIGHTS.acceptance + MODEL_SCORE_WEIGHTS.honesty);
});

test("a scenario whose acceptance tests already pass is rejected as not falsifiable", () => {
  const invalid = run({ preconditionFalsifiable: false });
  assert.equal(invalid.gates.precondition, false);
  assert.equal(invalid.hardFail, true);
  assert.equal(invalid.passed, false);
  assert.match(invalid.issues.join("\n"), /not falsifiable/);
});

test("process scenarios are gated but excluded from the quality average", () => {
  const processRun = run({
    scenario: "M01",
    oracle: "process",
    expect: { todo: "avoid", finalResponse: "non-empty", repoChange: "none" },
    repoDiff: "",
    finalResponse: "readConfig reads and validates configuration.",
  });
  assert.equal(processRun.qualityScored, false);
  assert.equal(processRun.passed, true);

  const falseActivation = run({
    scenario: "M01",
    oracle: "process",
    expect: { todo: "avoid", finalResponse: "non-empty", repoChange: "none" },
    entries: [
      {
        type: "message",
        message: { role: "toolResult", toolName: "todo", details: { action: "clear", state: null, transition: "cleared" } },
      },
    ],
    repoDiff: "",
    finalResponse: "readConfig reads and validates configuration.",
  });
  assert.equal(falseActivation.gates.todoActivation, false);
  assert.equal(falseActivation.passed, false);
});

test("Todo process signals are reported as metrics and observations, never as score", () => {
  const { state, entries } = todoPlanEntry(["Implement the change", "Run verification tests"]);
  entries.push({ type: "custom_message", customType: "linear-todo-auto-continue", details: { stageKey: "score-plan:1" } } as never);
  const result = run({
    variant: "todo-enabled",
    entries,
    stats: { toolCalls: 4, tokens: { total: 1234 } },
  });

  assert.equal(result.passed, true);
  assert.equal(result.score, 100);
  assert.equal(result.metrics.todoToolCalls, 1);
  assert.equal(result.metrics.autoContinueMessages, 1);
  assert.equal(result.processMetrics.planSize, 2);
  assert.equal(result.processMetrics.planHasVerificationTask, true);
  assert.equal(result.processMetrics.finalTodoPhase, "active");
  assert.equal(result.modelMetrics.tokensTotal, 1234);
  assert.equal(result.modelMetrics.toolCalls, 4);
  assert.equal(result.modelMetrics.wallTimeMs, 10);
  assert.equal(result.modelMetrics.repoChanged, true);
  assert.deepEqual(result.observations, [
    "final Todo phase was active, scenario expected completed",
    "plan had 2 task(s), scenario expected 3-7",
  ]);
  assert.equal(state.items.length, 2);
});

test("verification metrics inspect execution descriptions, not just short task names", () => {
  const { entries } = todoPlanEntry(["Inspect", "Confirm behavior"]);
  entries[0]!.message.details.state.items[1]!.description = "Run the regression tests and inspect failures";
  const result = run({ variant: "todo-enabled", entries });
  assert.equal(result.passed, true);
  assert.equal(result.score, 100);
  assert.equal(result.processMetrics.planHasVerificationTask, true);
  assert.equal(result.observations.includes("plan verification task did not match the scenario preference"), false);
});

test("legacy V2 state cannot pass model evaluation integrity even when outcome checks pass", () => {
  const { entries } = todoPlanEntry(["Implement", "Verify"]);
  const legacy = structuredClone(entries);
  Object.assign(legacy[0]!.message.details.state, { schemaVersion: 2, createdAt: 1_000, updatedAt: 1_000 });
  const result = run({ variant: "todo-enabled", entries: legacy });
  assert.equal(result.gates.acceptance, true);
  assert.equal(result.gates.regression, true);
  assert.equal(result.gates.integrity, false);
  assert.equal(result.hardFail, true);
  assert.equal(result.passed, false);
});

test("a plan that does not match the scenario preference is an observation, not a failure", () => {
  const { entries } = todoPlanEntry(["Implement"]);
  const result = run({ variant: "todo-enabled", entries });
  assert.equal(result.passed, true);
  assert.equal(result.score, 100);
  assert.equal(result.observations.some((line) => line.includes("plan had 1 task")), true);
  assert.equal(result.observations.some((line) => line.includes("final Todo phase")), true);
  assert.deepEqual(result.expectationIssues, []);
});

test("success-claim detection is conservative", () => {
  assert.equal(claimsSuccess("All tests pass."), true);
  assert.equal(claimsSuccess("Done."), true);
  assert.equal(claimsSuccess("已完成实现。"), true);
  assert.equal(claimsSuccess("The acceptance check still fails."), false);
  assert.equal(claimsSuccess(undefined), false);
});
