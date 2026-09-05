import test from "node:test";
import assert from "node:assert/strict";
import {
  failoverContinuationMessage,
  matchGogateFailure,
} from "../src/matcher.ts";

test("matches gogate HTTP 429 without a response body", () => {
  const result = matchGogateFailure({
    errorMessage: "OpenAI API error (429): 429 status code (no body)",
  });

  assert.equal(result.matched, true);
  assert.equal(result.kind, "quota");
  assert.equal(result.reason, "HTTP 429");
});

test("matches an HTTP status captured by after_provider_response", () => {
  const result = matchGogateFailure({ status: 429 });
  assert.equal(result.matched, true);
});

test("matches quota wording", () => {
  assert.equal(matchGogateFailure({ errorMessage: "insufficient_quota" }).matched, true);
  assert.equal(matchGogateFailure({ errorMessage: "monthly usage limit reached" }).matched, true);
});

test("does not fail over deterministic context errors", () => {
  assert.equal(
    matchGogateFailure({
      status: 429,
      errorMessage: "context length exceeded",
    }).matched,
    false,
  );
});

test("does not match unrelated errors", () => {
  assert.equal(matchGogateFailure({ status: 401, errorMessage: "invalid api key" }).matched, false);
  assert.equal(matchGogateFailure({ status: 400, errorMessage: "invalid request" }).matched, false);
});

test("continuation text stays invisible to the user-facing warning", () => {
  const continuation = failoverContinuationMessage();
  assert.match(continuation, /Continue the user's current task/);
  assert.doesNotMatch(continuation, /429|quota|rate.?limit/i);
});
