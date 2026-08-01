import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_BASH_DISPLAY_OPTIONS,
	DEFAULT_EDIT_DISPLAY_OPTIONS,
	DEFAULT_TOOL_RENDER_SHELL,
	type MutableCompactToolUiOptions,
} from "./settings/options.js";
import { loadCompactToolUiSettings } from "./settings/compact-tool-ui.js";

function registerLazyCompactToolUiSettingsCommand(pi: ExtensionAPI, displayOptions: MutableCompactToolUiOptions) {
	pi.registerCommand("compact-tool-ui-settings", {
		description: "Configure compact-tool-ui settings",
		handler: async (_args, ctx) => {
			const { openCompactToolUiSettings } = await import("./commands/compact-tool-ui-settings.js");
			await openCompactToolUiSettings(displayOptions, ctx);
		},
	});
}

async function registerCompactRenderers(pi: ExtensionAPI, cwd: string, displayOptions: MutableCompactToolUiOptions) {
	const [
		{ registerCompactBash },
		{ registerCompactWrite },
		{ registerCompactRead },
		{ registerCompactEdit },
	] = await Promise.all([
		import("./renderers/bash.js"),
		import("./renderers/write.js"),
		import("./renderers/read.js"),
		import("./renderers/edit.js"),
	]);

	registerCompactBash(pi, cwd, () => displayOptions.bash, () => displayOptions.renderShell);
	registerCompactWrite(pi, cwd, () => displayOptions.renderShell);
	registerCompactRead(pi, cwd, () => displayOptions.renderShell);
	registerCompactEdit(pi, cwd, () => displayOptions.edit, () => displayOptions.renderShell);
}

export default async function compactToolUiExtension(pi: ExtensionAPI) {
	const cwd = process.cwd();
	const displayOptions: MutableCompactToolUiOptions = {
		bash: { ...DEFAULT_BASH_DISPLAY_OPTIONS },
		edit: { ...DEFAULT_EDIT_DISPLAY_OPTIONS },
		renderShell: DEFAULT_TOOL_RENDER_SHELL,
	};

	try {
		const loaded = await loadCompactToolUiSettings();
		Object.assign(displayOptions.bash, loaded.effective.bash ?? {});
		Object.assign(displayOptions.edit, loaded.effective.edit ?? {});
		displayOptions.renderShell = loaded.effective.renderShell ?? DEFAULT_TOOL_RENDER_SHELL;
	} catch (error) {
		console.warn("[compact-tool-ui] Failed to load settings:", error);
	}

	registerLazyCompactToolUiSettingsCommand(pi, displayOptions);
	try {
		// In the installed Pi runtime, a same-name built-in override registered from
		// session_start is lost after /reload. Register during extension load instead.
		await registerCompactRenderers(pi, cwd, displayOptions);
	} catch (error) {
		console.warn("[compact-tool-ui] Failed to load compact renderers:", error);
	}
}
