import path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	type EditDisplayOptions,
	DEFAULT_EDIT_DISPLAY_OPTIONS,
	DEFAULT_TOOL_RENDER_SHELL,
	type EffectiveCompactToolUiOptions,
	normalizeInlineDiffMaxLines,
	type ToolRenderShell,
} from "./options.js";
import { readSettingsFile, updateSettingsFile } from "./store.js";

export type CompactToolUiScope = "global" | "project";
export type CompactToolUiField = "renderShell" | "inlineDiffMaxLines";

export type CompactToolUiSettings = {
	edit?: EditDisplayOptions;
	renderShell?: ToolRenderShell;
};

/** Only present fields change; null explicitly removes a field to restore inheritance. */
export type CompactToolUiSettingsPatch = {
	renderShell?: ToolRenderShell | null;
	edit?: { inlineDiffMaxLines?: number | null };
};

export type CompactToolUiLoadError = { path: string; message: string };

/** A failed layer resolves as empty but remains explicitly unavailable for editing. */
export type CompactToolUiLayers = {
	global: CompactToolUiSettings;
	/** Empty when the project folder is not trusted. */
	project: CompactToolUiSettings;
	errors?: Partial<Record<CompactToolUiScope, CompactToolUiLoadError>>;
};

const SETTINGS_KEY = "compactToolUi";
const OBSOLETE_BASH_KEYS = [
	"tailPreview", "previewLines", "runningTailPreview", "successfulTailPreview",
	"failedTailPreview", "successfulOutputSummary", "settledTailPreview",
] as const;

export function globalSettingsPath(): string {
	return path.join(getAgentDir(), "settings.json");
}

export function projectSettingsPath(cwd: string): string {
	return path.join(cwd, CONFIG_DIR_NAME, "settings.json");
}

export function settingsPathForScope(scope: CompactToolUiScope, cwd: string): string {
	return scope === "project" ? projectSettingsPath(cwd) : globalSettingsPath();
}

function hasKeys(value: object): boolean {
	return Object.keys(value).length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeCompactToolUiSettings(value: unknown): CompactToolUiSettings {
	if (!isRecord(value)) return {};
	const settings: CompactToolUiSettings = {};
	if (isRecord(value.edit) && typeof value.edit.inlineDiffMaxLines === "number" && Number.isFinite(value.edit.inlineDiffMaxLines)) {
		settings.edit = { inlineDiffMaxLines: normalizeInlineDiffMaxLines(value.edit.inlineDiffMaxLines) };
	}
	if (value.renderShell === "default" || value.renderShell === "self") settings.renderShell = value.renderShell;
	return settings;
}

/** Project values win per field; absent fields fall back to the global layer. */
export function layerCompactToolUiSettings(layers: CompactToolUiLayers): CompactToolUiSettings {
	const merged: CompactToolUiSettings = {};
	const edit = { ...(layers.global.edit ?? {}), ...(layers.project.edit ?? {}) };
	if (hasKeys(edit)) merged.edit = edit;
	const renderShell = layers.project.renderShell ?? layers.global.renderShell;
	if (renderShell) merged.renderShell = renderShell;
	return merged;
}

export function effectiveCompactToolUiSettings(settings: CompactToolUiSettings): EffectiveCompactToolUiOptions {
	return {
		edit: { ...DEFAULT_EDIT_DISPLAY_OPTIONS, ...(settings.edit ?? {}) },
		renderShell: settings.renderShell ?? DEFAULT_TOOL_RENDER_SHELL,
	};
}

/** Patch only edited keys into the current disk block, preserving all other writers' fields. */
function patchOwnedKeys(existing: unknown, patch: CompactToolUiSettingsPatch): Record<string, unknown> {
	const block = isRecord(existing) ? { ...existing } : {};
	if (Object.hasOwn(patch, "renderShell")) {
		if (patch.renderShell === null) delete block.renderShell;
		else if (patch.renderShell === "self" || patch.renderShell === "default") block.renderShell = patch.renderShell;
		else throw new Error("Invalid compactToolUi.renderShell patch");
	}
	if (patch.edit && Object.hasOwn(patch.edit, "inlineDiffMaxLines")) {
		const edit = isRecord(block.edit) ? { ...block.edit } : {};
		const value = patch.edit.inlineDiffMaxLines;
		if (value === null) delete edit.inlineDiffMaxLines;
		else if (typeof value === "number" && Number.isFinite(value)) edit.inlineDiffMaxLines = normalizeInlineDiffMaxLines(value);
		else throw new Error("Invalid compactToolUi.edit.inlineDiffMaxLines patch");
		if (hasKeys(edit)) block.edit = edit;
		else delete block.edit;
	}
	// Retire only owned legacy keys, and only during an explicit save to this layer.
	const bash = isRecord(block.bash) ? { ...block.bash } : {};
	for (const key of OBSOLETE_BASH_KEYS) delete bash[key];
	if (hasKeys(bash)) block.bash = bash;
	else delete block.bash;
	return block;
}

export async function loadCompactToolUiSettings(scope: CompactToolUiScope, cwd: string): Promise<CompactToolUiSettings> {
	const root = await readSettingsFile(settingsPathForScope(scope, cwd));
	return normalizeCompactToolUiSettings(root[SETTINGS_KEY]);
}

/** Read each trusted layer independently: an invalid layer must not hide the healthy one. */
export async function loadCompactToolUiLayers(cwd: string, projectTrusted: boolean): Promise<CompactToolUiLayers> {
	const layers: CompactToolUiLayers = { global: {}, project: {} };
	const scopes: CompactToolUiScope[] = projectTrusted ? ["global", "project"] : ["global"];
	for (const scope of scopes) {
		try {
			layers[scope] = await loadCompactToolUiSettings(scope, cwd);
		} catch (error) {
			(layers.errors ??= {})[scope] = {
				path: settingsPathForScope(scope, cwd),
				message: error instanceof Error ? error.message : String(error),
			};
		}
	}
	return layers;
}

export async function resolveCompactToolUiOptions(cwd: string, projectTrusted: boolean): Promise<EffectiveCompactToolUiOptions> {
	return effectiveCompactToolUiSettings(layerCompactToolUiSettings(await loadCompactToolUiLayers(cwd, projectTrusted)));
}

export async function hasIgnoredProjectSettings(cwd: string): Promise<boolean> {
	try {
		return hasKeys(await loadCompactToolUiSettings("project", cwd));
	} catch {
		return false;
	}
}

/** Returns the committed layer, including untouched fields refreshed from the latest disk state. */
export async function saveCompactToolUiSettings(
	scope: CompactToolUiScope,
	cwd: string,
	patch: CompactToolUiSettingsPatch,
): Promise<CompactToolUiSettings> {
	// Freeze this operation before any async lock/directory wait, including nested edit values.
	const snapshot = structuredClone(patch);
	return updateSettingsFile(settingsPathForScope(scope, cwd), (root) => {
		const block = patchOwnedKeys(root[SETTINGS_KEY], snapshot);
		if (hasKeys(block)) root[SETTINGS_KEY] = block;
		else delete root[SETTINGS_KEY];
		return normalizeCompactToolUiSettings(block);
	});
}
