export interface CommandCodeCredential {
    access: string;
    expires?: number;
}

export interface CommandCodeUser {
    id?: string;
    name?: string;
    email?: string;
    userName?: string;
}

export interface CommandCodeOrg {
    id?: string;
    name?: string;
    login?: string;
}

export interface UsageWindow {
    used?: number;
    cap?: number;
    exceeded?: boolean;
    resetAt?: number;
}

export interface CreditsSnapshot {
    monthlyCredits?: number;
    purchasedCredits?: number;
    freeCredits?: number;
    belowThreshold?: boolean;
    creditThreshold?: number;
}

export interface WindowLimitsSnapshot {
    limited?: boolean;
    exceeded?: boolean;
    fiveHour?: UsageWindow | null;
    weekly?: UsageWindow | null;
}

export interface CreditsResponse {
    credits: CreditsSnapshot;
    windowLimits?: WindowLimitsSnapshot;
}

export interface SubscriptionSnapshot {
    id?: string;
    status?: string;
    planId?: string;
    currentPeriodStart?: string;
    currentPeriodEnd?: string;
}

export interface UsageSummary {
    totalCount?: number;
    totalCost?: number;
    averageCost?: number;
    successRate?: number;
    completedCount?: number;
    failedCount?: number;
    totalTokensIn?: number;
    totalTokensOut?: number;
    totalTokens?: number;
    totalCredits?: number;
    totalFreeCredits?: number;
    totalMonthlyCredits?: number;
    totalPurchasedCredits?: number;
    periodBasis?: string;
}

export type UsageSection = "credits" | "subscription" | "summary";

export interface UsageSectionError {
    section: UsageSection;
    message: string;
}

export interface CommandCodeUsageData {
    user: CommandCodeUser;
    org: CommandCodeOrg | null;
    credits: CreditsResponse | null;
    subscription: SubscriptionSnapshot | null;
    summary: UsageSummary | null;
    errors: UsageSectionError[];
    observedAt: Date;
}

export type UsageResultStatus = "success" | "expired" | "error" | "cancelled";

export interface CommandCodeUsageResult {
    status: UsageResultStatus;
    usage: CommandCodeUsageData | null;
    error?: string;
}

// Local session scan (mirrors codex-usage).
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
