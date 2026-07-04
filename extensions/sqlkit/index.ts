// ============================================================
// SQLKit Pi Extension
// ============================================================
// 组装点 —— 状态 → 命令 → 钩子
// 实现细节见: src/extension/{state,commands,hooks}.ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createSqlkitState } from "./src/extension/state.js";
import { registerCommands } from "./src/extension/commands.js";
import { registerHooks } from "./src/extension/hooks.js";

export default function sqlkitExtension(pi: ExtensionAPI) {
	const state = createSqlkitState();

	registerCommands(pi, state);
	registerHooks(pi, state);
}
