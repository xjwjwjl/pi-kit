import { spawn, spawnSync } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

type JsonEvent =
	| {
			type?: string;
			message?: {
				role?: string;
				content?: Array<{ type?: string; name?: string; toolName?: string; text?: string; arguments?: unknown }>;
			};
			toolName?: string;
	  }
	| undefined;

type ChatCompletionRequest = {
	messages?: Array<{
		role?: string;
		content?: unknown;
		tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>;
		tool_call_id?: string;
	}>;
	tools?: Array<{ function?: { name?: string } }>;
};

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionPath = path.join(projectRoot, "index.ts");
const agentDir = path.join(tmpdir(), `sqlkit-pi-print-${Date.now()}`);
const debugLogPath = path.join(agentDir, "verify-pi-print.log");
const prompt = "请必须先调用 sql_validate_config 工具，参数 check_connections=true；再调用 sql_list_sources；最后用中文总结。不要凭空回答。";

function parseJsonLine(line: string): JsonEvent {
	const text = line.trim().replace(/^\uFEFF/, "");
	if (!text.startsWith("{")) return undefined;
	try {
		return JSON.parse(text) as JsonEvent;
	} catch {
		return undefined;
	}
}

function writeJson(filePath: string, value: unknown): void {
	writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function appendDebug(line: string): void {
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(debugLogPath, `${line}\n`, { encoding: "utf-8", flag: "a" });
}

function resolvePiCommand(): { command: string; argsPrefix: string[] } {
	if (process.platform !== "win32") return { command: "pi", argsPrefix: [] };

	const whereResult = spawnSync("where.exe", ["pi.cmd"], { encoding: "utf-8" });
	const piCmdPath = whereResult.stdout
		.split(/\r?\n/)
		.map((line) => line.trim())
		.find(Boolean);
	if (!piCmdPath) throw new Error("Unable to locate pi.cmd on PATH.");

	const piBinDir = path.dirname(piCmdPath);
	const nodePath = existsSync(path.join(piBinDir, "node.exe")) ? path.join(piBinDir, "node.exe") : "node";
	const cliCandidates = [
		path.join(piBinDir, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"),
		path.join(piBinDir, "node_modules", "@mariozechner", "pi-coding-agent", "dist", "cli.js"),
	];
	const cliPath = cliCandidates.find((candidate) => existsSync(candidate));
	if (!cliPath) {
		throw new Error(`Unable to locate pi CLI entrypoint under ${piBinDir}.`);
	}

	return { command: nodePath, argsPrefix: [cliPath] };
}

function normalizeContentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	return content
		.map((part) => {
			if (typeof part === "string") return part;
			if (part && typeof part === "object" && "text" in part && typeof (part as { text?: unknown }).text === "string") {
				return (part as { text: string }).text;
			}
			return "";
		})
		.join("\n");
}

function sendSseJson(res: ServerResponse, chunk: unknown): void {
	res.write(`data: ${JSON.stringify(chunk)}\n\n`);
}

function extractLastToolResult(messages: ChatCompletionRequest["messages"]): string {
	const toolMessages = (messages ?? []).filter((message) => message.role === "tool");
	const lastToolMessage = toolMessages[toolMessages.length - 1];
	return normalizeContentText(lastToolMessage?.content);
}

async function readBody(req: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) {
		chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
	}
	return Buffer.concat(chunks).toString("utf-8");
}

