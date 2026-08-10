import {
	BorderedLoader,
	type ExtensionAPI,
	type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { rollingRange, customRange, parseLocalDateTime, RANGE_PRESETS } from "./src/time-range.ts";
import { providerAggregates, totalsForEvents } from "./src/aggregate.ts";
import { formatCost, formatCount, formatRange, formatTotalsSummary } from "./src/format.ts";
import { scanTokenEvents, type ScanTokenEventsOptions } from "./src/session-scanner.ts";
import { TokenMonitorComponent } from "./src/token-monitor-component.ts";
import type { ScanProgress, ScanResult, TimeRange } from "./src/types.ts";

type ScanDialogResult =
	| { type: "complete"; result: ScanResult }
	| { type: "aborted" }
	| { type: "error"; error: unknown };

type LoaderWithMessage = {
	loader?: { setMessage?(message: string): void };
};

function setLoaderMessage(loader: BorderedLoader, message: string): void {
	(loader as unknown as LoaderWithMessage).loader?.setMessage?.(message);
}

function progressMessage(progress: ScanProgress): string {
	if (progress.phase === "discovering") {
		return progress.discovered > 0 ? `Finding Pi session files... ${progress.discovered} found` : "Finding Pi session files...";
	}
	if (progress.phase === "finalizing") return "Finalizing attributed usage...";
	const skipped = progress.skipped > 0 ? ` | ${progress.skipped} skipped` : "";
	return `Scanning Pi sessions... ${progress.loaded}/${progress.total}${skipped}`;
}

async function scanWithProgress(ctx: ExtensionCommandContext, range: TimeRange): Promise<ScanResult | undefined> {
	const result = await ctx.ui.custom<ScanDialogResult>((tui, theme, _keybindings, done) => {
		const loader = new BorderedLoader(tui, theme, `Scanning ${formatRange(range)}...`);
		const controller = new AbortController();
		let progress: ScanProgress = {
			phase: "discovering",
			discovered: 0,
			loaded: 0,
			total: 0,
			skipped: 0,
		};
		let closed = false;
		const interval = setInterval(() => setLoaderMessage(loader, progressMessage(progress)), 100);
		const close = (value: ScanDialogResult) => {
			if (closed) return;
			closed = true;
			clearInterval(interval);
			done(value);
		};

		loader.onAbort = () => {
			controller.abort();
			close({ type: "aborted" });
		};

		void scanTokenEvents({
			range,
			signal: controller.signal,
			onProgress: (next) => {
				progress = next;
			},
		})
			.then((scan) => {
				if (scan.aborted) close({ type: "aborted" });
				else close({ type: "complete", result: scan });
			})
			.catch((error: unknown) => close({ type: "error", error }));

		return loader;
	});

	if (!result || result.type === "aborted") {
		ctx.ui.notify("Token monitor scan cancelled.", "info");
		return undefined;
	}
	if (result.type === "error") {
		const message = result.error instanceof Error ? result.error.message : String(result.error);
		ctx.ui.notify(`Could not scan Pi sessions: ${message}`, "error");
		return undefined;
	}
	return result.result;
}

async function chooseRange(ctx: ExtensionCommandContext, current: TimeRange): Promise<TimeRange | undefined> {
	const options = [
		...RANGE_PRESETS.map((preset) => `${preset === current.preset ? "* " : "  "}${rollingRange(preset).label}`),
		`${current.preset === "custom" ? "* " : "  "}Custom range`,
	];
	const selected = await ctx.ui.select(`Time range | current ${formatRange(current)}`, options);
	if (!selected) return undefined;

	const selectedIndex = options.indexOf(selected);
	if (selectedIndex >= 0 && selectedIndex < RANGE_PRESETS.length) {
		return rollingRange(RANGE_PRESETS[selectedIndex]!);
	}
	if (selectedIndex !== RANGE_PRESETS.length) return undefined;

	const startText = await ctx.ui.input("Custom range start", "YYYY-MM-DD HH:mm");
	if (!startText) return undefined;
	const endText = await ctx.ui.input("Custom range end", "YYYY-MM-DD HH:mm");
	if (!endText) return undefined;
	const startMs = parseLocalDateTime(startText);
	const endMs = parseLocalDateTime(endText);
	if (startMs === undefined || endMs === undefined) {
		ctx.ui.notify("Use YYYY-MM-DD HH:mm for custom range values.", "error");
		return undefined;
	}
	try {
		return customRange(startMs, endMs);
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		return undefined;
	}
}

function nonInteractiveSummary(range: TimeRange, scan: ScanResult): string {
	const totals = totalsForEvents(scan.events);
	const providers = providerAggregates(scan.events, "tokens").slice(0, 5);
	const providerLines = providers.length === 0
		? "No attributed usage."
		: providers.map((row) => `- ${row.provider}: ${formatCount(row.totals.tokens)} tokens | ${formatCost(row.totals.cost)} | ${row.totals.requests} requests`).join("\n");
	return [
		`Token Monitor | ${formatRange(range)}`,
		formatTotalsSummary(totals),
		`Input ${formatCount(totals.inputTokens)} | Output ${formatCount(totals.outputTokens)} | Cache R ${formatCount(totals.cacheReadTokens)} | Cache W ${formatCount(totals.cacheWriteTokens)}`,
		"",
		"Providers",
		providerLines,
	].join("\n");
}

async function showMonitor(ctx: ExtensionCommandContext, initialRange: TimeRange, initialScan: ScanResult): Promise<void> {
	await ctx.ui.custom<void>((tui, theme, keybindings, done) =>
		new TokenMonitorComponent(
			tui,
			theme,
			keybindings,
			initialRange,
			initialScan,
			done,
			async (range, signal, onProgress) => {
				const options: ScanTokenEventsOptions = { range, signal, onProgress };
				return scanTokenEvents(options);
			},
			(current) => chooseRange(ctx, current),
		),
	);
}

export default function tokenMonitorExtension(pi: ExtensionAPI): void {
	pi.registerCommand("token-monitor", {
		description: "Offline token and cost analysis for attributed Pi session usage",
		handler: async (_args, ctx) => {
			const range = rollingRange("24h");
			if (ctx.mode !== "tui") {
				const scan = await scanTokenEvents({ range });
				pi.sendMessage(
					{
						customType: "token-monitor",
						content: nonInteractiveSummary(range, scan),
						display: true,
					},
					{ triggerTurn: false },
				);
				return;
			}

			await ctx.waitForIdle();
			const scan = await scanWithProgress(ctx, range);
			if (!scan) return;
			if (scan.events.length === 0) {
				ctx.ui.notify("No attributed Pi usage was found in the selected range.", "info");
			}
			await showMonitor(ctx, range, scan);
		},
	});
}
