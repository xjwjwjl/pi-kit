/**
 * wt-notify — Windows Terminal completion notification.
 *
 * Sends a system-level toast (via PowerShell) when an agent run has fully
 * settled inside Windows Terminal (detected via WT_SESSION). Short runs below
 * a configurable minimum duration and user-aborted runs are filtered out.
 */

import { execFile } from "node:child_process";
import path from "node:path";
import type { AgentEndEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DEFAULT_MIN_SECONDS = 8;

// Prefix shown on the toast to fill the blank area beside the text.
const TOAST_PREFIX = "🤖 ";

// AUMIDs registered on stock Windows. A PowerShell process has no registered
// AUMID of its own, and arbitrary ids (like the app title "Pi") are silently
// dropped by Show() — the toast never displays and no error is thrown. We must
// target a real, registered AUMID for the toast to surface.
const REGISTERED_AUMIDS = [
	// Windows Terminal itself, when it is the host — toast source shows its name.
	"Microsoft.WindowsTerminal",
	// The Run dialog app ("运行"), a reliable fallback present on desktop Windows.
	"Microsoft.Windows.Shell.RunDialog",
];

/**
 * Build a PowerShell script that shows a single-line Windows toast from the
 * official ToastText01 template, bound to a registered AUMID so it actually
 * displays.
 */
function windowsToastScript(body: string): string {
	const type = "Windows.UI.Notifications";
	const mgr = `[${type}.ToastNotificationManager, ${type}, ContentType = WindowsRuntime]`;
	const template = `[${type}.ToastTemplateType]::ToastText01`;
	const toast = `[${type}.ToastNotification]::new($xml)`;
	const choose = REGISTERED_AUMIDS.map((a) => `'${a}'`).join(", ");
	return [
		"try {",
		`${mgr} | Out-Null`,
		`$xml = [${type}.ToastNotificationManager]::GetTemplateContent(${template})`,
		// Cache the text node before mutating, to avoid "collection modified".
		"$texts = $xml.GetElementsByTagName('text')",
		"$textNode = $texts.Item(0)",
		`$null = $textNode.AppendChild($xml.CreateTextNode('${body}'))`,
		`$toast = ${toast}`,
		// Try several registered AUMIDs in order; a miss never fails hard.
		`foreach ($id in @(${choose})) { try { $nt = [${type}.ToastNotificationManager]::CreateToastNotifier($id); $nt.Show($toast); break } catch { continue } }`,
		"} catch { /* swallow: a failing toast must never break the agent */ }",
	].join("\n");
}

/** Escape a string for safe embedding inside a PowerShell single-quoted context. */
function escapeSingleQuote(value: string): string {
	return value.replace(/'/g, "''");
}

/** Build the single-line toast body, including the current project name. */
function buildToastBody(seconds: number): string {
	const project = path.basename(process.cwd());
	return `${TOAST_PREFIX}任务完成 · 用时 ${seconds}s · ${project}`;
}

/** Send a system-level desktop toast when running inside Windows Terminal. */
function notifySystemToast(message: string): void {
	if (!process.env.WT_SESSION) return;
	const body = escapeSingleQuote(message);
	const script = windowsToastScript(body);
	const child = execFile("powershell.exe", ["-NoProfile", "-Command", script], () => {});
	child.unref(); // fire-and-forget; don't keep the agent alive for the toast.
}

/** Return the stopReason of the last assistant message in the run, if any. */
function lastAssistantStopReason(messages: AgentEndEvent["messages"]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role === "assistant") return message.stopReason;
	}
	return undefined;
}

export interface WtNotifyOptions {
	/** Override the completion-notification sink (mainly for tests). Defaults to a Windows toast. */
	notify?: (message: string) => void;
}

export default function wtNotifyExtension(pi: ExtensionAPI, options?: WtNotifyOptions) {
	const notify = options?.notify ?? notifySystemToast;
	let minSeconds = DEFAULT_MIN_SECONDS;
	// Pi emits agent_start/agent_end for each retry attempt, while agent_settled
	// marks the end of the complete run. Keep the wall-clock start alive across
	// those attempts.
	let runActive = false;
	let runStartedAt: number | null = null;
	// stopReason of the last assistant message seen at agent_end; used to skip
	// notifications for user-aborted runs (agent_settled fires on aborts too).
	let lastStopReason: string | undefined;

	function reset(): void {
		runActive = false;
		runStartedAt = null;
		lastStopReason = undefined;
	}

	pi.on("agent_start", () => {
		if (!runActive) {
			runActive = true;
			runStartedAt = Date.now();
		}
	});

	pi.on("agent_end", (event) => {
		lastStopReason = lastAssistantStopReason(event.messages);
	});

	pi.on("agent_settled", (_event, _ctx) => {
		if (!runActive || runStartedAt == null) return;
		const startedAt = runStartedAt;
		runActive = false;
		runStartedAt = null;

		// Only notify for Windows Terminal runs; stay silent elsewhere (Ghostty/iTerm etc).
		if (!process.env.WT_SESSION) return;
		// Esc-aborted runs settle too; never notify for those.
		if (lastStopReason === "aborted") return;

		const seconds = Math.round((Date.now() - startedAt) / 1000);
		if (minSeconds > 0 && seconds < minSeconds) return;
		notify(buildToastBody(seconds));
	});

	pi.on("session_shutdown", () => {
		reset();
	});

	pi.registerCommand("wt-notify", {
		description: "Show or set the minimum run duration (seconds) for completion notices; 0 disables the filter",
		handler: async (args, ctx) => {
			const input = args.trim();
			if (input === "") {
				ctx.ui.notify(`wt-notify: minimum duration is ${minSeconds}s (0 = filter off)`, "info");
				return;
			}
			const value = Number(input);
			if (!Number.isFinite(value) || value < 0) {
				ctx.ui.notify("wt-notify: expected a non-negative number of seconds", "error");
				return;
			}
			minSeconds = value;
			ctx.ui.notify(
				value === 0 ? "wt-notify: minimum duration filter disabled" : `wt-notify: minimum duration set to ${value}s`,
				"info",
			);
		},
	});
}