import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { CONFIG_FILE_NAME, loadConfig, type FailoverConfig } from "./src/config.ts";
import {
  failoverContinuationMessage,
  matchGogateFailure,
} from "./src/matcher.ts";
import { modelKey, nextCandidate, resolvePool } from "./src/pool.ts";
import { normalizeLeakedThinking } from "./src/thinking.ts";

const STATUS_KEY = "gogate-failover";
const ENTRY_TYPE = "gogate-failover-event";
const RETRY_MESSAGE_TYPE = "gogate-failover-retry";
const MAX_STORED_ERROR_LENGTH = 500;

interface RunState {
  pool: Model<any>[];
  attempted: Set<string>;
  switches: number;
}

interface FailureState {
  failedUntil: number;
  reason: string;
}

function modelLabel(model: Model<any> | undefined): string {
  return model ? `${model.provider}/${model.id}` : "none";
}

function displayModel(model: Model<any>, provider: string): string {
  return modelKey(model).replace(`${provider}/`, "");
}

function trimError(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > MAX_STORED_ERROR_LENGTH
    ? `${compact.slice(0, MAX_STORED_ERROR_LENGTH)}...`
    : compact;
}

function formatRemaining(until: number, now: number): string {
  const minutes = Math.max(1, Math.ceil((until - now) / 60_000));
  return `${minutes}m`;
}