const server = createServer(async (req, res) => {
	try {
		if (req.method === "GET" && req.url === "/v1/models") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ object: "list", data: [{ id: "dummy" }] }));
			return;
		}

		if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
			res.writeHead(404, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: "Not found" } }));
			return;
		}

		const body = await readBody(req);
		const payload = JSON.parse(body) as ChatCompletionRequest;
		appendDebug(
			`REQUEST ${JSON.stringify({
				method: req.method,
				url: req.url,
				toolNames: (payload.tools ?? []).map((tool) => tool.function?.name),
				messageRoles: (payload.messages ?? []).map((message) => message.role),
				toolMessageCount: (payload.messages ?? []).filter((message) => message.role === "tool").length,
				lastToolResult: extractLastToolResult(payload.messages).slice(0, 120),
			})}`,
		);
		const hasValidateTool = (payload.tools ?? []).some((tool) => tool.function?.name === "sql_validate_config");
		const hasListSourcesTool = (payload.tools ?? []).some((tool) => tool.function?.name === "sql_list_sources");
		const toolMessages = (payload.messages ?? []).filter((message) => message.role === "tool");

		res.writeHead(200, {
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "no-cache",
			connection: "keep-alive",
		});

		if (toolMessages.length === 0) {
			if (!hasValidateTool || !hasListSourcesTool) {
				sendSseJson(res, {
					id: "chatcmpl-mock-error",
					object: "chat.completion.chunk",
					created: Math.floor(Date.now() / 1000),
					model: "dummy",
					choices: [
						{
							index: 0,
							delta: { content: "工具列表不完整。" },
							finish_reason: "stop",
						},
					],
				});
				res.write("data: [DONE]\n\n");
				res.end();
				appendDebug("RESPONSE missing_tools");
				return;
			}

			sendSseJson(res, {
				id: "chatcmpl-mock-1",
				object: "chat.completion.chunk",
				created: Math.floor(Date.now() / 1000),
				model: "dummy",
				choices: [
					{
						index: 0,
						delta: {
							role: "assistant",
							content: "我先验证配置，然后列出数据源。",
						},
						finish_reason: null,
					},
				],
			});
			sendSseJson(res, {
				id: "chatcmpl-mock-1",
				object: "chat.completion.chunk",
				created: Math.floor(Date.now() / 1000),
				model: "dummy",
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [
								{
									index: 0,
									id: "mock-tool-call-validate",
									type: "function",
									function: {
										name: "sql_validate_config",
										arguments: "{\"check_connections\":true}",
									},
								},
							],
						},
						finish_reason: "tool_calls",
					},
				],
			});
			sendSseJson(res, {
				id: "chatcmpl-mock-1",
				object: "chat.completion.chunk",
				created: Math.floor(Date.now() / 1000),
				model: "dummy",
				usage: {
					prompt_tokens: 100,
					completion_tokens: 20,
					total_tokens: 120,
				},
				choices: [],
			});
			res.write("data: [DONE]\n\n");
			res.end();
			appendDebug("RESPONSE toolcall sql_validate_config");
			return;
		}

		if (toolMessages.length === 1) {
			const validateResult = extractLastToolResult(payload.messages);
			sendSseJson(res, {
				id: "chatcmpl-mock-2",
				object: "chat.completion.chunk",
				created: Math.floor(Date.now() / 1000),
				model: "dummy",
				choices: [
					{
						index: 0,
						delta: {
							role: "assistant",
							content: `验证结果已收到：${validateResult.slice(0, 80)}`,
						},
						finish_reason: null,
					},
				],
			});
			sendSseJson(res, {
				id: "chatcmpl-mock-2",
				object: "chat.completion.chunk",
				created: Math.floor(Date.now() / 1000),
				model: "dummy",
				choices: [
					{
						index: 0,
						delta: {
							tool_calls: [
								{
									index: 0,
									id: "mock-tool-call-list",
									type: "function",
									function: {
										name: "sql_list_sources",
										arguments: "{}",
									},
								},
							],
						},
						finish_reason: "tool_calls",
					},
				],
			});
			sendSseJson(res, {
				id: "chatcmpl-mock-2",
				object: "chat.completion.chunk",
				created: Math.floor(Date.now() / 1000),
				model: "dummy",
				usage: {
					prompt_tokens: 140,
					completion_tokens: 20,
					total_tokens: 160,
				},
				choices: [],
			});
			res.write("data: [DONE]\n\n");
			res.end();
			appendDebug("RESPONSE toolcall sql_list_sources");
			return;
		}

		const finalSummary = "总结：配置校验通过，MySQL 和 ClickHouse 两个数据源连接正常；MySQL 当前账号存在 FILE 权限警告，生产环境应改为受限只读账号。";
		sendSseJson(res, {
			id: "chatcmpl-mock-3",
			object: "chat.completion.chunk",
			created: Math.floor(Date.now() / 1000),
			model: "dummy",
			choices: [
				{
					index: 0,
					delta: {
						role: "assistant",
						content: finalSummary,
					},
					finish_reason: "stop",
				},
			],
		});
		sendSseJson(res, {
			id: "chatcmpl-mock-3",
			object: "chat.completion.chunk",
			created: Math.floor(Date.now() / 1000),
			model: "dummy",
			usage: {
				prompt_tokens: 200,
				completion_tokens: 30,
				total_tokens: 230,
			},
			choices: [],
		});
		res.write("data: [DONE]\n\n");
		res.end();
		appendDebug("RESPONSE final_summary");
	} catch (error) {
		appendDebug(`SERVER_ERROR ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
		res.writeHead(500, { "content-type": "application/json" });
		res.end(
			JSON.stringify({
				error: {
					message: error instanceof Error ? error.message : String(error),
				},
			}),
		);
	}
});

await new Promise<void>((resolve, reject) => {
	server.once("error", reject);
	server.listen(0, "127.0.0.1", () => resolve());
});

const address = server.address();
if (!address || typeof address === "string") {
	server.close();
	throw new Error("Failed to bind mock OpenAI server.");
}
const mockBaseUrl = `http://127.0.0.1:${address.port}/v1`;
appendDebug(`MOCK_BASE_URL ${mockBaseUrl}`);

mkdirSync(agentDir, { recursive: true });
mkdirSync(path.join(agentDir, ".pi"), { recursive: true });
writeJson(path.join(agentDir, ".pi", "sqlkit.json"), {
	sources: [
		{
			name: "mysql_mock",
			dialect: "mysql",
			read_only: true,
			options: {
				host: "127.0.0.1",
				port: 1,
				user: "mock",
				password: "",
				connect_timeout_ms: 100,
				query_timeout_ms: 100,
			},
		},
		{
			name: "clickhouse_mock",
			dialect: "clickhouse",
			read_only: true,
			options: {
				url: "http://127.0.0.1:1",
				username: "default",
				request_timeout_ms: 100,
			},
		},
	],
});
writeJson(path.join(agentDir, "settings.json"), {
	defaultProvider: "openai",
	defaultModel: "dummy",
});
writeJson(path.join(agentDir, "models.json"), {
	providers: {
		openai: {
			baseUrl: mockBaseUrl,
			api: "openai-completions",
			apiKey: "$DUMMY_KEY_LITERAL",
			models: [
				{
					id: "dummy",
					compat: {
						supportsDeveloperRole: false,
						supportsReasoningEffort: false,
						supportsUsageInStreaming: true,
					},
				},
			],
		},
	},
});

const piCommand = resolvePiCommand();
const child = spawn(
	piCommand.command,
	[
		...piCommand.argsPrefix,
		"--mode",
		"json",
		"-p",
		"-nbt",
		"-e",
		extensionPath,
		"-t",
		"sql_validate_config,sql_list_sources",
		prompt,
	],
	{
		cwd: agentDir,
		env: {
			...process.env,
			PI_CODING_AGENT_DIR: agentDir,
			PI_OFFLINE: "1",
			DUMMY_KEY_LITERAL: "local-test-key",
			SQLKIT_AUTO_ENABLE_TOOLS: "1",
		},
		stdio: ["ignore", "pipe", "pipe"],
	},
);

const stderrLines: string[] = [];
let resolved = false;
let sawValidateCall = false;
let sawListSourcesCall = false;
let sawChineseSummary = false;

function finish(exitCode: number, message: string): void {
	if (resolved) return;
	resolved = true;
	clearTimeout(timeout);
	child.kill();
	server.close();
	if (exitCode === 0) {
		try {
			rmSync(agentDir, { recursive: true, force: true });
		} catch {
			// Best-effort cleanup: on Windows the just-killed pi child can briefly keep cwd handles open.
		}
		console.log(message);
	} else {
		console.error(message);
		if (existsSync(debugLogPath)) {
			console.error(`Debug log: ${debugLogPath}`);
		}
		if (stderrLines.length > 0) console.error(stderrLines.join("\n"));
	}
	process.exitCode = exitCode;
}

child.once("error", (error) => {
	finish(1, `Failed to start pi CLI: ${error.message}`);
});

child.stderr.setEncoding("utf-8");
child.stderr.on("data", (chunk: string) => {
	const text = chunk.trim();
	if (text.length > 0) stderrLines.push(text);
});

const rl = createInterface({ input: child.stdout });
rl.on("line", (line) => {
	appendDebug(`PI_EVENT ${line}`);
	const event = parseJsonLine(line);
	if (!event) return;

	if (event.type === "tool_execution_start") {
		if (event.toolName === "sql_validate_config") sawValidateCall = true;
		if (event.toolName === "sql_list_sources") sawListSourcesCall = true;
		return;
	}

	if (event.type !== "message_end" && event.type !== "turn_end" && event.type !== "agent_end") return;
	const content = event.message?.content ?? [];
	for (const block of content) {
		if (block?.type === "toolCall") {
			if (block.name === "sql_validate_config") sawValidateCall = true;
			if (block.name === "sql_list_sources") sawListSourcesCall = true;
		}
		if (block?.type === "text" && typeof block.text === "string") {
			if (/总结：配置校验通过/.test(block.text)) {
				sawChineseSummary = true;
			}
		}
	}

	if (event.type === "agent_end") {
		if (!sawValidateCall) {
			finish(1, "pi print-mode reached agent_end without calling sql_validate_config.");
			return;
		}
		if (!sawListSourcesCall) {
			finish(1, "pi print-mode reached agent_end without calling sql_list_sources.");
			return;
		}
		if (!sawChineseSummary) {
			finish(1, "pi print-mode reached agent_end without the expected Chinese summary.");
			return;
		}
		finish(0, "OK pi print-mode exposed sql_validate_config/sql_list_sources and completed a Chinese summary.");
	}
});

child.on("exit", (code) => {
	if (resolved) return;
	if (!sawValidateCall) {
		finish(code ?? 1, "pi print-mode did not call sql_validate_config.");
		return;
	}
	if (!sawListSourcesCall) {
		finish(code ?? 1, "pi print-mode did not call sql_list_sources.");
		return;
	}
	if (!sawChineseSummary) {
		finish(code ?? 1, "pi print-mode did not emit the expected Chinese summary.");
		return;
	}
	finish(0, "OK pi print-mode exposed sql_validate_config/sql_list_sources and completed a Chinese summary.");
});

const timeout = setTimeout(() => {
	finish(1, "Timed out waiting for pi print-mode verification to finish.");
}, 30_000);
