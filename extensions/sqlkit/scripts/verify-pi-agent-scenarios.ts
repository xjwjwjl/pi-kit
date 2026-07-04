import { spawn, spawnSync } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

type ChatCompletionRequest = {
	messages?: Array<{
		role?: string;
		content?: unknown;
		tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>;
		tool_call_id?: string;
	}>;
	tools?: Array<{ function?: { name?: string } }>;
};

type JsonEvent =
	| {
			type?: string;
			toolName?: string;
			message?: {
				content?: Array<{ type?: string; name?: string; text?: string }>;
			};
	  }
	| undefined;

type PlannedToolCall = {
	name: string;
	arguments: Record<string, unknown>;
	validateResult?: (text: string) => void;
};

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionPath = path.join(projectRoot, "index.ts");
const agentDir = path.join(tmpdir(), `sqlkit-agent-scenarios-${Date.now()}`);
const scenarioProjectDir = path.join(agentDir, "project");
const debugLogPath = path.join(agentDir, "verify-pi-agent-scenarios.log");
const prompt = [
	"请按顺序完成一个 SQL agent 场景验证。",
	"先列出数据源，再搜索 ClickHouse system 数据库里匹配 tables 的表。",
	"然后描述 system.tables，执行 SELECT count() AS tables_count FROM system.tables。",
	"接着对同一条查询执行 sql_clickhouse_profile_query，再用 sql_explain_query 的 pipeline 模式解释它。",
	"最后切换到 mysql_local，对 SELECT 1 AS one 执行 sql_mysql_analyze_query，并用中文总结。",
].join("");

const plannedCalls: PlannedToolCall[] = [
	{
		name: "sql_list_sources",
		arguments: {},
		validateResult(text) {
			assertIncludes(text, "clickhouse_local", "sql_list_sources result did not mention clickhouse_local.");
			assertIncludes(text, "mysql_local", "sql_list_sources result did not mention mysql_local.");
		},
	},
	{
		name: "sql_search_tables",
		arguments: { source: "clickhouse_local", database: "system", keyword: "tables", engine: "System", max_results: 5 },
		validateResult(text) {
			assertIncludes(text, "system.tables", "sql_search_tables result did not include system.tables.");
		},
	},
	{
		name: "sql_describe_table",
		arguments: { source: "clickhouse_local", database: "system", table: "tables" },
		validateResult(text) {
			assertIncludes(text, "columns", "sql_describe_table result did not include base column metadata.");
		},
	},
	{
		name: "sql_run_query",
		arguments: {
			source: "clickhouse_local",
			query: "SELECT count() AS tables_count FROM system.tables",
			max_rows: 5,
		},
		validateResult(text) {
			assertIncludes(text, "tables_count", "sql_run_query result did not include the expected result column.");
			assertIncludes(text, "result_profile", "sql_run_query result did not include result_profile.");
			assertIncludes(text, "sampled_result_rows", "sql_run_query result profile did not report sampled scope.");
		},
	},
	{
		name: "sql_clickhouse_profile_query",
		arguments: {
			source: "clickhouse_local",
			query: "SELECT count() AS tables_count FROM system.tables",
			max_rows: 5,
		},
		validateResult(text) {
			assertIncludes(text, "runtime_profile", "sql_clickhouse_profile_query result did not include runtime_profile.");
			assertIncludes(text, "query_id", "sql_clickhouse_profile_query result did not include query_id.");
		},
	},
	{
		name: "sql_explain_query",
		arguments: {
			source: "clickhouse_local",
			query: "SELECT count() AS tables_count FROM system.tables",
			mode: "pipeline",
			max_rows: 10,
		},
		validateResult(text) {
			assertIncludes(text, "pipeline", "sql_explain_query result did not use pipeline mode.");
		},
	},
	{
		name: "sql_mysql_analyze_query",
		arguments: {
			source: "mysql_local",
			query: "SELECT 1 AS one",
			max_rows: 10,
		},
		validateResult(text) {
			assertIncludes(text, "analyze_mode", "sql_mysql_analyze_query result did not include analyze_mode.");
			assertIncludes(text, "one", "sql_mysql_analyze_query result did not include the analyzed query output.");
		},
	},
];

