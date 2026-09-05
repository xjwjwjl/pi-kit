import type { FastModeConfig } from "./config.ts";

export const CODEX_PROVIDER = "openai-codex";

export type ModelRef = {
  provider: string;
  id: string;
};

export function toModelRef(model: unknown): ModelRef | undefined {
  if (!model || typeof model !== "object" || Array.isArray(model)) return undefined;

  const record = model as Record<string, unknown>;
  if (typeof record.provider !== "string" || typeof record.id !== "string") return undefined;
  if (!record.provider || !record.id) return undefined;

  return { provider: record.provider, id: record.id };
}

export function isCodexModel(model: ModelRef | undefined): boolean {
  return model?.provider === CODEX_PROVIDER;
}

export function isBlacklisted(model: ModelRef | undefined, blacklist: string[]): boolean {
  return model !== undefined && blacklist.includes(model.id);
}

export function isFastActive(
  config: FastModeConfig,
  model: ModelRef | undefined,
): boolean {
  return config.enabled && isCodexModel(model) && !isBlacklisted(model, config.blacklist);
}
