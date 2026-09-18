import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CompactToolUiOptionsRef } from "./settings/options.js";
import { effectiveCompactToolUiSettings, hasIgnoredProjectSettings, loadShellPath, resolveCompactToolUiOptions } from "./settings/compact-tool-ui.js";

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
	] = await Promise.all([
		import("./renderers/bash.js"),
		import("./renderers/write.js"),
		import("./renderers/read.js"),
		import("./renderers/edit.js"),
	]);

	let shellPath: string | undefined;
	try {
		shellPath = await loadShellPath();
	} catch {
		shellPath = undefined;
	}

	// Renderers read through the ref so the settings command can hot-apply a new options object.
	registerCompactBash(pi, cwd, () => optionsRef.current.bash, () => optionsRef.current.renderShell, shellPath);
	registerCompactWrite(pi, cwd, () => optionsRef.current.renderShell);
	registerCompactRead(pi, cwd, () => optionsRef.current.renderShell);
	registerCompactEdit(pi, cwd, () => optionsRef.current.edit, () => optionsRef.current.renderShell);
}

/**
 * Project-level overrides can only be resolved once pi knows whether the folder is trusted, which
 * happens after extension load. Tool registration has to stay at load time, but the options the
 * renderers read can be refreshed on session_start.
 */
async function applySessionOptions(optionsRef: CompactToolUiOptionsRef, fallbackCwd: string, ctx: ExtensionContext) {
	const cwd = ctx.cwd || fallbackCwd;
	const projectTrusted = ctx.isProjectTrusted();
	optionsRef.current = await resolveCompactToolUiOptions(cwd, projectTrusted);
	if (!projectTrusted && ctx.hasUI && (await hasIgnoredProjectSettings(cwd))) {
		ctx.ui.notify("Ignoring project compact-tool-ui settings: this folder is not trusted", "info");
	}
}

export default async function compactToolUiExtension(pi: ExtensionAPI) {
	const cwd = process.cwd();
	const optionsRef: CompactToolUiOptionsRef = { current: effectiveCompactToolUiSettings({}) };

	try {
		optionsRef.current = await resolveCompactToolUiOptions(cwd, false);
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
		// In the installed Pi runtime, a same-name built-in override registered from
		// session_start is lost after /reload. Register during extension load instead.
		await registerCompactRenderers(pi, cwd, optionsRef);
	} catch (error) {
		console.warn("[compact-tool-ui] Failed to load compact renderers:", error);
	}
}
