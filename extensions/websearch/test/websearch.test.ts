import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import deepSeekWebSearchExtension from "../index.ts";
import { executeDeepSeekWebSearchQuery } from "../runtime.ts";

function captureRegisteredTool() {
	let tool;
	deepSeekWebSearchExtension({
		registerTool(definition) {
			tool = definition;
		},
	});
	assert.ok(tool, "extension should register a tool");
	return tool;
}

const tool = captureRegisteredTool();

async function withTempHome(fn: (home: string) => Promise<void>) {
	const root = await mkdtemp(path.join(os.tmpdir(), "deepseek-websearch-test-"));
	const home = path.join(root, "home");
	const previousHome = process.env.HOME;
	const previousUserProfile = process.env.USERPROFILE;

	process.env.HOME = home;
	process.env.USERPROFILE = home;

	try {
		await mkdir(path.join(home, ".pi", "agent"), { recursive: true });
		await fn(home);
	} finally {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;

		if (previousUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = previousUserProfile;

		await rm(root, { recursive: true, force: true });
	}
}

async function writeAgentJson(home: string, fileName: string, data: unknown) {
	await writeFile(path.join(home, ".pi", "agent", fileName), JSON.stringify(data));
}

async function withMockFetch(
	mockFetch: typeof fetch,
	fn: () => Promise<void>,
) {
	const descriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");
	Object.defineProperty(globalThis, "fetch", {
		value: mockFetch,
		configurable: true,
		writable: true,
	});

	try {
		await fn();
	} finally {
		if (descriptor) {
			Object.defineProperty(globalThis, "fetch", descriptor);
		} else {
			delete (globalThis as { fetch?: typeof fetch }).fetch;
		}
	}
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function textResultText(result: { content?: Array<{ type?: string; text?: string }> }): string {
	return result.content?.find((block) => block.type === "text")?.text ?? "";
}

function parseJsonBody(request: { init?: RequestInit }): Record<string, unknown> {
	assert.equal(typeof request.init?.body, "string");
	return JSON.parse(request.init.body);
}

test("throws missing_api_key before making any request", async () => {
	await withTempHome(async () => {
		let fetchCalled = false;

		await withMockFetch(
			(async () => {
				fetchCalled = true;
				return jsonResponse({});
			}) as typeof fetch,
			async () => {
				await assert.rejects(
					() => tool.execute("call-1", { query: "latest rust stable release" }),
					/missing DeepSeek Web Search API key/i,
				);
				assert.equal(fetchCalled, false);
			},
		);
	});
});

test("throws when the DeepSeek request is rejected", async () => {
	await withTempHome(async (home) => {
		await writeAgentJson(home, "settings.json", {
			"deepseek-websearch": {
				apiKey: "settings-key",
			},
		});

		await withMockFetch(
			(async () => new Response("upstream unavailable", { status: 503 })) as typeof fetch,
			async () => {
				await assert.rejects(
					() => tool.execute("call-2", { query: "latest rust stable release" }),
					/HTTP 503/i,
				);
			},
		);
	});
});

test("truncates oversized upstream HTTP error bodies", async () => {
	await withTempHome(async (home) => {
		await writeAgentJson(home, "settings.json", {
			"deepseek-websearch": {
				apiKey: "settings-key",
			},
		});

		const largeErrorBody = "x".repeat(6_000);
		await withMockFetch(
			(async () => new Response(largeErrorBody, { status: 500 })) as typeof fetch,
			async () => {
				const result = await executeDeepSeekWebSearchQuery("latest rust stable release");
				assert.equal(result.details?.ok, false);
				assert.equal(result.details?.reason, "request_failed");
				assert.match(String(result.details?.error ?? ""), /HTTP 500/i);
				assert.match(String(result.details?.error ?? ""), /truncated 2000 chars/i);
				assert.ok(String(result.details?.error ?? "").length < largeErrorBody.length);
			},
		);
	});
});

test("passes cancellation signal to upstream requests", async () => {
	await withTempHome(async (home) => {
		await writeAgentJson(home, "settings.json", {
			"deepseek-websearch": {
				apiKey: "settings-key",
			},
		});

		const controller = new AbortController();

		await withMockFetch(
			(async (_input, init) => {
				const requestSignal = init?.signal;
				assert.ok(requestSignal, "fetch should receive an abort signal");

				return new Promise<Response>((_resolve, reject) => {
					requestSignal.addEventListener(
						"abort",
						() => reject(requestSignal.reason instanceof Error ? requestSignal.reason : new Error("aborted")),
						{ once: true },
					);
					controller.abort(new Error("user aborted"));
				});
			}) as typeof fetch,
			async () => {
				await assert.rejects(
					() => tool.execute("call-2b", { query: "latest rust stable release" }, controller.signal),
					/user aborted/,
				);
			},
		);
	});
});

test("returns direct answers, sends DeepSeek web search tool, and normalizes sources", async () => {
	await withTempHome(async (home) => {
		await writeAgentJson(home, "settings.json", {
			"deepseek-websearch": {
				apiKey: "settings-key",
			},
		});

		const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];

		await withMockFetch(
			(async (input, init) => {
				requests.push({ input, init });
				return jsonResponse({
					model: "deepseek-v4-flash",
					usage: { input_tokens: 12, output_tokens: 24 },
					content: [
						{ type: "text", text: "Rust 1.90.0 is the latest stable release." },
						{
							type: "web_search_tool_result",
							content: [
								{ title: "Rust Blog", url: "https://blog.rust-lang.org/releases/1.90.0/?utm_source=feed" },
								{ title: "Rust Blog Mirror", url: "https://blog.rust-lang.org/releases/1.90.0/" },
								{ title: "Release Notes", url: "https://doc.rust-lang.org/stable/releases.html?from=search" },
								{ title: "Guide 1", url: "https://example.com/guide-1" },
								{ title: "Guide 2", url: "https://example.com/guide-2" },
								{ title: "Guide 3", url: "https://example.com/guide-3" },
								{ title: "Guide 4", url: "https://example.com/guide-4" },
								{ title: "Guide 5", url: "https://example.com/guide-5" },
							],
						},
					],
				});
			}) as typeof fetch,
			async () => {
				const result = await tool.execute("call-3", { query: "latest rust stable release" });

				assert.equal(requests.length, 1);
				assert.equal(String(requests[0].input), "https://api.deepseek.com/anthropic/v1/messages");
				assert.equal(requests[0].init?.headers?.["x-api-key"], "settings-key");
				assert.equal(requests[0].init?.headers?.["anthropic-version"], "2023-06-01");

				const body = parseJsonBody(requests[0]);
				assert.equal(body.model, "deepseek-v4-flash");
				assert.equal(body.messages?.[0]?.content, "latest rust stable release");
				assert.equal(body.tools?.[0]?.type, "web_search_20250305");
				assert.equal(body.tools?.[0]?.name, "web_search");
				assert.equal(body.tools?.[0]?.max_uses, 2);

				assert.equal(result.details?.ok, true);
				assert.equal(result.details?.path, "direct");
				assert.deepEqual(result.details?.sources, [
					{ title: "Rust Blog", url: "https://blog.rust-lang.org/releases/1.90.0" },
					{ title: "Release Notes", url: "https://doc.rust-lang.org/stable/releases.html" },
					{ title: "Guide 1", url: "https://example.com/guide-1" },
					{ title: "Guide 2", url: "https://example.com/guide-2" },
					{ title: "Guide 3", url: "https://example.com/guide-3" },
					{ title: "Guide 4", url: "https://example.com/guide-4" },
					{ title: "Guide 5", url: "https://example.com/guide-5" },
				]);
				assert.match(textResultText(result), /Rust 1\.90\.0 is the latest stable release\./);
				assert.match(textResultText(result), /Sources:/);
				assert.match(textResultText(result), /https:\/\/blog\.rust-lang\.org\/releases\/1\.90\.0/);
				assert.match(textResultText(result), /https:\/\/example\.com\/guide-5/);
				assert.doesNotMatch(textResultText(result), /utm_source|from=search/);
			},
		);
	});
});

test("retries with a stricter search prompt when DeepSeek answers without sources", async () => {
	await withTempHome(async (home) => {
		await writeAgentJson(home, "settings.json", {
			"deepseek-websearch": {
				apiKey: "settings-key",
			},
		});

		const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];

		await withMockFetch(
			(async (input, init) => {
				requests.push({ input, init });
				if (requests.length === 1) {
					return jsonResponse({
						content: [{ type: "text", text: "I can help with web research." }],
					});
				}

				return jsonResponse({
					model: "deepseek-v4-flash",
					content: [
						{ type: "text", text: "Rust 1.95.0 is the latest stable release." },
						{
							type: "web_search_tool_result",
							content: [{ title: "Rust Blog", url: "https://blog.rust-lang.org/releases/1.95.0/" }],
						},
					],
				});
			}) as typeof fetch,
			async () => {
				const result = await tool.execute("call-3b", { query: "latest rust stable release" });

				assert.equal(requests.length, 2);
				const firstBody = parseJsonBody(requests[0]);
				const secondBody = parseJsonBody(requests[1]);

				assert.equal(firstBody.messages?.[0]?.content, "latest rust stable release");
				assert.match(String(secondBody.system?.[0]?.text ?? ""), /must use the web search tool for every request/i);
				assert.match(String(secondBody.messages?.[0]?.content ?? ""), /Important: you must use the web search tool/i);
				assert.equal(result.details?.ok, true);
				assert.deepEqual(result.details?.sources, [
					{ title: "Rust Blog", url: "https://blog.rust-lang.org/releases/1.95.0" },
				]);
				assert.match(textResultText(result), /Rust 1\.95\.0 is the latest stable release\./);
				assert.match(textResultText(result), /https:\/\/blog\.rust-lang\.org\/releases\/1\.95\.0/);
			},
		);
	});
});

