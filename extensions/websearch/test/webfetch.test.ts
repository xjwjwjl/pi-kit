import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import axios from "axios";
import { Markdown, Text } from "@earendil-works/pi-tui";
import deepSeekWebSearchExtension from "../index.ts";
import {
	clearDeepSeekWebFetchCache,
	executeDeepSeekWebFetch,
	isWebFetchUrlInProvenance,
} from "../webfetch.ts";
import { getCurrentLocalDate } from "../temporal.ts";

async function withTempHome(fn: (home: string) => Promise<void>) {
	const root = await mkdtemp(path.join(os.tmpdir(), "deepseek-webfetch-test-"));
	const home = path.join(root, "home");
	const previousHome = process.env.HOME;
	const previousUserProfile = process.env.USERPROFILE;
	const previousConfigDir = process.env.PI_CODING_AGENT_DIR;

	process.env.HOME = home;
	process.env.USERPROFILE = home;
	delete process.env.PI_CODING_AGENT_DIR;

	try {
		await mkdir(path.join(home, ".pi", "agent"), { recursive: true });
		await fn(home);
	} finally {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		if (previousUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = previousUserProfile;
		if (previousConfigDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousConfigDir;
		clearDeepSeekWebFetchCache();
		await rm(root, { recursive: true, force: true });
	}
}

async function writeSettings(home: string, timeZone?: string) {
	await writeFile(
		path.join(home, ".pi", "agent", "settings.json"),
		JSON.stringify({ "deepseek-websearch": { apiKey: "settings-key", ...(timeZone ? { timeZone } : {}) } }),
	);
}

async function withMockFetch(mockFetch: typeof fetch, fn: () => Promise<void>) {
	const descriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");
	Object.defineProperty(globalThis, "fetch", { value: mockFetch, configurable: true, writable: true });
	try {
		await fn();
	} finally {
		if (descriptor) Object.defineProperty(globalThis, "fetch", descriptor);
		else delete (globalThis as { fetch?: typeof fetch }).fetch;
	}
}

async function withMockAxiosGet(
	mockGet: typeof axios.get,
	fn: () => Promise<void>,
) {
	const originalGet = axios.get;
	axios.get = mockGet;
	try {
		await fn();
	} finally {
		axios.get = originalGet;
	}
}

function deepSeekResponse(text: string): Response {
	return new Response(JSON.stringify({ content: [{ type: "text", text }] }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

function axiosResponse(html: string, url = "https://example.com/") {
	return {
		data: Buffer.from(html),
		status: 200,
		statusText: "OK",
		headers: { "content-type": "text/html" },
		config: { url },
	} as Awaited<ReturnType<typeof axios.get<ArrayBuffer>>>;
}

function redirectError(status: number, location: string): Error {
	return Object.assign(new Error("redirect"), {
		isAxiosError: true,
		response: { status, headers: { location } },
	});
}

function captureTool(name: string) {
	const tools: Array<{ name?: string }> = [];
	deepSeekWebSearchExtension({
		on() {},
		registerTool(definition) {
			tools.push(definition as { name?: string });
		},
	});
	const tool = tools.find((definition) => definition.name === name);
	assert.ok(tool, `expected ${name} to be registered`);
	return tool as {
		execute: (...args: unknown[]) => Promise<unknown>;
		renderResult?: (...args: unknown[]) => unknown;
	};
}

test("registers both DeepSeek web tools", () => {
	const names: string[] = [];
	deepSeekWebSearchExtension({
		on() {},
		registerTool(definition) {
			names.push((definition as { name: string }).name);
		},
	});
	assert.deepEqual(names, ["deepseek_websearch", "deepseek_webfetch"]);
});

test("renders fetched Markdown with Pi's Markdown component when expanded", () => {
	const tool = captureTool("deepseek_webfetch");
	assert.equal(typeof tool.renderResult, "function");
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
	const result = {
		content: [{ type: "text", text: "## Summary\n\n- Useful result" }],
		details: {
			ok: true,
			path: "fetched",
			url: "https://example.com/",
			bytes: 1024,
			code: 200,
			codeText: "OK",
			result: "## Summary\n\n- Useful result",
			durationMs: 12,
			contentType: "text/html",
			cached: false,
		},
	};

	const expanded = tool.renderResult!(result, { expanded: true, isPartial: false }, theme, {});
	assert.ok(expanded instanceof Markdown);
	assert.equal(expanded.text, result.details.result);

	const collapsed = tool.renderResult!(result, { expanded: false, isPartial: false }, theme, {});
	assert.ok(collapsed instanceof Text);
	assert.doesNotMatch(collapsed.text, /##|\*\*/);
});

test("adds the current local date to each agent system prompt", () => {
	let handler: ((event: { systemPrompt: string }) => { systemPrompt: string }) | undefined;
	deepSeekWebSearchExtension({
		on(event, registeredHandler) {
			if (event === "before_agent_start") handler = registeredHandler as typeof handler;
		},
		registerTool() {},
	});
	assert.ok(handler);
	const result = handler({ systemPrompt: "base prompt" });
	assert.match(result.systemPrompt, /^base prompt/);
	assert.match(result.systemPrompt, /Current date and time zone: \d{4}-\d{2}-\d{2} \([^)]*\)/);
	assert.match(result.systemPrompt, /freshness cannot be verified/i);
});

test("enforces URL provenance at the Pi tool boundary", async () => {
	const tool = captureTool("deepseek_webfetch");
	await assert.rejects(
		() => tool.execute(
			"call-provenance",
			{ url: "https://example.com/", prompt: "Summarize it" },
			undefined,
			undefined,
			{ sessionManager: { buildSessionContext: () => ({ messages: [{ role: "user", content: "Please read the docs." }] }) } },
		),
		/only retrieve URLs that appeared/i,
	);
});

test("accepts URLs emitted by deepseek_websearch", async () => {
	await withTempHome(async () => {
		const tool = captureTool("deepseek_webfetch");
		await assert.rejects(
			() => tool.execute(
				"call-search-provenance",
				{ url: "https://example.com/weather", prompt: "Extract the weather" },
				undefined,
				undefined,
				{
					sessionManager: {
						buildSessionContext: () => ({
							messages: [{
								role: "toolResult",
								toolName: "deepseek_websearch",
								content: [{ type: "text", text: "Sources:\n1. Weather - https://example.com/weather" }],
							}],
						}),
					},
				},
			),
			/missing DeepSeek Web Search API key/i,
		);
	});
});

test("fetches HTML locally, converts it to Markdown, and applies the prompt with DeepSeek Flash", async () => {
	await withTempHome(async (home) => {
		await writeSettings(home, "Asia/Shanghai");
		const progress: string[] = [];
		let axiosCalls = 0;
		let deepSeekRequestBody: Record<string, unknown> | undefined;

		await withMockAxiosGet(
			(async (_url, config) => {
				axiosCalls += 1;
				assert.equal(typeof config?.lookup, "function");
				return axiosResponse("<h1>Example title</h1><p>Useful page content.</p>");
			}) as typeof axios.get,
			async () => {
				await withMockFetch(
					(async (_input, init) => {
						deepSeekRequestBody = JSON.parse(String(init?.body));
						return deepSeekResponse("Extracted page summary.");
					}) as typeof fetch,
					async () => {
						const result = await executeDeepSeekWebFetch(
							"https://example.com/",
							"Summarize today's page.",
							undefined,
							(message) => progress.push(message),
						);

						assert.equal(result.details.ok, true);
						if (!result.details.ok) return;
						assert.equal(result.details.path, "fetched");
						assert.equal(result.details.code, 200);
						assert.equal(result.details.result, "Extracted page summary.");
						assert.match(result.content[0]?.text ?? "", /Extracted page summary/);
					},
				);
			},
		);

		assert.equal(axiosCalls, 1);
		assert.equal(deepSeekRequestBody?.model, "deepseek-v4-flash");
		assert.match(String(deepSeekRequestBody?.messages?.[0]?.content ?? ""), /Example title/);
		assert.match(String(deepSeekRequestBody?.messages?.[0]?.content ?? ""), /Summarize today's page/);
		assert.match(
			String(deepSeekRequestBody?.messages?.[0]?.content ?? ""),
			new RegExp(`Current date and time zone: ${getCurrentLocalDate(new Date(), "Asia/Shanghai")} \\(Asia/Shanghai\\)`),
		);
		assert.match(String(deepSeekRequestBody?.system?.[0]?.text ?? ""), /freshness cannot be verified/i);
		assert.match(String(deepSeekRequestBody?.system?.[0]?.text ?? ""), /compact terminal-friendly Markdown/i);
		assert.deepEqual(progress, [
			"Fetching example.com...",
			"Converting HTML to Markdown...",
			"Applying your prompt to the fetched content with DeepSeek Flash...",
		]);
	});
});

test("reuses the 15-minute URL cache while applying each new prompt", async () => {
	await withTempHome(async (home) => {
		await writeSettings(home);
		let axiosCalls = 0;
		let modelCalls = 0;

		await withMockAxiosGet(
			(async () => {
				axiosCalls += 1;
				return axiosResponse("<p>Cached content</p>");
			}) as typeof axios.get,
			async () => {
				await withMockFetch(
					(async () => {
						modelCalls += 1;
						return deepSeekResponse(`Answer ${modelCalls}`);
					}) as typeof fetch,
					async () => {
						const first = await executeDeepSeekWebFetch("https://example.com/cache", "First prompt");
						const second = await executeDeepSeekWebFetch("https://example.com/cache", "Second prompt");
						assert.equal(first.details.ok, true);
						assert.equal(second.details.ok, true);
						if (second.details.ok) assert.equal(second.details.cached, true);
					},
				);
			},
		);

		assert.equal(axiosCalls, 1);
		assert.equal(modelCalls, 2);
	});
});

test("returns cross-host redirects without fetching the destination", async () => {
	await withTempHome(async (home) => {
		await writeSettings(home);
		let modelCalled = false;

		await withMockAxiosGet(
			(async () => {
				throw redirectError(302, "https://redirected.example.net/docs");
			}) as typeof axios.get,
			async () => {
				await withMockFetch(
					(async () => {
						modelCalled = true;
						return deepSeekResponse("should not run");
					}) as typeof fetch,
					async () => {
						const result = await executeDeepSeekWebFetch("https://example.com/redirect", "Read it");
						assert.equal(result.details.ok, true);
						if (!result.details.ok) return;
						assert.equal(result.details.path, "redirect");
						assert.equal(result.details.redirectUrl, "https://redirected.example.net/docs");
						assert.match(result.details.result, /REDIRECT DETECTED/);
					},
				);
			},
		);

		assert.equal(modelCalled, false);
	});
});

test("follows same-host www redirects", async () => {
	await withTempHome(async (home) => {
		await writeSettings(home);
		let axiosCalls = 0;

		await withMockAxiosGet(
			(async () => {
				axiosCalls += 1;
				if (axiosCalls === 1) throw redirectError(301, "https://www.example.com/docs");
				return axiosResponse("<p>Redirected content</p>", "https://www.example.com/docs");
			}) as typeof axios.get,
			async () => {
				await withMockFetch(
					(async () => deepSeekResponse("Redirected answer.")) as typeof fetch,
					async () => {
						const result = await executeDeepSeekWebFetch("https://example.com/docs", "Summarize");
						assert.equal(result.details.ok, true);
						if (result.details.ok) assert.equal(result.details.path, "fetched");
					},
				);
			},
		);

		assert.equal(axiosCalls, 2);
	});
});

test("rejects private URLs before issuing a network request", async () => {
	await withTempHome(async (home) => {
		await writeSettings(home);
		let axiosCalled = false;
		await withMockAxiosGet(
			(async () => {
				axiosCalled = true;
				return axiosResponse("<p>unexpected</p>");
			}) as typeof axios.get,
			async () => {
				const result = await executeDeepSeekWebFetch("http://127.0.0.1:8080/secret", "Read it");
				assert.equal(result.details.ok, false);
				if (!result.details.ok) assert.match(result.details.error ?? "", /private or local/i);
			},
		);
		assert.equal(axiosCalled, false);
	});
});

test("allows public DNS names that happen to begin with fd or fc", async () => {
	await withTempHome(async (home) => {
		await writeSettings(home);
		await withMockAxiosGet(
			(async () => axiosResponse("<p>Public content</p>", "https://fda.gov/")) as typeof axios.get,
			async () => {
				await withMockFetch(
					(async () => deepSeekResponse("Public answer.")) as typeof fetch,
					async () => {
						const result = await executeDeepSeekWebFetch("https://fda.gov/", "Summarize");
						assert.equal(result.details.ok, true);
					},
				);
			},
		);
	});
});

test("removes persisted binary content when its cache entry is cleared", async () => {
	await withTempHome(async (home) => {
		await writeSettings(home);
		await withMockAxiosGet(
			(async () => ({
				data: Buffer.from("%PDF-1.7 binary fixture"),
				status: 200,
				statusText: "OK",
				headers: { "content-type": "application/pdf" },
				config: { url: "https://example.com/report.pdf" },
			}) as Awaited<ReturnType<typeof axios.get<ArrayBuffer>>>) as typeof axios.get,
			async () => {
				await withMockFetch(
					(async () => deepSeekResponse("PDF summary.")) as typeof fetch,
					async () => {
						const result = await executeDeepSeekWebFetch("https://example.com/report.pdf", "Summarize");
						assert.equal(result.details.ok, true);
						if (!result.details.ok || !result.details.persistedPath) return assert.fail("expected persisted binary path");
						await access(result.details.persistedPath);
						clearDeepSeekWebFetchCache();
						for (let attempt = 0; attempt < 20; attempt += 1) {
							try {
								await access(result.details.persistedPath);
								await new Promise((resolve) => setTimeout(resolve, 10));
							} catch {
								return;
							}
						}
						assert.fail("persisted binary file was not removed after cache clear");
					},
				);
			},
		);
	});
});

test("requires exact URL provenance after HTTP-to-HTTPS normalization", () => {
	assert.equal(isWebFetchUrlInProvenance("https://example.com/docs", ["Read http://example.com/docs please."]), true);
	assert.equal(isWebFetchUrlInProvenance("https://example.com/other", ["Read https://example.com/docs please."]), false);
});
