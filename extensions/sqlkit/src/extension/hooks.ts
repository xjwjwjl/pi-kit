// ============================================================
// 扩展层 —— 生命周期钩子注册
// ============================================================
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { findProjectConfigPath } from "../config/loader.js";
import {
	buildSqlkitPolicyPrompt,
	restoreSqlkitToolsEnabled,
	statusText,
	syncSqlTools,
	type SqlkitState,
} from "./state.js";
import { logBeforeAgentStart, logBeforeProviderRequest, logSessionStart } from "./debug.js";
import { reshapeToolResultsForLlm } from "./context.js";
import { existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { getContextCwd } from "../utils.js";

function cleanupStaleConfigBackups(cwd: string): void {
	try {
		const configPath = findProjectConfigPath(cwd);
		if (!configPath) return;
		const dir = path.dirname(configPath);
		const base = path.basename(configPath);
		for (const entry of readdirSync(dir)) {
			if (entry.startsWith(`${base}.bak.`)) {
				rmSync(path.join(dir, entry), { force: true });
			}
		}
	} catch {
		// Cleanup is best-effort; never fail the session for it.
	}
}

export function registerHooks(pi: ExtensionAPI, state: SqlkitState): void {
	pi.on("input", async (_event, ctx) => {
		restoreSqlkitToolsEnabled(getContextCwd(ctx), state);
		await syncSqlTools(pi, state, getContextCwd(ctx));
		return { action: "continue" };
	});

	pi.on("context", async (event: { messages: unknown[] }) => {
		return { messages: reshapeToolResultsForLlm(event.messages) };
	});

	pi.on("before_agent_start", async (event, ctx) => {
		logBeforeAgentStart(
			getContextCwd(ctx),
			pi.getActiveTools(),
			Array.isArray(event.systemPromptOptions?.selectedTools)
				? (event.systemPromptOptions.selectedTools as Array<
						string | { name?: unknown; sourceInfo?: unknown }
				  >)
				: undefined,
		);

		if (!state.sqlkitToolsEnabled || !pi.getActiveTools().some((name) => state.sqlRuntimeToolNames.includes(name))) return;

		return {
			systemPrompt: `${event.systemPrompt}\n\n${buildSqlkitPolicyPrompt()}`,
		};
	});

	pi.on("before_provider_request", async (event, ctx) => {
		logBeforeProviderRequest(getContextCwd(ctx), event.payload);
	});

	pi.on("session_start", async (event, ctx) => {
		const cwd = getContextCwd(ctx);
		cleanupStaleConfigBackups(cwd);
		restoreSqlkitToolsEnabled(cwd, state);
		await syncSqlTools(pi, state, cwd);
		logSessionStart(cwd, event.reason, pi.getAllTools(), pi.getActiveTools());
		ctx.ui.setStatus("sqlkit", statusText(state, cwd));
	});

	pi.on("session_shutdown", async () => {
		if (!state.sqlRuntimeLoaded) return;
		const { closeAllAdapters } = await import("../adapters/registry.js");
		await closeAllAdapters();
	});
}