test("does not treat source entries without URLs as web sources", async () => {
	await withTempHome(async (home) => {
		await writeAgentJson(home, "settings.json", {
			"deepseek-websearch": {
				apiKey: "settings-key",
			},
		});

		const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];

		await withMockFetch(
			(async (input, init) => {
				requests.push({ input, init });
				if (requests.length === 1) {
					return jsonResponse({
						content: [
							{ type: "text", text: "This answer should not pass without source URLs." },
							{
								type: "web_search_tool_result",
								content: [{ title: "Title only" }, { title: "Blank URL", url: "  " }],
							},
						],
					});
				}

				return jsonResponse({
					content: [
						{ type: "text", text: "Retried answer with a real source URL." },
						{
							type: "web_search_tool_result",
							content: [{ title: "Example", url: "https://example.com/retried/" }],
						},
					],
				});
			}) as typeof fetch,
			async () => {
				const result = await executeDeepSeekWebSearchQuery("latest example");

				assert.equal(requests.length, 2);
				assert.equal(result.details?.ok, true);
				assert.deepEqual(result.details?.sources, [{ title: "Example", url: "https://example.com/retried" }]);
				assert.match(textResultText(result), /Retried answer with a real source URL\./);
				assert.doesNotMatch(textResultText(result), /Title only|Blank URL/);
			},
		);
	});
});

