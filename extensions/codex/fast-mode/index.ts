import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import {
  cloneFastModeConfig,
  DEFAULT_CONFIG,
  loadFastModeConfig,
  saveFastModePatch,
  type ConfigScope,
  type FastModeConfig,
} from "./src/config.ts";
import { isBlacklisted, isCodexModel, toModelRef, type ModelRef } from "./src/matcher.ts";
import { getFastModePayload } from "./src/payload.ts";
import { clearFastStatus, updateFastStatus } from "./src/status.ts";

const FAST_USAGE = "Usage: /fast [on|off|toggle|status]";

type ExtensionOptions = {
  agentDir?: string;
};

function notify(
  ctx: Pick<ExtensionContext, "hasUI" | "ui">,
  message: string,
  level: "info" | "warning" | "error",
): void {
  if (ctx.hasUI) ctx.ui.notify(message, level);
}

function statusMessage(config: FastModeConfig, model: ModelRef | undefined): string {
  if (!config.enabled) return "Codex Fast mode is OFF.";
  if (!model) return "Codex Fast mode is ON, but no model is selected.";
  if (!isCodexModel(model)) return `Codex Fast mode is ON but inactive for ${model.provider}/${model.id}.`;
  if (isBlacklisted(model, config.blacklist)) return `Codex Fast mode is ON but ${model.id} is blacklisted.`;
  return `Codex Fast mode is ON and active for ${model.id}.`;
}

function createExtension(options: ExtensionOptions = {}): ExtensionFactory {
  return function sxFastMode(pi: ExtensionAPI): void {
    let config = cloneFastModeConfig(DEFAULT_CONFIG);
    let configScope: ConfigScope = "global";
    let loadedCwd: string | undefined;
    let currentModel: ModelRef | undefined;

    async function loadForContext(ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">): Promise<void> {
      const loaded = await loadFastModeConfig({
        cwd: ctx.cwd,
        agentDir: options.agentDir,
        includeProject: ctx.isProjectTrusted(),
      });
      config = loaded.config;
      configScope = loaded.scope;
      loadedCwd = ctx.cwd;
    }

    async function ensureLoaded(ctx: Pick<ExtensionContext, "cwd" | "isProjectTrusted">): Promise<void> {
      if (loadedCwd !== ctx.cwd) await loadForContext(ctx);
    }

    function refreshModel(model: unknown): void {
      currentModel = toModelRef(model) ?? currentModel;
    }

    function refreshStatus(ctx: Pick<ExtensionContext, "hasUI" | "ui" | "model">): void {
      updateFastStatus(ctx, config, toModelRef(ctx.model) ?? currentModel);
    }

    async function setEnabled(
      enabled: boolean,
      ctx: ExtensionCommandContext,
    ): Promise<void> {
      await ensureLoaded(ctx);
      await saveFastModePatch(
        { cwd: ctx.cwd, agentDir: options.agentDir, scope: configScope },
        { enabled },
      );
      config = { ...config, enabled };
      refreshModel(ctx.model);
      refreshStatus(ctx);
    }

    pi.registerFlag("fast", {
      description: "Start with Codex Fast mode enabled",
      type: "boolean",
      default: false,
    });

    pi.registerCommand("fast", {
      description: "Control Codex Fast mode",
      getArgumentCompletions: (prefix: string) => {
        const normalized = prefix.trim().toLowerCase();
        return ["on", "off", "toggle", "status"]
          .filter((value) => value.startsWith(normalized))
          .map((value) => ({ value, label: value }));
      },
      handler: async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
        try {
          await ensureLoaded(ctx);
          refreshModel(ctx.model);
          const command = args.trim().toLowerCase();

          if (command === "" || command === "toggle") {
            await setEnabled(!config.enabled, ctx);
            notify(ctx, `Codex Fast mode ${config.enabled ? "enabled" : "disabled"}.`, "info");
            return;
          }

          if (command === "on" || command === "off") {
            const enabled = command === "on";
            await setEnabled(enabled, ctx);
            notify(ctx, `Codex Fast mode ${enabled ? "enabled" : "disabled"}.`, "info");
            return;
          }

          if (command === "status") {
            notify(ctx, statusMessage(config, toModelRef(ctx.model) ?? currentModel), "info");
            return;
          }

          notify(ctx, FAST_USAGE, "warning");
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          notify(ctx, `codex-fast-mode: ${message}`, "error");
        }
      },
    });

    pi.on("session_start", async (_event, ctx) => {
      try {
        currentModel = toModelRef(ctx.model);
        await loadForContext(ctx);

        if (pi.getFlag("fast") === true && !config.enabled) {
          await saveFastModePatch(
            { cwd: ctx.cwd, agentDir: options.agentDir, scope: configScope },
            { enabled: true },
          );
          config = { ...config, enabled: true };
        }

        refreshStatus(ctx);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        notify(ctx, `codex-fast-mode: failed to load settings: ${message}`, "warning");
        refreshStatus(ctx);
      }
    });

    pi.on("model_select", (event, ctx) => {
      refreshModel(event.model);
      refreshStatus(ctx);
    });

    pi.on("before_provider_request", (event, ctx) => {
      return getFastModePayload(
        config,
        toModelRef(ctx.model) ?? currentModel,
        event.payload,
      );
    });

    pi.on("session_shutdown", (_event, ctx) => {
      clearFastStatus(ctx);
      loadedCwd = undefined;
      currentModel = undefined;
    });
  };
}

export function createSxFastModeExtension(options: ExtensionOptions = {}): ExtensionFactory {
  return createExtension(options);
}

export default createExtension();
