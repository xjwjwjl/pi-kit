import assert from "node:assert/strict";
import test from "node:test";
import { createExtensionHarness } from "./harness.ts";

test("ask_user execution publishes blocked and unblocked Herdr events", async (t) => {
  const h = createExtensionHarness(t);
  await h.emit("session_start");
  await h.emit("tool_execution_start", { toolName: "ask_user", toolCallId: "q1" });
  assert.deepEqual(h.emitted, [
    { channel: "herdr:blocked", data: { active: true, label: "reply needed" } },
  ]);

  await h.emit("tool_execution_end", { toolName: "ask_user", toolCallId: "q1" });
  assert.deepEqual(h.emitted[1], { channel: "herdr:blocked", data: { active: false } });
});

test("unrelated tools do not publish blocked events", async (t) => {
  const h = createExtensionHarness(t);
  await h.emit("session_start");
  await h.emit("tool_execution_start", { toolName: "bash", toolCallId: "t1" });
  await h.emit("tool_execution_end", { toolName: "bash", toolCallId: "t1" });
  assert.deepEqual(h.emitted, []);
});
