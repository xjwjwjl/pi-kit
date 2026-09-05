import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import { COMMAND_CODE_API_BASE_URL, COMMAND_CODE_PROVIDER_ID } from "./constants.ts";
import type {
    CommandCodeCredential,
    CommandCodeOrg,
    CommandCodeUsageResult,
    CommandCodeUser,
    CreditsResponse,
    SubscriptionSnapshot,
    UsageSection,
    UsageSectionError,
    UsageSummary,
    UsageWindow,
    WindowLimitsSnapshot,
} from "./usage-types.ts";
import type { CommandCodeQuotaData, CommandCodeQuotaResult } from "./quota-types.ts";

const USAGE_REQUEST_TIMEOUT_MS = 10_000;

export type FetchFn = typeof globalThis.fetch;

export function readCommandCodeCredential(): CommandCodeCredential | null {
    try {
        const stored = readStoredCredential(COMMAND_CODE_PROVIDER_ID);
        if (!stored || typeof stored !== "object") return null;

        const value = stored as { type?: unknown; access?: unknown; expires?: unknown };
        if (value.type !== "oauth" || typeof value.access !== "string" || value.access.length === 0) return null;

        return {
            access: value.access,
            ...(typeof value.expires === "number" ? { expires: value.expires } : {}),
        };
    } catch {
        return null;
    }
}

function toQuotaData(credits: CreditsResponse | null): CommandCodeQuotaData | null {
    if (!credits?.windowLimits) return null;
    return {
        fiveHour: toQuotaWindow(credits.windowLimits.fiveHour),
        weekly: toQuotaWindow(credits.windowLimits.weekly),
    };
}

function toQuotaWindow(value: UsageWindow | null | undefined): CommandCodeQuotaData["fiveHour"] {
    if (!value) return null;
    return {
        used: typeof value.used === "number" && Number.isFinite(value.used) ? value.used : 0,
        cap: typeof value.cap === "number" && Number.isFinite(value.cap) ? value.cap : 0,
        exceeded: value.exceeded === true,
        ...(typeof value.resetAt === "number" && Number.isFinite(value.resetAt) ? { resetAt: value.resetAt } : {}),
    };
}

/**
 * Background status-bar fetch: request only `/alpha/billing/credits` and return
 * the rolling quota windows. Lightweight compared to the full usage report, and
 * tolerant of a missing windowLimits section.
 */
export async function fetchCommandCodeQuota(
    credential: CommandCodeCredential,
    signal?: AbortSignal,
    fetchFn: FetchFn = globalThis.fetch,
): Promise<CommandCodeQuotaResult> {
    const aborted = signal?.aborted ?? false;
    if (aborted) return { status: "cancelled", quota: null };
    if (typeof credential.expires === "number" && Date.now() >= credential.expires) {
        return { status: "expired", quota: null, error: "Command Code login has expired. Run /login commandcode again." };
    }

    try {
        const payload = await getJson("/alpha/billing/credits", credential.access, signal ?? new AbortController().signal, fetchFn);
        if (signal?.aborted) return { status: "cancelled", quota: null };
        const credits = parseCredits(payload);
        return { status: "success", quota: toQuotaData(credits) };
    } catch (error) {
        if (signal?.aborted || isAbortError(error)) return { status: "cancelled", quota: null };
        return { status: "error", quota: null, error: describeError(error) };
    }
}

/**
 * Derive a status-bar quota result from a full usage response. The command
 * path uses this to push its already-fetched data into the controller without
 * triggering a second quota request. A non-success usage result maps to error.
 */
export function toCommandCodeQuotaResult(result: CommandCodeUsageResult): CommandCodeQuotaResult {
    if (result.status === "cancelled") return { status: "cancelled", quota: null };
    if (result.status === "expired") return { status: "expired", quota: null, error: result.error };
    if (result.status !== "success" || !result.usage?.credits) {
        return { status: "error", quota: null, error: result.error || "quota unavailable" };
    }
    return { status: "success", quota: toQuotaData(result.usage.credits) };
}

