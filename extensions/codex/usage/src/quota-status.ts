import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatWindowDuration, hasUsagePercent, remainingPercent, selectStatusWindow } from "./quota.ts";
import type { UsageResult } from "./types.ts";

export type StatusColor = "success" | "warning" | "error" | "muted";
export type Paint = (color: StatusColor, text: string) => string;

export const STATUS_KEY = "codex-usage";
export const CODEX_PROVIDER = "openai-codex";

export function formatQuotaStatus(result: UsageResult, paint: Paint): string {
	if (result.status === "expired") return paint("muted", "Codex·") + paint("error", "token expired");
	if (result.status !== "success" || !result.usage) return unavailableStatus(paint);

	const window = selectStatusWindow(result.usage);
	if (!hasUsagePercent(window)) return unavailableStatus(paint);

	const percent = Math.round(remainingPercent(window) ?? 0);
	const color: StatusColor = percent < 10 ? "error" : percent <= 50 ? "warning" : "success";
	return `${paint("muted", `Codex·${formatWindowDuration(window)}`)} ${paint(color, `${percent}%`)}`;
}

export function unavailableStatus(paint: Paint): string {
	return paint("muted", "Codex·") + paint("warning", "quota unavailable");
}

export function safePaint(ctx: ExtensionContext): Paint {
	return (color, text) => {
		try {
			return ctx.hasUI ? ctx.ui.theme.fg(color, text) : text;
		} catch {
			return text;
		}
	};
}

export function isCodexModel(model: unknown): boolean {
	if (!model || typeof model !== "object" || Array.isArray(model)) return false;
	return (model as { provider?: unknown }).provider === CODEX_PROVIDER;
}

export function safeSetStatus(
	ctx: ExtensionContext,
	status: string | undefined,
	model?: unknown,
): void {
	try {
		ctx.ui.setStatus(STATUS_KEY, isCodexModel(model ?? ctx.model) ? status : undefined);
	} catch {
		// Status display is best effort and must not affect the host process.
	}
}

