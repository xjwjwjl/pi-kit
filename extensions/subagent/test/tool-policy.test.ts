import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createAgentSession,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, JsonObject } from "@earendil-works/pi-ai";
import { createChildSession, disposeChildSession } from "../src/runner.ts";
import { CORE_BUILTIN_TOOLS } from "../src/tool-selection.ts";
import { createChildToolPolicy } from "../src/tool-policy.ts";

const MODEL = {
	provider: "probe", id: "probe", name: "probe", api: "openai-completions",
	input: ["text"], contextWindow: 10_000, maxTokens: 1_000, reasoning: false,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const RESOURCES = ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"];
const EXTRA_TOOLS = ["unrequested_direct", "unrequested_action", "unrequested_deferred",
	"mcp__probe__read", "mcp__probe__write", "mcp__other__write", ...RESOURCES, "ask_user", "agent"];

function fixture(t: TestContext, settings: Record<string, unknown> = {}): {
	cwd: string; agentDir: string; extension: string;
} {
	const root = mkdtempSync(join(tmpdir(), "pi-subagent-grants-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const cwd = join(root, "cwd");
	const agentDir = join(root, "agent");
	mkdirSync(cwd); mkdirSync(agentDir);
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings));
	const extension = join(root, "tools.ts");
	writeFileSync(extension, `
export default pi => {
	const register = (name, exposure = "codemode", execute) => pi.registerTool({
		name, exposure, label: name, description: "extension: " + name,
		parameters: { type: "object", properties: { target: { type: "string" } } },
		execute: execute ?? (async () => ({ content: [{ type: "text", text: name }], details: undefined })),
	});
	register("requested_read", "direct");
	register("requested_nested", "direct", async (_id, args, _signal, _update, ctx) => {
		const outcome = await ctx.executeTool(args.target, {});
		return { content: outcome.result.content, details: { nestedError: outcome.isError } };
	});
	register("unrequested_direct", "direct");
	register("unrequested_action");
	register("unrequested_deferred", "deferred");
	register("bash", "direct");
	for (const name of ${JSON.stringify(EXTRA_TOOLS.filter((name) => !name.startsWith("unrequested")))}) register(name);
	pi.registerCommand("register-late", { handler: async () => {
		register("late_allowed", "deferred");
		register("late_direct", "direct");
		register("late_codemode");
		register("late_deferred", "deferred");
		register("mcp__late__write");
		register("bash", "direct");
	}});
};
`);
	return { cwd, agentDir, extension };
}

async function child(
	t: TestContext,
	tools: string[] | undefined,
	options: { settings?: Record<string, unknown>; excludeTools?: string[] } = {},
): Promise<AgentSession> {
	const { cwd, agentDir, extension } = fixture(t, options.settings);
	const session = await createChildSession({
		cwd, agentDir, modelRegistry: {} as ModelRegistry, model: MODEL as never, prompt: "x",
		extensionPaths: ["builtin:codemode", "builtin:tool-search", extension],
		tools, excludeTools: options.excludeTools,
	});
	t.after(() => disposeChildSession(session));
	return session;
}

function assertUnavailable(session: AgentSession, names: readonly string[]): void {
	const registered = session.getAllTools().map((tool) => tool.name);
	const active = session.getActiveToolNames();
	const callable = session.getCallableToolNames();
	for (const name of names) {
		assert.ok(!registered.includes(name), `${name} must not be registered`);
		assert.ok(!active.includes(name), `${name} must not be declared`);
		assert.ok(!callable.includes(name), `${name} must not be callable`);
	}
}

let callCounter = 0;
async function execute(session: AgentSession, name: string, args: JsonObject = {}) {
	const tool = session.agent.state.tools.find((candidate) => candidate.name === name);
	assert.ok(tool, `${name} must be active`);
	const id = `grant-probe-${++callCounter}`;
	// The nested executor requires an issuing assistant message. Supply a synthetic
	// call in this test-only agent state instead of making a model request.
	const message: AssistantMessage = {
		role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }],
		api: "openai-completions", provider: MODEL.provider, model: MODEL.id,
		stopReason: "toolUse", timestamp: Date.now(),
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	};
	session.agent.state.messages = [...session.agent.state.messages, message];
	return tool.execute(id, args, new AbortController().signal);
}

test("tool policy preserves empty selections, modifier order, and configured core defaults", () => {
	const settings = SettingsManager.inMemory({ defaultTools: ["read", "grep", "unrequested_action"] });
	assert.deepEqual(createChildToolPolicy(".", settings).tools, ["read", "grep"]);
	assert.deepEqual(createChildToolPolicy(".", settings, []).tools, []);
	const policy = createChildToolPolicy(".", settings, ["-read", "+requested_read", "+read", "-grep"]);
	assert.deepEqual(policy.tools, ["requested_read", "read"]);
	assert.deepEqual(policy.customTools, [], "explicit core grants may deliberately select an override");
	assert.throws(() => createChildToolPolicy(".", settings, ["read", "+bash"]), /cannot be mixed/);
	assert.throws(() => createChildToolPolicy(".", settings, ["+probe*"]), /exact tool names/);
});

test("implicit core pin factories cover the SDK's actual exported core tools", () => {
	const settings = SettingsManager.inMemory({ defaultTools: [...CORE_BUILTIN_TOOLS] });
	const policy = createChildToolPolicy(".", settings);
	assert.deepEqual(policy.customTools.map((tool) => tool.name).sort(), [...CORE_BUILTIN_TOOLS].sort());
});

