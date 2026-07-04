import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sqlkitExtension from "../index.js";
import { SQL_CONFIG_TOOL_NAMES, SQL_RUNTIME_TOOL_NAMES, SQL_TOOL_NAMES } from "../src/core/catalog.js";

const expectedTools = [...SQL_TOOL_NAMES];
const expectedConfigTools = [...SQL_CONFIG_TOOL_NAMES];
const expectedRuntimeTools = [...SQL_RUNTIME_TOOL_NAMES];
const expectedCommands = ["sqlkit"];

type RegisteredTool = {
	name: string;
	description?: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
	execute?: unknown;
	parameters?: unknown;
};

const registeredTools: RegisteredTool[] = [];
const registeredCommands: Array<{ name: string; handler?: (args: string, ctx: unknown) => unknown }> = [];
const registeredEvents: string[] = [];
const eventHandlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
type ToolCallResult = { block?: boolean; reason?: string } | undefined;
let activeTools: string[] = [];

const fakePi = {
	registerTool(definition: RegisteredTool) {
		registeredTools.push(definition);
	},
	registerCommand(name: string, definition: { handler?: (args: string, ctx: unknown) => unknown }) {
		registeredCommands.push({ name, handler: definition.handler });
	},
	on(event: string, handler: (event: any, ctx: any) => unknown) {
		registeredEvents.push(event);
		eventHandlers.set(event, [...(eventHandlers.get(event) ?? []), handler]);
	},
	getActiveTools() {
		return activeTools;
	},
	setActiveTools(names: string[]) {
		activeTools = names;
	},
	getAllTools() {
		return registeredTools;
	},
};

