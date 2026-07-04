import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_BASH_DISPLAY_OPTIONS,
	DEFAULT_EDIT_DISPLAY_OPTIONS,
	DEFAULT_TOOL_RENDER_SHELL,
	type MutableToolsUiDisplayOptions,
} from "./settings/options.js";
import { loadToolsUiDisplaySettings } from "./settings/tools-ui-display.js";

function registerLazyToolsUiSettingsCommand(pi: ExtensionAPI, displayOptions: MutableToolsUiDisplayOptions) {
	pi.registerCommand("tools-ui-settings", {
		description: "Configure tools-ui-display settings",
		handler: async (_args, ctx) => {
			const { openToolsUiSettings } = await import("./commands/tools-ui-settings.js");
			await openToolsUiSettings(displayOptions, ctx);
		},
	});
}

async function registerCompactRenderers(pi: ExtensionAPI, cwd: string, displayOptions: MutableToolsUiDisplayOptions) {
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

export default async function toolsUiDisplayExtension(pi: ExtensionAPI) {
	const cwd = process.cwd();
	let compactRenderersScheduled = false;
	const displayOptions: MutableToolsUiDisplayOptions = {
		bash: { ...DEFAULT_BASH_DISPLAY_OPTIONS },
		edit: { ...DEFAULT_EDIT_DISPLAY_OPTIONS },
		renderShell: DEFAULT_TOOL_RENDER_SHELL,
	};

	try {
		const loaded = await loadToolsUiDisplaySettings();
		Object.assign(displayOptions.bash, loaded.effective.bash ?? {});
		Object.assign(displayOptions.edit, loaded.effective.edit ?? {});
		displayOptions.renderShell = loaded.effective.renderShell ?? DEFAULT_TOOL_RENDER_SHELL;
	} catch (error) {
		console.warn("[tools-ui-display] Failed to load settings:", error);
	}

	registerLazyToolsUiSettingsCommand(pi, displayOptions);
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui" || compactRenderersScheduled) return;
		compactRenderersScheduled = true;
		try {
			await registerCompactRenderers(pi, cwd, displayOptions);
		} catch (error) {
			compactRenderersScheduled = false;
			console.warn("[tools-ui-display] Failed to load compact renderers:", error);
		}
	});
}
