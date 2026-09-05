import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fetchCommandCodeUsage, readCommandCodeCredential, toCommandCodeQuotaResult } from "./usage-api.ts";
import { formatCommandCodeUsage, formatLoadingNotice } from "./usage-format.ts";
import { scanLocalUsage } from "./local-scan.ts";
import type { CommandCodeQuotaController } from "./quota-controller.ts";

export async function showCommandCodeUsage(
	ctx: ExtensionContext,
	controller: CommandCodeQuotaController,
): Promise<void> {
	const credential = readCommandCodeCredential();

	if (!credential) {
		ctx.ui.notify("No Command Code login found. Run /login commandcode first.", "warning");
		return;
	}

	const signal = ctx.signal ?? new AbortController().signal;
	const theme = ctx.hasUI ? ctx.ui.theme : undefined;

	// Show a loading notice while the fetch is in flight, then replace it with the report.
	ctx.ui.notify(formatLoadingNotice(theme), "info");

	const result = await fetchCommandCodeUsage(credential, signal);
	if (result.status === "cancelled") {
		if (!signal.aborted) ctx.ui.notify("Command Code usage request cancelled.", "info");
		return;
	}

	const scan =
		result.status === "success" && result.usage ? await scanLocalUsage(result.usage) : null;

	ctx.ui.notify(
		formatCommandCodeUsage(result, new Date(), theme, scan).join("\n"),
		result.status === "success" ? "info" : "warning",
	);

	// Push the command's own result into the controller so the status bar updates
	// from this request without issuing a second quota API call.
	if (credential) await controller.applyCommandResult(credential, toCommandCodeQuotaResult(result), new Date());
}
