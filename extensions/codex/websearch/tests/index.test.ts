import assert from "node:assert/strict";
import test from "node:test";

import codexWebSearchExtension from "../index.ts";
import { OPENAI_WEB_SEARCH_TOOL_NAME } from "../src/openai-web-search.ts";

interface TestContext {
  model?: { provider?: string; api?: string };
}

function createExtensionHarness() {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const tools = new Map<string, any>();
  let commandRegistered = false;

  codexWebSearchExtension({
    on(name: string, handler: (...args: any[]) => unknown) {
      handlers.set(name, handler);
    },
    registerTool(tool: any) {
      tools.set(tool.name, tool);
    },
    registerCommand() {
      commandRegistered = true;
    },
  } as any);

  return { handlers, tools, commandRegistered };
}

const CODEX_CONTEXT: TestContext = {
  model: { provider: "openai-codex", api: "openai-codex-responses" },
};

test("keeps the wrapper hidden for Codex and keeps native search", () => {
  const { handlers, tools, commandRegistered } = createExtensionHarness();

  assert.equal(commandRegistered, false);
  // Registered at load (hidden) so transcript replay can resolve it before session_start.
  const loadTimeTool = tools.get(OPENAI_WEB_SEARCH_TOOL_NAME);
  assert.equal(loadTimeTool.exposure, "hidden");
  assert.equal(typeof loadTimeTool.renderCall, "function");
  assert.equal(typeof loadTimeTool.renderResult, "function");

  const beforeAgentStart = handlers.get("before_agent_start")!;
  const system = beforeAgentStart({ systemPrompt: "base" }, CODEX_CONTEXT) as { systemPrompt: string };
  assert.match(system.systemPrompt, /Codex's built-in web_search/i);
  assert.equal(tools.get(OPENAI_WEB_SEARCH_TOOL_NAME).exposure, "hidden");

  const beforeProviderRequest = handlers.get("before_provider_request")!;
  const payload = beforeProviderRequest(
    { payload: { model: "gpt-5.6", tool_choice: "auto" } },
    CODEX_CONTEXT,
  ) as { tools: unknown[]; tool_choice: unknown };
  assert.deepEqual(payload.tool_choice, "auto");
  assert.deepEqual(payload.tools, [{ type: "web_search" }]);
});

test("registers only for non-Codex models and toggles exposure on model switches", () => {
  const { handlers, tools } = createExtensionHarness();
  const sessionStart = handlers.get("session_start")!;
  const nonCodexModel = { provider: "deepseek", api: "openai-completions" };

  assert.equal(tools.get(OPENAI_WEB_SEARCH_TOOL_NAME).exposure, "hidden");
  sessionStart({ type: "session_start" }, { model: CODEX_CONTEXT.model });
  assert.equal(tools.get(OPENAI_WEB_SEARCH_TOOL_NAME).exposure, "hidden");

  sessionStart({ type: "session_start" }, { model: nonCodexModel });
  assert.equal(tools.get(OPENAI_WEB_SEARCH_TOOL_NAME).exposure, "direct");

  const modelSelect = handlers.get("model_select")!;
  modelSelect({ model: CODEX_CONTEXT.model }, {});
  assert.equal(tools.get(OPENAI_WEB_SEARCH_TOOL_NAME).exposure, "hidden");
  modelSelect({ model: nonCodexModel }, {});
  assert.equal(tools.get(OPENAI_WEB_SEARCH_TOOL_NAME).exposure, "direct");
});

test("guides non-Codex models and dynamically registers the wrapper", () => {
  const { handlers, tools } = createExtensionHarness();
  const context = { model: { provider: "deepseek", api: "openai-completions" } };
  const payload = { model: "deepseek-chat" };

  const beforeAgentStart = handlers.get("before_agent_start")!;
  const system = beforeAgentStart({ systemPrompt: "base" }, context) as { systemPrompt: string };
  assert.match(system.systemPrompt, /openai_web_search/);
  assert.match(system.systemPrompt, /make each query self-contained/);
  const searchTool = tools.get(OPENAI_WEB_SEARCH_TOOL_NAME);
  assert.equal(searchTool.exposure, "direct");
  assert.equal(typeof searchTool.renderCall, "function");
  assert.equal(typeof searchTool.renderResult, "function");
  assert.equal(searchTool.outputSchema.type, "object");
  assert.match(searchTool.description, /Make queries self-contained, preserving relevant context and constraints/);
  assert.match(searchTool.description, /multi-source comparisons/);
  assert.deepEqual(searchTool.parameters.required, ["query"]);
  assert.deepEqual(searchTool.parameters.properties.model.anyOf.map((item: any) => item.const), [
    "gpt-6-luna",
    "gpt-6.1-sol",
  ]);

  const beforeProviderRequest = handlers.get("before_provider_request")!;
  assert.equal(beforeProviderRequest({ payload }, context), undefined);
  assert.deepEqual(payload, { model: "deepseek-chat" });
});

test("runs the search through Pi's openai provider (API key or ChatGPT OAuth) with a native web_search tool", async () => {
  const { handlers, tools } = createExtensionHarness();
  handlers.get("session_start")!({ type: "session_start" }, {
    model: { provider: "deepseek", api: "openai-completions" },
  });
  const tool = tools.get(OPENAI_WEB_SEARCH_TOOL_NAME)!;
  const openaiModel = { id: "gpt-6.1-sol", provider: "openai", api: "openai-responses" };
  const requestedProviders: string[] = [];
  let requestedApi: string | undefined;
  let requestBody: Record<string, any> | undefined;
  let requestedThinkingLevel: string | undefined;

  const result = await tool.execute(
    "tool-call-id",
    { query: "latest release", model: "gpt-6.1-sol" },
    undefined,
    undefined,
    {
      modelRegistry: {
        async getAvailableOfType(type: string, provider: string) {
          assert.equal(type, "chat");
          requestedProviders.push(provider);
          return provider === "openai" ? [openaiModel] : [];
        },
        async complete(model: any, context: any, options: any) {
          assert.equal(model.provider, "openai");
          assert.equal(context.messages[0].content[0].text, "latest release");
          assert.match(context.systemPrompt, /depth proportional to the query/);
          requestedApi = model.api;
          requestedThinkingLevel = options.thinkingLevel;
          requestBody = await options.onPayload({
            model: model.id,
            tools: [],
            tool_choice: "auto",
            include: ["reasoning.encrypted_content"],
          }, model);
          // Mirror the real Responses stream: items arrive via output_item.done and
          // the final response carries an empty output array.
          await options.onProviderStreamEvent({
            type: "response.output_item.done",
            item: {
              id: "ws_1",
              type: "web_search_call",
              status: "completed",
              action: {
                type: "search",
                query: "latest release",
                sources: [
                  { type: "url", url: "https://example.com/releases" },
                  { type: "api", name: "oai-weather" },
                ],
              },
            },
          }, model);
          await options.onProviderStreamEvent({
            type: "response.output_item.done",
            item: {
              id: "msg_1",
              type: "message",
              status: "completed",
              content: [{ type: "output_text", text: "The current release is 1.2.", annotations: [] }],
            },
          }, model);
          await options.onProviderStreamEvent({
            type: "response.completed",
            response: { status: "completed", output: [] },
          }, model);
          return {
            stopReason: "stop",
            usage: {
              input: 10,
              output: 5,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 15,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
          };
        },
      },
    } as any,
  );

  assert.deepEqual(requestedProviders, ["openai"]);
  assert.equal(requestedApi, "openai-responses");
  assert.equal(requestedThinkingLevel, "low");
  assert.equal(requestBody?.tool_choice, "required");
  assert.deepEqual(requestBody?.tools, [{ type: "web_search", search_context_size: "medium" }]);
  assert.ok(requestBody?.include.includes("reasoning.encrypted_content"));
  assert.ok(requestBody?.include.includes("web_search_call.action.sources"));
  assert.equal(result.details.model, "gpt-6.1-sol");
  // The public OpenAI path requires URL sources, so the name-only source is dropped.
  assert.deepEqual(result.structuredContent.sources, [{ type: "url", url: "https://example.com/releases" }]);
  assert.equal(result.usage?.totalTokens, 15);
  assert.match(result.content[0].text, /The current release is 1\.2\./);
  assert.match(result.content[0].text, /https:\/\/example\.com\/releases/);
});

test("falls back to Pi's openai-codex OAuth provider when openai has no matching model", async () => {
  const { handlers, tools } = createExtensionHarness();
  handlers.get("session_start")!({ type: "session_start" }, {
    model: { provider: "deepseek", api: "openai-completions" },
  });
  const tool = tools.get(OPENAI_WEB_SEARCH_TOOL_NAME)!;
  const codexModel = {
    id: "gpt-6.1-sol",
    provider: "openai-codex",
    api: "openai-codex-responses",
  };
  const requestedProviders: string[] = [];
  let requestBody: Record<string, any> | undefined;
  let requestedApi: string | undefined;
  let requestedThinkingLevel: unknown;

  const result = await tool.execute(
    "tool-call-id",
    { query: "latest release", model: "gpt-6.1-sol" },
    undefined,
    undefined,
    {
      modelRegistry: {
        async getAvailableOfType(type: string, provider: string) {
          assert.equal(type, "chat");
          requestedProviders.push(provider);
          // The openai credential exists but only exposes gpt-6-luna.
          if (provider === "openai") return [{ id: "gpt-6-luna", provider: "openai", api: "openai-responses" }];
          return provider === "openai-codex" ? [codexModel] : [];
        },
        async complete(model: any, context: any, options: any) {
          assert.equal(model.provider, "openai-codex");
          assert.equal(context.messages[0].content[0].text, "latest release");
          requestedApi = model.api;
          requestedThinkingLevel = options.thinkingLevel;
          requestBody = await options.onPayload({
            model: model.id,
            tools: [],
            tool_choice: "auto",
            include: ["reasoning.encrypted_content"],
          }, model);
          // Mirror the real Codex stream: items arrive via output_item.done and
          // the final response carries an empty output array.
          await options.onProviderStreamEvent({
            type: "response.output_item.done",
            item: {
              id: "ws_1",
              type: "web_search_call",
              status: "completed",
              action: {
                type: "search",
                query: "latest release",
                sources: [{ type: "api", name: "oai-weather" }],
              },
            },
          }, model);
          await options.onProviderStreamEvent({
            type: "response.output_item.done",
            item: {
              id: "msg_1",
              type: "message",
              status: "completed",
              content: [{ type: "output_text", text: "The current release is 1.2.", annotations: [] }],
            },
          }, model);
          await options.onProviderStreamEvent({
            type: "response.completed",
            response: { status: "completed", output: [] },
          }, model);
          return {
            stopReason: "stop",
            usage: {
              input: 10,
              output: 5,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 15,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
          };
        },
      },
    } as any,
  );

  assert.deepEqual(requestedProviders, ["openai", "openai-codex"]);
  assert.equal(requestedApi, "openai-codex-responses");
  assert.equal(requestedThinkingLevel, undefined);
  assert.equal(requestBody?.tool_choice, "required");
  assert.deepEqual(requestBody?.tools, [{ type: "web_search" }]);
  assert.ok(requestBody?.include.includes("reasoning.encrypted_content"));
  assert.ok(requestBody?.include.includes("web_search_call.action.sources"));
  assert.equal(result.details.model, "gpt-6.1-sol");
  assert.deepEqual(result.structuredContent.sources, [{ name: "oai-weather", type: "api" }]);
  assert.equal(result.usage?.totalTokens, 15);
  assert.match(result.content[0].text, /The current release is 1\.2\./);
  assert.match(result.content[0].text, /oai-weather/);
});

test("rejects unsupported model IDs before touching the model registry", async () => {
  const { handlers, tools } = createExtensionHarness();
  handlers.get("session_start")!({ type: "session_start" }, {
    model: { provider: "deepseek", api: "openai-completions" },
  });
  const tool = tools.get(OPENAI_WEB_SEARCH_TOOL_NAME)!;

  await assert.rejects(
    tool.execute("tool-call-id", { query: "latest release", model: "gpt-5.5" }, undefined, undefined, {
      modelRegistry: {
        async getAvailableOfType() {
          throw new Error("registry must not be queried");
        },
      },
    } as any),
    /Unsupported OpenAI web search model/,
  );
});

test("fails with actionable guidance when neither OpenAI credential is available", async () => {
  const { handlers, tools } = createExtensionHarness();
  handlers.get("session_start")!({ type: "session_start" }, {
    model: { provider: "deepseek", api: "openai-completions" },
  });
  const tool = tools.get(OPENAI_WEB_SEARCH_TOOL_NAME)!;

  await assert.rejects(
    tool.execute("tool-call-id", { query: "latest release" }, undefined, undefined, {
      modelRegistry: {
        async getAvailableOfType() { return []; },
      },
    } as any),
    /\/login openai|OPENAI_API_KEY|\/login openai-codex/,
  );
});

test("falls back to openai-codex when openai authentication fails before search", async () => {
  const { handlers, tools } = createExtensionHarness();
  handlers.get("session_start")!({ type: "session_start" }, {
    model: { provider: "deepseek", api: "openai-completions" },
  });
  const tool = tools.get(OPENAI_WEB_SEARCH_TOOL_NAME)!;
  const openaiModel = { id: "gpt-6-luna", provider: "openai", api: "openai-responses" };
  const codexModel = { id: "gpt-6-luna", provider: "openai-codex", api: "openai-codex-responses" };
  const calls: string[] = [];

  const result = await tool.execute(
    "tool-call-id",
    { query: "latest release" },
    undefined,
    undefined,
    {
      modelRegistry: {
        async getAvailableOfType(_type: string, provider: string) {
          calls.push(`available:${provider}`);
          if (provider === "openai") return [openaiModel];
          return provider === "openai-codex" ? [codexModel] : [];
        },
        async complete(model: any, _context: any, options: any) {
          calls.push(`complete:${model.provider}`);
          if (model.provider === "openai") {
            return {
              stopReason: "error",
              errorMessage: "Encountered invalidated oauth token for user, failing request.",
            };
          }

          await options.onProviderStreamEvent({
            type: "response.output_item.done",
            item: {
              id: "ws_1",
              type: "web_search_call",
              status: "completed",
              action: {
                type: "search",
                query: "latest release",
                sources: [{ type: "url", url: "https://example.com/releases" }],
              },
            },
          }, model);
          await options.onProviderStreamEvent({
            type: "response.output_item.done",
            item: {
              id: "msg_1",
              type: "message",
              status: "completed",
              content: [{ type: "output_text", text: "Fallback answer.", annotations: [] }],
            },
          }, model);
          await options.onProviderStreamEvent({
            type: "response.completed",
            response: { status: "completed", output: [] },
          }, model);

          return {
            stopReason: "stop",
            usage: {
              input: 10,
              output: 5,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 15,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
          };
        },
      },
    } as any,
  );

  assert.deepEqual(calls, [
    "available:openai",
    "complete:openai",
    "available:openai-codex",
    "complete:openai-codex",
  ]);
  assert.match(result.content[0].text, /Fallback answer/);
  assert.equal(result.details.model, "gpt-6-luna");
});

test("reports real provider errors and login guidance when both credentials fail", async () => {
  const { handlers, tools } = createExtensionHarness();
  handlers.get("session_start")!({ type: "session_start" }, {
    model: { provider: "deepseek", api: "openai-completions" },
  });
  const tool = tools.get(OPENAI_WEB_SEARCH_TOOL_NAME)!;
  const openaiModel = { id: "gpt-6-luna", provider: "openai", api: "openai-responses" };
  const codexModel = { id: "gpt-6-luna", provider: "openai-codex", api: "openai-codex-responses" };
  const calls: string[] = [];

  await assert.rejects(
    () => tool.execute("tool-call-id", { query: "latest release" }, undefined, undefined, {
      modelRegistry: {
        async getAvailableOfType(_type: string, provider: string) {
          calls.push(`available:${provider}`);
          if (provider === "openai") return [openaiModel];
          return provider === "openai-codex" ? [codexModel] : [];
        },
        async complete(model: any) {
          calls.push(`complete:${model.provider}`);
          return model.provider === "openai"
            ? {
                stopReason: "error",
                errorMessage: "Encountered invalidated oauth token for user, failing request.",
              }
            : {
                stopReason: "error",
                errorMessage: "fetch failed",
              };
        },
      },
    } as any),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /openai \(gpt-6-luna\): Encountered invalidated oauth token/);
      assert.match(error.message, /openai-codex \(gpt-6-luna\): fetch failed/);
      assert.match(error.message, /Run `\/login openai` or `\/login openai-codex`/);
      assert.doesNotMatch(error.message, /did not return a final Responses payload/);
      return true;
    },
  );

  assert.deepEqual(calls, [
    "available:openai",
    "complete:openai",
    "available:openai-codex",
    "complete:openai-codex",
  ]);
});

test("does not fall back when the completed search has no usable sources", async () => {
  const { handlers, tools } = createExtensionHarness();
  handlers.get("session_start")!({ type: "session_start" }, {
    model: { provider: "deepseek", api: "openai-completions" },
  });
  const tool = tools.get(OPENAI_WEB_SEARCH_TOOL_NAME)!;
  const openaiModel = { id: "gpt-6-luna", provider: "openai", api: "openai-responses" };
  let codexQueried = false;

  await assert.rejects(
    () => tool.execute("tool-call-id", { query: "latest release" }, undefined, undefined, {
      modelRegistry: {
        async getAvailableOfType(_type: string, provider: string) {
          if (provider === "openai") return [openaiModel];
          codexQueried = true;
          return [];
        },
        async complete(_model: any, _context: any, options: any) {
          await options.onProviderStreamEvent({
            type: "response.output_item.done",
            item: {
              id: "ws_1",
              type: "web_search_call",
              status: "completed",
              action: { type: "search", query: "latest release", sources: [] },
            },
          });
          await options.onProviderStreamEvent({
            type: "response.output_item.done",
            item: {
              id: "msg_1",
              type: "message",
              status: "completed",
              content: [{ type: "output_text", text: "Answer without sources.", annotations: [] }],
            },
          });
          await options.onProviderStreamEvent({
            type: "response.completed",
            response: { status: "completed", output: [] },
          });
          return { stopReason: "stop" };
        },
      },
    } as any),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /openai \(gpt-6-luna\): OpenAI web search returned no usable source URLs/);
      assert.doesNotMatch(error.message, /\/login/);
      return true;
    },
  );

  assert.equal(codexQueried, false);
});

