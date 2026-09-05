import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { FastModeConfig } from "./config.ts";
import { isFastActive, type ModelRef } from "./matcher.ts";

export const STATUS_KEY = "codex-fast";

export function updateFastStatus(
  ctx: Pick<ExtensionContext, "hasUI" | "ui">,
  config: FastModeConfig,
  model: ModelRef | undefined,
): void {
  if (!ctx.hasUI) return;
  ctx.ui.setStatus(
    STATUS_KEY,
    isFastActive(config, model) ? ctx.ui.theme.fg("thinkingXhigh", "Codex Fast") : undefined,
  );
}

export function clearFastStatus(
  ctx: Pick<ExtensionContext, "hasUI" | "ui">,
): void {
  if (!ctx.hasUI) return;
  ctx.ui.setStatus(STATUS_KEY, undefined);
}
