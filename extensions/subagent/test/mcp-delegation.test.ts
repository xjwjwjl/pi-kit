import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createAgentSession, DefaultResourceLoader, ModelRegistry, SessionManager, SettingsManager,
	type AgentSession, type ExtensionAPI, type ExtensionContext, type RegisteredMcpServer, type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { BUILTIN_EXTENSION_FACTORIES } from "../src/builtin-extensions.ts";
import { resolveRequest } from "../src/request.ts";
import { createChildSession, disposeChildSession } from "../src/runner.ts";
import { resolveToolSelection } from "../src/tool-selection.ts";

const MODEL = {
	provider: "probe", id: "probe", name: "probe", api: "openai-completions",
	input: ["text"], contextWindow: 10_000, maxTokens: 1_000, reasoning: false,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function tool(name: string, namespace?: string, path = "builtin:mcp"): ToolInfo {
	return { name, description: "probe", parameters: {},
		...(namespace ? { namespace: { name: namespace } } : {}),
		sourceInfo: { path, source: "builtin", scope: "temporary", origin: "top-level" },
	} as ToolInfo;
}

function registration(name: string): RegisteredMcpServer {
	return { name, config: { command: "offline-fixture", args: [name] }, extensionPath: "/extensions/registrar.ts" };
}

const read = tool("mcp__probe_server__read", "mcp__probe_server");
const write = tool("mcp__probe_server__write", "mcp__probe_server");
const other = tool("mcp__other__read", "mcp__other");

for (const fromDefinition of [false, true]) {
	test(`dynamic MCP registrations follow ${fromDefinition ? "definition" : "requested"} tool grants only`, () => {
		const server = registration("probe-server");
		const selection = resolveToolSelection({
			requested: fromDefinition ? [] : [read.name, write.name, read.name],
			definitionTools: fromDefinition ? [read.name, write.name] : undefined,
			loadDefinitionTools: true,
			allTools: [read, write, other], trusted: false,
			mcpServers: [server, registration("other")],
		});
		assert.deepEqual(selection.extensionPaths, ["builtin:mcp"], "do not reload the registrar extension");
		assert.deepEqual(selection.mcpServers, [server], "deduplicate by server, without inheriting siblings");
		assert.notEqual(selection.mcpServers?.[0].config, server.config, "snapshot mutable configuration before queueing");
	});
}

test("MCP namespace matching does not confuse server names containing double underscores", () => {
	const requested = tool("mcp__probe__nested__read", "mcp__probe__nested");
	const server = registration("probe__nested");
	const selection = resolveToolSelection({ requested: [requested.name], allTools: [requested], trusted: true,
		mcpServers: [registration("probe"), server] });
	assert.deepEqual(selection.mcpServers, [server]);
});

test("resource grants carry dynamic servers without implicitly granting their tools", () => {
	const resource = tool("read_mcp_resource");
	const servers = [registration("probe-server"), registration("other")];
	const selection = resolveToolSelection({ requested: [resource.name], allTools: [resource], trusted: false, mcpServers: servers });
	assert.deepEqual(selection.mcpServers, servers, "resource grants have no per-server isolation");
	assert.deepEqual(selection.tools, ["+read_mcp_resource"]);
});

test("other built-ins and non-MCP tool implementations do not inherit server registrations", () => {
	for (const requested of [tool("codemode", undefined, "builtin:codemode"),
		{ ...read, sourceInfo: { ...read.sourceInfo, source: "user", path: "/extensions/custom-mcp.ts" } }]) {
		const selection = resolveToolSelection({ requested: [requested.name], allTools: [requested], trusted: true,
			mcpServers: [registration("probe-server")] });
		assert.equal(selection.mcpServers, undefined);
	}
});

const STDIO_SERVER = `
import { createInterface } from "node:readline";
const server = process.argv[2];
createInterface({ input: process.stdin }).on("line", line => {
	const message = JSON.parse(line);
	if (message.id === undefined) return;
	let result;
	if (message.method === "initialize") result = {
		protocolVersion: message.params.protocolVersion,
		capabilities: { tools: {}, resources: {} }, serverInfo: { name: server, version: "1" },
	};
	else if (message.method === "tools/list") result = { tools: ["read", "write"].map(name => ({
		name, description: "offline " + name, inputSchema: { type: "object", properties: {} },
	})) };
	else if (message.method === "tools/call") result = { content: [{ type: "text", text: server + ":" + message.params.name }] };
	else if (message.method === "resources/list") result = { resources: [{ uri: "fixture://" + server, name: server }] };
	else if (message.method === "resources/read") result = { contents: [{ uri: message.params.uri, text: server }] };
	else result = {};
	process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
});
`;

async function waitForDirectMcp(session: AgentSession): Promise<void> {
	// Runs MCP's readiness hook without issuing a model request or polling.
	await session.extensionRunner!.emit({ type: "before_agent_start", messageType: "user", prompt: "offline probe",
		systemPrompt: "", systemPromptOptions: { sections: {} } } as never);
}

async function fixture(t: TestContext, when: "load" | "session_start" = "load") {
	const root = mkdtempSync(join(tmpdir(), "pi-subagent-mcp-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	const sessions: AgentSession[] = [];
	t.after(async () => {
		try {
			for (const session of sessions.reverse()) await disposeChildSession(session);
		} finally {
			if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previous;
			rmSync(root, { recursive: true, force: true });
		}
	});
	const cwd = join(root, "cwd");
	const agentDir = join(root, "agent");
	mkdirSync(cwd); mkdirSync(agentDir);
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const serverPath = join(root, "server.mjs");
	writeFileSync(serverPath, STDIO_SERVER);
	const servers = ["probe-server", "other"].map(name => ({ name,
		config: { command: process.execPath, args: [serverPath, name], exposure: "direct", timeout: 5 },
	}));
	const registrar = join(root, "registrar.ts");
	const loads = join(root, "registrar-loads.txt");
	const registrations = join(root, "registrations.txt");
	const register = `for (const server of ${JSON.stringify(servers)}) pi.registerMcpServer(server.name, server.config);
	appendFileSync(${JSON.stringify(registrations)}, "registered\\n");`;
	writeFileSync(registrar, `import { appendFileSync } from "node:fs";
export default pi => {
	appendFileSync(${JSON.stringify(loads)}, "loaded\\n");
	${when === "load" ? register : `pi.on("session_start", () => { ${register} });`}
	pi.registerTool({ name: "registrar_tool", label: "Registrar", description: "probe",
		parameters: { type: "object", properties: {} },
		execute: async () => ({ content: [{ type: "text", text: "registrar" }], details: undefined }),
	});
};`);
	const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
	const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true,
		extensionFactories: BUILTIN_EXTENSION_FACTORIES, additionalExtensionPaths: [registrar, "builtin:mcp"] });
	await loader.reload();
	const { session: parent } = await createAgentSession({ cwd, agentDir, settingsManager, resourceLoader: loader,
		model: MODEL as never, sessionManager: SessionManager.inMemory() });
	sessions.push(parent);
	await parent.bindExtensions({});
	await waitForDirectMcp(parent);
	assert.ok(parent.getAllTools().some(entry => entry.name === read.name), "the parent really connected its dynamic MCP server");
	const pi = { getAllTools: () => parent.getAllTools(),
		getMcpServers: () => loader.getExtensions().runtime.mcpServers.list(),
	} as ExtensionAPI;
	const ctx = { cwd, model: MODEL, modelRegistry: new ModelRegistry(parent.modelRuntime),
		sessionManager: parent.sessionManager, isProjectTrusted: () => true,
	} as unknown as ExtensionContext;
	return { cwd, loads, registrations, pi, ctx, async child(params: Parameters<typeof resolveRequest>[2]) {
		const request = resolveRequest(pi, ctx, params);
		const session = await createChildSession({ ...request, agentDir });
		sessions.push(session);
		await waitForDirectMcp(session);
		return session;
	} };
}

function assertAbsent(session: AgentSession, names: string[]): void {
	for (const available of [session.getAllTools().map(entry => entry.name), session.getActiveToolNames(), session.getCallableToolNames()]) {
		for (const name of names) assert.ok(!available.includes(name), `${name} must not be reachable`);
	}
}

test("a dynamically registered MCP tool works in the child without loading its registrar or siblings", async t => {
	const f = await fixture(t);
	const session = await f.child({ description: "probe", prompt: "unused", tools: [read.name] });
	const requested = session.agent.state.tools.find(entry => entry.name === read.name);
	assert.ok(requested, "the granted tool is active in the real child SDK session");
	const result = await requested.execute("probe", {}, new AbortController().signal);
	assert.deepEqual(result.content, [{ type: "text", text: "probe-server:read" }]);
	assertAbsent(session, [write.name, "mcp__other__read", "mcp__other__write", "registrar_tool",
		"read_mcp_resource", "list_mcp_resources", "list_mcp_resource_templates"]);
	assert.equal(readFileSync(f.loads, "utf8"), "loaded\n", "the child must not re-execute the registrar's side effects");
});

for (const when of ["load", "session_start"] as const) {
	test(`definition-only MCP grants retain ownership when the registrar registers during ${when}`, async t => {
		const f = await fixture(t, when);
		mkdirSync(join(f.cwd, ".pi", "agents"), { recursive: true });
		writeFileSync(join(f.cwd, ".pi", "agents", "probe.md"),
			`---\nname: probe\ndescription: probe\ntools: [${read.name}]\n---\nOffline probe`);
		const definitionChild = await f.child({ description: "probe", prompt: "unused", subagent_type: "probe" });
		assert.ok(definitionChild.getActiveToolNames().includes(read.name));
		assertAbsent(definitionChild, [write.name, "mcp__other__read", "mcp__other__write", "registrar_tool"]);
		assert.equal(readFileSync(f.loads, "utf8"), "loaded\n");
		const params = { description: "probe", prompt: "unused", subagent_type: "probe", tools: ["registrar_tool"] };
		assert.equal(resolveRequest(f.pi, f.ctx, params).mcpServers, undefined, "the explicit registrar retains server ownership");
		const session = await f.child(params);
		assert.ok(session.getActiveToolNames().includes(read.name));
		assert.ok(session.getActiveToolNames().includes("registrar_tool"));
		assertAbsent(session, [write.name, "mcp__other__read", "mcp__other__write"]);
		assert.equal(readFileSync(f.loads, "utf8"), "loaded\nloaded\n");
		assert.equal(readFileSync(f.registrations, "utf8"), "registered\nregistered\n");
	});
}

test("a resource-only grant retains dynamic servers without exposing their tools", async t => {
	const f = await fixture(t);
	const session = await f.child({ description: "probe", prompt: "unused", tools: ["list_mcp_resources"] });
	const resource = session.agent.state.tools.find(entry => entry.name === "list_mcp_resources");
	assert.ok(resource);
	const result = await resource.execute("probe", {}, new AbortController().signal);
	const text = result.content.filter(part => part.type === "text").map(part => part.text).join("\n");
	assert.match(text, /fixture:\/\/probe-server/);
	assert.match(text, /fixture:\/\/other/);
	assertAbsent(session, [read.name, write.name, "mcp__other__read", "mcp__other__write", "registrar_tool",
		"read_mcp_resource", "list_mcp_resource_templates"]);
});