export async function fetchCommandCodeUsage(
    credential: CommandCodeCredential,
    signal: AbortSignal,
    fetchFn: FetchFn = globalThis.fetch,
): Promise<CommandCodeUsageResult> {
    if (signal.aborted) return { status: "cancelled", usage: null };
    if (typeof credential.expires === "number" && Date.now() >= credential.expires) {
        return { status: "expired", usage: null, error: "Command Code login has expired. Run /login commandcode again." };
    }

    try {
        const whoami = parseWhoami(await getJson("/alpha/whoami", credential.access, signal, fetchFn));
        const [credits, subscription] = await Promise.all([
            fetchSection("credits", "/alpha/billing/credits", parseCredits, credential.access, signal, fetchFn),
            fetchSection("subscription", "/alpha/billing/subscriptions", parseSubscription, credential.access, signal, fetchFn),
        ]);

        signal.throwIfAborted();
        const since = subscription.value?.currentPeriodStart;
        const summaryPath = since
            ? `/alpha/usage/summary?since=${encodeURIComponent(since)}`
            : "/alpha/usage/summary";
        const summary = await fetchSection("summary", summaryPath, parseSummary, credential.access, signal, fetchFn);

        return {
            status: "success",
            usage: {
                user: whoami.user,
                org: whoami.org,
                credits: credits.value,
                subscription: subscription.value,
                summary: summary.value,
                errors: [credits.error, subscription.error, summary.error].filter(isUsageSectionError),
                observedAt: new Date(),
            },
        };
    } catch (error) {
        if (signal.aborted || isAbortError(error)) return { status: "cancelled", usage: null };
        return { status: "error", usage: null, error: describeError(error) };
    }
}

interface SectionResult<T> {
    value: T | null;
    error?: UsageSectionError;
}

async function fetchSection<T>(
    section: UsageSection,
    path: string,
    parse: (value: unknown) => T,
    apiKey: string,
    signal: AbortSignal,
    fetchFn: FetchFn,
): Promise<SectionResult<T>> {
    try {
        const payload = await getJson(path, apiKey, signal, fetchFn);
        return { value: parse(payload) };
    } catch (error) {
        if (signal.aborted || isAbortError(error)) throw error;
        return { value: null, error: { section, message: describeError(error) } };
    }
}

async function getJson(path: string, apiKey: string, signal: AbortSignal, fetchFn: FetchFn): Promise<unknown> {
    signal.throwIfAborted();

    let response: Response;
    try {
        response = await fetchFn(`${COMMAND_CODE_API_BASE_URL}${path}`, {
            method: "GET",
            headers: {
                Accept: "application/json",
                Authorization: `Bearer ${apiKey}`,
            },
            signal: AbortSignal.any([signal, AbortSignal.timeout(USAGE_REQUEST_TIMEOUT_MS)]),
        });
    } catch (error) {
        if (signal.aborted || isAbortError(error)) throw error;
        if (isTimeoutError(error)) throw new UsageApiError("Command Code request timed out.");
        throw new UsageApiError("Command Code request failed.");
    }

    if (!response.ok) {
        throw new UsageApiError("Command Code request failed.", response.status);
    }

    try {
        return await response.json();
    } catch (error) {
        throw new UsageApiError("Command Code returned an invalid JSON response.");
    }
}

function parseWhoami(value: unknown): { user: CommandCodeUser; org: CommandCodeOrg | null } {
    const record = asRecord(value);
    const user = parseUser(record?.user);
    if (!user) throw new UsageApiError("Command Code returned no authenticated user.");

    return {
        user,
        org: parseOrg(record?.org),
    };
}

function parseUser(value: unknown): CommandCodeUser | null {
    const record = asRecord(value);
    if (!record) return null;
    return {
        ...(typeof record.id === "string" ? { id: record.id } : {}),
        ...(typeof record.name === "string" ? { name: record.name } : {}),
        ...(typeof record.email === "string" ? { email: record.email } : {}),
        ...(typeof record.userName === "string" ? { userName: record.userName } : {}),
    };
}

function parseOrg(value: unknown): CommandCodeOrg | null {
    const record = asRecord(value);
    if (!record) return null;
    return {
        ...(typeof record.id === "string" ? { id: record.id } : {}),
        ...(typeof record.name === "string" ? { name: record.name } : {}),
        ...(typeof record.login === "string" ? { login: record.login } : {}),
    };
}

