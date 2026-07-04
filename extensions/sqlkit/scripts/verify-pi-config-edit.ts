import { spawn, spawnSync } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const agentDir = path.join(tmpdir(), `sqlkit-config-edit-${Date.now()}`);
const projectDir = path.join(agentDir, "project");
const configPath = path.join(projectDir, ".pi", "sqlkit.json");
const debugLogPath = path.join(agentDir, "verify-pi-config-edit.log");
const prompt = [
	"请直接编辑 SQLKit 配置，新增一个 MySQL source。",
	"source 名称 mysql_agent_config，host 127.0.0.1，port 3306，user app_user，password app_password，database app_db。",
	"新增后不要开启写入或 DDL 权限；如果因为缺少用户确认无法读取或修改，请直接用中文说明没有读取或修改配置。",
].join("");

const initialConfig = {
	agent_tools: { enabled: true },
	sources: [
		{
			name: "clickhouse_existing",
			dialect: "clickhouse",
			read_only: true,
			options: {
				url: "http://127.0.0.1:8123",
				username: "default",
				password: "",
				database: "default",
			},
		},
	],
};

function assertIncludes(text: string, expected: string, message: string): void {
	if (!text.includes(expected)) {
		throw new Error(`${message} Last result started with: ${JSON.stringify(text.slice(0, 260))}`);
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
		id: `chatcmpl-config-edit-${index}`,
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
		id: `chatcmpl-config-edit-${index}`,
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
							id: `config-edit-tool-call-${index}`,
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
		id: `chatcmpl-config-edit-${index}`,
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
		id: "chatcmpl-config-edit-final",
		object: "chat.completion.chunk",
		created: Math.floor(Date.now() / 1000),
		model: "dummy",
		choices: [
			{
				index: 0,
				delta: {
					role: "assistant",
					content: "总结：未读取或修改 sqlkit.json，因为访问 SQLKit 配置需要用户确认；请在交互环境中确认后再重试。",
				},
				finish_reason: "stop",
			},
		],
	});
	sendSseJson(res, {
		id: "chatcmpl-config-edit-final",
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

const plannedCalls: PlannedToolCall[] = [
	{
		name: "read",
		arguments: { path: ".pi/sqlkit.json" },
		validateResult(text) {
			assertIncludes(text, "SQLKit config access requires explicit user confirmation", "read result did not report confirmation block.");
			assertIncludes(text, "No sqlkit.json content was read or changed", "read result did not state that config stayed inaccessible.");
		},
	},
];

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
				lastToolResult: extractLastToolResult(payload.messages).slice(0, 220),
			})}`,
		);

		res.writeHead(200, {
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "no-cache",
			connection: "keep-alive",
		});

		if (toolMessages.length === 0) {
			for (const call of plannedCalls) {
				if (!toolNames.includes(call.name)) {
					throw new Error(`Provider payload did not expose required tool ${call.name}. tools=${toolNames.join(",")}`);
				}
			}
			sendToolCall(res, plannedCalls[0]!, 0);
			return;
		}

		const previousIndex = toolMessages.length - 1;
		plannedCalls[previousIndex]?.validateResult?.(extractLastToolResult(payload.messages));
		if (toolMessages.length < plannedCalls.length) {
			sendToolCall(res, plannedCalls[toolMessages.length]!, toolMessages.length);
			return;
		}

		sendFinal(res);
	} catch (error) {
		appendDebug(`SERVER_ERROR ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
		const message = error instanceof Error ? error.message : String(error);
		if (res.headersSent) {
			sendSseJson(res, {
				id: "chatcmpl-config-edit-error",
				object: "chat.completion.chunk",
				created: Math.floor(Date.now() / 1000),
				model: "dummy",
				choices: [
					{
						index: 0,
						delta: { content: `Config edit verification failed: ${message}` },
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

mkdirSync(path.join(projectDir, ".pi"), { recursive: true });
writeJson(configPath, initialConfig);
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
		"-e",
		extensionPath,
		"-t",
		"read,write,sql_validate_config",
		prompt,
	],
	{
		cwd: projectDir,
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
const calledTools: string[] = [];
let resolved = false;
let sawFinalSummary = false;

function cleanupAgentDir(): void {
	try {
		rmSync(agentDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
	} catch {
		// Best-effort cleanup; a short-lived pi child can keep handles open briefly on Windows.
	}
}

function verifyPersistedConfig(): void {
	const persisted = JSON.parse(readFileSync(configPath, "utf-8")) as typeof initialConfig;
	if (persisted.sources.some((source) => source.name === "mysql_agent_config")) {
		throw new Error("Unconfirmed config edit should not add mysql_agent_config.");
	}
	if (JSON.stringify(persisted) !== JSON.stringify(initialConfig)) {
		throw new Error("Unconfirmed config edit should leave sqlkit.json unchanged.");
	}
}

function finish(exitCode: number, message: string): void {
	if (resolved) return;
	resolved = true;
	clearTimeout(timeout);
	child.kill();
	server.close();
	if (exitCode === 0) {
		try {
			verifyPersistedConfig();
		} catch (error) {
			console.error(error instanceof Error ? error.message : String(error));
			if (existsSync(debugLogPath)) console.error(`Debug log: ${debugLogPath}`);
			process.exitCode = 1;
			return;
		}
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
		calledTools.push(event.toolName);
		return;
	}

	const content = event.message?.content ?? [];
	for (const block of content) {
		if (block?.type === "text" && typeof block.text === "string" && block.text.includes("未读取或修改 sqlkit.json")) {
			sawFinalSummary = true;
		}
	}

	if (event.type === "agent_end") {
		const expectedOrder = plannedCalls.map((call) => call.name).join(",");
		const actualOrder = calledTools.join(",");
		if (actualOrder !== expectedOrder) {
			finish(1, `pi config edit scenario called unexpected tools. expected=${expectedOrder} actual=${actualOrder}`);
			return;
		}
		if (!sawFinalSummary) {
			finish(1, "pi config edit scenario did not emit the expected final Chinese summary.");
			return;
		}
		finish(0, "OK pi config edit scenario blocked unconfirmed sqlkit.json read and left config unchanged.");
	}
});

child.on("exit", (code) => {
	if (resolved) return;
	finish(code ?? 1, "pi config edit scenario exited before agent_end.");
});

const timeout = setTimeout(() => {
	finish(1, "Timed out waiting for pi config edit scenario verification to finish.");
}, 45_000);