function writeJson(filePath: string, value: unknown): void {
	writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function requireTool(name: string): RegisteredTool {
	const tool = registeredTools.find((item) => item.name === name);
	if (!tool) throw new Error(`Expected tool "${name}" to be registered.`);
	return tool;
}

function toolPromptText(name: string): string {
	const tool = requireTool(name);
	return JSON.stringify({
		description: tool.description,
		promptSnippet: tool.promptSnippet,
		promptGuidelines: tool.promptGuidelines,
		parameters: tool.parameters,
	});
}

sqlkitExtension(fakePi as never);

const actualCommands = registeredCommands.map((command) => command.name);
const missingCommands = expectedCommands.filter((name) => !actualCommands.includes(name));
const extraCommands = actualCommands.filter((name) => !expectedCommands.includes(name));
if (missingCommands.length > 0 || extraCommands.length > 0) {
	throw new Error(`Extension command registration mismatch. missing=${JSON.stringify(missingCommands)} extra=${JSON.stringify(extraCommands)}`);
}
for (const command of registeredCommands) {
	if (typeof command.handler !== "function") {
		throw new Error(`Command "${command.name}" is missing a handler.`);
	}
}

const sqlkitCommand = registeredCommands.find((command) => command.name === "sqlkit");
if (!sqlkitCommand?.handler) {
	throw new Error("sqlkit command is missing a handler.");
}

const startupDir = path.join(tmpdir(), `sqlkit-verify-extension-startup-${Date.now()}`);
mkdirSync(startupDir, { recursive: true });
try {
	for (const handler of eventHandlers.get("session_start") ?? []) {
		await handler({ reason: "startup" }, { cwd: startupDir, ui: { setStatus() {} } });
	}
	const actualTools = registeredTools.map((tool) => tool.name);
	const missingStartupTools = expectedTools.filter((name) => !actualTools.includes(name));
	const activeUnexpectedRuntimeTools = expectedRuntimeTools.filter((name) => activeTools.includes(name));
	const inactiveConfigTools = expectedConfigTools.filter((name) => !activeTools.includes(name));
	if (missingStartupTools.length > 0 || activeUnexpectedRuntimeTools.length > 0 || inactiveConfigTools.length > 0) {
		throw new Error(
			`Expected startup to register all sql_* tools and activate only config tools. missing=${JSON.stringify(missingStartupTools)} runtime_active=${JSON.stringify(activeUnexpectedRuntimeTools)} config_inactive=${JSON.stringify(inactiveConfigTools)}`,
		);
	}
} finally {
	rmSync(startupDir, { recursive: true, force: true });
}

const noSourceDir = path.join(tmpdir(), `sqlkit-verify-extension-no-source-${Date.now()}`);
mkdirSync(noSourceDir, { recursive: true });
try {
	const notifications: string[] = [];
	await sqlkitCommand.handler("on", {
		cwd: noSourceDir,
		ui: {
			setStatus() {},
			notify(message: string) {
				notifications.push(message);
			},
		},
	});
	if (!notifications.some((message) => message.includes("SQLKit runtime tools enabled"))) {
		throw new Error("Expected /sqlkit on without sources to enable SQLKit runtime tools.");
	}
	if (!notifications.some((message) => message.includes("Add a SQL source before using datasource-specific tools"))) {
		throw new Error("Expected /sqlkit on without sources to explain that datasource-specific tools still need a source.");
	}
	const noSourceConfigPath = path.join(noSourceDir, ".pi", "sqlkit.json");
	if (!existsSync(noSourceConfigPath)) {
		throw new Error("Expected /sqlkit on without sources to create sqlkit.json with the enabled tool preference.");
	}
	const noSourceConfig = JSON.parse(readFileSync(noSourceConfigPath, "utf-8"));
	if (noSourceConfig.agent_tools?.enabled !== true || !Array.isArray(noSourceConfig.sources) || noSourceConfig.sources.length !== 0) {
		throw new Error("Expected /sqlkit on without sources to persist agent_tools.enabled=true with an empty sources array.");
	}
	const inactiveNoSourceTools = expectedTools.filter((name) => !activeTools.includes(name));
	if (inactiveNoSourceTools.length > 0) {
		throw new Error(`Expected /sqlkit on without sources to activate sql_* tools. inactive=${JSON.stringify(inactiveNoSourceTools)}`);
	}
} finally {
	rmSync(noSourceDir, { recursive: true, force: true });
}

const tmpDir = path.join(tmpdir(), `sqlkit-verify-extension-${Date.now()}`);
mkdirSync(path.join(tmpDir, ".pi"), { recursive: true });
writeJson(path.join(tmpDir, ".pi", "sqlkit.json"), {
	sources: [
		{
			name: "unit",
			dialect: "clickhouse",
			read_only: true,
			options: { url: "http://127.0.0.1:8123", username: "default" },
		},
	],
});

try {
	for (const handler of eventHandlers.get("session_start") ?? []) {
		await handler({ reason: "startup" }, { cwd: tmpDir, ui: { setStatus() {} } });
	}

	const defaultActiveTools = registeredTools.map((tool) => tool.name);
	const missingDefaultTools = expectedTools.filter((name) => !defaultActiveTools.includes(name));
	const inactiveByDefault = expectedTools.filter((name) => !activeTools.includes(name));
	if (missingDefaultTools.length > 0 || inactiveByDefault.length > 0) {
		throw new Error(
			`Expected sql_* tools to activate by default when sources exist. missing=${JSON.stringify(missingDefaultTools)} inactive=${JSON.stringify(inactiveByDefault)}`,
		);
	}
	const persistedAfterDefaultStart = JSON.parse(readFileSync(path.join(tmpDir, ".pi", "sqlkit.json"), "utf-8"));
	if (persistedAfterDefaultStart.agent_tools?.enabled !== undefined) {
		throw new Error("Expected default source-based activation not to persist agent_tools.enabled until the user toggles it.");
	}

	const commandCtx = { cwd: tmpDir, ui: { setStatus() {}, notify() {} } };
	await sqlkitCommand?.handler?.("on", commandCtx);

	const actualTools = registeredTools.map((tool) => tool.name);
	const missingTools = expectedTools.filter((name) => !actualTools.includes(name));
	const extraTools = actualTools.filter((name) => !expectedTools.includes(name));
	const duplicateTools = actualTools.filter((name, index) => actualTools.indexOf(name) !== index);

	if (missingTools.length > 0 || extraTools.length > 0 || duplicateTools.length > 0) {
		throw new Error(
			[
				"Extension dynamic tool registration mismatch.",
				`missing=${JSON.stringify(missingTools)}`,
				`extra=${JSON.stringify(extraTools)}`,
				`duplicates=${JSON.stringify(duplicateTools)}`,
			].join(" "),
		);
	}

	const persistedAfterOn = JSON.parse(readFileSync(path.join(tmpDir, ".pi", "sqlkit.json"), "utf-8"));
	if (persistedAfterOn.agent_tools?.enabled !== true) {
		throw new Error("Expected /sqlkit on to persist agent_tools.enabled=true in sqlkit.json.");
	}

	const inactiveAfterOn = expectedTools.filter((name) => !activeTools.includes(name));
	if (inactiveAfterOn.length > 0) {
		throw new Error(`Expected /sqlkit on to activate sql_* tools. inactive=${JSON.stringify(inactiveAfterOn)}`);
	}

	const policyPrompts: Array<{ systemPrompt?: string } | undefined> = [];
	for (const handler of eventHandlers.get("before_agent_start") ?? []) {
		policyPrompts.push(
			(await handler(
				{ systemPrompt: "base prompt", systemPromptOptions: { selectedTools: activeTools.map((name) => ({ name })) } },
				{ cwd: tmpDir, ui: { setStatus() {}, notify() {} } },
			)) as { systemPrompt?: string } | undefined,
		);
	}
	if (!policyPrompts.some((result) => result?.systemPrompt?.includes("SQLKit policy is active"))) {
		throw new Error("Expected before_agent_start to inject SQLKit policy guidance when tools are enabled.");
	}
	if (policyPrompts.some((result) => result?.systemPrompt?.includes("Do not read raw SQLKit config files"))) {
		throw new Error("Expected SQLKit policy guidance to allow explicit config-management requests instead of forbidding raw config reads.");
	}
	if (policyPrompts.some((result) => result?.systemPrompt?.includes("password_env"))) {
		throw new Error("Expected SQLKit policy guidance not to recommend password_env.");
	}
	if (!policyPrompts.some((result) => result?.systemPrompt?.includes("call sql_list_sources first"))) {
		throw new Error("Expected SQLKit policy guidance to require source-policy preflight before writes.");
	}
	if (!policyPrompts.some((result) => result?.systemPrompt?.includes("sql_apply allows only") && result.systemPrompt.includes("CREATE DATABASE"))) {
		throw new Error("Expected SQLKit policy guidance to explain the allowed sql_apply statements.");
	}
	if (!policyPrompts.some((result) => result?.systemPrompt?.includes("DELETE, DROP, TRUNCATE"))) {
		throw new Error("Expected SQLKit policy guidance to identify blocked destructive statements.");
	}

	await sqlkitCommand?.handler?.("off", commandCtx);
	const persistedAfterOff = JSON.parse(readFileSync(path.join(tmpDir, ".pi", "sqlkit.json"), "utf-8"));
	if (persistedAfterOff.agent_tools?.enabled !== false) {
		throw new Error("Expected /sqlkit off to persist agent_tools.enabled=false in sqlkit.json.");
	}
	const activeRuntimeAfterOff = expectedRuntimeTools.filter((name) => activeTools.includes(name));
	const inactiveConfigAfterOff = expectedConfigTools.filter((name) => !activeTools.includes(name));
	if (activeRuntimeAfterOff.length > 0 || inactiveConfigAfterOff.length > 0) {
		throw new Error(
			`Expected /sqlkit off to keep config tools active and remove runtime tools. runtime_active=${JSON.stringify(activeRuntimeAfterOff)} config_inactive=${JSON.stringify(inactiveConfigAfterOff)}`,
		);
	}
	const disabledPrompts: Array<{ systemPrompt?: string } | undefined> = [];
	for (const handler of eventHandlers.get("before_agent_start") ?? []) {
		disabledPrompts.push(
			(await handler(
				{ systemPrompt: "base prompt", systemPromptOptions: { selectedTools: activeTools.map((name) => ({ name })) } },
				{ cwd: tmpDir, ui: { setStatus() {}, notify() {} } },
			)) as { systemPrompt?: string } | undefined,
		);
	}
	if (disabledPrompts.some((result) => result?.systemPrompt?.includes("SQLKit policy is active"))) {
		throw new Error("Expected SQLKit execution policy guidance to stay out of the prompt when agent tools are disabled.");
	}

	for (const tool of registeredTools) {
		if (typeof tool.execute !== "function") {
			throw new Error(`Tool "${tool.name}" is missing an execute function.`);
		}
	}

	const runTool = requireTool("sql_run_query");
	const runParameters = runTool.parameters as { properties?: Record<string, { description?: string }> } | undefined;
	const sourceDescription = runParameters?.properties?.source?.description ?? "";
	if (/default source/i.test(sourceDescription) || !/exactly one source/i.test(sourceDescription) || !/pass source explicitly/i.test(sourceDescription)) {
		throw new Error(`source parameter prompt should describe single-source omission, not a default source. description=${sourceDescription}`);
	}
	if (/default source/i.test(toolPromptText("sql_list_sources"))) {
		throw new Error("sql_list_sources prompt should not claim a default source is returned.");
	}
	const upsertPrompt = toolPromptText("sql_upsert_source");
	if (!/Create or update one SQLKit datasource/.test(upsertPrompt) || !/canonical config schema/.test(upsertPrompt)) {
		throw new Error("sql_upsert_source prompt should clearly describe canonical SQLKit datasource config edits.");
	}
	if (!/MySQL URLs are parsed/.test(upsertPrompt) || !/ClickHouse URLs are stored/.test(upsertPrompt)) {
		throw new Error("sql_upsert_source prompt should explain dialect-specific URL handling.");
	}
	if (!/sql_validate_config/.test(upsertPrompt)) {
		throw new Error("sql_upsert_source prompt should steer agents to post-edit validation.");
	}
	const validatePrompt = toolPromptText("sql_validate_config");
	if (!/after sql_upsert_source/.test(validatePrompt) || !/connectivity by default/.test(validatePrompt)) {
		throw new Error("sql_validate_config prompt should frame post-edit validation with connectivity as the default.");
	}
	if (!/Set check_connections=false only/.test(validatePrompt)) {
		throw new Error("sql_validate_config prompt should reserve check_connections=false for lightweight structural checks.");
	}
	if (!/prefer sql_ping/.test(validatePrompt)) {
		throw new Error("sql_validate_config prompt should distinguish full validation from single-source ping.");
	}
	const profilePrompt = toolPromptText("sql_clickhouse_profile_query");
	if (!/ClickHouse/.test(profilePrompt) || !/MySQL/.test(profilePrompt)) {
		throw new Error("sql_clickhouse_profile_query prompt should clearly state ClickHouse support and MySQL alternative.");
	}
	const analyzePrompt = toolPromptText("sql_mysql_analyze_query");
	if (!/MySQL/.test(analyzePrompt) || !/ClickHouse/.test(analyzePrompt)) {
		throw new Error("sql_mysql_analyze_query prompt should clearly state MySQL support and ClickHouse alternative.");
	}
	const writePrompt = toolPromptText("sql_apply");
	if (!/sql_list_sources/.test(writePrompt) || !/allow_apply/.test(writePrompt) || !/CREATE DATABASE/.test(writePrompt)) {
		throw new Error("sql_apply prompt should guide agents to preflight datasource apply policy.");
	}
	if (!/DELETE/.test(writePrompt) || !/DROP/.test(writePrompt) || !/TRUNCATE/.test(writePrompt)) {
		throw new Error("sql_apply prompt should identify blocked destructive statements before tool use.");
	}
	const removedDdlField = ["allow", "ddl"].join("_");
	if (writePrompt.includes(removedDdlField)) {
		throw new Error("sql_apply prompt should not mention the removed DDL config field.");
	}

	const explainTool = requireTool("sql_explain_query");
	const explainParameters = explainTool?.parameters as { properties?: Record<string, unknown> } | undefined;
	const modeSchema = explainParameters?.properties?.mode as { enum?: unknown } | undefined;
	if (!Array.isArray(modeSchema?.enum) || !modeSchema.enum.includes("pipeline") || !modeSchema.enum.includes("json")) {
		throw new Error("sql_explain_query mode parameter should expose a string enum for provider-compatible tool schemas.");
	}

	const analyzeTool = requireTool("sql_mysql_analyze_query");
	const analyzeParameters = analyzeTool?.parameters as { properties?: Record<string, unknown> } | undefined;
	if (!analyzeParameters?.properties?.query) {
		throw new Error("sql_mysql_analyze_query should expose a query parameter.");
	}
	const analyzeModeSchema = analyzeParameters?.properties?.mode as { enum?: unknown } | undefined;
	if (!Array.isArray(analyzeModeSchema?.enum) || analyzeModeSchema.enum.length !== 1 || !analyzeModeSchema.enum.includes("analyze")) {
		throw new Error('sql_mysql_analyze_query mode parameter should expose only the supported "analyze" enum value.');
	}

	for (const event of ["context", "input", "session_start", "session_shutdown"]) {
		if (!registeredEvents.includes(event)) {
			throw new Error(`Extension did not register "${event}" event handler.`);
		}
	}
} finally {
	rmSync(tmpDir, { recursive: true, force: true });
}

console.log(`OK dynamically registered ${registeredTools.length} tools, ${registeredCommands.length} commands, and ${registeredEvents.length} event handlers.`);
