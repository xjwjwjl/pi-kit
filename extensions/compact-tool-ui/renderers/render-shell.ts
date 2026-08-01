import { DEFAULT_TOOL_RENDER_SHELL, type ToolRenderShell } from "../settings/options.js";
export { DEFAULT_TOOL_RENDER_SHELL, type ToolRenderShell } from "../settings/options.js";

export type ToolRenderShellSource = ToolRenderShell | (() => ToolRenderShell | undefined) | undefined;

export function resolveToolRenderShell(source: ToolRenderShellSource): ToolRenderShell {
	const value = typeof source === "function" ? source() : source;
	return value === "default" ? "default" : DEFAULT_TOOL_RENDER_SHELL;
}