function assertIncludes(text: string, expected: string, message: string): void {
	if (!text.includes(expected)) {
		throw new Error(`${message} Last tool result started with: ${JSON.stringify(text.slice(0, 240))}`);
	}
}

function writeJson(filePath: string, value: unknown): void {
	writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function appendDebug(line: string): void {
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(debugLogPath, `${line}\n`, { encoding: "utf-8", flag: "a" });
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

function sendToolCall(res: ServerResponse, call: PlannedToolCall, index: number): void {
	sendSseJson(res, {
		id: `chatcmpl-scenario-${index}`,
		object: "chat.completion.chunk",
		created: Math.floor(Date.now() / 1000),
		model: "dummy",
		choices: [
			{
				index: 0,
				delta: { role: "assistant", content: `调用 ${call.name}。` },
				finish_reason: null,
			},
		],
	});
	sendSseJson(res, {
		id: `chatcmpl-scenario-${index}`,
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
							id: `scenario-tool-call-${index}`,
							type: "function",
							function: {
								name: call.name,
								arguments: JSON.stringify(call.arguments),
							},
						},
					],
				},
				finish_reason: "tool_calls",
			},
		],
	});
	sendSseJson(res, {
		id: `chatcmpl-scenario-${index}`,
		object: "chat.completion.chunk",
		created: Math.floor(Date.now() / 1000),
		model: "dummy",
		usage: {
			prompt_tokens: 100 + index * 20,
			completion_tokens: 20,
			total_tokens: 120 + index * 20,
		},
		choices: [],
	});
	res.write("data: [DONE]\n\n");
	res.end();
}

