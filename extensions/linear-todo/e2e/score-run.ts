import { isTodoState } from "../schema.ts";
import type { ModelScenarioExpectations } from "./model-scenarios.ts";
import {
  addCheck,
  claimsSuccess,
  MODEL_PASS_THRESHOLD,
  MODEL_SCORE_WEIGHTS,
  verificationIssue,
  type BehaviorCheck,
  type ModelVerificationOutcome,
} from "./rubric.ts";
import type { ScenarioExpectations } from "./scenario.ts";

// Backwards-compatible re-exports. The rubric lives in `rubric.ts`, which has no dependency on
// the Todo domain, so it can be copied into another extension unchanged.
export { claimsSuccess, MODEL_PASS_THRESHOLD, MODEL_SCORE_WEIGHTS } from "./rubric.ts";
export type { BehaviorCheck, ModelVerificationOutcome } from "./rubric.ts";

interface JsonRecord {
  [key: string]: unknown;
}

export interface TodoTransitionRecord {
  action: string;
  state: JsonRecord | null;
  transition?: string;
  error?: string;
  invalidState?: boolean;
}

export interface ScoreResult {
  score: number;
  hardFail: boolean;
  passed: boolean;
  issues: string[];
  metrics: {
    todoActions: string[];
    todoToolCalls: number;
    autoContinueMessages: number;
    finalTodoPhase: string;
    finalTodoCursor?: number;
    finalTodoItemCount?: number;
    duplicateAutoContinueStages: string[];
  };
  todoTransitions: TodoTransitionRecord[];
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function transitionFromEntry(entry: unknown): TodoTransitionRecord | undefined {
  if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) return undefined;
  if (entry.message.role !== "toolResult" || entry.message.toolName !== "todo") return undefined;
  const details = entry.message.details;
  if (!isRecord(details) || typeof details.action !== "string") return undefined;
  const hasState = Object.prototype.hasOwnProperty.call(details, "state");
  const state = details.state;
  const invalidState = !hasState || (state !== null && !isTodoState(state));
  return {
    action: details.action,
    state: state === null ? null : isRecord(state) ? structuredClone(state) : null,
    ...(typeof details.transition === "string" ? { transition: details.transition } : {}),
    ...(typeof details.error === "string" ? { error: details.error } : {}),
    ...(invalidState ? { invalidState: true } : {}),
  };
}

function autoContinueStageKeys(entries: unknown[]): string[] {
  return entries.flatMap((entry) => {
    if (!isRecord(entry) || entry.type !== "custom_message" || entry.customType !== "linear-todo-auto-continue") return [];
    if (!isRecord(entry.details) || typeof entry.details.stageKey !== "string") return [];
    return [entry.details.stageKey];
  });
}

function finalTodoState(transitions: TodoTransitionRecord[]): JsonRecord | null | undefined {
  return transitions.length === 0 ? undefined : transitions[transitions.length - 1]!.state;
}

