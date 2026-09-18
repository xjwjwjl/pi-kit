import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	BASH_TAIL_PREVIEW_VALUES,
	type BashDisplayOptions,
	type BashTailPreview,
	DEFAULT_BASH_DISPLAY_OPTIONS,
	type EditDisplayOptions,
	DEFAULT_EDIT_DISPLAY_OPTIONS,
	DEFAULT_TOOL_RENDER_SHELL,
	type EffectiveCompactToolUiOptions,
	normalizeInlineDiffMaxLines,
	type ToolRenderShell,
} from "./options.js";

/** Which settings file a value lives in. */
export type CompactToolUiScope = "global" | "project";

export type CompactToolUiSettings = {
	bash?: BashDisplayOptions;
	edit?: EditDisplayOptions;
	renderShell?: ToolRenderShell;
};

/** Both layers kept apart so the settings UI can edit and clear each one independently. */
export type CompactToolUiLayers = {
	global: CompactToolUiSettings;
	/** Empty when the project folder is not trusted. */
	project: CompactToolUiSettings;
};

type RootSettings = {
	compactToolUi?: CompactToolUiSettings;
	[key: string]: unknown;
};

const SETTINGS_KEY = "compactToolUi";

/** Bumped per write so concurrent writers never share a temp file name. */
let tmpSeq = 0;

/** Keys this extension owns; anything else in the block is left untouched. */
const OWNED_BASH_KEYS = ["tailPreview", "previewLines"] as const;
const OWNED_EDIT_KEYS = ["inlineDiffMaxLines"] as const;
/** Keys from 0.1.0 and earlier. Ignored on read, cleaned up on the next write. */
const LEGACY_BASH_KEYS = [
	"runningTailPreview",
	"successfulTailPreview",
	"failedTailPreview",
	"successfulOutputSummary",
	"settledTailPreview",
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

function isBashTailPreview(value: unknown): value is BashTailPreview {
	return typeof value === "string" && (BASH_TAIL_PREVIEW_VALUES as readonly string[]).includes(value);
}

function normalizeBashDisplayOptions(value: unknown): BashDisplayOptions | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	const options: BashDisplayOptions = {};
	if (isBashTailPreview(record.tailPreview)) options.tailPreview = record.tailPreview;
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
		options.inlineDiffMaxLines = normalizeInlineDiffMaxLines(record.inlineDiffMaxLines);
	}
	return hasKeys(options) ? options : undefined;
}

function normalizeRenderShell(value: unknown): ToolRenderShell | undefined {
	return value === "default" || value === "self" ? value : undefined;
}

function normalizeCompactToolUiSettings(value: unknown): CompactToolUiSettings {
	if (!isRecord(value)) return {};
	const settings: CompactToolUiSettings = {};
	const bash = normalizeBashDisplayOptions(value.bash);
	if (bash) settings.bash = bash;
	const edit = normalizeEditDisplayOptions(value.edit);
	if (edit) settings.edit = edit;
	const renderShell = normalizeRenderShell(value.renderShell);
	if (renderShell) settings.renderShell = renderShell;
	return settings;
}

function definedBashDisplayOptions(options: BashDisplayOptions | undefined): BashDisplayOptions {
	const defined: BashDisplayOptions = {};
	if (options?.tailPreview !== undefined) defined.tailPreview = options.tailPreview;
	if (options?.previewLines !== undefined) defined.previewLines = options.previewLines;
	return defined;
}

function definedEditDisplayOptions(options: EditDisplayOptions | undefined): EditDisplayOptions {
	const defined: EditDisplayOptions = {};
	if (options?.inlineDiffMaxLines !== undefined) defined.inlineDiffMaxLines = options.inlineDiffMaxLines;
	return defined;
}

/** Project values win per field; absent fields fall back to the global layer. */
export function layerCompactToolUiSettings(layers: CompactToolUiLayers): CompactToolUiSettings {
	const merged: CompactToolUiSettings = {};
	const bash = { ...(layers.global.bash ?? {}), ...(layers.project.bash ?? {}) };
	if (hasKeys(bash)) merged.bash = bash;
	const edit = { ...(layers.global.edit ?? {}), ...(layers.project.edit ?? {}) };
	if (hasKeys(edit)) merged.edit = edit;
	const renderShell = layers.project.renderShell ?? layers.global.renderShell;
	if (renderShell) merged.renderShell = renderShell;
	return merged;
}

/** Merge layered settings with built-in defaults; renderers consume this shape directly. */
export function effectiveCompactToolUiSettings(settings: CompactToolUiSettings): EffectiveCompactToolUiOptions {
	return {
		bash: { ...DEFAULT_BASH_DISPLAY_OPTIONS, ...(settings.bash ?? {}) },
		edit: { ...DEFAULT_EDIT_DISPLAY_OPTIONS, ...(settings.edit ?? {}) },
		renderShell: settings.renderShell ?? DEFAULT_TOOL_RENDER_SHELL,
	};
}