function parseCredits(value: unknown): CreditsResponse {
    const record = asRecord(value);
    const credits = asRecord(record?.credits);
    if (!credits) throw new UsageApiError("Command Code returned invalid credit data.");

    return {
        credits: {
            ...numberField(credits, "monthlyCredits"),
            ...numberField(credits, "purchasedCredits"),
            ...numberField(credits, "freeCredits"),
            ...booleanField(credits, "belowThreshold"),
            ...numberField(credits, "creditThreshold"),
        },
        windowLimits: parseWindowLimits(record?.windowLimits),
    };
}

function parseWindowLimits(value: unknown): WindowLimitsSnapshot | undefined {
    const record = asRecord(value);
    if (!record) return undefined;

    return {
        ...booleanField(record, "limited"),
        ...booleanField(record, "exceeded"),
        fiveHour: parseWindow(record.fiveHour),
        weekly: parseWindow(record.weekly),
    };
}

function parseWindow(value: unknown): UsageWindow | null | undefined {
    if (value === null) return null;
    const record = asRecord(value);
    if (!record) return undefined;

    return {
        ...numberField(record, "used"),
        ...numberField(record, "cap"),
        ...booleanField(record, "exceeded"),
        ...numberField(record, "resetAt"),
    };
}

function parseSubscription(value: unknown): SubscriptionSnapshot {
    const record = asRecord(value);
    const data = asRecord(record?.data);
    if (!data) throw new UsageApiError("Command Code returned invalid subscription data.");

    return {
        ...stringField(data, "id"),
        ...stringField(data, "status"),
        ...stringField(data, "planId"),
        ...stringField(data, "currentPeriodStart"),
        ...stringField(data, "currentPeriodEnd"),
    };
}

function parseSummary(value: unknown): UsageSummary {
    const record = asRecord(value);
    if (!record) throw new UsageApiError("Command Code returned invalid usage summary data.");

    return {
        ...numberField(record, "totalCount"),
        ...numberField(record, "totalCost"),
        ...numberField(record, "averageCost"),
        ...numberField(record, "successRate"),
        ...numberField(record, "completedCount"),
        ...numberField(record, "failedCount"),
        ...numberField(record, "totalTokensIn"),
        ...numberField(record, "totalTokensOut"),
        ...numberField(record, "totalTokens"),
        ...numberField(record, "totalCredits"),
        ...numberField(record, "totalFreeCredits"),
        ...numberField(record, "totalMonthlyCredits"),
        ...numberField(record, "totalPurchasedCredits"),
        ...stringField(record, "periodBasis"),
    };
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function numberField(record: Record<string, unknown>, key: string): Record<string, number> {
    return typeof record[key] === "number" && Number.isFinite(record[key]) ? { [key]: record[key] as number } : {};
}

function stringField(record: Record<string, unknown>, key: string): Record<string, string> {
    return typeof record[key] === "string" && record[key].length > 0 ? { [key]: record[key] as string } : {};
}

function booleanField(record: Record<string, unknown>, key: string): Record<string, boolean> {
    return typeof record[key] === "boolean" ? { [key]: record[key] as boolean } : {};
}

function isUsageSectionError(value: UsageSectionError | undefined): value is UsageSectionError {
    return value !== undefined;
}

class UsageApiError extends Error {
    readonly status?: number;

    constructor(message: string, status?: number) {
        super(message);
        this.name = "UsageApiError";
        this.status = status;
    }
}

function describeError(error: unknown): string {
    if (error instanceof UsageApiError) {
        if (error.status === 401 || error.status === 403) return "Authentication rejected. Run /login commandcode again.";
        if (error.status === 429) return "Command Code rate limit reached. Try again later.";
        if (error.status !== undefined) return `Command Code request failed (HTTP ${error.status}).`;
        return error.message;
    }
    if (isTimeoutError(error)) return "Command Code request timed out.";
    return "Unable to reach Command Code usage service.";
}

function isAbortError(error: unknown): boolean {
    return Boolean(error && typeof error === "object" && "name" in error && error.name === "AbortError");
}

function isTimeoutError(error: unknown): boolean {
    return Boolean(error && typeof error === "object" && "name" in error && error.name === "TimeoutError");
}
