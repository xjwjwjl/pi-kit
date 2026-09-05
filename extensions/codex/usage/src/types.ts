export interface CodexCredential {
	access: string;
	expires?: number;
}

export interface UsageWindow {
	used_percent?: number;
	limit_window_seconds?: number;
	reset_after_seconds?: number;
	reset_at?: number;
}

export interface UsageResponse {
	email?: string;
	plan_type?: string;
	allowed?: boolean;
	limit_reached?: boolean;
	rate_limit?: {
		allowed?: boolean;
		limit_reached?: boolean;
		primary_window?: UsageWindow | null;
		secondary_window?: UsageWindow | null;
	};
}

export type UsageResultStatus = "success" | "expired" | "error" | "cancelled";

export interface UsageResult {
	status: UsageResultStatus;
	usage: UsageResponse | null;
	error?: string;
}

export interface ModelStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
}

export interface WindowStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
	sessions: number;
	models: Record<string, ModelStats>;
}

export interface TimeRange {
	start: Date;
	end: Date;
}

export interface ScanQuality {
	totalFiles: number;
	parsedFiles: number;
	skippedFiles: number;
	malformedLines: number;
	duplicateEntries: number;
}

export interface SessionScanResult {
	stats: WindowStats[];
	quality: ScanQuality;
}

export interface SelectedQuotaWindows {
	short: UsageWindow | null;
	long: UsageWindow | null;
}

export interface UsageViewData {
	email: string;
	plan: string;
	allowed: boolean | null;
	limitReached: boolean;
	apiError?: string;
	shortWindow: UsageWindow | null;
	longWindow: UsageWindow | null;
	shortRange: TimeRange | null;
	longRange: TimeRange | null;
	shortStats: WindowStats;
	longStats: WindowStats;
	scanQuality: ScanQuality;
	observedAt: Date;
}

export interface CacheEntry {
	result: UsageResult;
	observedAt: number;
	lastSuccessAt?: number;
	lastAttemptAt: number;
	stale: boolean;
	retryCount: number;
	nextRetryAt?: number;
}

export type PersistentCache = Record<string, CacheEntry>;
