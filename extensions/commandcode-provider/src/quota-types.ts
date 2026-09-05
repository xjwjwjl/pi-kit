/** Status-bar quota model for Command Code, decoupled from the full usage report. */

export type QuotaStatus = "success" | "expired" | "error" | "cancelled";

/** A single rolling quota window (5-hour or weekly), normalized to millisecond resetAt. */
export interface QuotaWindow {
	used: number;
	cap: number;
	exceeded: boolean;
	resetAt?: number;
}

/** The two Command Code rolling windows, each optional. */
export interface CommandCodeQuotaData {
	fiveHour: QuotaWindow | null;
	weekly: QuotaWindow | null;
}

/** Result of a background quota refresh or a command-triggered quota update. */
export interface CommandCodeQuotaResult {
	status: QuotaStatus;
	quota: CommandCodeQuotaData | null;
	error?: string;
}
