import test from "node:test";
import assert from "node:assert/strict";
import { normalizeLeakedThinking } from "../src/thinking.ts";

function assistant(content: any[], stopReason: "toolUse" | "stop" = "toolUse") {
  return {
    role: "assistant",
    content,
    api: "openai-responses",
    provider: "gogate",
    model: "deepseek-v4-flash-vision-exp",
    usage: {},
    stopReason,
  } as any;
}

test("moves unsigned text before a tool call into thinking", () => {
  const message = assistant([
    { type: "text", text: "先分析当前状态，再执行命令。" },
    { type: "toolCall", id: "call|item", name: "bash", arguments: {} },
  ]);

  const normalized = normalizeLeakedThinking(message);
  assert.equal(normalized.content[0].type, "thinking");
  assert.equal((normalized.content[0] as any).thinking, "先分析当前状态，再执行命令。");
  assert.equal(normalized.content[1].type, "toolCall");
});

test("keeps signed commentary text visible", () => {
  const message = assistant([
    { type: "text", text: "执行结果如下。", textSignature: "{\"v\":1,\"id\":\"msg-1\"}" },
    { type: "toolCall", id: "call|item", name: "bash", arguments: {} },
  ]);

  const normalized = normalizeLeakedThinking(message);
  assert.equal(normalized, message);
});

test("does not change text-only final answers", () => {
  const message = assistant([{ type: "text", text: "这是最终答案。" }], "stop");
  assert.equal(normalizeLeakedThinking(message), message);
});
