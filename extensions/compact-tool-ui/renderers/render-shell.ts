import type { ExtensionAPI, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { CompactToolShell, unwrapToolShellComponent } from "../components/compact-tool-shell.js";
import { DEFAULT_TOOL_RENDER_SHELL, type ToolRenderShell } from "../settings/options.js";
export { DEFAULT_TOOL_RENDER_SHELL, type ToolRenderShell } from "../settings/options.js";

export type ToolRenderShellSource = ToolRenderShell | (() => ToolRenderShell | undefined) | undefined;

export function resolveToolRenderShell(source: ToolRenderShellSource): ToolRenderShell {
	const value = typeof source === "function" ? source() : source;
	return value === "default" ? "default" : DEFAULT_TOOL_RENDER_SHELL;
}

/** Presentation-only registration: neither tool definitions nor execution/activation are replaced. */
export function registerCompactToolRenderer(
	pi: ExtensionAPI,
	toolName: string,
	create: (next: () => ToolRenderers | undefined) => ToolRenderers,
	source?: ToolRenderShellSource,
) {
	pi.registerToolRenderer((name, next) => {
		if (name !== toolName) return next();
		const renderers = create(next);
		const shells = new WeakMap<object, CompactToolShell>();
		const shellFor = (state: object) => {
			let shell = shells.get(state);
			if (!shell) {
				shell = new CompactToolShell(() => resolveToolRenderShell(source));
				shells.set(state, shell);
			}
			return shell;
		};
		return {
			// Pi mounts its shell once. Mutable native renderShell getters break existing rows.
			renderShell: "self",
			renderCall(args, theme, context) {
				const shell = shellFor(context.state);
				const lastComponent = unwrapToolShellComponent(context.lastComponent) ?? shell.getComponent("call");
				const component = renderers.renderCall!(args, theme, { ...context, lastComponent });
				shell.setCall(component, theme, context);
				return shell.callPart;
			},
			renderResult(result, options, theme, context) {
				const shell = shellFor(context.state);
				const lastComponent = unwrapToolShellComponent(context.lastComponent) ?? shell.getComponent("result");
				const component = renderers.renderResult!(result, options, theme, { ...context, lastComponent });
				shell.setResult(component, theme, { ...context, isPartial: options.isPartial });
				return shell.resultPart;
			},
		} satisfies ToolRenderers;
	});
}
