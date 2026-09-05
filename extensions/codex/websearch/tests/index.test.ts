import assert from "node:assert/strict";
import test from "node:test";

import codexWebSearchExtension from "../index.ts";

interface TestContext {
  model?: { provider?: string; api?: string };
}

function createExtensionHarness() {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  let commandRegistered = false;

  codexWebSearchExtension({
    on(name: string, handler: (...args: any[]) => unknown) {
      handlers.set(name, handler);
    },
    registerCommand() {
      commandRegistered = true;
    },
  } as any);

  return { handlers, commandRegistered };
}

const CODEX_CONTEXT: TestContext = {
  model: { provider: "openai-codex", api: "openai-codex-responses" },
};

test("enables native web search for every Codex request", () => {
  const { handlers, commandRegistered } = createExtensionHarness();

  assert.equal(commandRegistered, false);

  const beforeAgentStart = handlers.get("before_agent_start")!;
  const system = beforeAgentStart({ systemPrompt: "base" }, CODEX_CONTEXT) as { systemPrompt: string };
  assert.match(system.systemPrompt, /facts that may have changed/i);

  const beforeProviderRequest = handlers.get("before_provider_request")!;
  const payload = beforeProviderRequest(
    { payload: { model: "gpt-5.6", tool_choice: "auto" } },
    CODEX_CONTEXT,
  ) as { tools: unknown[]; tool_choice: unknown };
  assert.deepEqual(payload.tool_choice, "auto");
  assert.deepEqual(payload.tools, [{ type: "web_search" }]);
});

test("leaves non-Codex requests unchanged", () => {
  const { handlers } = createExtensionHarness();
  const context = { model: { provider: "deepseek", api: "openai-completions" } };
  const payload = { model: "deepseek-chat" };

  const beforeAgentStart = handlers.get("before_agent_start")!;
  assert.equal(beforeAgentStart({ systemPrompt: "base" }, context), undefined);

  const beforeProviderRequest = handlers.get("before_provider_request")!;
  assert.equal(beforeProviderRequest({ payload }, context), undefined);
  assert.deepEqual(payload, { model: "deepseek-chat" });
});
