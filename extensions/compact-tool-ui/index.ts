import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CompactToolUiOptionsRef } from "./settings/options.js";
import {
	type CompactToolUiLayers,
	effectiveCompactToolUiSettings,
	hasIgnoredProjectSettings,
	layerCompactToolUiSettings,
	loadCompactToolUiLayers,
} from "./settings/compact-tool-ui.js";

function registerLazyCompactToolUiSettingsCommand(pi: ExtensionAPI, optionsRef: CompactToolUiOptionsRef) {
	pi.registerCommand("compact-tool-ui-settings", {
		description: "Configure compact-tool-ui settings",
		handler: async (_args, ctx) => {
			const { openCompactToolUiSettings } = await import("./commands/compact-tool-ui-settings.js");
			await openCompactToolUiSettings(optionsRef, ctx);
		},
	});
}

async function registerCompactRenderers(pi: ExtensionAPI, cwd: string, optionsRef: CompactToolUiOptionsRef) {
	const [
		{ registerCompactBash },
		{ registerCompactWrite },
		{ registerCompactRead },
		{ registerCompactEdit },
		{ registerCompactCodemode },
	] = await Promise.all([
		import("./renderers/bash.js"),
		import("./renderers/write.js"),
		import("./renderers/read.js"),
		import("./renderers/edit.js"),
		import("./renderers/codemode.js"),
	]);

	// Renderers read through the ref so the settings command can hot-apply a new options object.
	registerCompactBash(pi, cwd, () => optionsRef.current.renderShell);
	registerCompactWrite(pi, cwd, () => optionsRef.current.renderShell);
	registerCompactRead(pi, cwd, () => optionsRef.current.renderShell);
	registerCompactEdit(pi, cwd, () => optionsRef.current.edit, () => optionsRef.current.renderShell);
	registerCompactCodemode(pi, () => optionsRef.current.renderShell);
}

function reportLoadErrors(layers: CompactToolUiLayers, ctx?: ExtensionContext) {
	for (const scope of ["global", "project"] as const) {
		const error = layers.errors?.[scope];
		if (!error) continue;
		const message = `Failed to load compact-tool-ui ${scope} settings (${error.path}): ${error.message}`;
		if (ctx?.hasUI) ctx.ui.notify(message, "error");
		else console.warn(`[compact-tool-ui] ${message}`);
	}
}

/** Project trust is known after extension load; refresh options without re-registering renderers. */
async function applySessionOptions(optionsRef: CompactToolUiOptionsRef, fallbackCwd: string, ctx: ExtensionContext) {
	const cwd = ctx.cwd || fallbackCwd;
	const projectTrusted = ctx.isProjectTrusted();
	const layers = await loadCompactToolUiLayers(cwd, projectTrusted);
	optionsRef.current = effectiveCompactToolUiSettings(layerCompactToolUiSettings(layers));
	reportLoadErrors(layers, ctx);
	if (!projectTrusted && ctx.hasUI && (await hasIgnoredProjectSettings(cwd))) {
		ctx.ui.notify("Ignoring project compact-tool-ui settings: this folder is not trusted", "info");
	}
}

export default async function compactToolUiExtension(pi: ExtensionAPI) {
	const cwd = process.cwd();
	const optionsRef: CompactToolUiOptionsRef = { current: effectiveCompactToolUiSettings({}) };

	try {
		const layers = await loadCompactToolUiLayers(cwd, false);
		optionsRef.current = effectiveCompactToolUiSettings(layerCompactToolUiSettings(layers));
		reportLoadErrors(layers);
	} catch (error) {
		console.warn("[compact-tool-ui] Failed to load settings:", error);
	}

	registerLazyCompactToolUiSettingsCommand(pi, optionsRef);

	pi.on("session_start", async (_event, ctx) => {
		try {
			await applySessionOptions(optionsRef, cwd, ctx);
		} catch (error) {
			console.warn("[compact-tool-ui] Failed to load project settings:", error);
		}
	});

	try {
		await registerCompactRenderers(pi, cwd, optionsRef);
	} catch (error) {
		console.warn("[compact-tool-ui] Failed to load compact renderers:", error);
	}
}
