import assert from "node:assert/strict";
import test from "node:test";
import { AskUserBlockedBridge } from "../src/blocked-bridge.ts";

test("ask_user start and end toggle Herdr blocked state", () => {
  const bridge = new AskUserBlockedBridge();
  assert.deepEqual(bridge.onToolStart("ask_user", "q1"), { active: true, label: "reply needed" });
  assert.deepEqual(bridge.onToolEnd("ask_user", "q1"), { active: false });
});

test("unrelated tools do not affect Herdr blocked state", () => {
  const bridge = new AskUserBlockedBridge();
  assert.equal(bridge.onToolStart("bash", "t1"), undefined);
  assert.equal(bridge.onToolEnd("bash", "t1"), undefined);
});

test("nested ask_user calls only clear blocked after the final prompt ends", () => {
  const bridge = new AskUserBlockedBridge();
  assert.deepEqual(bridge.onToolStart("ask_user", "q1"), { active: true, label: "reply needed" });
  assert.equal(bridge.onToolStart("ask_user", "q2"), undefined);
  assert.equal(bridge.onToolEnd("ask_user", "q1"), undefined);
  assert.deepEqual(bridge.onToolEnd("ask_user", "q2"), { active: false });
});
