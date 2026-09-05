export type GogateFailureKind = "quota" | "other";

export interface GogateFailureSignal {
  errorMessage?: string;
  status?: number;
}

export interface GogateFailureMatch {
  matched: boolean;
  kind?: GogateFailureKind;
  reason?: string;
}

const CONTEXT_ERROR_PATTERN = /context.?length|maximum context|too many tokens|prompt is too long/i;
const QUOTA_ERROR_PATTERN = /insufficient[_ -]?quota|quota|usage limit|out of budget|rate.?limit|too many requests/i;

/**
 * gogate currently reports exhausted model quotas as HTTP 429 with no body:
 * `OpenAI API error (429): 429 status code (no body)`.
 *
 * Status is intentionally accepted as a signal because the gateway may return
 * an empty error body. Context errors are excluded so a model switch does not
 * hide a deterministic prompt-size problem.
 */
export function matchGogateFailure(signal: GogateFailureSignal): GogateFailureMatch {
  const message = signal.errorMessage ?? "";
  if (CONTEXT_ERROR_PATTERN.test(message)) {
    return { matched: false };
  }

  if (signal.status === 429 || /\b429\b/.test(message)) {
    return { matched: true, kind: "quota", reason: "HTTP 429" };
  }

  if (QUOTA_ERROR_PATTERN.test(message)) {
    return { matched: true, kind: "quota", reason: "quota or usage limit" };
  }

  return { matched: false };
}

export function failoverContinuationMessage(): string {
  return "Continue the user's current task from the existing conversation. Do not mention this internal recovery step.";
}

