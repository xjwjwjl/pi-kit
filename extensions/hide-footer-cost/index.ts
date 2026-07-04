/**
 * Hide Token Cost Footer Extension
 * 
 * This extension customizes the footer to show:
 * - Current model name
 * - Thinking level (if supported by model)
 * - Current working directory
 * - Extension statuses
 * 
 * It removes token counts and cost display.
 * 
 * Remembers the last state across restarts.
 * Run /hide-footer-cost to toggle on/off.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

const CONFIG_FILE = path.join(homedir(), ".pi", "agent", "hide-footer-cost.json");

function loadEnabled(): boolean {
	try {
		if (existsSync(CONFIG_FILE)) {
			const data = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
			return data.enabled ?? true;
		}
	} catch {
		// Ignore errors, default to true
	}
	return true;
}

function saveEnabled(enabled: boolean): void {
	try {
		writeFileSync(CONFIG_FILE, JSON.stringify({ enabled }, null, 2));
	} catch {
		// Ignore errors
	}
}

function createFooter(ctx: ExtensionAPI) {
	return (tui: any, theme: any, footerData: any) => {
		// Subscribe to branch changes to re-render
		const unsub = footerData.onBranchChange(() => tui.requestRender());

		return {
			dispose: unsub,
			invalidate() {},
			render(width: number): string[] {
				// Get extension statuses
				const extStatuses = footerData.getExtensionStatuses();
				const statusTexts = extStatuses.size > 0 
					? Array.from(extStatuses.values()).join(" | ")
					: "";
				
				// Get thinking level from session entries (if model supports reasoning)
				let thinkingLevel: string | undefined;
				if (ctx.model?.reasoning) {
					for (const e of ctx.sessionManager.getBranch()) {
						if (e.type === "thinking_level_change") {
							thinkingLevel = (e as any).thinkingLevel;
						}
					}
				}
				
				// Build left side: model name + thinking level
				const thinkingStr = thinkingLevel
					? (thinkingLevel === "off" ? " • thinking off" : ` • ${thinkingLevel}`)
					: "";
				
				const modelStr = theme.fg("dim", `${ctx.model?.id || "no-model"}${thinkingStr}`);
				
				// Get current working directory (shortened if too long)
				const cwd = ctx.cwd || "";
				let cwdStr = "";
				if (cwd) {
					// Shorten home directory to ~
					const home = homedir();
					const displayCwd = home && cwd.startsWith(home)
						? "~" + cwd.slice(home.length)
						: cwd;
					// Truncate if too long (reserve space for model + statuses)
					const maxCwdLen = Math.max(20, Math.floor(width * 0.3));
					cwdStr = theme.fg("dim", " • ") + theme.fg("muted", truncateToWidth(displayCwd, maxCwdLen));
				}
				
				// Build right side: extension statuses
				const right = theme.fg("dim", statusTexts);
				
				// Combine: left (model+thinking) | middle (cwd) | right (extension statuses)
				const left = modelStr + cwdStr;
				const leftWidth = visibleWidth(left);
				const rightWidth = visibleWidth(right);
				
				// Put cwd between left and right with padding
				// Left: leftWidth, Right: rightWidth
				// Use remaining space between them
				const middlePad = " ".repeat(Math.max(1, width - leftWidth - rightWidth));
				
				return [truncateToWidth(left + middlePad + right, width)];
			},
		};
	};
}

export default function (pi: ExtensionAPI) {
	// Load saved state
	let enabled = loadEnabled();

	// Auto-enable on session start based on saved state
	pi.on("session_start", (_event, ctx) => {
		if (enabled) {
			ctx.ui.setFooter(createFooter(ctx));
		}
	});

	pi.registerCommand("hide-footer-cost", {
		description: "Toggle custom footer (model + thinking level + cwd)",
		handler: async (_args, ctx) => {
			enabled = !enabled;
			saveEnabled(enabled);

			if (enabled) {
				ctx.ui.setFooter(createFooter(ctx));
				ctx.ui.notify("Token cost hidden in footer", "info");
			} else {
				ctx.ui.setFooter(undefined);
				ctx.ui.notify("Default footer restored", "info");
			}
		},
	});
}
