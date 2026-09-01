/**
 * Codex Usage Extension
 *
 * Registers /codex-usage command to check ChatGPT/Codex account usage.
 * - Reads the openai-codex access token from pi's ~/.pi/agent/auth.json
 * - Calls /backend-api/wham/usage for official rate limit info
 * - Scans pi sessions to aggregate token usage inside the official rate-limit windows
 * - Renders lightweight themed message blocks
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { extractEmailFromJWT, fetchUsage, loadAccessToken } from "./src/usage-api.ts";
import {
	classifyRateLimitWindows,
	formatWindowDuration,
	inferWindowRange,
} from "./src/quota.ts";
import {
	emptyScanQuality,
	emptyStats,
	scanSessionsInRanges,
} from "./src/session-scanner.ts";
import { formatLoadingNotice, formatReport } from "./src/format.ts";
import type {
	ScanQuality,
	TimeRange,
	UsageViewData,
	UsageWindow,
} from "./src/types.ts";

export { formatReport } from "./src/format.ts";
export { formatWindowDuration } from "./src/quota.ts";
export { scanSessionsInRanges } from "./src/session-scanner.ts";

export default function codexUsageExtension(pi: ExtensionAPI) {
	pi.registerCommand("codex-usage", {
		description: "Check ChatGPT/Codex account usage (rate limits & token stats)",
		handler: async (_args, ctx) => {
			const accessToken = loadAccessToken();
			if (!accessToken) {
				ctx.ui.notify("No openai-codex token found in ~/.pi/agent/auth.json", "error");
				return;
			}

			ctx.ui.notify(formatLoadingNotice(ctx.hasUI ? ctx.ui.theme : undefined), "info");

			const usageResult = await fetchUsage(accessToken)
				.then((usage) => ({ ok: true as const, usage }))
				.catch((error) => ({ ok: false as const, error: String(error) }));
			const observedAt = new Date();
			let fiveHRange: TimeRange | null = null;
			let sevenDRange: TimeRange | null = null;
			let fiveH = emptyStats();
			let sevenD = emptyStats();
			let scanQuality: ScanQuality = emptyScanQuality();

			let fiveHWindow: UsageWindow | null = null;
			let sevenDWindow: UsageWindow | null = null;
			if (usageResult.ok) {
				({ fiveHWindow, sevenDWindow } = classifyRateLimitWindows(usageResult.usage.rate_limit));
				fiveHRange = inferWindowRange(fiveHWindow, observedAt);
				sevenDRange = inferWindowRange(sevenDWindow, observedAt);

				const scanResult = await scanSessionsInRanges([fiveHRange, sevenDRange]);
				[fiveH, sevenD] = scanResult.stats;
				scanQuality = scanResult.quality;
			}

			const usage = usageResult.ok ? usageResult.usage : null;
			const data: UsageViewData = {
				email: usage?.email || extractEmailFromJWT(accessToken) || "unknown",
				plan: usage?.plan_type || "unknown",
				allowed: usage?.rate_limit?.allowed ?? null,
				limitReached: usage?.rate_limit?.limit_reached ?? false,
				apiError: usageResult.ok ? undefined : usageResult.error,
				fiveHWindow,
				sevenDWindow,
				fiveHRange,
				sevenDRange,
				fiveH,
				sevenD,
				scanQuality,
				now: observedAt,
			};

			ctx.ui.notify(
				formatReport(data, ctx.hasUI ? ctx.ui.theme : undefined),
				data.apiError ? "warning" : "info",
			);
		},
	});
}
