import { promises as fs } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

export const SETTINGS_KEY = "codex-fast-mode";

export type FastModeConfig = {
  enabled: boolean;
  blacklist: string[];
};

export type FastModePatch = {
  enabled?: boolean;
  blacklist?: string[];
};

export type ConfigScope = "global" | "project";

export type ConfigPathOptions = {
  cwd: string;
  agentDir?: string;
};

export type LoadedFastModeConfig = {
  config: FastModeConfig;
  scope: ConfigScope;
  globalPath: string;
  projectPath: string;
};

export const DEFAULT_CONFIG: FastModeConfig = {
  enabled: true,
  blacklist: [],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneConfig(config: FastModeConfig): FastModeConfig {
  return {
    enabled: config.enabled,
    blacklist: [...config.blacklist],
  };
}

export function normalizeBlacklist(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const result: string[] = [];
  const seen = new Set<string>();

  for (const item of value) {
    if (typeof item !== "string") continue;
    const model = item.trim();
    if (!model || seen.has(model)) continue;
    seen.add(model);
    result.push(model);
  }

  return result;
}

export function normalizePatch(value: unknown): FastModePatch {
  if (!isRecord(value)) return {};

  const patch: FastModePatch = {};
  if (typeof value.enabled === "boolean") patch.enabled = value.enabled;

  const blacklist = normalizeBlacklist(value.blacklist);
  if (blacklist !== undefined) patch.blacklist = blacklist;

  return patch;
}

export function normalizeConfig(value: unknown): FastModeConfig {
  const patch = normalizePatch(value);
  return {
    enabled: patch.enabled ?? DEFAULT_CONFIG.enabled,
    blacklist: patch.blacklist ?? [...DEFAULT_CONFIG.blacklist],
  };
}

export function mergeConfig(
  globalPatch: FastModePatch,
  projectPatch: FastModePatch,
): FastModeConfig {
  return {
    enabled: projectPatch.enabled ?? globalPatch.enabled ?? DEFAULT_CONFIG.enabled,
    blacklist: projectPatch.blacklist ?? globalPatch.blacklist ?? [...DEFAULT_CONFIG.blacklist],
  };
}

export function getGlobalSettingsPath(agentDir: string = getAgentDir()): string {
  return join(agentDir, "settings.json");
}

export function getProjectSettingsPath(cwd: string): string {
  return join(resolve(cwd), CONFIG_DIR_NAME, "settings.json");
}

async function readSettingsFile(filePath: string): Promise<Record<string, unknown>> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return {};
    throw error;
  }
}

async function writeSettingsFile(
  filePath: string,
  settings: Record<string, unknown>,
): Promise<void> {
  await fs.mkdir(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;

  try {
    await fs.writeFile(tempPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

function sectionPatch(settings: Record<string, unknown>): FastModePatch {
  return normalizePatch(settings[SETTINGS_KEY]);
}

function hasSection(settings: Record<string, unknown>): boolean {
  return isRecord(settings[SETTINGS_KEY]);
}

export async function loadFastModeConfig(
  options: ConfigPathOptions & { includeProject?: boolean },
): Promise<LoadedFastModeConfig> {
  const globalPath = getGlobalSettingsPath(options.agentDir);
  const projectPath = getProjectSettingsPath(options.cwd);
  const globalSettings = await readSettingsFile(globalPath);
  const projectSettings = options.includeProject === false ? {} : await readSettingsFile(projectPath);
  const globalPatch = sectionPatch(globalSettings);
  const projectPatch = sectionPatch(projectSettings);

  return {
    config: mergeConfig(globalPatch, projectPatch),
    scope: hasSection(projectSettings) ? "project" : "global",
    globalPath,
    projectPath,
  };
}

export async function saveFastModePatch(
  options: ConfigPathOptions & { scope: ConfigScope },
  patch: FastModePatch,
): Promise<void> {
  const filePath = options.scope === "project"
    ? getProjectSettingsPath(options.cwd)
    : getGlobalSettingsPath(options.agentDir);
  const settings = await readSettingsFile(filePath);
  const existing = isRecord(settings[SETTINGS_KEY]) ? settings[SETTINGS_KEY] : {};
  const normalized = normalizePatch(patch);
  const nextSection: Record<string, unknown> = { ...existing };

  if (normalized.enabled !== undefined) nextSection.enabled = normalized.enabled;
  if (normalized.blacklist !== undefined) nextSection.blacklist = normalized.blacklist;

  settings[SETTINGS_KEY] = nextSection;
  await writeSettingsFile(filePath, settings);
}

export function cloneFastModeConfig(config: FastModeConfig): FastModeConfig {
  return cloneConfig(config);
}
