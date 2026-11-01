import type { AgentActivityOutcome } from "@earendil-works/pi-coding-agent";

/** Tracks one attempt but only exposes its outcome at final run settlement. */
export class SettledOutcomeTracker {
  private lastOutcome: AgentActivityOutcome | undefined;
  private signal: AbortSignal | undefined;
  private reachedBeforeSettle = false;

  reset(signal?: AbortSignal): void {
    this.lastOutcome = undefined;
    this.signal = signal;
    this.reachedBeforeSettle = false;
  }

  onTurnEnd(outcome: AgentActivityOutcome): void {
    this.lastOutcome = outcome;
  }

  onBeforeSettle(outcome: AgentActivityOutcome): void {
    this.lastOutcome = outcome;
    this.reachedBeforeSettle = true;
  }

  settle(): AgentActivityOutcome | undefined {
    // Pi skips agent_before_settle on explicit cancellation, including during
    // retry backoff when the attempt signal is no longer available/aborted.
    // Retain the signal too: a cancelled tool can leave turn.outcome completed.
    const cancelled = this.signal?.aborted ||
      (this.lastOutcome !== undefined && !this.reachedBeforeSettle);
    const outcome = cancelled ? "aborted" : this.lastOutcome;
    this.reset();
    return outcome;
  }
}