test("fails closed when DeepSeek still returns no sources after the retry", async () => {
	await withTempHome(async (home) => {
		await writeAgentJson(home, "settings.json", {
			"deepseek-websearch": {
				apiKey: "settings-key",
			},
		});

		let requestCount = 0;
		await withMockFetch(
			(async () => {
				requestCount += 1;
				return jsonResponse({
					content: [{ type: "text", text: requestCount === 1 ? "Hello!" : "Still no sources." }],
				});
			}) as typeof fetch,
			async () => {
				const result = await executeDeepSeekWebSearchQuery("what can you do");

				assert.equal(requestCount, 2);
				assert.equal(result.details?.ok, false);
				assert.equal(result.details?.reason, "missing_sources");
				assert.match(String(result.details?.error ?? ""), /did not return any web sources/i);
				assert.match(textResultText(result), /did not return any web sources/i);
			},
		);
	});
});

test("finalizes incomplete DSML answers with a second no-tool pass", async () => {
	await withTempHome(async (home) => {
		await writeAgentJson(home, "settings.json", {
			"deepseek-websearch": {
				apiKey: "settings-key",
			},
		});

		const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];

		await withMockFetch(
			(async (input, init) => {
				requests.push({ input, init });
				if (requests.length === 1) {
					return jsonResponse({
						model: "deepseek-v4-flash",
						content: [
							{ type: "text", text: "<|DSML|><tool_calls>web_search</tool_calls>" },
							{
								type: "web_search_tool_result",
								content: [{ title: "OpenAI API docs", url: "https://platform.openai.com/docs" }],
							},
						],
					});
				}

				return jsonResponse({
					content: [{ type: "text", text: "OpenAI's API documentation is available on the official docs site." }],
				});
			}) as typeof fetch,
			async () => {
				const result = await tool.execute("call-4", { query: "where are the OpenAI API docs" });

				assert.equal(requests.length, 2);
				const firstBody = parseJsonBody(requests[0]);
				const secondBody = parseJsonBody(requests[1]);

				assert.ok(Array.isArray(firstBody.tools));
				assert.equal(secondBody.tools, undefined);
				assert.equal(result.details?.path, "finalized");
				assert.equal(result.details?.answer, "OpenAI's API documentation is available on the official docs site.");
				assert.doesNotMatch(textResultText(result), /DSML|tool_calls/i);
			},
		);
	});
});

