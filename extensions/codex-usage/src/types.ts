export interface UsageWindow {
	used_percent?: number;
	limit_window_seconds?: number;
	reset_after_seconds?: number;
	reset_at?: number;
}

export interface UsageResponse {
	email?: string;
	plan_type?: string;
	rate_limit?: {
		allowed?: boolean;
		limit_reached?: boolean;
		primary_window?: UsageWindow | null;
		secondary_window?: UsageWindow | null;
	};
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

export interface UsageViewData {
	email: string;
	plan: string;
	allowed: boolean | null;
	limitReached: boolean;
	apiError?: string;
	fiveHWindow: UsageWindow | null;
	sevenDWindow: UsageWindow | null;
	fiveHRange: TimeRange | null;
	sevenDRange: TimeRange | null;
	fiveH: WindowStats;
	sevenD: WindowStats;
	scanQuality: ScanQuality;
	now: Date;
}
