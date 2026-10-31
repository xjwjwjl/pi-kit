import assert from "node:assert/strict";
import test from "node:test";
import type { WebFetchToolResult } from "../webfetch.ts";
import { validateWebFetchUrl } from "../webfetch.ts";
import {
	captureTool,
	fakeContext,
	fakeToolResultContext,
	jsonResponse,
	mockFetchSequence,
	parseJsonBody,
	textResult,
	withMockFetch,
	withTempAgentDir,
	writeSettings,
} from "./helpers.ts";

const tool = captureTool("deepseek_webfetch");

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
					() =>
						tool.execute(
							"call-1",
							{ url: "https://example.com/page" },
							undefined,
							undefined,
							fakeContext(["https://example.com/page"]),
						),
					/DeepSeek API key is not configured/,
				);
				assert.equal(fetchCalled, false);
			},
		);
	});
});

test("fetches a URL and returns title plus Markdown", async () => {
	await withTempAgentDir(async (agentDir) => {
		await writeSettings(agentDir, {
			apiKey: "sk-test",
			baseUrl: "https://api.example.test",
		});
		const calls: Parameters<typeof mockFetchSequence>[1] = [];
		const fetchMock = mockFetchSequence(
			[jsonResponse({ title: "Example page", content: "# Hello\n\nBody text." })],
			calls,
		);

		await withMockFetch(fetchMock, async () => {
			const result = (await tool.execute(
				"call-1",
				{ url: "https://example.com/page" },
				undefined,
				undefined,
				fakeContext(["Read https://example.com/page"]),
			)) as WebFetchToolResult;

			assert.equal(calls.length, 1);
			assert.equal(calls[0].url, "https://api.example.test/v1/tools/fetch");
			assert.deepEqual(parseJsonBody(calls[0]), { url: "https://example.com/page" });
			assert.equal(
				(calls[0].init.headers as Record<string, string>).Authorization,
				"Bearer sk-test",
			);

			assert.equal(result.details.title, "Example page");
			assert.equal(result.details.truncated, false);
			assert.equal(result.structuredContent.content, "# Hello\n\nBody text.");
			assert.ok(result.details.bytes > 0);
			assert.match(textResult(result), /^# Example page/);
			assert.match(textResult(result), /URL: https:\/\/example\.com\/page/);
			assert.match(textResult(result), /# Hello/);
		});
	});
});

test("requires the URL to appear in the session provenance", async () => {
	await withTempAgentDir(async (agentDir) => {
		await writeSettings(agentDir, { apiKey: "sk-test" });
		let fetchCalled = false;
		await withMockFetch(
			(async () => {
				fetchCalled = true;
				return jsonResponse({});
			}) as typeof fetch,
			async () => {
				await assert.rejects(
					() =>
						tool.execute(
							"call-1",
							{ url: "https://example.com/page" },
							undefined,
							undefined,
							fakeContext(["No URL here"]),
						),
					/can only retrieve URLs/,
				);
				assert.equal(fetchCalled, false);
			},
		);
	});
});

test("accepts a URL from a prior tool result and normalizes HTTP to HTTPS", async () => {
	await withTempAgentDir(async (agentDir) => {
		await writeSettings(agentDir, { apiKey: "sk-test" });
		const fetchMock = mockFetchSequence([
			jsonResponse({ title: "Page", content: "Body" }),
			jsonResponse({ title: "Other", content: "Other body" }),
		]);

		await withMockFetch(fetchMock, async () => {
			const fromTool = (await tool.execute(
				"call-1",
				{ url: "https://example.com/page" },
				undefined,
				undefined,
				fakeToolResultContext("deepseek_websearch", "Result: https://example.com/page"),
			)) as WebFetchToolResult;
			assert.equal(fromTool.details.title, "Page");

			const normalized = (await tool.execute(
				"call-2",
				{ url: "https://example.com/other" },
				undefined,
				undefined,
				fakeContext(["Try http://example.com/other"]),
			)) as WebFetchToolResult;
			assert.equal(normalized.details.title, "Other");
		});
	});
});

test("validates URLs before calling DeepSeek", () => {
	assert.throws(() => validateWebFetchUrl(""), /must not be empty/);
	assert.throws(() => validateWebFetchUrl("ftp://example.com/page"), /Only HTTP and HTTPS/);
	assert.throws(() => validateWebFetchUrl("https://user:pass@example.com/page"), /credentials/);
	assert.throws(() => validateWebFetchUrl("https://"), /invalid/);
	assert.throws(
		() => validateWebFetchUrl(`https://example.com/${"a".repeat(8_192)}`),
		/must not exceed/,
	);
	assert.equal(
		validateWebFetchUrl("https://example.com/page#section"),
		"https://example.com/page",
	);
});

test("truncates oversized page content for the model", async () => {
	await withTempAgentDir(async (agentDir) => {
		await writeSettings(agentDir, { apiKey: "sk-test" });
		const content = "x".repeat(60_000);
		const fetchMock = mockFetchSequence([jsonResponse({ title: "Large", content })]);

		await withMockFetch(fetchMock, async () => {
			const result = (await tool.execute(
				"call-1",
				{ url: "https://example.com/large" },
				undefined,
				undefined,
				fakeContext(["https://example.com/large"]),
			)) as WebFetchToolResult;

			assert.equal(result.details.truncated, true);
			assert.equal(result.structuredContent.truncated, true);
			assert.match(textResult(result), /Output truncated/);
			assert.ok(result.structuredContent.content.length <= 200_000);
		});
	});
});

test("maps fetch errors and rejects empty content", async () => {
	await withTempAgentDir(async (agentDir) => {
		await writeSettings(agentDir, { apiKey: "sk-test" });

		await withMockFetch(
			mockFetchSequence([jsonResponse({ error: { message: "blocked" } }, 403)]),
			async () => {
				await assert.rejects(
					() =>
						tool.execute(
							"call-1",
							{ url: "https://example.com/page" },
							undefined,
							undefined,
							fakeContext(["https://example.com/page"]),
						),
					/security policy/,
				);
			},
		);

		await withMockFetch(
			mockFetchSequence([jsonResponse({ error: { message: "missing" } }, 404)]),
			async () => {
				await assert.rejects(
					() =>
						tool.execute(
							"call-1",
							{ url: "https://example.com/page" },
							undefined,
							undefined,
							fakeContext(["https://example.com/page"]),
						),
					/could not retrieve usable content/,
				);
			},
		);

		await withMockFetch(
			mockFetchSequence([jsonResponse({ title: "Empty", content: "   " })]),
			async () => {
				await assert.rejects(
					() =>
						tool.execute(
							"call-1",
							{ url: "https://example.com/page" },
							undefined,
							undefined,
							fakeContext(["https://example.com/page"]),
						),
					/returned no usable content/,
				);
			},
		);
	});
});
