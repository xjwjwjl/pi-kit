// ============================================================
// 扩展层 —— /sqlkit 命令处理器
// ============================================================
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getContextCwd } from "../utils.js";
import {
	notifyNoSourcesYet,
	projectHasSources,
	setSqlkitToolsEnabled,
	statusText,
	syncSqlTools,
	type SqlkitState,
} from "./state.js";

export function registerCommands(pi: ExtensionAPI, state: SqlkitState): void {
	pi.registerCommand("sqlkit", {
		description: "Open the SQLKit source manager; use on/off/toggle/status to control agent tools",
		handler: async (args, ctx) => {
			const cwd = getContextCwd(ctx);
			const command = args.trim().toLowerCase();

			if (command === "on" || command === "enable") {
				const enabled = await setSqlkitToolsEnabled(pi, state, true, cwd);
				ctx.ui.setStatus("sqlkit", statusText(state, cwd));
				if (enabled && projectHasSources(cwd)) ctx.ui.notify("SQLKit agent tools enabled.", "info");
				if (enabled && !projectHasSources(cwd)) notifyNoSourcesYet(ctx);
				return;
			}
			if (command === "off" || command === "disable") {
				await setSqlkitToolsEnabled(pi, state, false, cwd);
				ctx.ui.setStatus("sqlkit", statusText(state, cwd));
				ctx.ui.notify("SQLKit agent tools disabled.", "info");
				return;
			}
			if (command === "toggle") {
				const targetEnabled = !state.sqlkitToolsEnabled;
				const enabled = await setSqlkitToolsEnabled(pi, state, targetEnabled, cwd);
				ctx.ui.setStatus("sqlkit", statusText(state, cwd));
				if (targetEnabled && enabled && !projectHasSources(cwd)) notifyNoSourcesYet(ctx);
				else ctx.ui.notify(
					state.sqlkitToolsEnabled
						? "SQLKit agent tools enabled."
						: "SQLKit agent tools disabled.",
					"info",
				);
				return;
			}
			if (command === "status") {
				await syncSqlTools(pi, state, cwd);
				ctx.ui.setStatus("sqlkit", statusText(state, cwd));
				ctx.ui.notify(
					state.sqlkitToolsEnabled
						? "SQLKit agent tools are enabled."
						: "SQLKit agent tools are disabled.",
					"info",
				);
				return;
			}

			// 默认：打开 TUI
			const { openSqlConfig } = await import("../config/tui.js");
			state.sqlRuntimeLoaded = true;
			await openSqlConfig({
				...ctx,
				get sqlkitToolsEnabled() {
					return state.sqlkitToolsEnabled;
				},
				toggleSqlkitTools: async () => {
					const targetEnabled = !state.sqlkitToolsEnabled;
					const enabled = await setSqlkitToolsEnabled(pi, state, targetEnabled, cwd);
					ctx.ui.setStatus("sqlkit", statusText(state, cwd));
					if (targetEnabled && enabled && !projectHasSources(cwd)) notifyNoSourcesYet(ctx);
					else ctx.ui.notify(
						state.sqlkitToolsEnabled
							? "SQLKit agent tools enabled."
							: "SQLKit agent tools disabled.",
						"info",
					);
				},
			});
			await syncSqlTools(pi, state, cwd);
			ctx.ui.setStatus("sqlkit", statusText(state, cwd));
		},
	});
}
