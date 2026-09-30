import assert from "node:assert/strict";
import test from "node:test";
import { formatCompletionTimestamp, formatSettledStateLabel } from "../src/format.ts";

test("formats completion timestamp as local MM-DD HH:mm", () => {
  assert.equal(formatCompletionTimestamp(new Date(2026, 8, 29, 14, 7)), "09-29 14:07");
  assert.equal(formatCompletionTimestamp(new Date(2026, 8, 29, 0, 5)), "09-29 00:05");
});

test("formats outcome-specific English labels", () => {
  const date = new Date(2026, 8, 29, 14, 7);
  assert.equal(formatSettledStateLabel("completed", date), "done · 09-29 14:07");
  assert.equal(formatSettledStateLabel("aborted", date), "stopped");
  assert.equal(formatSettledStateLabel("error", date), "failed");
  assert.equal(formatSettledStateLabel(undefined, date), undefined);
});
