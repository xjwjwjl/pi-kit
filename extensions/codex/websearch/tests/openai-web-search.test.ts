import assert from "node:assert/strict";
import test from "node:test";

import {
  buildOpenAIWebSearchResult,
  DEFAULT_OPENAI_WEB_SEARCH_MODEL,
  isOpenAIWebSearchModel,
  OPENAI_WEB_SEARCH_INSTRUCTIONS,
  OPENAI_WEB_SEARCH_OUTPUT_SCHEMA,
} from "../src/openai-web-search.ts";

const SEARCH_RESPONSE = {
  status: "completed",
  output: [
    {
      type: "web_search_call",
      status: "completed",
      action: {
        type: "search",
        sources: [{ url: "https://example.com/news" }],
      },
    },
    {
      type: "message",
      content: [{
        type: "output_text",
        text: "The verified answer is 42.",
        annotations: [{
          type: "url_citation",
          title: "Official source",
          url: "https://example.com/news",
        }],
      }],
    },
  ],
  usage: { input_tokens: 15, output_tokens: 22 },
};

test("returns a concise answer with deduplicated URLs", () => {
  const result = buildOpenAIWebSearchResult(SEARCH_RESPONSE, "gpt-6-luna", { requireUrlSources: true });

  assert.match(result.content[0].text, /The verified answer is 42\./);
  assert.match(result.content[0].text, /1\. \[Official source\]\(<https:\/\/example\.com\/news>\)/);
  assert.doesNotMatch(result.content[0].text, /— https:\/\/example\.com\/news/);
  assert.equal(result.details.sources.length, 1);
  assert.equal(result.details.sources[0].title, "Official source");
  assert.deepEqual(result.details.usage, SEARCH_RESPONSE.usage);
  assert.deepEqual(result.structuredContent, {
    model: "gpt-6-luna",
    answer: "The verified answer is 42.",
    sources: [{ title: "Official source", url: "https://example.com/news" }],
  });
});

test("describes the structured result shape for programmatic callers", () => {
  assert.equal(OPENAI_WEB_SEARCH_OUTPUT_SCHEMA.type, "object");
  assert.deepEqual(OPENAI_WEB_SEARCH_OUTPUT_SCHEMA.required, ["model", "answer", "sources"]);
  assert.equal(OPENAI_WEB_SEARCH_OUTPUT_SCHEMA.properties.sources.type, "array");
  assert.equal(OPENAI_WEB_SEARCH_OUTPUT_SCHEMA.properties.sources.items.type, "object");
});

test("defaults to gpt-6-luna and accepts gpt-6.1-sol only", () => {
  assert.equal(DEFAULT_OPENAI_WEB_SEARCH_MODEL, "gpt-6-luna");
  assert.equal(isOpenAIWebSearchModel("gpt-6-luna"), true);
  assert.equal(isOpenAIWebSearchModel("gpt-6.1-sol"), true);
  assert.equal(isOpenAIWebSearchModel("gpt-5.5"), false);
});

test("keeps the shared search instructions", () => {
  assert.match(OPENAI_WEB_SEARCH_INSTRUCTIONS, /depth proportional to the query/);
  assert.match(OPENAI_WEB_SEARCH_INSTRUCTIONS, /Cite sources alongside key claims/);
  assert.match(OPENAI_WEB_SEARCH_INSTRUCTIONS, /Resolve conflicting evidence when possible/);
});

test("rejects responses that do not confirm a search", () => {
  assert.throws(
    () => buildOpenAIWebSearchResult({
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: "An unsourced answer." }] }],
    }, "gpt-6-luna", { requireUrlSources: true }),
    /did not return a web_search action/i,
  );

  assert.throws(
    () => buildOpenAIWebSearchResult({
      status: "completed",
      output: [
        {
          type: "web_search_call",
          status: "completed",
          action: { type: "open_page", sources: [{ url: "https://example.com" }] },
        },
        { type: "message", content: [{ type: "output_text", text: "Page result." }] },
      ],
    }, "gpt-6-luna", { requireUrlSources: true }),
    /did not return a web_search action/i,
  );
});

test("drops sources that are not HTTP(S) URLs", () => {
  assert.throws(
    () => buildOpenAIWebSearchResult({
      status: "completed",
      output: [
        {
          type: "web_search_call",
          status: "completed",
          action: { type: "search", sources: [{ url: "javascript:alert(1)" }] },
        },
        { type: "message", content: [{ type: "output_text", text: "No sources." }] },
      ],
    }, "gpt-6-luna", { requireUrlSources: true }),
    /no usable source URLs/i,
  );
});

test("accepts named provider sources when URL sources are optional (Codex path)", () => {
  const result = buildOpenAIWebSearchResult({
    status: "completed",
    output: [
      {
        type: "web_search_call",
        status: "completed",
        action: { type: "search", query: "wuhan weather", sources: [{ type: "api", name: "oai-weather" }] },
      },
      {
        type: "message",
        content: [{ type: "output_text", text: "Wuhan is cloudy, 28C.", annotations: [] }],
      },
    ],
  }, "gpt-6-luna", { requireUrlSources: false });

  assert.match(result.content[0].text, /Wuhan is cloudy, 28C\./);
  assert.match(result.content[0].text, /oai-weather \(api\)/);
  assert.deepEqual(result.details.sources, [{ name: "oai-weather", type: "api" }]);
});

test("lists sources without titles as bare URLs", () => {
  const result = buildOpenAIWebSearchResult({
    status: "completed",
    output: [
      {
        type: "web_search_call",
        status: "completed",
        action: { type: "search", sources: [{ url: "https://example.com/raw" }] },
      },
      { type: "message", content: [{ type: "output_text", text: "Answer." }] },
    ],
  }, "gpt-6-luna", { requireUrlSources: true });

  assert.match(result.content[0].text, /Sources:\n1\. <https:\/\/example\.com\/raw>/);
});

test("still requires URL sources on the public OpenAI path", () => {
  assert.throws(
    () => buildOpenAIWebSearchResult({
      status: "completed",
      output: [
        {
          type: "web_search_call",
          status: "completed",
          action: { type: "search", sources: [{ type: "api", name: "oai-weather" }] },
        },
        { type: "message", content: [{ type: "output_text", text: "Answer." }] },
      ],
    }, "gpt-6-luna", { requireUrlSources: true }),
    /no usable source URLs/i,
  );
});

test("rejects incomplete or failed Responses even when search completed with an answer and URL", () => {
  for (const status of ["incomplete", "failed"]) {
    assert.throws(
      () => buildOpenAIWebSearchResult({ ...SEARCH_RESPONSE, status }, "gpt-6-luna", { requireUrlSources: true }),
      new RegExp(`did not complete successfully.*${status}`),
    );
  }
});

test("rejects failed web searches even if an answer and URL are present", () => {
  assert.throws(
    () => buildOpenAIWebSearchResult({
      status: "completed",
      output: [
        {
          type: "web_search_call",
          status: "failed",
          action: { type: "search", sources: [{ url: "https://example.com" }] },
        },
        {
          type: "message",
          content: [{
            type: "output_text",
            text: "Unsupported guess.",
            annotations: [{ type: "url_citation", url: "https://example.com" }],
          }],
        },
      ],
    }, "gpt-6-luna", { requireUrlSources: true }),
    /did not complete successfully.*failed/i,
  );
});
