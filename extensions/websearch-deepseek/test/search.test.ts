import assert from "node:assert/strict";
import test from "node:test";
import type { SearchToolResult } from "../search.ts";
import {
	captureTool,
	jsonResponse,
	mockFetchSequence,
	parseJsonBody,
	textResult,
	withMockFetch,
	withTempAgentDir,
	writeSettings,
} from "./helpers.ts";

const tool = captureTool("deepseek_websearch");

test("throws before fetching when the API key is missing", async () => {
	await withTempAgentDir(async () => {
		let fetchCalled = false;
		await withMockFetch(
			(async () => {
				fetchCalled = true;
				return jsonResponse({});
			}) as typeof fetch,
			async () => {
				await assert.rejects(
					() => tool.execute("call-1", { query: "latest Rust release" }),
					/DeepSeek API key is not configured/,
				);
				assert.equal(fetchCalled, false);
			},
		);
	});
});

test("sends a Search request and returns structured results", async () => {
	await withTempAgentDir(async (agentDir) => {
		await writeSettings(agentDir, {
			apiKey: "sk-test",
			baseUrl: "https://api.example.test",
			timeZone: "Asia/Shanghai",
		});
		const calls: Parameters<typeof mockFetchSequence>[1] = [];
		const fetchMock = mockFetchSequence(
			[
				jsonResponse({
					results: [
						{
							title: "DeepSeek V4.1",
							url: "https://example.com/deepseek-v4",
							summary: "DeepSeek released V4.1 Flash.",
							snippet: "Short snippet.",
							site_name: "Example",
							date: "2026-10-17T00:00:00+00:00",
							authority: 4,
							rerank_score: 2.8,
						},
					],
				}),
			],
			calls,
		);

		await withMockFetch(fetchMock, async () => {
			const result = (await tool.execute("call-1", {
				query: "  DeepSeek V4.1  ",
				count: 3,
			})) as SearchToolResult;

			assert.equal(calls.length, 1);
			assert.equal(calls[0].url, "https://api.example.test/v1/tools/search");
			assert.deepEqual(parseJsonBody(calls[0]), {
				query: "DeepSeek V4.1",
				count: 3,
				need_content: false,
			});
			assert.equal(
				(calls[0].init.headers as Record<string, string>).Authorization,
				"Bearer sk-test",
			);

			assert.equal(result.details.results.length, 1);
			assert.equal(result.structuredContent.results[0].title, "DeepSeek V4.1");
			assert.equal(result.structuredContent.results[0].siteName, "Example");
			assert.equal(result.structuredContent.results[0].authority, 4);
			assert.equal(result.structuredContent.timeZone, "Asia/Shanghai");
			assert.match(result.structuredContent.currentDate, /^\d{4}-\d{2}-\d{2}$/);

			const text = textResult(result);
			assert.match(text, /Current date: \d{4}-\d{2}-\d{2} \(Asia\/Shanghai\)/);
			assert.match(text, /https:\/\/example\.com\/deepseek-v4/);
			assert.match(text, /authority 4/);
			assert.match(text, /DeepSeek released V4\.1 Flash\./);
		});
	});
});

test("uses the default count and reports empty results as success", async () => {
	await withTempAgentDir(async (agentDir) => {
		await writeSettings(agentDir, { apiKey: "sk-test" });
		const calls: Parameters<typeof mockFetchSequence>[1] = [];
		const fetchMock = mockFetchSequence([jsonResponse({ results: [] })], calls);

		await withMockFetch(fetchMock, async () => {
			const result = (await tool.execute("call-1", { query: "nothing" })) as SearchToolResult;
			assert.equal(parseJsonBody(calls[0]).count, 8);
			assert.deepEqual(result.details.results, []);
			assert.match(textResult(result), /No results/);
		});
	});
});

test("validates query length and count", async () => {
	await withTempAgentDir(async (agentDir) => {
		await writeSettings(agentDir, { apiKey: "sk-test" });
		await withMockFetch(async () => jsonResponse({ results: [] }), async () => {
			await assert.rejects(() => tool.execute("call-1", { query: "   " }), /1-128/);
			await assert.rejects(() => tool.execute("call-1", { query: "a".repeat(129) }), /1-128/);
			await assert.rejects(() => tool.execute("call-1", { query: "ok", count: 0 }), /between 1 and 50/);
			await assert.rejects(() => tool.execute("call-1", { query: "ok", count: 51 }), /between 1 and 50/);

			const emojiResult = (await tool.execute("call-1", { query: "😀".repeat(65) })) as SearchToolResult;
			assert.equal(emojiResult.details.query, "😀".repeat(65));
		});
	});
});

