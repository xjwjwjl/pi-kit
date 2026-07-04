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
			toolName?: string;
			message?: {
				content?: Array<{ type?: string; name?: string; text?: string }>;
			};
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

type Scenario = {
	name: string;
	prompt: string;
	query: string;
	expectedReason: RegExp;
	summarySnippet: string;
};

const scenarios: Scenario[] = [
	{
		name: "create-table",
		prompt: "请帮我创建一个测试表。",
		query: "CREATE TABLE sqlkit.test_data (id UInt32) ENGINE = Memory",
		expectedReason: /Received CREATE/i,
		summarySnippet: "SQLKit 目前只支持读向查询，不能创建表",
	},
	{
		name: "alter-drop-column",
		prompt: "把 insert_time 字段删了。",
		query: "ALTER TABLE sqlkit.test_data DROP COLUMN insert_time",
		expectedReason: /Received ALTER/i,
		summarySnippet: "SQLKit 目前只支持读向查询，不能修改表结构",
	},
];

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionPath = path.join(projectRoot, "index.ts");

function writeJson(filePath: string, value: unknown): void {
	writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function parseJsonLine(line: string): JsonEvent {
	const text = line.trim().replace(/^\uFEFF/, "");
	if (!text.startsWith("{")) return undefined;
	try {
		return JSON.parse(text) as JsonEvent;
	} catch {
		return undefined;
	}
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

function sendSseJson(res: ServerResponse, chunk: unknown): void {
	res.write(`data: ${JSON.stringify(chunk)}\n\n`);
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

async function runScenario(scenario: Scenario): Promise<string> {
	const agentDir = path.join(tmpdir(), `sqlkit-write-block-${scenario.name}-${Date.now()}`);
	const debugLogPath = path.join(agentDir, "verify-pi-write-blocks.log");
	mkdirSync(path.join(agentDir, ".pi"), { recursive: true });
	writeJson(path.join(agentDir, ".pi", "sqlkit.json"), {
		agent_tools: { enabled: true },
		sources: [
			{
				name: "clickhouse_local",
				dialect: "clickhouse",
				read_only: true,
				allow_apply: false,
				options: {
					url: "http://127.0.0.1:8123",
					username: "default",
					password: "",
					database: "default",
				},
			},
		],
	});
	writeJson(path.join(agentDir, "settings.json"), {
		defaultProvider: "openai",
		defaultModel: "dummy",
	});

	let sawPolicyPrompt = false;
	let validatedBlockedResult = false;

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

			const payload = JSON.parse(await readBody(req)) as ChatCompletionRequest;
			const allMessageText = JSON.stringify(payload.messages ?? []);
			if (allMessageText.includes("SQLKit policy is active for this turn.")) {
				sawPolicyPrompt = true;
			}
			const toolNames = (payload.tools ?? []).map((tool) => tool.function?.name).filter(Boolean);
			const toolMessages = (payload.messages ?? []).filter((message) => message.role === "tool");

			res.writeHead(200, {
				"content-type": "text/event-stream; charset=utf-8",
				"cache-control": "no-cache",
				connection: "keep-alive",
			});

			if (toolMessages.length === 0) {
				if (!toolNames.includes("sql_run_query")) {
					throw new Error("Provider payload did not expose sql_run_query.");
				}
				sendSseJson(res, {
					id: `chatcmpl-${scenario.name}-1`,
					object: "chat.completion.chunk",
					created: Math.floor(Date.now() / 1000),
					model: "dummy",
					choices: [
						{
							index: 0,
							delta: { role: "assistant", content: "我先尝试执行一次。" },
							finish_reason: null,
						},
					],
				});
				sendSseJson(res, {
					id: `chatcmpl-${scenario.name}-1`,
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
										id: `mock-${scenario.name}-sql-run-query`,
										type: "function",
										function: {
											name: "sql_run_query",
											arguments: JSON.stringify({ source: "clickhouse_local", query: scenario.query }),
										},
									},
								],
							},
							finish_reason: "tool_calls",
						},
					],
				});
				sendSseJson(res, {
					id: `chatcmpl-${scenario.name}-1`,
					object: "chat.completion.chunk",
					created: Math.floor(Date.now() / 1000),
					model: "dummy",
					usage: { prompt_tokens: 120, completion_tokens: 25, total_tokens: 145 },
					choices: [],
				});
				res.write("data: [DONE]\n\n");
				res.end();
				return;
			}

			if (toolMessages.length === 1) {
				const blocked = extractLastToolResult(payload.messages);
				if (!/SQLKIT QUERY BLOCKED - READ\/SAFETY POLICY/.test(blocked)) {
					throw new Error(`Expected policy block tool result. Received: ${blocked.slice(0, 240)}`);
				}
				if (!scenario.expectedReason.test(blocked)) {
					throw new Error(`Blocked result for ${scenario.name} did not mention expected reason. Received: ${blocked.slice(0, 240)}`);
				}
				validatedBlockedResult = true;

				sendSseJson(res, {
					id: `chatcmpl-${scenario.name}-2`,
					object: "chat.completion.chunk",
					created: Math.floor(Date.now() / 1000),
					model: "dummy",
					choices: [
						{
							index: 0,
							delta: {
								role: "assistant",
								content: `${scenario.summarySnippet}。请改走迁移或管理员流程，我不会继续重试这类写操作。`,
							},
							finish_reason: "stop",
						},
					],
				});
				sendSseJson(res, {
					id: `chatcmpl-${scenario.name}-2`,
					object: "chat.completion.chunk",
					created: Math.floor(Date.now() / 1000),
					model: "dummy",
					usage: { prompt_tokens: 160, completion_tokens: 40, total_tokens: 200 },
					choices: [],
				});
				res.write("data: [DONE]\n\n");
				res.end();
				return;
			}

			throw new Error(`Unexpected tool message count for ${scenario.name}: ${toolMessages.length}`);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (res.headersSent) {
				sendSseJson(res, {
					id: `chatcmpl-${scenario.name}-error`,
					object: "chat.completion.chunk",
					created: Math.floor(Date.now() / 1000),
					model: "dummy",
					choices: [
						{
							index: 0,
							delta: { content: `Scenario verification failed: ${message}` },
							finish_reason: "stop",
						},
					],
				});
				res.write("data: [DONE]\n\n");
				res.end();
				return;
			}
			res.writeHead(500, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message } }));
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
			"sql_run_query",
			scenario.prompt,
		],
		{
			cwd: agentDir,
			env: {
				...process.env,
				PI_CODING_AGENT_DIR: agentDir,
				PI_OFFLINE: "1",
				DUMMY_KEY_LITERAL: "local-test-key",
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);

	const stderrLines: string[] = [];
	const calledTools = new Set<string>();
	let sawSummary = false;

	const result = await new Promise<string>((resolve, reject) => {
		let resolved = false;

		function cleanup(exitCode: number, message: string): void {
			if (resolved) return;
			resolved = true;
			clearTimeout(timeout);
			child.kill();
			server.close();
			if (exitCode === 0) {
				try {
					rmSync(agentDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
				} catch {
					// Best-effort cleanup.
				}
				resolve(message);
				return;
			}
			reject(new Error([message, existsSync(debugLogPath) ? `Debug log: ${debugLogPath}` : "", ...stderrLines].filter(Boolean).join("\n")));
		}

		child.once("error", (error) => cleanup(1, `Failed to start pi CLI: ${error.message}`));

		child.stderr.setEncoding("utf-8");
		child.stderr.on("data", (chunk: string) => {
			const text = chunk.trim();
			if (text.length > 0) stderrLines.push(text);
		});

		const rl = createInterface({ input: child.stdout });
		rl.on("line", (line) => {
			const event = parseJsonLine(line);
			if (!event) return;
			if (event.type === "tool_execution_start" && event.toolName) {
				calledTools.add(event.toolName);
				return;
			}
			const content = event.message?.content ?? [];
			for (const block of content) {
				if (block?.type === "toolCall" && block.name) calledTools.add(block.name);
				if (block?.type === "text" && typeof block.text === "string" && block.text.includes(scenario.summarySnippet)) {
					sawSummary = true;
				}
			}

			if (event.type === "agent_end") {
				if (!sawPolicyPrompt) {
					cleanup(1, `Scenario ${scenario.name} did not inject the SQLKit policy prompt.`);
					return;
				}
				if (!validatedBlockedResult) {
					cleanup(1, `Scenario ${scenario.name} did not validate the blocked sql_run_query result.`);
					return;
				}
				if (!calledTools.has("sql_run_query")) {
					cleanup(1, `Scenario ${scenario.name} never called sql_run_query.`);
					return;
				}
				if (calledTools.size !== 1) {
					cleanup(1, `Scenario ${scenario.name} unexpectedly called other tools: ${Array.from(calledTools).join(",")}`);
					return;
				}
				if (!sawSummary) {
					cleanup(1, `Scenario ${scenario.name} did not emit the expected Chinese explanation.`);
					return;
				}
				cleanup(0, `OK ${scenario.name} blocked write SQL and still produced a Chinese explanation.`);
			}
		});

		child.on("exit", (code) => {
			if (resolved) return;
			cleanup(code ?? 1, `Scenario ${scenario.name} exited before agent_end.`);
		});

		const timeout = setTimeout(() => {
			cleanup(1, `Timed out waiting for scenario ${scenario.name}.`);
		}, 30_000);
	});

	return result;
}

for (const scenario of scenarios) {
	const message = await runScenario(scenario);
	console.log(message);
}

console.log(`OK verified ${scenarios.length} blocked-write agent scenarios.`);
