import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const STATE_FILE = "task-fold.json";

export interface HintState {
  readonly seen: boolean;
  markSeen(): void;
}

/** Persist only this extension's first-use hint, not Pi settings. */
export function loadHintState(agentDir = getAgentDir()): HintState {
  const path = join(agentDir, STATE_FILE);
  let seen = false;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { hintSeen?: unknown };
    seen = parsed.hintSeen === true;
  } catch {
    // A missing or malformed state file simply shows the hint again.
  }
  return {
    get seen() {
      return seen;
    },
    markSeen() {
      if (seen) return;
      seen = true;
      try {
        mkdirSync(agentDir, { recursive: true });
        writeFileSync(path, `${JSON.stringify({ hintSeen: true })}\n`, "utf8");
      } catch (error) {
        console.warn("[task-fold] Could not persist the first-use hint:", error);
      }
    },
  };
}