export function scoreRun(expect: ScenarioExpectations | undefined, entries: unknown[]): ScoreResult {
  const todoTransitions = entries.map(transitionFromEntry).filter((entry): entry is TodoTransitionRecord => entry !== undefined);
  const todoActions = todoTransitions.map((transition) => transition.action);
  const stageKeys = autoContinueStageKeys(entries);
  const duplicates = [...new Set(stageKeys.filter((key, index) => stageKeys.indexOf(key) !== index))];
  const finalState = finalTodoState(todoTransitions);
  const finalTodoPhase = finalState === undefined ? "none" : finalState === null ? "none" : String(finalState.phase ?? "unknown");
  const invalidStateSnapshot = todoTransitions.some((transition) => transition.invalidState);
  const invalidActiveState = todoTransitions.some(
    (transition) =>
      transition.state &&
      transition.state.phase === "active" &&
      Number(transition.state.cursor) >= (Array.isArray(transition.state.items) ? transition.state.items.length : 0),
  );
  const scriptExhausted = entries.some((entry) =>
    isRecord(entry) && entry.type === "message" && isRecord(entry.message) &&
    entry.message.role === "assistant" && entry.message.stopReason === "error" &&
    typeof entry.message.errorMessage === "string" &&
    /^Scripted scenario .+ exhausted at provider call \d+\.$/.test(entry.message.errorMessage),
  );
  const issues: string[] = [];

  if (scriptExhausted) issues.push("scripted provider exhausted before the scenario finished");
  if (duplicates.length > 0) issues.push(`duplicate auto-continue stage keys: ${duplicates.join(", ")}`);
  if (invalidStateSnapshot) issues.push("Todo tool result is missing a valid state snapshot");
  if (invalidActiveState) issues.push("active Todo snapshot has no remaining task");

  if (expect?.todoActions && JSON.stringify(todoActions) !== JSON.stringify(expect.todoActions)) {
    issues.push(`todo actions mismatch: expected ${JSON.stringify(expect.todoActions)}, got ${JSON.stringify(todoActions)}`);
  }
  if (expect?.todoToolCalls !== undefined && todoTransitions.length !== expect.todoToolCalls) {
    issues.push(`todo tool call count mismatch: expected ${expect.todoToolCalls}, got ${todoTransitions.length}`);
  }
  if (expect?.autoContinueMessages !== undefined && stageKeys.length !== expect.autoContinueMessages) {
    issues.push(`auto-continue count mismatch: expected ${expect.autoContinueMessages}, got ${stageKeys.length}`);
  }
  if (expect?.finalTodoPhase !== undefined && finalTodoPhase !== expect.finalTodoPhase) {
    issues.push(`final Todo phase mismatch: expected ${expect.finalTodoPhase}, got ${finalTodoPhase}`);
  }

  if (expect?.finalTodoCursor !== undefined) {
    const cursor = finalState && typeof finalState.cursor === "number" ? finalState.cursor : undefined;
    if (cursor !== expect.finalTodoCursor) issues.push(`final Todo cursor mismatch: expected ${expect.finalTodoCursor}, got ${String(cursor)}`);
  }
  if (expect?.finalTodoItemCount !== undefined) {
    const count = finalState && Array.isArray(finalState.items) ? finalState.items.length : undefined;
    if (count !== expect.finalTodoItemCount) issues.push(`final Todo item count mismatch: expected ${expect.finalTodoItemCount}, got ${String(count)}`);
  }

  const score = scriptExhausted ? 0 : Math.max(0, 100 - issues.length * 20);
  return {
    score,
    hardFail: scriptExhausted || duplicates.length > 0 || invalidStateSnapshot || invalidActiveState,
    passed: issues.length === 0,
    issues,
    metrics: {
      todoActions,
      todoToolCalls: todoTransitions.length,
      autoContinueMessages: stageKeys.length,
      finalTodoPhase,
      ...(finalState && typeof finalState.cursor === "number" ? { finalTodoCursor: finalState.cursor } : {}),
      ...(finalState && Array.isArray(finalState.items) ? { finalTodoItemCount: finalState.items.length } : {}),
      duplicateAutoContinueStages: duplicates,
    },
    todoTransitions,
  };
}

export type ModelVariant = "baseline" | "todo-enabled" | "control";

export interface ModelGates {
  /** The task-specific acceptance tests pass after the run. */
  acceptance: boolean;
  /** The pre-existing test suite passes after the run. */
  regression: boolean;
  /** The acceptance tests failed on the pristine fixture, so the scenario can discriminate. */
  precondition: boolean;
  /** The repository change matches the scenario contract. */
  repoChange: boolean;
  /** A scenario marked `avoid` did not activate Todo. */
  todoActivation: boolean;
  /** Todo state was not corrupted (duplicate stages, invalid snapshots). */
  integrity: boolean;
}

export interface ModelProcessMetrics {
  todoCalls: number;
  planSize?: number;
  planHasVerificationTask?: boolean;
  finalTodoPhase: string;
  autoContinueMessages: number;
  repoChanged: boolean;
  finalResponsePresent: boolean;
  falseSuccessClaim: boolean;
}

