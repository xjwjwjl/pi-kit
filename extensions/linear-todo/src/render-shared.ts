import { stripTerminalSequences } from "@earendil-works/pi-tui";
import type { TodoState } from "../schema.ts";

export interface TodoRenderSnapshot {
  state: TodoState | null;
  compatibilityError?: string;
  earlyStopWarning?: boolean;
  paused?: boolean;
  /** Released after settlement or when undo restores a completed pre-image; state stays available to /todos and undo. */
  completedDismissed?: boolean;
}

export function displayText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function sanitizeRenderText(value: string): string {
  return displayText(stripTerminalSequences(value)).replace(/[\x00-\x1f\x7f-\x9f]/g, "");
}
