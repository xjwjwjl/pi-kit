import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createReadToolDefinition, keyText } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

export default function collapseReadExtension(pi: ExtensionAPI) {
	const cwd = process.cwd();
	const originalRead = createReadToolDefinition(cwd);

	pi.registerTool({
		name: "read",
		label: originalRead.label,
		description: originalRead.description,
		parameters: originalRead.parameters,

		execute(toolCallId, params, signal, onUpdate, ctx) {
			return originalRead.execute(toolCallId, params, signal, onUpdate, ctx);
		},

		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const path = typeof args.path === "string" && args.path.length > 0 ? args.path : "...";
			const startLine = args.offset ?? 1;
			const lineRange =
				args.offset !== undefined || args.limit !== undefined
					? theme.fg("warning", `:${startLine}${args.limit !== undefined ? `-${startLine + args.limit - 1}` : ""}`)
					: "";
			const hint = theme.fg("dim", ` (${keyText("app.tools.expand")} to ${context.expanded ? "collapse" : "expand"})`);

			text.setText(`${theme.fg("toolTitle", theme.bold("read"))} ${theme.fg("accent", path)}${lineRange}${hint}`);
			return text;
		},

		renderResult(result, options, theme, context) {
			if (options.isPartial || context.isError || options.expanded) {
				return originalRead.renderResult?.(result, options, theme, context) ?? new Text("", 0, 0);
			}

			return new Text("", 0, 0);
		},
	});
}