test("deduplicates result URLs and handles nullable fields", async () => {
	await withTempAgentDir(async (agentDir) => {
		await writeSettings(agentDir, { apiKey: "sk-test" });
		const fetchMock = mockFetchSequence([
			jsonResponse({
				results: [
					{
						title: "First",
						url: "https://example.com/page#one",
						summary: "First summary",
						site_name: null,
						date: null,
						authority: -1,
						rerank_score: 0,
					},
					{
						title: "Duplicate",
						url: "https://example.com/page#two",
						summary: "Duplicate summary",
						authority: 2,
						rerank_score: 1,
					},
				],
			}),
		]);

		await withMockFetch(fetchMock, async () => {
			const result = (await tool.execute("call-1", { query: "page" })) as SearchToolResult;
			assert.equal(result.details.results.length, 1);
			assert.equal(result.details.results[0].title, "First");
			assert.equal(result.details.results[0].siteName, undefined);
			assert.equal(result.details.results[0].date, undefined);
			assert.equal(result.details.results[0].authority, -1);
			assert.match(textResult(result), /date unknown/);
			assert.match(textResult(result), /authority -1/);
		});
	});
});

test("maps API errors and does not retry non-retryable failures", async () => {
	await withTempAgentDir(async (agentDir) => {
		await writeSettings(agentDir, { apiKey: "sk-test" });

		const unauthorizedCalls: Parameters<typeof mockFetchSequence>[1] = [];
		await withMockFetch(
			mockFetchSequence(
				[jsonResponse({ error: { message: "invalid key" } }, 401)],
				unauthorizedCalls,
			),
			async () => {
				await assert.rejects(
					() => tool.execute("call-1", { query: "x" }),
					/DeepSeek API key is invalid or missing/,
				);
				assert.equal(unauthorizedCalls.length, 1);
			},
		);

		const badRequestCalls: Parameters<typeof mockFetchSequence>[1] = [];
		await withMockFetch(
			mockFetchSequence(
				[jsonResponse({ error: { message: "bad query" } }, 400)],
				badRequestCalls,
			),
			async () => {
				await assert.rejects(
					() => tool.execute("call-1", { query: "x" }),
					/DeepSeek rejected the request: bad query/,
				);
				assert.equal(badRequestCalls.length, 1);
			},
		);
	});
});

test("retries rate limits and server errors", async () => {
	await withTempAgentDir(async (agentDir) => {
		await writeSettings(agentDir, { apiKey: "sk-test" });

		const rateLimitCalls: Parameters<typeof mockFetchSequence>[1] = [];
		await withMockFetch(
			mockFetchSequence(
				[
					jsonResponse({ error: { message: "slow down" } }, 429, { "retry-after": "0" }),
					jsonResponse({ results: [] }),
				],
				rateLimitCalls,
			),
			async () => {
				const result = (await tool.execute("call-1", { query: "x" })) as SearchToolResult;
				assert.equal(result.details.results.length, 0);
				assert.equal(rateLimitCalls.length, 2);
			},
		);

		const serverErrorCalls: Parameters<typeof mockFetchSequence>[1] = [];
		await withMockFetch(
			mockFetchSequence(
				[
					jsonResponse({ error: { message: "boom" } }, 500, { "retry-after": "0" }),
					jsonResponse({ error: { message: "boom" } }, 500, { "retry-after": "0" }),
					jsonResponse({ error: { message: "boom" } }, 500, { "retry-after": "0" }),
				],
				serverErrorCalls,
			),
			async () => {
				await assert.rejects(
					() => tool.execute("call-1", { query: "x" }),
					/DeepSeek server error \(HTTP 500\)/,
				);
				assert.equal(serverErrorCalls.length, 3);
			},
		);
	});
});

test("rejects an invalid Search response", async () => {
	await withTempAgentDir(async (agentDir) => {
		await writeSettings(agentDir, { apiKey: "sk-test" });
		await withMockFetch(async () => jsonResponse({ results: "not-an-array" }), async () => {
			await assert.rejects(
				() => tool.execute("call-1", { query: "x" }),
				/returned an invalid response/,
			);
		});
	});
});