export interface ModelScoreResult extends ScoreResult {
  model: string;
  scenario: string;
  variant: ModelVariant;
  /** False for `process` scenarios: the run is gated but excluded from the A/B quality average. */
  qualityScored: boolean;
  gates: ModelGates;
  gateIssues: string[];
  infrastructurePassed: boolean;
  behaviorPassed: boolean;
  behaviorScore: number;
  behaviorChecks: BehaviorCheck[];
  acceptancePassed: boolean;
  regressionPassed: boolean;
  preconditionFalsifiable: boolean;
  expectationIssues: string[];
  observations: string[];
  processMetrics: ModelProcessMetrics;
  modelMetrics: {
    tokensTotal?: number;
    toolCalls?: number;
    wallTimeMs: number;
    repoChanged: boolean;
    finalResponsePresent: boolean;
  };
}

export interface ModelScoreInput {
  model: string;
  scenario: string;
  variant: ModelVariant;
  entries: unknown[];
  expect?: ModelScenarioExpectations;
  acceptance: ModelVerificationOutcome;
  regression: ModelVerificationOutcome;
  /** True when the acceptance tests failed on the pristine fixture. */
  preconditionFalsifiable: boolean;
  /** Defaults to `outcome`. Process scenarios keep the gates but are not quality scored. */
  oracle?: "outcome" | "process";
  stats?: unknown;
  wallTimeMs: number;
  finalResponse?: string;
  repoDiff?: string;
}

function planState(transitions: TodoTransitionRecord[]): JsonRecord | undefined {
  const plan = transitions.find((transition) => transition.action === "plan" && transition.state !== null)?.state;
  return plan && isRecord(plan) ? plan : undefined;
}

function planItems(state: JsonRecord | undefined): JsonRecord[] {
  return state && Array.isArray(state.items) ? state.items.filter(isRecord) : [];
}

function includesVerificationTask(items: JsonRecord[]): boolean {
  return items.some((item) => {
    const text = [item.title, item.description, item.doneWhen].filter((value) => typeof value === "string").join(" ");
    return /\b(test|tests|testing|verify|verification|build|lint|check)\b/i.test(text);
  });
}

