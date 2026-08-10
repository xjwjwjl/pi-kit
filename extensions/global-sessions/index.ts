import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { BorderedLoader } from "@earendil-works/pi-coding-agent";
import { SessionBrowserComponent } from "./src/session-browser.ts";
import { scanGlobalSessions } from "./src/session-scanner.ts";
import { loadSessionTranscript } from "./src/session-transcript.ts";
import type { BrowserAction, BrowserState, SessionScanProgress, SessionScanResult } from "./src/types.ts";

type ScanDialogResult =
	| { type: "complete"; result: SessionScanResult }
	| { type: "aborted" }
	| { type: "error"; error: unknown };

type LoaderWithMessage = {
	loader?: { setMessage?(message: string): void };
};

function setLoaderMessage(loader: BorderedLoader, message: string): void {
	(loader as unknown as LoaderWithMessage).loader?.setMessage?.(message);
}

function progressMessage(progress: SessionScanProgress): string {
	if (progress.phase === "discovering") {
		return progress.discovered > 0
			? `Finding Pi session files… ${progress.discovered} found`
			: "Finding Pi session files…";
	}
	const skipped = progress.skipped > 0 ? ` · ${progress.skipped} skipped` : "";
	return `Scanning Pi sessions… ${progress.loaded}/${progress.total}${skipped}`;
}

async function scanWithProgress(ctx: ExtensionCommandContext): Promise<SessionScanResult | undefined> {
	const result = await ctx.ui.custom<ScanDialogResult>((tui, theme, _keybindings, done) => {
		const loader = new BorderedLoader(tui, theme, "Finding Pi session files…");
		const controller = new AbortController();
		let progress: SessionScanProgress = {
			phase: "discovering",
			loaded: 0,
			total: 0,
			skipped: 0,
			discovered: 0,
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

		void scanGlobalSessions({
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
		ctx.ui.notify("Session scan cancelled.", "info");
		return undefined;
	}
	if (result.type === "error") {
		const message = result.error instanceof Error ? result.error.message : String(result.error);
		ctx.ui.notify(`Could not scan Pi sessions: ${message}`, "error");
		return undefined;
	}
	return result.result;
}

async function showBrowser(
	ctx: ExtensionCommandContext,
	scan: SessionScanResult,
	initialState: BrowserState,
): Promise<void> {
	let state = initialState;
	while (true) {
		const action = await ctx.ui.custom<BrowserAction>((tui, theme, keybindings, done) =>
			new SessionBrowserComponent(
				tui,
				theme,
				keybindings,
				scan.sessions,
				scan,
				done,
				loadSessionTranscript,
				ctx.cwd,
				state,
			),
		);
		if (!action) return;

		const confirmed = await ctx.ui.confirm(
			"Resume this session?",
			`Switch to the original project and session?\n\n${action.session.cwd}\n${action.session.path}\n\nYour current session is already saved. Pi may ask to trust the destination project.`,
		);
		if (!confirmed) {
			state = action.state;
			continue;
		}

		try {
			const result = await ctx.switchSession(action.session.path);
			if (!result.cancelled) return;
			ctx.ui.notify("Session switch cancelled.", "info");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Could not resume the selected session: ${message}`, "error");
		}
		state = action.state;
	}
}

export default function globalSessionsExtension(pi: ExtensionAPI): void {
	pi.registerCommand("sessions", {
		description: "Browse and resume sessions across all local Pi projects",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/sessions is available only in interactive TUI mode.", "error");
				return;
			}

			await ctx.waitForIdle();
			const scan = await scanWithProgress(ctx);
			if (!scan) return;
			if (scan.sessions.length === 0) {
				ctx.ui.notify("No readable Pi sessions were found in the default global session directory.", "info");
				return;
			}

			await showBrowser(ctx, scan, { query: args.trim(), view: "list" });
		},
	});
}
