import { readFileSync } from "node:fs";
import { join } from "node:path";

export const CONFIG_FILE_NAME = "gogate-failover.json";

export interface FailoverConfig {
  enabled: boolean;
  provider: string;
  /** Optional full model keys or model ids. Empty means use Pi's scoped models. */
  models?: string[];
  /** How long a failed model should be avoided in the current Pi runtime. */
  cooldownMs: number;
  /** Maximum model switches per high-level user prompt. */
  maxSwitchesPerRun?: number;
}

export interface LoadedConfig {
  config: FailoverConfig;
  path: string;
  error?: string;
}

export const DEFAULT_CONFIG: FailoverConfig = {
  enabled: true,
  provider: "gogate",
  cooldownMs: 30 * 60 * 1000,
};

function nonNegativeOrDefault(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function optionalNonNegativeInteger(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return undefined;
  return value;
}

function normalizeConfig(value: unknown): FailoverConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...DEFAULT_CONFIG };

  const raw = value as Record<string, unknown>;
  const models = Array.isArray(raw.models)
    ? raw.models.filter((model): model is string => typeof model === "string" && model.trim().length > 0)
    : undefined;

  return {
    enabled: raw.enabled !== false,
    provider: typeof raw.provider === "string" && raw.provider.trim() ? raw.provider.trim() : DEFAULT_CONFIG.provider,
    models: models?.length ? [...new Set(models.map((model) => model.trim()))] : undefined,
    cooldownMs: nonNegativeOrDefault(raw.cooldownMs, DEFAULT_CONFIG.cooldownMs),
    maxSwitchesPerRun: optionalNonNegativeInteger(raw.maxSwitchesPerRun),
  };
}

function defaultAgentDir(): string {
  return process.env.PI_AGENT_DIR
    ?? process.env.PI_CODING_AGENT_DIR
    ?? join(process.env.HOME ?? process.env.USERPROFILE ?? ".", ".pi", "agent");
}

export function loadConfig(configPath = join(defaultAgentDir(), CONFIG_FILE_NAME)): LoadedConfig {
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
    return { config: normalizeConfig(parsed), path: configPath };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return { config: { ...DEFAULT_CONFIG }, path: configPath };
    }

    return {
      config: { ...DEFAULT_CONFIG },
      path: configPath,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
