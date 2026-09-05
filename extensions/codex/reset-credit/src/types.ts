export interface CodexCredential {
	access: string;
	expires?: number;
	accountId?: string;
}

export interface ResetCredit {
	id: string;
	reset_type?: string;
	is_supported_by_plan?: boolean;
	status?: string;
	granted_at?: number | string;
	expires_at?: number | string | null;
	title?: string | null;
	description?: string | null;
}

export interface ResetCreditsSnapshot {
	availableCount: number;
	totalEarnedCount?: number;
	credits: ResetCredit[];
}

export type ResetApiStatus = "success" | "expired" | "error" | "cancelled";

export interface ResetCreditsResult {
	status: ResetApiStatus;
	credits: ResetCreditsSnapshot | null;
	error?: string;
}

export type ResetCreditOutcome = "reset" | "nothingToReset" | "noCredit" | "alreadyRedeemed";

export interface ConsumeResetCreditRequest {
	idempotencyKey: string;
	creditId?: string;
}

export interface ConsumeResetCreditResult {
	status: ResetApiStatus;
	outcome: ResetCreditOutcome | null;
	error?: string;
}
