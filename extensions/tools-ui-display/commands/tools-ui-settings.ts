import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui";
import type { BashDisplayOptions, EditDisplayOptions, MutableToolsUiDisplayOptions, ToolRenderShell } from "../settings/options.js";
import { effectiveToolsUiDisplaySettings, loadToolsUiDisplaySettings, saveToolsUiDisplaySettings } from "../settings/tools-ui-display.js";

const PREVIEW_LINE_VALUES = [1, 2, 3, 5, 8];
const EDIT_INLINE_DIFF_MAX_LINE_VALUES = [0, 16, 32, 64, 128];

function applyToolsUiDisplayOptions(target: MutableToolsUiDisplayOptions, source: MutableToolsUiDisplayOptions) {
	target.bash.successfulOutputSummary = source.bash.successfulOutputSummary;
	target.bash.runningTailPreview = source.bash.runningTailPreview;
	target.bash.successfulTailPreview = source.bash.successfulTailPreview;
	target.bash.previewLines = source.bash.previewLines;
	target.edit.inlineDiffMaxLines = source.edit.inlineDiffMaxLines;
	target.renderShell = source.renderShell;
}

function updateBashDisplayOption(options: BashDisplayOptions, id: string, value: string) {
	if (id === "runningTailPreview") {
		options.runningTailPreview = value === "on";
		return;
	}
	if (id === "successfulOutputSummary") {
		options.successfulOutputSummary = value === "on";
		return;
	}
	if (id === "successfulTailPreview") {
		options.successfulTailPreview = value === "on";
		return;
	}
	if (id === "previewLines") {
		const parsed = Number.parseInt(value, 10);
		if (Number.isFinite(parsed) && parsed > 0) options.previewLines = parsed;
	}
}

function updateEditDisplayOption(options: EditDisplayOptions, id: string, value: string) {
	if (id === "inlineDiffMaxLines") {
		const parsed = Number.parseInt(value, 10);
		if (Number.isFinite(parsed) && parsed >= 0) options.inlineDiffMaxLines = parsed;
	}
}

function settingItems(options: MutableToolsUiDisplayOptions): SettingItem[] {
	return [
		{
			id: "renderShell",
			label: "Tool render shell",
			description: "Use self for borderless compact rows, or default for pi's original boxed shell.",
			currentValue: options.renderShell,
			values: ["self", "default"],
		},
		{
			id: "runningTailPreview",
			label: "Bash running tail preview",
			description: "Show the last few streamed lines for running bash commands in collapsed tool rows.",
			currentValue: options.bash.runningTailPreview ? "on" : "off",
			values: ["on", "off"],
		},
		{
			id: "successfulTailPreview",
			label: "Bash success tail preview",
			description: "Keep showing the bash tail preview after a successful command finishes.",
			currentValue: options.bash.successfulTailPreview ? "on" : "off",
			values: ["on", "off"],
		},
		{
			id: "previewLines",
			label: "Bash preview lines",
			description: "How many trailing lines to show in bash tail previews.",
			currentValue: String(options.bash.previewLines),
			values: PREVIEW_LINE_VALUES.map(String),
		},
		{
			id: "successfulOutputSummary",
			label: "Bash success output summary",
			description: "Show a compact output-line summary on successful bash commands.",
			currentValue: options.bash.successfulOutputSummary ? "on" : "off",
			values: ["on", "off"],
		},
		{
			id: "inlineDiffMaxLines",
			label: "Edit inline diff max lines",
			description: "Show edit diffs inline up to this many lines; 0 means unlimited.",
			currentValue: String(options.edit.inlineDiffMaxLines),
			values: EDIT_INLINE_DIFF_MAX_LINE_VALUES.map(String),
		},
	];
}

function updateDisplayOption(options: MutableToolsUiDisplayOptions, id: string, value: string) {
	if (id === "renderShell") {
		options.renderShell = value === "default" ? "default" : "self";
		return;
	}
	updateEditDisplayOption(options.edit, id, value);
	updateBashDisplayOption(options.bash, id, value);
}

export async function openToolsUiSettings(displayOptions: MutableToolsUiDisplayOptions, ctx: ExtensionCommandContext) {
	if (ctx.mode !== "tui") return;

	const loaded = await loadToolsUiDisplaySettings();
	const currentOptions = effectiveToolsUiDisplaySettings(loaded.effective);
	const rawBashOptions: BashDisplayOptions = { ...(loaded.settings.bash ?? {}) };
	const rawEditOptions: EditDisplayOptions = { ...(loaded.settings.edit ?? {}) };
	const rawRenderShell: { value?: ToolRenderShell } = { value: loaded.settings.renderShell };

	await ctx.ui.custom((tui, theme, _kb, done) => {
		const items = settingItems(currentOptions);
		const container = new Container();
		container.addChild(new Text(theme.fg("accent", theme.bold("Tools UI Settings")), 1, 1));

		const settingsList = new SettingsList(
			items,
			Math.min(items.length + 4, 15),
			getSettingsListTheme(),
			(id, newValue) => {
				updateDisplayOption(currentOptions, id, newValue);
				if (id === "renderShell") rawRenderShell.value = newValue === "default" ? "default" : "self";
				else if (id === "inlineDiffMaxLines") updateEditDisplayOption(rawEditOptions, id, newValue);
				else updateBashDisplayOption(rawBashOptions, id, newValue);
				void (async () => {
					try {
						await saveToolsUiDisplaySettings({ bash: rawBashOptions, edit: rawEditOptions, renderShell: rawRenderShell.value });
						const reloaded = await loadToolsUiDisplaySettings();
						applyToolsUiDisplayOptions(displayOptions, effectiveToolsUiDisplaySettings(reloaded.effective));
						ctx.ui.notify("Saved tools-ui settings", "info");
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						ctx.ui.notify(`Failed to save tools-ui settings: ${message}`, "error");
					}
				})();
			},
			() => done(undefined),
			{ enableSearch: true },
		);
		container.addChild(settingsList);

		return {
			render(width: number) {
				return container.render(width);
			},
			invalidate() {
				container.invalidate();
			},
			handleInput(data: string) {
				settingsList.handleInput?.(data);
				tui.requestRender();
			},
		};
	});
}

export function registerToolsUiSettingsCommand(pi: ExtensionAPI, displayOptions: MutableToolsUiDisplayOptions) {
	pi.registerCommand("tools-ui-settings", {
		description: "Configure tools-ui-display settings",
		handler: async (_args, ctx) => {
			await openToolsUiSettings(displayOptions, ctx);
		},
	});
}