export function scoreModelRun(input: ModelScoreInput): ModelScoreResult {
  const base = scoreRun(undefined, input.entries);
  const checks: BehaviorCheck[] = [];
  const gateIssues: string[] = [];
  const observations: string[] = [];
  const todoCalls = base.metrics.todoToolCalls;
  const finalResponsePresent = typeof input.finalResponse === "string" && input.finalResponse.trim().length > 0;
  const repoChanged = typeof input.repoDiff === "string" && input.repoDiff.trim().length > 0;
  const falseSuccessClaim = claimsSuccess(input.finalResponse) && !input.acceptance.passed;

  const acceptanceIssue = verificationIssue("acceptance", input.acceptance);
  if (acceptanceIssue) gateIssues.push(acceptanceIssue);
  const regressionIssue = verificationIssue("regression", input.regression);
  if (regressionIssue) gateIssues.push(regressionIssue);

  const expectedRepoChange = input.expect?.repoChange;
  const repoChangeGate =
    expectedRepoChange === "some" ? repoChanged : expectedRepoChange === "none" ? !repoChanged : true;
  if (!repoChangeGate) {
    gateIssues.push(
      expectedRepoChange === "none"
        ? "repository should remain unchanged but the run modified it"
        : "repository should contain a change but the run left it untouched",
    );
  }

  const avoidTodo = input.expect?.todo === "avoid";
  const todoActivationGate = avoidTodo ? todoCalls === 0 : true;
  if (!todoActivationGate) {
    gateIssues.push(`Todo should remain inactive for this scenario but the run made ${todoCalls} Todo call(s)`);
  }

  if (!input.preconditionFalsifiable) {
    gateIssues.push("scenario is not falsifiable: the acceptance tests already passed on the pristine fixture");
  }
  if (base.hardFail) gateIssues.push(...base.issues);

  const honestyPassed =
    input.expect?.finalResponse === "either"
      ? !falseSuccessClaim
      : finalResponsePresent && !falseSuccessClaim;

  addCheck(checks, "acceptance", MODEL_SCORE_WEIGHTS.acceptance, input.acceptance.passed, acceptanceIssue ?? "acceptance tests passed");
  addCheck(checks, "regression", MODEL_SCORE_WEIGHTS.regression, input.regression.passed, regressionIssue ?? "regression suite passed");
  addCheck(
    checks,
    "honesty",
    MODEL_SCORE_WEIGHTS.honesty,
    honestyPassed,
    falseSuccessClaim
      ? "final response claims success while the acceptance oracle failed"
      : finalResponsePresent
        ? "final response is present"
        : "final response is empty",
  );

  const gates: ModelGates = {
    acceptance: input.acceptance.passed,
    regression: input.regression.passed,
    precondition: input.preconditionFalsifiable,
    repoChange: repoChangeGate,
    todoActivation: todoActivationGate,
    integrity: !base.hardFail,
  };
  const behaviorPassed = Object.values(gates).every(Boolean);
  const behaviorScore = checks.filter((check) => check.passed).reduce((sum, check) => sum + check.weight, 0);

  const plan = planState(base.todoTransitions);
  const items = planItems(plan);
  const finalTodoPhase = base.metrics.finalTodoPhase;

  // Process signals are observations, never score. They explain *how* the run behaved.
  if (input.expect?.finalTodoPhase && input.expect.finalTodoPhase !== "either" && finalTodoPhase !== input.expect.finalTodoPhase) {
    observations.push(`final Todo phase was ${finalTodoPhase}, scenario expected ${input.expect.finalTodoPhase}`);
  }
  if (input.expect?.plan) {
    const min = input.expect.plan.minItems ?? 1;
    const max = input.expect.plan.maxItems ?? Number.POSITIVE_INFINITY;
    if (items.length < min || items.length > max) observations.push(`plan had ${items.length} task(s), scenario expected ${min}-${max}`);
    if (
      input.expect.plan.requireVerificationTask !== undefined &&
      includesVerificationTask(items) !== input.expect.plan.requireVerificationTask
    ) {
      observations.push("plan verification task did not match the scenario preference");
    }
  }

  const stats = isRecord(input.stats) ? input.stats : undefined;
  const tokensTotal = stats && isRecord(stats.tokens) && typeof stats.tokens.total === "number" ? stats.tokens.total : undefined;
  const toolCalls = stats && typeof stats.toolCalls === "number" ? stats.toolCalls : undefined;
  const score = behaviorScore;
  const infrastructurePassed = gates.precondition && gates.integrity;

  return {
    ...base,
    model: input.model,
    scenario: input.scenario,
    variant: input.variant,
    qualityScored: (input.oracle ?? "outcome") === "outcome",
    gates,
    gateIssues,
    infrastructurePassed,
    acceptancePassed: input.acceptance.passed,
    regressionPassed: input.regression.passed,
    preconditionFalsifiable: input.preconditionFalsifiable,
    behaviorPassed,
    behaviorScore,
    behaviorChecks: checks,
    expectationIssues: gateIssues,
    observations,
    processMetrics: {
      todoCalls,
      ...(items.length > 0 ? { planSize: items.length } : {}),
      ...(items.length > 0 ? { planHasVerificationTask: includesVerificationTask(items) } : {}),
      finalTodoPhase,
      autoContinueMessages: base.metrics.autoContinueMessages,
      repoChanged,
      finalResponsePresent,
      falseSuccessClaim,
    },
    modelMetrics: {
      ...(tokensTotal === undefined ? {} : { tokensTotal }),
      ...(toolCalls === undefined ? {} : { toolCalls }),
      wallTimeMs: input.wallTimeMs,
      repoChanged,
      finalResponsePresent,
    },
    score,
    hardFail: !gates.integrity || !gates.precondition,
    passed: behaviorPassed && score >= MODEL_PASS_THRESHOLD,
    issues: [...base.issues, ...gateIssues],
  };
}
