import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { QuotaController } from "./src/quota-controller.ts";
import { selectQuotaWindows, inferWindowRange } from "./src/quota.ts";
import { emptyScanQuality, emptyStats, scanSessionsInRanges } from "./src/session-scanner.ts";
import { formatLoadingNotice, formatReport } from "./src/format.ts";
import { extractEmailFromJWT, fetchUsage, readCodexCredential } from "./src/usage-api.ts";
import type { ScanQuality, UsageResult, UsageViewData } from "./src/types.ts";

export { formatReport } from "./src/format.ts";
export { formatQuotaStatus } from "./src/quota-status.ts";
export { formatWindowDuration, classifyRateLimitWindows, selectQuotaWindows } from "./src/quota.ts";
export {
	createCacheEntry,
	hasAttemptedInRefreshWindow,
	isFreshCacheEntry,
	isRetryDue,
	RETRY_MAX_ATTEMPTS,
} from "./src/quota-cache.ts";
export { scanSessionsInRanges } from "./src/session-scanner.ts";
export { QuotaController } from "./src/quota-controller.ts";
export type * from "./src/types.ts";

export default function codexUsageExtension(pi: ExtensionAPI): void {
	const controller = new QuotaController();

	pi.events.on("openai-codex:credential-changed", () => {
		controller.handleCredentialChanged();
	});

	pi.events.on("openai-codex:reset-credit-consumed", () => {
		controller.handleCredentialChanged();
	});

	pi.on("session_start", (_event, ctx) => {
		controller.start(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		controller.stop(ctx);
	});

	pi.on("model_select", (event, ctx) => {
		controller.handleModelSelected(ctx, event.model);
	});

	pi.registerCommand("codex-usage", {
		description: "Check ChatGPT/Codex account usage (rate limits & token stats)",
		handler: async (_args, ctx) => {
			const credential = readCodexCredential();
			ctx.ui.notify(formatLoadingNotice(ctx.hasUI ? ctx.ui.theme : undefined), "info");

			const result: UsageResult = credential
				? await fetchUsage(credential, ctx.signal)
				: { status: "error", usage: null, error: "No openai-codex OAuth credential found" };
			const observedAt = new Date();
			const report = await buildReport(result, credential, observedAt);
			ctx.ui.notify(
				formatReport(report, ctx.hasUI ? ctx.ui.theme : undefined),
				result.status === "success" ? "info" : "warning",
			);

			if (credential) await controller.applyCommandResult(credential, result, observedAt);
		},
	});

}

async function buildReport(
	result: UsageResult,
	credential: ReturnType<typeof readCodexCredential>,
	observedAt: Date,
): Promise<UsageViewData> {
	const usage = result.status === "success" ? result.usage : null;
	const selected = selectQuotaWindows(usage);
	const shortRange = inferWindowRange(selected.short, observedAt);
	const longRange = inferWindowRange(selected.long, observedAt);
	let shortStats = emptyStats();
	let longStats = emptyStats();
	let scanQuality: ScanQuality = emptyScanQuality();
	if (result.status === "success") {
		const scanResult = await scanSessionsInRanges([shortRange, longRange]);
		[shortStats, longStats] = scanResult.stats;
		scanQuality = scanResult.quality;
	}

	return {
		email: usage?.email || (credential ? extractEmailFromJWT(credential.access) : "") || "unknown",
		plan: usage?.plan_type || "unknown",
		allowed: usage ? usage.allowed ?? usage.rate_limit?.allowed ?? null : null,
		limitReached: usage?.limit_reached ?? usage?.rate_limit?.limit_reached ?? false,
		apiError: result.status === "success" ? undefined : result.error || (result.status === "expired" ? "OAuth token expired" : "usage unavailable"),
		shortWindow: selected.short,
		longWindow: selected.long,
		shortRange,
		longRange,
		shortStats,
		longStats,
		scanQuality,
		observedAt,
	};
}
