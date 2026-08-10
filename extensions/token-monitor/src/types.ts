export type RangePreset = "1h" | "6h" | "24h" | "7d" | "30d" | "custom";

export type SortKey = "tokens" | "cost" | "requests";
export type RequestSortKey = "time" | "tokens" | "cost";

export interface TimeRange {
	preset: RangePreset;
	startMs: number;
	endMs: number;
	label: string;
}

export interface TokenEvent {
	entryId: string;
	sessionId: string;
	sessionFile: string;
	sessionCreatedAt: number;
	timestampMs: number;
	scope: string;
	provider: string;
	model: string;
	requestedModel?: string;
	api?: string;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	cost: number;
	stopReason?: string;
}

export type ScanPhase = "discovering" | "scanning" | "finalizing";

export interface ScanProgress {
	phase: ScanPhase;
	discovered: number;
	loaded: number;
	total: number;
	skipped: number;
	currentFile?: string;
}

export interface ScanResult {
	aborted: boolean;
	events: TokenEvent[];
	totalFiles: number;
	loadedFiles: number;
	skippedFiles: number;
	deduplicatedEvents: number;
	malformedLines: number;
	scannedAt: number;
}

export interface MetricTotals {
	tokens: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	cost: number;
	requests: number;
}

export interface ProviderAggregate {
	key: string;
	provider: string;
	totals: MetricTotals;
	models: ModelAggregate[];
}

export interface ModelAggregate {
	key: string;
	provider: string;
	model: string;
	totals: MetricTotals;
}

export interface ScopeAggregate {
	key: string;
	scope: string;
	totals: MetricTotals;
	providers: ProviderAggregate[];
}

export interface TrendBucket {
	label: string;
	startMs: number;
	endMs: number;
	totals: MetricTotals;
}
