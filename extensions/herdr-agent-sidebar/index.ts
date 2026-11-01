import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AskUserBlockedBridge } from "./src/blocked-bridge.ts";
import { baseStateLabelArgs, settleStateLabelArgs } from "./src/labels.ts";
import { HerdrMetadataReporter, type HerdrTarget } from "./src/metadata.ts";
import { SettledOutcomeTracker } from "./src/outcome.ts";

function getHerdrTarget(): HerdrTarget | undefined {
  if (process.env.HERDR_ENV !== "1") return undefined;

  const binaryPath = process.env.HERDR_BIN_PATH;
  const paneId = process.env.HERDR_PANE_ID;
  if (!binaryPath || !paneId) return undefined;

  return { binaryPath, paneId };
}

export default function (pi: ExtensionAPI) {
  // Capture launch-time identity; child sessions must never retarget later writes.
  const target = getHerdrTarget();
  if (!target) return;

  let reporter: HerdrMetadataReporter | undefined;
  const outcomes = new SettledOutcomeTracker();
  const askUserBlockedBridge = new AskUserBlockedBridge();

  function activeReporter(ctx: ExtensionContext): HerdrMetadataReporter | undefined {
    return ctx.mode === "tui" ? reporter : undefined;
  }

  function resetBlocked(): void {
    const signal = askUserBlockedBridge.reset();
    if (signal) pi.events.emit("herdr:blocked", signal);
  }

  pi.on("tool_execution_start", (event, ctx) => {
    if (!activeReporter(ctx)) return;
    const signal = askUserBlockedBridge.onToolStart(event.toolName, event.toolCallId);
    if (signal) pi.events.emit("herdr:blocked", signal);
  });

  pi.on("tool_execution_end", (event, ctx) => {
    if (!activeReporter(ctx)) return;
    const signal = askUserBlockedBridge.onToolEnd(event.toolName, event.toolCallId);
    if (signal) pi.events.emit("herdr:blocked", signal);
  });

  pi.on("session_start", async (_event, ctx) => {
    // RPC also has hasUI=true, but it does not own the inherited Herdr pane.
    if (ctx.mode !== "tui") return;
    reporter ??= new HerdrMetadataReporter(target);
    outcomes.reset(ctx.signal);
    resetBlocked();
    await reporter.report(...baseStateLabelArgs());
  });

  pi.on("agent_start", async (_event, ctx) => {
    const active = activeReporter(ctx);
    if (!active) return;
    outcomes.reset(ctx.signal);
    await active.report(...baseStateLabelArgs());
  });

  pi.on("turn_end", (event, ctx) => {
    if (!activeReporter(ctx)) return;
    outcomes.onTurnEnd(event.outcome);
  });

  pi.on("agent_before_settle", (event, ctx) => {
    if (!activeReporter(ctx)) return;
    outcomes.onBeforeSettle(event.outcome);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const active = activeReporter(ctx);
    if (!active) return;
    const args = settleStateLabelArgs(outcomes.settle(), new Date());
    if (args) await active.report(...args);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const closing = activeReporter(ctx);
    if (!closing) return;
    reporter = undefined;
    outcomes.reset();
    resetBlocked();
    await closing.close();
  });
}
