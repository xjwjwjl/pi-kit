import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createCodexQuotaCommand } from "./src/reset-command.ts";

export const RESET_CREDIT_CONSUMED_EVENT = "openai-codex:reset-credit-consumed";

export default function codexQuotaExtension(pi: ExtensionAPI): void {
	const handleResetCredit = createCodexQuotaCommand({
		onReset: () => pi.events.emit(RESET_CREDIT_CONSUMED_EVENT, {}),
	});

	pi.registerCommand("codex-reset-credit", {
		description: "View or consume ChatGPT/Codex reset credits",
		handler: handleResetCredit,
	});
}
