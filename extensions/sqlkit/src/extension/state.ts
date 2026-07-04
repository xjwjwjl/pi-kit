// ============================================================
// 扩展层 —— 共享状态管理与工具控制函数
// ============================================================
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadProjectConfig } from "../config/loader.js";
import { setProjectAgentToolsEnabled } from "../config/store.js";
import { logExtensionLoaded } from "./debug.js";
import { buildStatusText } from "./context.js";

export type SqlkitState = {
	sqlToolsRegistered: boolean;
	sqlToolNames: string[];
	sqlConfigToolNames: string[];
	sqlRuntimeToolNames: string[];
	sqlkitToolsEnabled: boolean;
	sqlRuntimeLoaded: boolean;
};

export function createSqlkitState(): SqlkitState {
	return {
		sqlToolsRegistered: false,
		sqlToolNames: [],
		sqlConfigToolNames: [],
		sqlRuntimeToolNames: [],
		sqlkitToolsEnabled: process.env.SQLKIT_AUTO_ENABLE_TOOLS === "1",
		sqlRuntimeLoaded: false,
	};
}

export function projectHasSources(cwd: string): boolean {
	try {
		return loadProjectConfig(cwd).sources.length > 0;
	} catch {
		return false;
	}
}

export function projectHasConfig(cwd: string): boolean {
	try {
		loadProjectConfig(cwd);
		return true;
	} catch {
		return false;
	}
}

function envToolsEnabledOverride(): boolean | undefined {
	const value = process.env.SQLKIT_AUTO_ENABLE_TOOLS;
	if (value == null || value.trim() === "") return undefined;
	return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

export function resolvePersistedToolsEnabled(cwd: string): boolean {
	const envOverride = envToolsEnabledOverride();
	if (envOverride !== undefined) return envOverride;
	try {
		const config = loadProjectConfig(cwd);
		if (config.agentTools.enabled !== undefined) return config.agentTools.enabled === true;
		return config.sources.length > 0;
	} catch {
		return false;
	}
}

export function restoreSqlkitToolsEnabled(cwd: string, state: SqlkitState): void {
	state.sqlkitToolsEnabled = resolvePersistedToolsEnabled(cwd);
}

export function statusText(state: SqlkitState, cwd: string): string {
	return state.sqlkitToolsEnabled ? buildStatusText(cwd) : "sqlkit";
}

export function buildSqlkitPolicyPrompt(): string {
	return [
		"SQLKit policy is active for this turn.",
		"- SQLKit query tools are read-oriented only. Do not use sql_run_query, sql_clickhouse_profile_query, sql_explain_query, or sql_mysql_analyze_query for DDL, DML, admin, or session-setting SQL such as CREATE, ALTER, DROP, INSERT, UPDATE, DELETE, TRUNCATE, OPTIMIZE, SYSTEM, SET, GRANT, or REVOKE.",
		"- Before any user-requested database change, if the selected datasource policy is not already known in this turn, call sql_list_sources first and inspect allow_apply before deciding whether sql_apply is allowed.",
		"- If the user asks for an allowed change, use sql_apply only when the datasource explicitly enables allow_apply; if that capability is disabled, do not call sql_apply just to discover the block. Tell the user which config field is required and ask whether to update SQLKit configuration.",
		"- sql_apply allows only INSERT, UPDATE, REPLACE, MERGE, CREATE DATABASE, CREATE TABLE, and additive ALTER TABLE ... ADD statements. DELETE, DROP, TRUNCATE, destructive ALTER forms, account/grant/session/file/admin operations, and unsupported CREATE forms are blocked.",
		"- sql_apply must never be treated as executed unless its tool result says executed=true. If confirmation is unavailable or the user cancels, explain that no SQL was executed.",
		"- Do not edit SQLKit config files merely to bypass read_only, allow_apply, or access-policy settings after a query/apply policy block unless the user explicitly asks to change SQLKit configuration.",
		"- If a SQLKit tool reports SQLKIT QUERY BLOCKED - READ/SAFETY POLICY or SQLKIT APPLY BLOCKED - SAFETY POLICY, stop retrying that operation and summarize the policy block to the user.",
	].join("\n");
}

export function notifyNoSourcesYet(ctx: {
	ui: { notify(message: string, type?: "info" | "warning" | "error"): void };
}): void {
	ctx.ui.notify("SQLKit runtime tools enabled. Add a SQL source before using datasource-specific tools.", "info");
}

async function ensureSqlToolsRegistered(pi: ExtensionAPI, state: SqlkitState): Promise<string[]> {
	if (state.sqlToolsRegistered) return state.sqlToolNames;
	const { sqlToolCatalog, SQL_CONFIG_TOOL_NAMES, SQL_RUNTIME_TOOL_NAMES, SQL_TOOL_NAMES } = await import("../core/catalog.js");
	state.sqlRuntimeLoaded = true;
	for (const { definition } of sqlToolCatalog) {
		pi.registerTool(definition);
	}
	state.sqlToolNames = [...SQL_TOOL_NAMES];
	state.sqlConfigToolNames = [...SQL_CONFIG_TOOL_NAMES];
	state.sqlRuntimeToolNames = [...SQL_RUNTIME_TOOL_NAMES];
	state.sqlToolsRegistered = true;
	logExtensionLoaded(state.sqlToolNames);
	return state.sqlToolNames;
}

function setSqlToolsActive(pi: ExtensionAPI, state: SqlkitState, runtimeEnabled: boolean): void {
	const active = pi.getActiveTools().filter((name) => !state.sqlToolNames.includes(name));
	const names = runtimeEnabled ? state.sqlToolNames : state.sqlConfigToolNames;
	pi.setActiveTools([...new Set([...active, ...names])]);
}

export async function syncSqlTools(pi: ExtensionAPI, state: SqlkitState, cwd: string): Promise<void> {
	await ensureSqlToolsRegistered(pi, state);
	if (projectHasConfig(cwd)) {
		setSqlToolsActive(pi, state, state.sqlkitToolsEnabled);
		return;
	}
	if (state.sqlkitToolsEnabled) {
		setSqlToolsActive(pi, state, true);
		return;
	}
	setSqlToolsActive(pi, state, false);
}

export async function setSqlkitToolsEnabled(
	pi: ExtensionAPI,
	state: SqlkitState,
	enabled: boolean,
	cwd: string,
): Promise<boolean> {
	state.sqlkitToolsEnabled = enabled;
	setProjectAgentToolsEnabled(cwd, enabled);
	await syncSqlTools(pi, state, cwd);
	return true;
}
