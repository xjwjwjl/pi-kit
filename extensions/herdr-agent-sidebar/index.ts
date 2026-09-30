import { execFile } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AskUserBlockedBridge } from "./src/blocked-bridge.ts";
import { baseStateLabelArgs, settleStateLabelArgs } from "./src/labels.ts";

const SOURCE = "pi-completion-time";

type HerdrTarget = {
  binaryPath: string;
  paneId: string;
};

function getHerdrTarget(): HerdrTarget | undefined {
  if (process.env.HERDR_ENV !== "1") return undefined;

  const binaryPath = process.env.HERDR_BIN_PATH;
  const paneId = process.env.HERDR_PANE_ID;
  if (!binaryPath || !paneId) return undefined;

  return { binaryPath, paneId };
}

function reportMetadata(...options: string[]): Promise<void> {
  const target = getHerdrTarget();
  if (!target) return Promise.resolve();

  return new Promise((resolve) => {
    execFile(
      target.binaryPath,
      ["pane", "report-metadata", target.paneId, "--source", SOURCE, ...options],
      { windowsHide: true, timeout: 5_000 },
      (error) => {
        if (error) {
          console.error(`[herdr-agent-sidebar] metadata update failed: ${error.message}`);
        }
        resolve();
      },
    );
  });
}

// `report-metadata --state-label` replaces the whole label map for this source,
// so every write must include the complete base set instead of a single key.
async function resetStateLabels(): Promise<void> {
  await reportMetadata(...baseStateLabelArgs());
}

export default function (pi: ExtensionAPI) {
  let lastOutcome: string | undefined;
  const askUserBlockedBridge = new AskUserBlockedBridge();

  pi.on("tool_execution_start", (event) => {
    const signal = askUserBlockedBridge.onToolStart(event.toolName, event.toolCallId);
    if (signal) pi.events.emit("herdr:blocked", signal);
  });

  pi.on("tool_execution_end", (event) => {
    const signal = askUserBlockedBridge.onToolEnd(event.toolName, event.toolCallId);
    if (signal) pi.events.emit("herdr:blocked", signal);
  });

  pi.on("session_start", async () => {
    await resetStateLabels();
  });

  pi.on("agent_start", async () => {
    lastOutcome = undefined;
    await resetStateLabels();
  });

  pi.on("agent_before_settle", (event) => {
    lastOutcome = event.outcome;
  });

  pi.on("agent_settled", async () => {
    const args = settleStateLabelArgs(lastOutcome, new Date());
    lastOutcome = undefined;
    if (!args) return;

    await reportMetadata(...args);
  });
}