/**
 * Rebuild one settings block from `settings`. Owned keys are replaced rather than merged so a
 * cleared (undefined) value really disappears and the layer falls back to the one below, while
 * keys owned by pi or by other extensions survive untouched.
 */
function replaceOwnedKeys(existing: unknown, settings: CompactToolUiSettings): CompactToolUiSettings & Record<string, unknown> {
	const block: CompactToolUiSettings & Record<string, unknown> = isRecord(existing) ? { ...existing } : {};
	const bash: Record<string, unknown> = isRecord(block.bash) ? { ...block.bash } : {};
	const edit: Record<string, unknown> = isRecord(block.edit) ? { ...block.edit } : {};

	for (const key of OWNED_BASH_KEYS) delete bash[key];
	for (const key of LEGACY_BASH_KEYS) delete bash[key];
	for (const key of OWNED_EDIT_KEYS) delete edit[key];
	delete block.renderShell;

	Object.assign(bash, definedBashDisplayOptions(settings.bash));
	Object.assign(edit, definedEditDisplayOptions(settings.edit));
	if (hasKeys(bash)) block.bash = bash;
	else delete block.bash;
	if (hasKeys(edit)) block.edit = edit;
	else delete block.edit;
	if (settings.renderShell) block.renderShell = settings.renderShell;

	return block;
}

async function readSettingsFile(filePath: string): Promise<RootSettings> {
	try {
		const raw = await readFile(filePath, "utf8");
		const parsed = JSON.parse(raw) as RootSettings;
		return isRecord(parsed) ? parsed : {};
	} catch (error: unknown) {
		if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return {};
		throw error;
	}
}

/**
 * Windows can fail the atomic replace with EPERM/EACCES while a scanner or indexer briefly holds
 * the target file, so retry a few times before giving up.
 */
async function renameWithRetry(from: string, to: string, attempts = 4) {
	for (let attempt = 1; ; attempt++) {
		try {
			await rename(from, to);
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException | undefined)?.code;
			if (attempt >= attempts || (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY")) throw error;
			await new Promise((resolve) => setTimeout(resolve, 20 * attempt));
		}
	}
}

async function writeSettingsFile(filePath: string, settings: RootSettings) {
	await mkdir(path.dirname(filePath), { recursive: true });
	const payload = `${JSON.stringify(settings, null, 2)}\n`;
	// A monotonic suffix keeps two writers in the same millisecond from sharing a temp path.
	const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${tmpSeq++}.tmp`;
	await writeFile(tmpPath, payload, "utf8");
	try {
		await renameWithRetry(tmpPath, filePath);
	} catch {
		// Windows can hold a scanner lock on the freshly written temp file. Saving the setting
		// matters more than keeping the write atomic, so fall back to writing in place.
		await writeFile(filePath, payload, "utf8");
		await rm(tmpPath, { force: true }).catch(() => {});
	}
}

/** Read the raw (non-defaulted) compactToolUi block of a single layer. */
export async function loadCompactToolUiSettings(scope: CompactToolUiScope, cwd: string): Promise<CompactToolUiSettings> {
	const root = await readSettingsFile(settingsPathForScope(scope, cwd));
	return normalizeCompactToolUiSettings(root[SETTINGS_KEY]);
}

/**
 * Load both layers. The project layer is only read when the folder is trusted, matching pi's
 * project-trust model: an untrusted clone must not be able to change the UI through `.pi`.
 */
export async function loadCompactToolUiLayers(cwd: string, projectTrusted: boolean): Promise<CompactToolUiLayers> {
	const global = await loadCompactToolUiSettings("global", cwd);
	const project = projectTrusted ? await loadCompactToolUiSettings("project", cwd) : {};
	return { global, project };
}

/** Resolve the effective options for a session. */
export async function resolveCompactToolUiOptions(cwd: string, projectTrusted: boolean): Promise<EffectiveCompactToolUiOptions> {
	return effectiveCompactToolUiSettings(layerCompactToolUiSettings(await loadCompactToolUiLayers(cwd, projectTrusted)));
}

/** True when the project contains compact-tool-ui settings that are being ignored. */
export async function hasIgnoredProjectSettings(cwd: string): Promise<boolean> {
	try {
		return hasKeys(await loadCompactToolUiSettings("project", cwd));
	} catch {
		return false;
	}
}

export async function saveCompactToolUiSettings(scope: CompactToolUiScope, cwd: string, settings: CompactToolUiSettings): Promise<void> {
	const filePath = settingsPathForScope(scope, cwd);
	const root = await readSettingsFile(filePath);
	const block = replaceOwnedKeys(root[SETTINGS_KEY], settings);
	if (hasKeys(block)) root[SETTINGS_KEY] = block;
	else delete root[SETTINGS_KEY];
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