test("does not retry with another provider after search output has started", async () => {
  const { handlers, tools } = createExtensionHarness();
  handlers.get("session_start")!({ type: "session_start" }, {
    model: { provider: "deepseek", api: "openai-completions" },
  });
  const tool = tools.get(OPENAI_WEB_SEARCH_TOOL_NAME)!;
  const openaiModel = { id: "gpt-6-luna", provider: "openai", api: "openai-responses" };
  let codexQueried = false;

  await assert.rejects(
    () => tool.execute("tool-call-id", { query: "latest release" }, undefined, undefined, {
      modelRegistry: {
        async getAvailableOfType(_type: string, provider: string) {
          if (provider === "openai") return [openaiModel];
          codexQueried = true;
          return [];
        },
        async complete(_model: any, _context: any, options: any) {
          await options.onProviderStreamEvent({
            type: "response.output_item.done",
            item: {
              id: "ws_1",
              type: "web_search_call",
              status: "completed",
              action: {
                type: "search",
                query: "latest release",
                sources: [{ type: "url", url: "https://example.com/releases" }],
              },
            },
          });
          return { stopReason: "error", errorMessage: "fetch failed" };
        },
      },
    } as any),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /openai \(gpt-6-luna\): fetch failed/);
      assert.match(error.message, /network or proxy/);
      assert.doesNotMatch(error.message, /openai-codex/);
      return true;
    },
  );

  assert.equal(codexQueried, false);
});