function sendFinal(res: ServerResponse): void {
	sendSseJson(res, {
		id: "chatcmpl-scenario-final",
		object: "chat.completion.chunk",
		created: Math.floor(Date.now() / 1000),
		model: "dummy",
		choices: [
			{
				index: 0,
				delta: {
					role: "assistant",
					content: "总结：已完成真实 SQL agent 场景验证，工具按发现、描述、查询、解释的顺序执行。",
				},
				finish_reason: "stop",
			},
		],
	});
	sendSseJson(res, {
		id: "chatcmpl-scenario-final",
		object: "chat.completion.chunk",
		created: Math.floor(Date.now() / 1000),
		model: "dummy",
		usage: {
			prompt_tokens: 260,
			completion_tokens: 30,
			total_tokens: 290,
		},
		choices: [],
	});
	res.write("data: [DONE]\n\n");
	res.end();
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

		const payload = JSON.parse(await readBody(req)) as ChatCompletionRequest;
		const toolNames = (payload.tools ?? []).map((tool) => tool.function?.name).filter(Boolean);
		const toolMessages = (payload.messages ?? []).filter((message) => message.role === "tool");
		appendDebug(
			`REQUEST ${JSON.stringify({
				toolNames,
				toolMessageCount: toolMessages.length,
				lastToolResult: extractLastToolResult(payload.messages).slice(0, 180),
			})}`,
		);

		if (toolMessages.length === 0) {
			for (const call of plannedCalls) {
				if (!toolNames.includes(call.name)) {
					throw new Error(`Provider payload did not expose required tool ${call.name}.`);
				}
			}
			res.writeHead(200, {
				"content-type": "text/event-stream; charset=utf-8",
				"cache-control": "no-cache",
				connection: "keep-alive",
			});
			sendToolCall(res, plannedCalls[0]!, 0);
			return;
		}

		const previousIndex = toolMessages.length - 1;
		plannedCalls[previousIndex]?.validateResult?.(extractLastToolResult(payload.messages));
		if (toolMessages.length < plannedCalls.length) {
			res.writeHead(200, {
				"content-type": "text/event-stream; charset=utf-8",
				"cache-control": "no-cache",
				connection: "keep-alive",
			});
			sendToolCall(res, plannedCalls[toolMessages.length]!, toolMessages.length);
			return;
		}

		res.writeHead(200, {
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "no-cache",
			connection: "keep-alive",
		});
		sendFinal(res);
	} catch (error) {
		appendDebug(`SERVER_ERROR ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
		const message = error instanceof Error ? error.message : String(error);
		if (res.headersSent) {
			sendSseJson(res, {
				id: "chatcmpl-scenario-error",
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
appendDebug(`MOCK_BASE_URL ${mockBaseUrl}`);

mkdirSync(path.join(scenarioProjectDir, ".pi"), { recursive: true });
writeJson(path.join(scenarioProjectDir, ".pi", "sqlkit.json"), {
	sources: [
		{
			name: "clickhouse_local",
			dialect: "clickhouse",
			read_only: true,
			options: {
				url: "http://127.0.0.1:8123",
				username: "default",
				password: "",
				database: "default",
			},
		},
		{
			name: "mysql_local",
			dialect: "mysql",
			read_only: true,
			options: {
				host: "127.0.0.1",
				port: 3306,
				user: "root",
				password_env: "SQLKIT_MYSQL_PASSWORD",
				database: "mysql",
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
		plannedCalls.map((call) => call.name).join(","),
		prompt,
	],
	{
		cwd: scenarioProjectDir,
		env: {
			...process.env,
			// Normalize legacy env var name so the spawned pi process can resolve
			// the config's password_env regardless of which name the caller set.
			SQLKIT_MYSQL_PASSWORD: process.env.SQLKIT_MYSQL_PASSWORD ?? process.env.SQL_MCP_MYSQL_PASSWORD,
			PI_CODING_AGENT_DIR: agentDir,
			PI_OFFLINE: "1",
			DUMMY_KEY_LITERAL: "local-test-key",
		},
		stdio: ["ignore", "pipe", "pipe"],
	},
);

const stderrLines: string[] = [];
const calledTools = new Set<string>();
let resolved = false;
let sawFinalSummary = false;

function cleanupAgentDir(): void {
	try {
		rmSync(agentDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.warn(`Warning: unable to remove temporary directory ${agentDir}: ${message}`);
	}
}

function finish(exitCode: number, message: string): void {
	if (resolved) return;
	resolved = true;
	clearTimeout(timeout);
	child.kill();
	server.close();
	if (exitCode === 0) {
		cleanupAgentDir();
		console.log(message);
	} else {
		console.error(message);
		if (existsSync(debugLogPath)) console.error(`Debug log: ${debugLogPath}`);
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

	if (event.type === "tool_execution_start" && event.toolName) {
		calledTools.add(event.toolName);
		return;
	}

	const content = event.message?.content ?? [];
	for (const block of content) {
		if (block?.type === "toolCall" && block.name) calledTools.add(block.name);
		if (block?.type === "text" && typeof block.text === "string" && block.text.includes("真实 SQL agent 场景验证")) {
			sawFinalSummary = true;
		}
	}

	if (event.type === "agent_end") {
		for (const call of plannedCalls) {
			if (!calledTools.has(call.name)) {
				finish(1, `pi agent scenario did not call ${call.name}.`);
				return;
			}
		}
		if (!sawFinalSummary) {
			finish(1, "pi agent scenario did not emit the expected final Chinese summary.");
			return;
		}
		finish(0, `OK pi agent scenario called ${plannedCalls.length} SQL tools in the expected order.`);
	}
});

child.on("exit", (code) => {
	if (resolved) return;
	finish(code ?? 1, "pi agent scenario exited before agent_end.");
});

const timeout = setTimeout(() => {
	finish(1, "Timed out waiting for pi agent scenario verification to finish.");
}, 45_000);