test("finalizes ASCII DSML marker even without tool_calls markup", async () => {
	await withTempHome(async (home) => {
		await writeAgentJson(home, "settings.json", {
			"deepseek-websearch": {
				apiKey: "settings-key",
			},
		});

		let requestCount = 0;
		await withMockFetch(
			(async () => {
				requestCount += 1;
				if (requestCount === 1) {
					return jsonResponse({
						content: [
							{ type: "text", text: "<|DSML|>" },
							{
								type: "web_search_tool_result",
								content: [{ title: "Example", url: "https://example.com/latest" }],
							},
						],
					});
				}

				return jsonResponse({
					content: [{ type: "text", text: "Clean finalized answer." }],
				});
			}) as typeof fetch,
			async () => {
				const result = await tool.execute("call-4b", { query: "latest example" });

				assert.equal(requestCount, 2);
				assert.equal(result.details?.path, "finalized");
				assert.equal(result.details?.answer, "Clean finalized answer.");
				assert.doesNotMatch(textResultText(result), /DSML/i);
			},
		);
	});
});

test("falls back to a plain source list when finalization still does not produce a clean answer", async () => {
	await withTempHome(async (home) => {
		await writeAgentJson(home, "settings.json", {
			"deepseek-websearch": {
				apiKey: "settings-key",
			},
		});

		await withMockFetch(
			(async (_input, _init) =>
				jsonResponse({
					content: [
						{ type: "text", text: "<|DSML|><tool_calls>web_search</tool_calls>" },
						{
							type: "web_search_tool_result",
							content: [{ title: "Example", url: "https://example.com/latest?utm_medium=feed" }],
						},
					],
				})) as typeof fetch,
			async () => {
				const result = await tool.execute("call-5", { query: "latest example" });
				const text = textResultText(result);

				assert.equal(result.details?.path, "fallback");
				assert.match(String(result.details?.answer ?? ""), /did not produce a clean final answer/i);
				assert.doesNotMatch(text, /DSML|tool_calls/i);
				assert.match(text, /Review the sources below/i);
				assert.match(text, /https:\/\/example\.com\/latest/);
			},
		);
	});
});

test("resolves API keys only from deepseek-websearch settings", async () => {
	await withTempHome(async (home) => {
		const seenKeys: string[] = [];

		await withMockFetch(
			(async (_input, init) => {
				const headers = init?.headers as Record<string, string> | undefined;
				seenKeys.push(headers?.["x-api-key"] ?? "");
				return jsonResponse({
					content: [
						{ type: "text", text: "ok" },
						{
							type: "web_search_tool_result",
							content: [{ title: "Example", url: "https://example.com/key-source" }],
						},
					],
				});
			}) as typeof fetch,
			async () => {
				await writeAgentJson(home, "settings.json", {
					"deepseek-websearch": {
						apiKey: "settings-key",
					},
				});
				await writeAgentJson(home, "models.json", {
					providers: {
						deepseek: { apiKey: "models-key" },
					},
				});
				await writeAgentJson(home, "auth.json", {
					deepseek: {
						type: "api_key",
						key: "auth-key",
					},
				});

				const settingsResult = await tool.execute("call-6a", { query: "a" });
				assert.equal(settingsResult.details?.ok, true);

				await writeAgentJson(home, "settings.json", {});
				await assert.rejects(() => tool.execute("call-6b", { query: "b" }), /missing DeepSeek Web Search API key/i);
			},
		);

		assert.deepEqual(seenKeys, ["settings-key"]);
	});
});
