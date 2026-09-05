import type { Theme } from "@earendil-works/pi-coding-agent";
import type {
	ConsumeResetCreditResult,
	ResetCredit,
	ResetCreditsResult,
	ResetCreditsSnapshot,
} from "./types.ts";

export function formatResetCreditsResult(
	result: ResetCreditsResult,
	now = new Date(),
	theme?: Theme,
): string {
	if (result.status === "cancelled") return styled(theme, "warning", "Codex quota request cancelled.");
	if (result.status === "expired") return styled(theme, "error", "Codex OAuth token expired.");
	if (result.status !== "success" || !result.credits) {
		return styled(theme, "error", `Unable to read Codex reset credits${result.error ? `: ${result.error}` : "."}`);
	}
	return formatResetCredits(result.credits, now, theme);
}

export function formatResetCredits(
	snapshot: ResetCreditsSnapshot,
	now = new Date(),
	theme?: Theme,
): string {
	const title = styled(theme, "accent", theme?.bold("Codex Quota") ?? "Codex Quota");
	const countLabel = snapshot.availableCount === 1 ? "reset credit" : "reset credits";
	const lines = [
		`${title} · ${styled(theme, snapshot.availableCount > 0 ? "success" : "dim", `${snapshot.availableCount} ${countLabel} available`)}`,
	];

	if (snapshot.credits.length === 0) {
		if (snapshot.availableCount > 0) {
			lines.push(styled(theme, "dim", "Credit details unavailable; the backend will select the next available credit."));
		}
		return `\n${lines.join("\n")}`;
	}

	lines.push(styled(theme, "dim", "Available credits:"));
	for (const [index, credit] of snapshot.credits.entries()) {
		lines.push(`  ${formatCreditChoice(credit, index, now)}`);
	}
	if (snapshot.credits.length < snapshot.availableCount) {
		lines.push(styled(theme, "dim", `  Showing ${snapshot.credits.length} of ${snapshot.availableCount} available credits.`));
	}
	return `\n${lines.join("\n")}`;
}

export function formatCreditChoice(credit: ResetCredit, _index: number, now = new Date()): string {
	const title = normalizeCreditTitle(credit.title?.trim() || "Reset credit");
	const expiry = formatExpiry(credit, now);
	return `${title} · ${expiry}`;
}

function normalizeCreditTitle(title: string): string {
	// Map backend display titles to a cleaner canonical text. Falls back to the
	// original title for any value not recognized here.
	const normalized = title.trim().toLowerCase();
	if (normalized === "full reset (weekly + 5 hr)" || normalized === "full reset (weekly + 5h)") {
		return "Weekly + 5h reset credits";
	}
	return title.trim() || "Reset credit";
}

export function formatConsumeResetCreditResult(
	result: ConsumeResetCreditResult,
	theme?: Theme,
): string {
	if (result.status === "cancelled") return styled(theme, "warning", "Codex quota reset cancelled.");
	if (result.status === "expired") return styled(theme, "error", "Codex OAuth token expired.");
	if (result.status !== "success" || !result.outcome) {
		return styled(theme, "error", `Codex quota reset failed${result.error ? `: ${result.error}` : "."}`);
	}

	switch (result.outcome) {
		case "reset":
			return styled(theme, "success", "Codex quota reset completed; one reset credit was consumed.");
		case "alreadyRedeemed":
			return styled(theme, "success", "Codex quota reset was already redeemed for this attempt.");
		case "nothingToReset":
			return styled(theme, "warning", "Codex has no eligible rate-limit window to reset.");
		case "noCredit":
			return styled(theme, "warning", "No Codex reset credit is available.");
	}
}

function formatExpiry(credit: ResetCredit, now: Date): string {
	if (credit.expires_at === null || credit.expires_at === undefined) return "no expiry";
	const expiresMs = toMs(credit.expires_at);
	if (expiresMs === undefined) return "no expiry";
	if (expiresMs <= now.getTime()) return "expired";
	const date = new Date(expiresMs);
	const daysLeft = Math.ceil((expiresMs - now.getTime()) / 86_400_000);
	const dateText = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
	return `expires ${dateText} · ${daysLeft}d left`;
}

function toMs(value: number | string | null | undefined): number | undefined {
	if (typeof value === "number") return value * 1000;
	if (typeof value === "string") {
		const parsed = Date.parse(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

function styled(theme: Theme | undefined, color: string, text: string): string {
	return theme ? theme.fg(color as any, text) : text;
}
