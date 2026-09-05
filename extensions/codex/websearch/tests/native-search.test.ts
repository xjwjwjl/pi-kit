import assert from "node:assert/strict";
import test from "node:test";

import { addNativeWebSearchTool, isCodexModel } from "../src/native-search.ts";

test("adds the native web search tool without changing automatic tool choice", () => {
  const result = addNativeWebSearchTool({ model: "gpt-5.6-luna", tool_choice: "auto" });

  assert.deepEqual(result, {
    model: "gpt-5.6-luna",
    tool_choice: "auto",
    tools: [{ type: "web_search" }],
  });
});

test("keeps an existing native web search tool without duplication", () => {
  const tools = [{ type: "function", name: "read" }, { type: "web_search" }];
  const result = addNativeWebSearchTool({ tools });

  assert.deepEqual(result?.tools, tools);
});

test("recognizes supported web search aliases", () => {
  const tools = [
    { type: "web_search_preview" },
    { type: "web_search_preview_2025_03_11" },
    { type: "web_search_2025_08_26" },
  ];

  const result = addNativeWebSearchTool({ tools });

  assert.deepEqual(result?.tools, tools);
});

test("does not rewrite malformed payloads", () => {
  assert.equal(addNativeWebSearchTool(null), undefined);
  assert.equal(addNativeWebSearchTool({ tools: "invalid" }), undefined);
});

test("only identifies the OpenAI Codex Responses provider", () => {
  assert.equal(
    isCodexModel({ provider: "openai-codex", api: "openai-codex-responses" }),
    true,
  );
  assert.equal(isCodexModel({ provider: "openai-codex", api: "openai-responses" }), false);
  assert.equal(isCodexModel({ provider: "openai", api: "openai-codex-responses" }), false);
  assert.equal(isCodexModel(undefined), false);
});
