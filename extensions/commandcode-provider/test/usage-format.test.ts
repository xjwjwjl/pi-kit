import assert from "node:assert/strict";
import { test } from "node:test";
import { formatCommandCodeUsage } from "../src/usage-format.ts";
import type { LocalScanResult } from "../src/local-scan.ts";
import type { CommandCodeUsageResult } from "../src/usage-types.ts";

const observedAt = new Date("2026-09-03T12:00:00.000Z");

const successResult: CommandCodeUsageResult = {
    status: "success",
    usage: {
        user: { email: "lin@example.com" },
        org: null,
        credits: {
            credits: { monthlyCredits: 80, purchasedCredits: 10, freeCredits: 2 },
            windowLimits: {
                fiveHour: { used: 20, cap: 100, resetAt: observedAt.getTime() + 60 * 60 * 1_000 },
                weekly: { used: 40, cap: 200, resetAt: observedAt.getTime() + 24 * 60 * 60 * 1_000 },
            },
        },
        subscription: {
            status: "active",
            planId: "individual-pro",
            currentPeriodStart: "2026-09-01T00:00:00.000Z",
            currentPeriodEnd: "2026-10-01T00:00:00.000Z",
        },
        summary: {
            totalCount: 12,
            completedCount: 11,
            failedCount: 1,
            totalTokensIn: 500,
            totalTokensOut: 734,
            totalTokens: 1234,
            totalCost: 4.5,
            totalCredits: 3.2,
            totalMonthlyCredits: 4.5,
        },
        errors: [],
        observedAt,
    },
};

test("formatCommandCodeUsage renders account, credits, windows, and activity", () => {
    const output = formatCommandCodeUsage(successResult, observedAt).join("\n");

    assert.match(output, /Command Code Usage/);
    assert.match(output, /·\s+Pro Plan\s+·\s+active/);
    assert.doesNotMatch(output, /lin@example\.com/);
    assert.doesNotMatch(output, /% left/);
    assert.match(output, /5-hour/);
    assert.match(output, /80%/);
    assert.doesNotMatch(output, /Billing period/);
    assert.match(output, /total 1\.2K\s+in 500\s+out 734/);
    assert.match(output, /requests 12\s+completed 11\s+failed 1/);
});

test("formatCommandCodeUsage reports unavailable results without exposing credentials", () => {
    const output = formatCommandCodeUsage({
        status: "error",
        usage: null,
        error: "Authentication rejected. Run /login commandcode again.",
    }).join("\n");

    assert.match(output, /UNAVAILABLE/);
    assert.match(output, /\/login commandcode/);
    assert.doesNotMatch(output, /test-key|Bearer/);
});

function makeScan(): LocalScanResult {
    const fill = (n: number) => ({ input: n * 10, output: n, cacheRead: n, cacheWrite: 0, totalTokens: n * 11, cost: n, sessions: n, models: {} });
    return {
        fiveHour: { range: { start: new Date(observedAt.getTime() - 5 * 3600_000), end: observedAt }, stats: fill(12) },
        weekly: { range: { start: new Date(observedAt.getTime() - 7 * 24 * 3600_000), end: observedAt }, stats: fill(34) },
        quality: { totalFiles: 5, parsedFiles: 5, skippedFiles: 0, malformedLines: 0, duplicateEntries: 0 },
        scanned: true,
    };
}

test("formatCommandCodeUsage embeds local scan stats under each window", () => {
    const output = formatCommandCodeUsage(successResult, observedAt, undefined, makeScan()).join("\n");

    // Each quota window carries its own scanned stats beneath it, not a separate section.
    assert.match(output, /5-hour/);
    assert.match(output, /Weekly/);
    assert.match(output, /period /);
    assert.match(output, /total 132/);
    assert.doesNotMatch(output, /sessions/);
    assert.match(output, /total 132\s+in 120\s+out 12\s+cacheRead 12\s+cacheWrite 0/);
    assert.match(output, /total 374/);
    assert.doesNotMatch(output, /Local usage/);
    assert.doesNotMatch(output, /No local usage/);
});

test("formatCommandCodeUsage marks partial sections", () => {
    const output = formatCommandCodeUsage({
        ...successResult,
        usage: { ...successResult.usage!, errors: [{ section: "summary", message: "Request failed (HTTP 503)." }] },
    }).join("\n");

    assert.match(output, /Partial data/);
    assert.match(output, /summary\s+Request failed \(HTTP 503\)/);
});
