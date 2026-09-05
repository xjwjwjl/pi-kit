import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { COMMAND_CODE_PROVIDER_ID } from "./constants.ts";
import { remainingPercent, selectStatusWindow } from "./quota.ts";
import type { CommandCodeQuotaResult } from "./quota-types.ts";

export type StatusColor = "success" | "warning" | "error" | "muted";
export type Paint = (color: StatusColor, text: string) => string;

export const STATUS_KEY = "commandcode-usage";

export function formatQuotaStatus(result: CommandCodeQuotaResult, paint: Paint): string {
	if (result.status === "expired") return paint("muted", "CommandCode·") + paint("error", "login expired");
	if (result.status !== "success" || !result.quota) return unavailableStatus(paint);

	const selected = selectStatusWindow(result.quota);
	if (!selected.window) return unavailableStatus(paint);

	const percent = Math.round(remainingPercent(selected.window) ?? 0);
	const color: StatusColor = percent < 10 ? "error" : percent <= 50 ? "warning" : "success";
	return `${paint("muted", `CommandCode·${selected.label}`)} ${paint(color, `${percent}%`)}`;
}

export function unavailableStatus(paint: Paint): string {
	return paint("muted", "CommandCode·") + paint("warning", "quota unavailable");
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

export function isCommandCodeModel(model: unknown): boolean {
	if (!model || typeof model !== "object" || Array.isArray(model)) return false;
	return (model as { provider?: unknown }).provider === COMMAND_CODE_PROVIDER_ID;
}

export function safeSetStatus(
	ctx: ExtensionContext,
	status: string | undefined,
	model?: unknown,
): void {
	try {
		ctx.ui.setStatus(STATUS_KEY, isCommandCodeModel(model ?? ctx.model) ? status : undefined);
	} catch {
		// Status display is best effort and must not affect the host process.
	}
}
