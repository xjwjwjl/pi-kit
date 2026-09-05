import type { FastModeConfig } from "./config.ts";
import { isFastActive, type ModelRef } from "./matcher.ts";

export const FAST_SERVICE_TIER = "priority";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getFastModePayload(
  config: FastModeConfig,
  model: ModelRef | undefined,
  payload: unknown,
): unknown | undefined {
  if (!isFastActive(config, model)) return undefined;
  if (!isRecord(payload)) return undefined;

  // An explicit valid service tier has precedence over the Fast Mode default.
  if (typeof payload.service_tier === "string" && payload.service_tier.trim() !== "") {
    return undefined;
  }

  return {
    ...payload,
    service_tier: FAST_SERVICE_TIER,
  };
}
