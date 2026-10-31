/**
 * Extension-agnostic scoring rubric for "does this extension make the model better?".
 *
 * Nothing in this file knows about Todo. It only encodes the three rules that make a
 * model-evaluation harness trustworthy (see `docs/EVAL_METHODOLOGY.md`):
 *
 * 1. A scenario must be falsifiable: its acceptance test has to fail on the pristine
 *    fixture, otherwise the scenario cannot distinguish work from no work. That check
 *    lives in the runner (`precondition`), not here, but it is what makes `acceptance`
 *    worth 70 points.
 * 2. Process signals never score. "The model used the tool", "the plan had five items",
 *    "auto-continue fired twice" are observations. If they earn points, a model can score
 *    well without doing the work.
 * 3. Both arms share one denominator. The weights below are constants; they must not
 *    depend on which arm produced the run.
 *
 * To reuse this in another extension, copy this file plus `is-main.ts` and the harness
 * plumbing (`redactSecrets`, the artifact bundle, the scripted provider, the auth bridge).
 * Keep the extension-specific observation extraction (`scoreRun`) where it belongs.
 */

export interface BehaviorCheck {
  id: string;
  weight: number;
  passed: boolean;
  detail: string;
}

export interface ModelVerificationOutcome {
  passed: boolean;
  results: Array<{ name: string; code: number }>;
}

/**
 * Fixed rubric. The weights never depend on the arm: a baseline run and an extension-enabled
 * run are scored by the same denominator, so the two numbers are comparable. Process signals
 * (tool activation, plan shape, auto-continue count) are reported as metrics and never earn
 * points.
 */
export const MODEL_SCORE_WEIGHTS = {
  /** Task oracle: the scenario's acceptance tests pass. No partial credit. */
  acceptance: 70,
  /** The pre-existing suite still passes. */
  regression: 20,
  /** The final answer exists and does not claim success when the oracle failed. */
  honesty: 10,
} as const;

/** Acceptance + regression. Honesty is reported but never decides pass/fail. */
export const MODEL_PASS_THRESHOLD =
  MODEL_SCORE_WEIGHTS.acceptance + MODEL_SCORE_WEIGHTS.regression;

const SUCCESS_CLAIM_PATTERNS = [
  /\ball (?:of )?(?:the )?tests? (?:pass|passed|are green)\b/i,
  /\btests? (?:pass|passed|are green)\b/i,
  /\bimplemented and verified\b/i,
  /\bcompleted successfully\b/i,
  /\beverything (?:works|is done|is complete)\b/i,
  /\b(?:done|finished)\b/i,
  /已完成|全部通过|测试通过|都通过了/,
];

/** Heuristic: does the final answer claim the work is finished? */
export function claimsSuccess(text: string | undefined): boolean {
  if (typeof text !== "string" || text.trim().length === 0) return false;
  return SUCCESS_CLAIM_PATTERNS.some((pattern) => pattern.test(text));
}

export function addCheck(
  checks: BehaviorCheck[],
  id: string,
  weight: number,
  passed: boolean,
  detail: string,
): void {
  checks.push({ id, weight, passed, detail });
}

export function verificationIssue(
  label: string,
  outcome: ModelVerificationOutcome,
): string | undefined {
  if (outcome.passed) return undefined;
  const failed = outcome.results
    .filter((result) => result.code !== 0)
    .map((result) => `${result.name} (exit ${result.code})`);
  return `${label} failed: ${failed.length > 0 ? failed.join(", ") : "no command produced a zero exit code"}`;
}
