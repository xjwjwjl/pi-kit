import assert from "node:assert/strict";
import test from "node:test";
import { BASE_STATE_LABELS, baseStateLabelArgs, settleStateLabelArgs } from "../src/labels.ts";

test("base labels initialize the row to idle and cover every lifecycle state", () => {
  const args = baseStateLabelArgs();
  assert.deepEqual(BASE_STATE_LABELS.map(([state]) => state), [
    "working",
    "blocked",
    "idle",
    "done",
    "unknown",
  ]);
  assert.ok(args.includes("idle=idle"));
  assert.equal(args.length, BASE_STATE_LABELS.length * 2);
});

test("settled labels keep the full base set instead of dropping other states", () => {
  const args = settleStateLabelArgs("completed", new Date(2026, 8, 29, 14, 7));
  assert.ok(args);
  assert.ok(args.includes("working=working"));
  assert.ok(args.includes("blocked=reply needed"));
  assert.ok(args.includes("idle=idle"));
  assert.ok(args.includes("unknown=unknown"));
  assert.ok(args.includes("done=done · 09-29 14:07"));
  assert.equal(args.length, BASE_STATE_LABELS.length * 2 + 2);
});

test("no label is written when the outcome is unknown", () => {
  assert.equal(settleStateLabelArgs(undefined, new Date()), undefined);
});
