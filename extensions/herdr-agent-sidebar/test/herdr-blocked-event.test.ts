import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import register from "../index.ts";

type Handler = (event: any) => void;

function createExtensionHarness() {
  const handlers = new Map<string, Handler>();
  const emitted: Array<{ channel: string; data: unknown }> = [];
  const pi = {
    on: (name: string, handler: Handler) => {
      handlers.set(name, handler);
      return () => {};
    },
    events: {
      emit: (channel: string, data: unknown) => emitted.push({ channel, data }),
    },
  } as unknown as ExtensionAPI;

  register(pi);
  return { handlers, emitted };
}

test("ask_user execution publishes blocked and unblocked Herdr events", () => {
  const { handlers, emitted } = createExtensionHarness();
  handlers.get("tool_execution_start")?.({ toolName: "ask_user", toolCallId: "q1" });
  assert.deepEqual(emitted, [
    { channel: "herdr:blocked", data: { active: true, label: "reply needed" } },
  ]);

  handlers.get("tool_execution_end")?.({ toolName: "ask_user", toolCallId: "q1" });
  assert.deepEqual(emitted[1], { channel: "herdr:blocked", data: { active: false } });
});

test("unrelated tools do not publish blocked events", () => {
  const { handlers, emitted } = createExtensionHarness();
  handlers.get("tool_execution_start")?.({ toolName: "bash", toolCallId: "t1" });
  handlers.get("tool_execution_end")?.({ toolName: "bash", toolCallId: "t1" });
  assert.deepEqual(emitted, []);
});
