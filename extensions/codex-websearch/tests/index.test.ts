import assert from "node:assert/strict";
import test from "node:test";

import codexWebSearchExtension from "../index.ts";

interface RegisteredCommand {
  handler: (args: string, ctx: TestContext) => Promise<void>;
}

interface TestContext {
  model?: { provider?: string; api?: string };
  ui: { notify: (message: string, type?: string) => void };
}

function createExtensionHarness() {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const sentMessages: string[] = [];
  let command: RegisteredCommand | undefined;

  codexWebSearchExtension({
    on(name: string, handler: (...args: any[]) => unknown) {
      handlers.set(name, handler);
    },
    registerCommand(_name: string, registered: RegisteredCommand) {
      command = registered;
    },
    sendUserMessage(content: string) {
      sentMessages.push(content);
    },
  } as any);

  assert.ok(command);
  return { handlers, sentMessages, command };
}

const CODEX_CONTEXT: TestContext = {
  model: { provider: "openai-codex", api: "openai-codex-responses" },
  ui: { notify() {} },
};

test("manual command submits a query and requires native web search once", async () => {
  const { handlers, sentMessages, command } = createExtensionHarness();

  await command.handler("latest Rust stable release", CODEX_CONTEXT);
  assert.deepEqual(sentMessages, ["latest Rust stable release"]);

  const beforeAgentStart = handlers.get("before_agent_start")!;
  const system = beforeAgentStart({ systemPrompt: "base" }, CODEX_CONTEXT) as { systemPrompt: string };
  assert.match(system.systemPrompt, /for this request before answering/i);

  const beforeProviderRequest = handlers.get("before_provider_request")!;
  const payload = beforeProviderRequest({ payload: { model: "gpt-5.6" } }, CODEX_CONTEXT) as {
    tools: unknown[];
    tool_choice: unknown;
  };
  assert.deepEqual(payload.tool_choice, { type: "web_search" });
  assert.deepEqual(payload.tools, [{ type: "web_search" }]);

  const afterProviderResponse = handlers.get("after_provider_response")!;
  afterProviderResponse({ status: 200 }, CODEX_CONTEXT);
  const nextSystem = beforeAgentStart({ systemPrompt: "base" }, CODEX_CONTEXT) as { systemPrompt: string };
  assert.match(nextSystem.systemPrompt, /facts that may have changed/i);
  assert.doesNotMatch(nextSystem.systemPrompt, /for this request before answering/i);
});

test("manual command still works when automatic mode is off", async () => {
  const { handlers, sentMessages, command } = createExtensionHarness();

  await command.handler("off", CODEX_CONTEXT);
  await command.handler("current exchange rate", CODEX_CONTEXT);
  assert.deepEqual(sentMessages, ["current exchange rate"]);

  const beforeProviderRequest = handlers.get("before_provider_request")!;
  const payload = beforeProviderRequest({ payload: {} }, CODEX_CONTEXT) as { tool_choice: unknown };
  assert.deepEqual(payload.tool_choice, { type: "web_search" });
});

test("manual command rejects non-Codex models without submitting a query", async () => {
  const { sentMessages, command } = createExtensionHarness();
  const notices: string[] = [];

  await command.handler("latest Rust stable release", {
    model: { provider: "deepseek", api: "openai-completions" },
    ui: { notify: (message) => notices.push(message) },
  });

  assert.deepEqual(sentMessages, []);
  assert.match(notices[0] ?? "", /requires an openai-codex/i);
});
