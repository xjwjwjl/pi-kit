/**
 * SX Fast Mode Extension
 *
 * Injects `service_tier: "priority"` into requests sent to the `sx` provider,
 * reducing latency at higher cost.
 *
 * Commands:
 *   /fast on      – enable priority mode
 *   /fast off     – disable priority mode
 *   /fast status  – show current state
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "sx-fast";
const PROVIDER = "sx";

// ── State (per-session; survives /reload but not pi restart) ──────────
let fastMode = false;

// ── Helpers ────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function updateFooter(ui: { setStatus(key: string, text: string | undefined): void }) {
  ui.setStatus(STATUS_KEY, fastMode ? "SX Fast: ON" : undefined);
}

// ── Extension ──────────────────────────────────────────────────────────

export default function sxFastMode(pi: ExtensionAPI) {
  // Inject service_tier into every sx provider request when enabled
  pi.on("before_provider_request", (event, ctx) => {
    if (!fastMode) return undefined;

    const model = ctx.model;
    if (!model) return undefined;
    if (model.provider !== PROVIDER) return undefined;

    if (!isRecord(event.payload)) return undefined;

    // Respect explicit service_tier if already set
    if ("service_tier" in event.payload) return undefined;

    return {
      ...event.payload,
      service_tier: "priority",
    };
  });

  // Show footer status on session start
  pi.on("session_start", (_event, ctx) => {
    updateFooter(ctx.ui);
  });

  // ── /fast command ──────────────────────────────────────────────────

  pi.registerCommand("fast", {
    description: "Toggle SX Fast (priority) mode — injects service_tier: priority",
    getArgumentCompletions: (_prefix: string) => [
      { value: "on", label: "on — enable priority mode" },
      { value: "off", label: "off — disable priority mode" },
      { value: "status", label: "status — show current state" },
    ],
    handler: async (args, ctx) => {
      const cmd = args.trim().toLowerCase();

      if (cmd === "on") {
        fastMode = true;
        ctx.ui.notify("SX Fast mode enabled — requests will use service_tier: priority", "info");
        updateFooter(ctx.ui);
      } else if (cmd === "off") {
        fastMode = false;
        ctx.ui.notify("SX Fast mode disabled", "info");
        updateFooter(ctx.ui);
      } else if (cmd === "status" || cmd === "") {
        ctx.ui.notify(`SX Fast mode is ${fastMode ? "ON" : "OFF"}`, "info");
      } else {
        ctx.ui.notify(`Unknown subcommand "${args}". Use /fast on | off | status`, "warning");
      }
    },
  });
}
