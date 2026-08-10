import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	type BashDisplayOptions,
	DEFAULT_BASH_DISPLAY_OPTIONS,
	type EditDisplayOptions,
	DEFAULT_EDIT_DISPLAY_OPTIONS,
	DEFAULT_TOOL_RENDER_SHELL,
	type ToolRenderShell,
} from "./options.js";

export type CompactToolUiSettings = {
	bash?: BashDisplayOptions;
	edit?: EditDisplayOptions;
	renderShell?: ToolRenderShell;
};

type RootSettings = {
	compactToolUi?: CompactToolUiSettings;
	[key: string]: unknown;
};

export type LoadedCompactToolUiSettings = {
	settings: CompactToolUiSettings;
	effective: CompactToolUiSettings;
};

const SETTINGS_KEY = "compactToolUi";

function globalSettingsPath() {
	return path.join(getAgentDir(), "settings.json");
}

function hasKeys(value: object): boolean {
	return Object.keys(value).length > 0;
}

function normalizeBashDisplayOptions(value: unknown): BashDisplayOptions | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	const options: BashDisplayOptions = {};
	if (typeof record.successfulOutputSummary === "boolean") options.successfulOutputSummary = record.successfulOutputSummary;
	if (typeof record.runningTailPreview === "boolean") options.runningTailPreview = record.runningTailPreview;
	if (typeof record.successfulTailPreview === "boolean") options.successfulTailPreview = record.successfulTailPreview;
	else if (typeof record.settledTailPreview === "boolean") options.successfulTailPreview = record.settledTailPreview;
	if (typeof record.previewLines === "number" && Number.isFinite(record.previewLines)) {
		options.previewLines = Math.max(1, Math.floor(record.previewLines));
	}
	return hasKeys(options) ? options : undefined;
}

function normalizeEditDisplayOptions(value: unknown): EditDisplayOptions | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	const options: EditDisplayOptions = {};
	if (typeof record.inlineDiffMaxLines === "number" && Number.isFinite(record.inlineDiffMaxLines)) {
		options.inlineDiffMaxLines = Math.max(0, Math.floor(record.inlineDiffMaxLines));
	}
	return hasKeys(options) ? options : undefined;
}

function normalizeRenderShell(value: unknown): ToolRenderShell | undefined {
	return value === "default" || value === "self" ? value : undefined;
}

function normalizeCompactToolUiSettings(value: unknown): CompactToolUiSettings {
	if (!value || typeof value !== "object") return {};
	const record = value as Record<string, unknown>;
	const settings: CompactToolUiSettings = {};
	const bash = normalizeBashDisplayOptions(record.bash);
	if (bash) settings.bash = bash;
	const edit = normalizeEditDisplayOptions(record.edit);
	if (edit) settings.edit = edit;
	const renderShell = normalizeRenderShell(record.renderShell);
	if (renderShell) settings.renderShell = renderShell;
	return settings;
}

function definedBashDisplayOptions(options: BashDisplayOptions | undefined): BashDisplayOptions | undefined {
	if (!options) return undefined;
	const defined: BashDisplayOptions = {};
	if (options.successfulOutputSummary !== undefined) defined.successfulOutputSummary = options.successfulOutputSummary;
	if (options.runningTailPreview !== undefined) defined.runningTailPreview = options.runningTailPreview;
	if (options.successfulTailPreview !== undefined) defined.successfulTailPreview = options.successfulTailPreview;
	if (options.previewLines !== undefined) defined.previewLines = options.previewLines;
	return hasKeys(defined) ? defined : undefined;
}

function definedEditDisplayOptions(options: EditDisplayOptions | undefined): EditDisplayOptions | undefined {
	if (!options) return undefined;
	const defined: EditDisplayOptions = {};
	if (options.inlineDiffMaxLines !== undefined) defined.inlineDiffMaxLines = options.inlineDiffMaxLines;
	return hasKeys(defined) ? defined : undefined;
}

function effectiveBashDisplayOptions(settings: CompactToolUiSettings): Required<BashDisplayOptions> {
	return { ...DEFAULT_BASH_DISPLAY_OPTIONS, ...(settings.bash ?? {}) };
}

function effectiveEditDisplayOptions(settings: CompactToolUiSettings): Required<EditDisplayOptions> {
	return { ...DEFAULT_EDIT_DISPLAY_OPTIONS, ...(settings.edit ?? {}) };
}

export type EffectiveCompactToolUiSettings = Required<Pick<CompactToolUiSettings, "renderShell">> & {
	bash: Required<BashDisplayOptions>;
	edit: Required<EditDisplayOptions>;
};

export function effectiveCompactToolUiSettings(settings: CompactToolUiSettings): EffectiveCompactToolUiSettings {
	return {
		bash: effectiveBashDisplayOptions(settings),
		edit: effectiveEditDisplayOptions(settings),
		renderShell: settings.renderShell ?? DEFAULT_TOOL_RENDER_SHELL,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function mergeRawCompactToolUiSettings(existing: unknown, settings: CompactToolUiSettings): CompactToolUiSettings & Record<string, unknown> {
	const next: CompactToolUiSettings & Record<string, unknown> = isRecord(existing) ? { ...existing } : {};
	const bash = definedBashDisplayOptions(settings.bash);
	if (bash) {
		const existingBash = isRecord(next.bash) ? next.bash : {};
		next.bash = { ...existingBash, ...bash };
	}
	const edit = definedEditDisplayOptions(settings.edit);
	if (edit) {
		const existingEdit = isRecord(next.edit) ? next.edit : {};
		next.edit = { ...existingEdit, ...edit };
	}
	if (settings.renderShell) next.renderShell = settings.renderShell;
	return next;
}

async function readSettingsFile(filePath: string): Promise<RootSettings> {
	try {
		const raw = await readFile(filePath, "utf8");
		const parsed = JSON.parse(raw) as RootSettings;
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch (error: unknown) {
		if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return {};
		throw error;
	}
}

async function writeSettingsFile(filePath: string, settings: RootSettings) {
	await mkdir(path.dirname(filePath), { recursive: true });
	const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(tmpPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
	await rename(tmpPath, filePath);
}

export async function loadCompactToolUiSettings(): Promise<LoadedCompactToolUiSettings> {
	const root = await readSettingsFile(globalSettingsPath());
	const settings = normalizeCompactToolUiSettings(root[SETTINGS_KEY]);
	return {
		settings,
		effective: settings,
	};
}

export async function saveCompactToolUiSettings(settings: CompactToolUiSettings): Promise<void> {
	const filePath = globalSettingsPath();
	const root = await readSettingsFile(filePath);
	root[SETTINGS_KEY] = mergeRawCompactToolUiSettings(root[SETTINGS_KEY], settings);
	await writeSettingsFile(filePath, root);
}

function expandHome(p: string): string {
	if (p === "~") return homedir();
	if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(homedir(), p.slice(2));
	return p;
}

/**
 * Read the configured bash shell path from pi's global settings.json.
 * The compact-tool-ui bash renderer overrides the built-in bash tool, so it
 * must re-apply shellPath (and tilde-expand it) or execution falls back to
 * PATH detection and fails on machines where bash is not discoverable.
 */
export async function loadShellPath(): Promise<string | undefined> {
	const root = await readSettingsFile(globalSettingsPath());
	const value = root.shellPath;
	return typeof value === "string" && value.trim().length > 0 ? expandHome(value.trim()) : undefined;
}
