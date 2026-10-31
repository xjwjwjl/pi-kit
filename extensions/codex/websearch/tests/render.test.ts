import assert from "node:assert/strict";
import test from "node:test";

import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderOpenAIWebSearchCall, renderOpenAIWebSearchResult } from "../src/render.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

function createContext(overrides: Record<string, unknown> = {}) {
  return {
    state: {},
    expanded: false,
    executionStarted: true,
    isPartial: true,
    isError: false,
    ...overrides,
  } as any;
}

function renderLines(args: any, context: any, width = 100): string[] {
  return renderOpenAIWebSearchCall(args, theme, context).render(width);
}

test("renders the query, default model, and a running status", () => {
  const lines = renderLines({ query: " 武汉今天天气 " }, createContext());
  assert.deepEqual(lines, ["openai_web_search 武汉今天天气 · gpt-6-luna · searching…"]);
});

test("shows the selected model and elapsed time once the result arrives", () => {
  const context = createContext();
  renderLines({ query: "latest release", model: "gpt-6.1-sol" }, context);
  context.isPartial = false;
  context.state.endedAt = context.state.startedAt + 6_500;

  assert.deepEqual(renderLines({ query: "latest release", model: "gpt-6.1-sol" }, context), [
    "openai_web_search latest release · gpt-6.1-sol · 6.5s",
  ]);
});

test("keeps one truncated line and preserves the model for long queries", () => {
  const query = "武汉未来七天天气预报和空气质量指数以及出行建议".repeat(3);
  const lines = renderLines({ query }, createContext(), 48);

  assert.equal(lines.length, 1);
  assert.ok(lines[0].startsWith("openai_web_search "));
  assert.ok(lines[0].includes("gpt-6-luna · searching…"));
  assert.ok(lines[0].includes("…"));
  assert.ok(visibleWidth(lines[0]) <= 48);
});

test("marks failed calls", () => {
  const lines = renderLines({ query: "latest release" }, createContext({ isPartial: false, isError: true }));
  assert.deepEqual(lines, ["openai_web_search latest release · gpt-6-luna · failed"]);
});

test("shows only the model before execution starts", () => {
  const lines = renderLines({ query: "latest release" }, createContext({ executionStarted: false }));
  assert.deepEqual(lines, ["openai_web_search latest release · gpt-6-luna"]);
});

const SEARCH_RESULT = {
  content: [{
    type: "text",
    text: "武汉今天阴，27°C。\n\nSources:\n1. [中国天气网](<https://example.com>)",
  }],
};

function renderResultLines(result: any, options: any, context: any, width = 100): string[] {
  return renderOpenAIWebSearchResult(result, { expanded: false, isPartial: false, ...options }, theme, context)
    .render(width);
}

test("hides the answer body while collapsed", () => {
  assert.deepEqual(renderResultLines(SEARCH_RESULT, {}, createContext()), []);
});

test("reveals the full answer and sources when expanded", () => {
  const text = renderResultLines(SEARCH_RESULT, { expanded: true }, createContext()).join("\n");
  assert.match(text, /武汉今天阴/);
  assert.match(text, /Sources:/);
  assert.match(text, /中国天气网/);
});

test("keeps failures visible while collapsed", () => {
  const errorResult = { content: [{ type: "text", text: "No usable OpenAI credential found." }] };
  const lines = renderResultLines(errorResult, {}, createContext({ isError: true }));
  assert.deepEqual(lines.map((line) => line.trimEnd()), ["No usable OpenAI credential found."]);
});
