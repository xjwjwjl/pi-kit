export type HerdrBlockedSignal =
  | { active: true; label: string }
  | { active: false };

/** Bridges only Pi's ask_user tool lifetime into Herdr's blocked event channel. */
export class AskUserBlockedBridge {
  private readonly activeToolCalls = new Set<string>();

  onToolStart(toolName: string, toolCallId: string): HerdrBlockedSignal | undefined {
    if (toolName !== "ask_user") return undefined;

    const alreadyBlocked = this.activeToolCalls.size > 0;
    this.activeToolCalls.add(toolCallId);
    return alreadyBlocked ? undefined : { active: true, label: "reply needed" };
  }

  onToolEnd(toolName: string, toolCallId: string): HerdrBlockedSignal | undefined {
    if (toolName !== "ask_user" || !this.activeToolCalls.delete(toolCallId)) {
      return undefined;
    }
    return this.activeToolCalls.size === 0 ? { active: false } : undefined;
  }
}
