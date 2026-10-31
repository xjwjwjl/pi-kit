import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import deepSeekWebSearchExtension from "../index.ts";

export interface FetchCall {
	url: string;
	init: RequestInit;
}

export interface ToolLike {
	name?: string;
	description?: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
	parameters?: Record<string, unknown>;
	outputSchema?: Record<string, unknown>;
	annotations?: Record<string, unknown>;
	execute: (...args: unknown[]) => Promise<unknown>;
	renderCall?: (...args: unknown[]) => unknown;
	renderResult?: (...args: unknown[]) => unknown;
}

export async function withTempAgentDir(fn: (agentDir: string) => Promise<void>): Promise<void> {
	const root = await mkdtemp(path.join(os.tmpdir(), "websearch-deepseek-test-"));
	const agentDir = path.join(root, "agent");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousApiKey = process.env.DEEPSEEK_API_KEY;

	process.env.PI_CODING_AGENT_DIR = agentDir;
	delete process.env.DEEPSEEK_API_KEY;
	await mkdir(agentDir, { recursive: true });

	try {
		await fn(agentDir);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;

		if (previousApiKey === undefined) delete process.env.DEEPSEEK_API_KEY;
		else process.env.DEEPSEEK_API_KEY = previousApiKey;

		await rm(root, { recursive: true, force: true });
	}
}

export async function writeSettings(
	agentDir: string,
	settings: Record<string, unknown>,
): Promise<void> {
	await writeFile(
		path.join(agentDir, "settings.json"),
		JSON.stringify({ "websearch-deepseek": settings }),
	);
}

export async function withMockFetch(
	mockFetch: typeof fetch,
	fn: () => Promise<void>,
): Promise<void> {
	const descriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");
	Object.defineProperty(globalThis, "fetch", {
		value: mockFetch,
		configurable: true,
		writable: true,
	});

	try {
		await fn();
	} finally {
		if (descriptor) Object.defineProperty(globalThis, "fetch", descriptor);
		else delete (globalThis as { fetch?: typeof fetch }).fetch;
	}
}

export function jsonResponse(
	body: unknown,
	status = 200,
	headers: Record<string, string> = {},
): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});
}

export function mockFetchSequence(
	responses: Array<Response | (() => Response | Promise<Response>)>,
	calls: FetchCall[] = [],
): typeof fetch {
	return (async (input: RequestInfo | URL, init?: RequestInit) => {
		calls.push({ url: String(input), init: init ?? {} });
		const next = responses.shift();
		if (!next) throw new Error("No mock response left.");
		return typeof next === "function" ? await next() : next;
	}) as typeof fetch;
}

export function captureTool(name: string): ToolLike {
	const tools: ToolLike[] = [];
	deepSeekWebSearchExtension({
		on() {},
		registerTool(definition: unknown) {
			tools.push(definition as ToolLike);
		},
	} as never);

	const tool = tools.find((definition) => definition.name === name);
	assert.ok(tool, `extension should register ${name}`);
	return tool;
}

export function textResult(result: unknown): string {
	const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
	return content?.find((block) => block.type === "text")?.text ?? "";
}

export function parseJsonBody(call: FetchCall): Record<string, unknown> {
	assert.equal(typeof call.init.body, "string");
	return JSON.parse(call.init.body);
}

export function fakeContext(texts: string[]): Record<string, unknown> {
	return {
		sessionManager: {
			buildSessionContext: () => ({
				messages: texts.map((text) => ({ role: "user", content: text })),
			}),
		},
	};
}

export function fakeToolResultContext(toolName: string, text: string): Record<string, unknown> {
	return {
		sessionManager: {
			buildSessionContext: () => ({
				messages: [{ role: "toolResult", toolName, content: [{ type: "text", text }] }],
			}),
		},
	};
}