export default function gogateFailoverExtension(pi: ExtensionAPI): void {
  const loaded = loadConfig(join(getAgentDir(), CONFIG_FILE_NAME));
  const config: FailoverConfig = loaded.config;
  const failedModels = new Map<string, FailureState>();
  let run: RunState | undefined;
  let lastProviderStatus: number | undefined;

  function updateStatus(ctx: ExtensionContext): void {
    if (!config.enabled || ctx.model?.provider !== config.provider) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      return;
    }

    const now = Date.now();
    const cooling = [...failedModels.entries()]
      .filter(([, state]) => state.failedUntil > now)
      .map(([key, state]) => `${key.replace(`${config.provider}/`, "")} ${formatRemaining(state.failedUntil, now)}`);

    const suffix = cooling.length > 0 ? `; cooldown: ${cooling.join(", ")}` : "";
    ctx.ui.setStatus(STATUS_KEY, `gogate failover: on${suffix}`);
  }

  function notify(ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info"): void {
    if (ctx.hasUI) ctx.ui.notify(message, type);
  }

  function appendEvent(data: Record<string, unknown>): void {
    pi.appendEntry(ENTRY_TYPE, {
      timestamp: Date.now(),
      ...data,
    });
  }

  function maxSwitches(pool: readonly Model<any>[]): number {
    return config.maxSwitchesPerRun ?? Math.max(0, pool.length - 1);
  }

  function cooldownMap(): Map<string, number> {
    return new Map([...failedModels.entries()].map(([key, value]) => [key, value.failedUntil]));
  }

  async function switchToNext(
    failedModel: Model<any>,
    ctx: ExtensionContext,
    failureReason: string,
    originalError: string | undefined,
    status: number | undefined,
  ): Promise<{ next?: Model<any>; error?: string }> {
    if (!run) {
      run = {
        pool: resolvePool(ctx, config),
        attempted: new Set([modelKey(failedModel)]),
        switches: 0,
      };
    }

    run.attempted.add(modelKey(failedModel));
    failedModels.set(modelKey(failedModel), {
      failedUntil: Date.now() + config.cooldownMs,
      reason: failureReason,
    });

    if (run.switches >= maxSwitches(run.pool)) {
      return { error: "no alternate model remains" };
    }

    let candidate = nextCandidate(
      run.pool,
      failedModel,
      run.attempted,
      cooldownMap(),
      Date.now(),
    );

    while (candidate) {
      try {
        const switched = await pi.setModel(candidate);
        if (switched === false) {
          throw new Error(`Model is unavailable: ${modelKey(candidate)}`);
        }
        run.switches += 1;
        run.attempted.add(modelKey(candidate));

        appendEvent({
          action: "switch",
          from: modelKey(failedModel),
          to: modelKey(candidate),
          status,
          reason: failureReason,
          error: trimError(originalError),
        });

        updateStatus(ctx);
        return { next: candidate };
      } catch (error) {
        run.attempted.add(modelKey(candidate));
        appendEvent({
          action: "candidate-unavailable",
          model: modelKey(candidate),
          error: trimError(error instanceof Error ? error.message : String(error)),
        });
        candidate = nextCandidate(
          run.pool,
          failedModel,
          run.attempted,
          cooldownMap(),
          Date.now(),
        );
      }
    }

    return { error: "no available alternate model remains" };
  }

  pi.registerCommand("gogate-failover", {
    description: "Show or reset automatic gogate model failover state",
    handler: async (args, ctx) => {
      const command = args.trim().toLowerCase();
      if (command === "reset") {
        failedModels.clear();
        updateStatus(ctx);
        notify(ctx, "gogate failover cooldowns reset.");
        return;
      }

      const pool = ctx.model?.provider === config.provider ? resolvePool(ctx, config) : [];
      const cooling = [...failedModels.entries()]
        .filter(([, state]) => state.failedUntil > Date.now())
        .map(([key, state]) => `${key} until ${new Date(state.failedUntil).toISOString()} (${state.reason})`);
      const lines = [
        `enabled: ${config.enabled}`,
        `provider: ${config.provider}`,
        `current: ${modelLabel(ctx.model)}`,
        `pool: ${pool.map(modelKey).join(", ") || "none"}`,
        `cooldownMs: ${config.cooldownMs}`,
        `cooling: ${cooling.join("; ") || "none"}`,
      ];
      if (loaded.error) lines.push(`config warning: ${loaded.error}`);
      notify(ctx, lines.join("\n"));
    },
  });

  pi.on("session_start", (_event, ctx) => {
    updateStatus(ctx);
    if (loaded.error) notify(ctx, `Failed to read ${loaded.path}: ${loaded.error}`, "warning");
  });

  pi.on("session_shutdown", (_event, ctx) => {
    ctx.ui.setStatus(STATUS_KEY, undefined);
    run = undefined;
  });

  pi.on("model_select", (_event, ctx) => {
    updateStatus(ctx);
  });

  pi.on("after_provider_response", (event) => {
    lastProviderStatus = event.status;
  });

  pi.on("agent_start", async (_event, ctx) => {
    lastProviderStatus = undefined;
    if (!config.enabled || ctx.model?.provider !== config.provider) return;

    if (!run) {
      run = {
        pool: resolvePool(ctx, config),
        attempted: new Set(ctx.model ? [modelKey(ctx.model)] : []),
        switches: 0,
      };
    }

    updateStatus(ctx);
  });

  pi.on("message_end", async (event, ctx) => {
    if (!config.enabled || event.message.role !== "assistant") return;

    const message = event.message as AssistantMessage;
    if (message.provider !== config.provider) return;

    // Keep the user's current thinking level. Some gogate responses put
    // unsigned reasoning text before tool calls; normalize that block back to
    // Pi's thinking channel without disabling reasoning.
    if (message.stopReason !== "error") {
      const normalized = normalizeLeakedThinking(message);
      if (normalized !== message) return { message: normalized };
      return;
    }

    const status = lastProviderStatus;
    lastProviderStatus = undefined;
    const match = matchGogateFailure({ errorMessage: message.errorMessage, status });
    if (!match.matched) return;

    const failedModel = ctx.modelRegistry.find(message.provider, message.model);
    if (!failedModel) return;

    const switched = await switchToNext(
      failedModel,
      ctx,
      match.reason ?? "quota-like error",
      message.errorMessage,
      status,
    );

    if (switched.next) {
      pi.sendMessage(
        {
          customType: RETRY_MESSAGE_TYPE,
          content: failoverContinuationMessage(),
          display: false,
          details: {
            from: modelKey(failedModel),
            to: modelKey(switched.next),
          },
        },
        { triggerTurn: true, deliverAs: "followUp" },
      );
      notify(
        ctx,
        `gogate: switched to ${displayModel(switched.next, config.provider)}; continuing`,
        "warning",
      );
      return {
        message: {
          ...message,
          content: [],
          stopReason: "stop",
          errorMessage: undefined,
        },
      };
    }

    appendEvent({
      action: "exhausted",
      model: modelKey(failedModel),
      status,
      reason: switched.error ?? "no alternate model remains",
      error: trimError(message.errorMessage),
    });
    notify(ctx, `gogate: ${switched.error ?? "no alternate model remains"}`, "warning");
    updateStatus(ctx);

    return {
      message: {
        ...message,
        content: [],
        stopReason: "stop",
        errorMessage: undefined,
      },
    };
  });

  pi.on("agent_settled", (_event, ctx) => {
    run = undefined;
    lastProviderStatus = undefined;
    updateStatus(ctx);
  });
}