test("default core selection agrees with the actual SDK defaults", async (t) => {
	const { cwd, agentDir } = fixture(t);
	const { session: reference } = await createAgentSession({
		cwd, agentDir, model: MODEL as never, settingsManager: SettingsManager.inMemory(),
		sessionManager: SessionManager.inMemory(cwd),
	});
	t.after(() => reference.dispose());
	const session = await child(t, undefined);
	assert.deepEqual(session.getActiveToolNames().sort(), reference.getActiveToolNames().sort());
	assertUnavailable(session, [...EXTRA_TOOLS, "requested_read", "requested_nested", "codemode", "tool_search"]);
});

test("additive grants do not expose sibling tools through codemode or tool search", async (t) => {
	const session = await child(t, ["+codemode", "+tool_search", "+requested_read", "+requested_nested"]);
	assertUnavailable(session, EXTRA_TOOLS);
	const output = await execute(session, "requested_nested", { target: "requested_read" });
	assert.deepEqual(output.content, [{ type: "text", text: "requested_read" }]);
	const denied = await execute(session, "requested_nested", { target: "unrequested_action" });
	assert.equal(denied.details?.nestedError, true, "nested calls cannot reach an ungranted sibling");
	assert.match(JSON.stringify(denied.content), /not callable|unknown tool|not available|not found/i);
	const searched = await execute(session, "tool_search", { query: "unrequested" });
	assert.ok(!JSON.stringify(searched).includes('"name":"unrequested_action"'));
});

test("codemode scripts can call a granted tool but not its ungranted sibling", async (t) => {
	const session = await child(t, ["+codemode", "+requested_read"]);
	const prefix = '// @options: {"timeout_ms": 5000}\n';
	const allowed = await execute(session, "codemode", { code: prefix + "return await tools.requested_read({});" });
	assert.match(JSON.stringify(allowed.content), /Script completed/);
	assert.match(JSON.stringify(allowed.content), /requested_read/);
	const denied = await execute(session, "codemode", { code: prefix + "return await tools.unrequested_action({});" });
	assert.match(JSON.stringify(denied.content), /Script failed/);
});

test("plain grants retain only the explicitly requested extension tools", async (t) => {
	const session = await child(t, ["requested_read", "codemode"]);
	assert.deepEqual(session.getAllTools().map((tool) => tool.name).sort(), ["codemode", "requested_read"]);
	assertUnavailable(session, [...EXTRA_TOOLS, "read", "bash", "edit", "write", "tool_search"]);
});

test("late registration cannot widen grants or replace an implicit core tool", async (t) => {
	const session = await child(t, ["+requested_read", "+late_allowed"]);
	await session.prompt("/register-late");
	assert.ok(session.getCallableToolNames().includes("late_allowed"), "an explicitly granted deferred tool can register late");
	assertUnavailable(session, ["late_direct", "late_codemode", "late_deferred", "mcp__late__write", ...EXTRA_TOOLS]);
	assert.equal(session.getAllTools().find((tool) => tool.name === "bash")?.sourceInfo.source, "sdk");
});

test("core defaults cannot be replaced by a loaded extension and preserve shell settings", async (t) => {
	const session = await child(t, ["+requested_read"], { settings: { shellCommandPrefix: "printf 'PREFIX-'" } });
	assert.equal(session.getAllTools().find((tool) => tool.name === "bash")?.sourceInfo.source, "sdk");
	const output = await execute(session, "bash", { command: "printf 'BUILTIN'" });
	assert.ok(JSON.stringify(output.content).includes("PREFIX-BUILTIN"));
});

test("an explicitly granted core name can select an extension override", async (t) => {
	const session = await child(t, ["+requested_read", "+bash"]);
	const output = await execute(session, "bash");
	assert.deepEqual(output.content, [{ type: "text", text: "bash" }]);
	await session.prompt("/register-late");
	assert.deepEqual((await execute(session, "bash")).content, [{ type: "text", text: "bash" }]);
});

test("configured defaults cannot implicitly grant extension tools", async (t) => {
	const session = await child(t, ["+requested_read"], { settings: { defaultTools: ["read", "unrequested_action"] } });
	assert.deepEqual(session.getActiveToolNames().sort(), ["read", "requested_read"]);
	assertUnavailable(session, [...EXTRA_TOOLS, "bash", "edit", "write"]);
});

test("one MCP grant does not authorize sibling servers, resources, or late tools", async (t) => {
	const session = await child(t, ["+codemode", "+mcp__probe__read"]);
	assert.ok(session.getCallableToolNames().includes("mcp__probe__read"));
	assertUnavailable(session, EXTRA_TOOLS.filter((name) => name !== "mcp__probe__read"));
	await session.prompt("/register-late");
	assertUnavailable(session, ["mcp__late__write"]);
});

test("resource-only authorization keeps all other MCP access closed", async (t) => {
	const session = await child(t, ["+read_mcp_resource"]);
	assert.ok(session.getCallableToolNames().includes("read_mcp_resource"));
	assertUnavailable(session, EXTRA_TOOLS.filter((name) => name !== "read_mcp_resource"));
});

test("hard exclusions still override explicit grants", async (t) => {
	const session = await child(t, ["+agent", "+ask_user", "+requested_read", "+mcp__probe__read"], {
		excludeTools: ["requested_*", "mcp__*"],
	});
	assertUnavailable(session, [...EXTRA_TOOLS, "requested_read"]);
});
