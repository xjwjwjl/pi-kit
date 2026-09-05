import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchCommandCodeUsage, fetchCommandCodeQuota, toCommandCodeQuotaResult, type FetchFn } from "../src/usage-api.ts";

function jsonResponse(value: unknown, status = 200): Response {
    return new Response(JSON.stringify(value), {
        status,
        headers: { "content-type": "application/json" },
    });
}

test("fetchCommandCodeUsage loads personal account data and billing-period summary", async () => {
    const calls: Array<{ path: string; authorization: string | null }> = [];
    const fetchFn = (async (input, init) => {
        const url = new URL(String(input));
        calls.push({
            path: `${url.pathname}${url.search}`,
            authorization: new Headers(init?.headers).get("authorization"),
        });

        if (url.pathname === "/alpha/whoami") {
            return jsonResponse({
                success: true,
                user: { id: "user-1", name: "Lin", email: "lin@example.com", userName: "lin" },
                org: null,
            });
        }
        if (url.pathname === "/alpha/billing/credits") {
            return jsonResponse({
                credits: { monthlyCredits: 80, purchasedCredits: 10, freeCredits: 2 },
                windowLimits: {
                    limited: true,
                    exceeded: false,
                    fiveHour: { used: 20, cap: 100, exceeded: false, resetAt: 1_800_000_000_000 },
                    weekly: { used: 40, cap: 200, exceeded: false, resetAt: 1_800_000_000_000 },
                },
            });
        }
        if (url.pathname === "/alpha/billing/subscriptions") {
            return jsonResponse({
                success: true,
                data: {
                    status: "active",
                    planId: "individual-pro",
                    currentPeriodStart: "2026-09-01T00:00:00.000Z",
                    currentPeriodEnd: "2026-10-01T00:00:00.000Z",
                },
            });
        }
        if (url.pathname === "/alpha/usage/summary") {
            assert.equal(url.searchParams.get("since"), "2026-09-01T00:00:00.000Z");
            return jsonResponse({ totalCount: 12, completedCount: 11, failedCount: 1, totalTokens: 1234, totalCost: 4.5, totalCredits: 3.2 });
        }
        return jsonResponse({ error: "unexpected path" }, 404);
    }) as FetchFn;

    const result = await fetchCommandCodeUsage(
        { access: "test-key" },
        new AbortController().signal,
        fetchFn,
    );

    assert.equal(result.status, "success");
    assert.ok(result.usage);
    assert.equal(result.usage.user.email, "lin@example.com");
    assert.equal(result.usage.credits?.credits.monthlyCredits, 80);
    assert.equal(result.usage.subscription?.planId, "individual-pro");
    assert.equal(result.usage.summary?.totalTokens, 1234);
    assert.deepEqual(result.usage.errors, []);
    assert.ok(calls.every((call) => call.authorization === "Bearer test-key"));
    assert.deepEqual(
        calls.map((call) => call.path).sort(),
        [
            "/alpha/billing/credits",
            "/alpha/billing/subscriptions",
            "/alpha/usage/summary?since=2026-09-01T00%3A00%3A00.000Z",
            "/alpha/whoami",
        ].sort(),
    );
});

test("fetchCommandCodeUsage keeps partial data when one section fails", async () => {
    const fetchFn = (async (input) => {
        const path = new URL(String(input)).pathname;
        if (path === "/alpha/whoami") return jsonResponse({ user: { email: "lin@example.com" }, org: null });
        if (path === "/alpha/billing/credits") return jsonResponse({ error: "temporarily unavailable" }, 503);
        if (path === "/alpha/billing/subscriptions") return jsonResponse({ data: { status: "active", planId: "individual-go" } });
        return jsonResponse({ totalCount: 2, totalTokens: 100 });
    }) as FetchFn;

    const result = await fetchCommandCodeUsage(
        { access: "test-key" },
        new AbortController().signal,
        fetchFn,
    );

    assert.equal(result.status, "success");
    assert.ok(result.usage);
    assert.equal(result.usage.credits, null);
    assert.equal(result.usage.summary?.totalCount, 2);
    assert.deepEqual(result.usage.errors.map((error) => error.section), ["credits"]);
    assert.match(result.usage.errors[0]!.message, /HTTP 503/);
});

test("fetchCommandCodeUsage reports authentication failure from whoami", async () => {
    const fetchFn = (async () => jsonResponse({ error: "unauthorized" }, 401)) as FetchFn;
    const result = await fetchCommandCodeUsage(
        { access: "test-key" },
        new AbortController().signal,
        fetchFn,
    );

    assert.equal(result.status, "error");
    assert.equal(result.usage, null);
    assert.match(result.error ?? "", /\/login commandcode/);
});

test("fetchCommandCodeUsage does not call the API for an expired credential", async () => {
    let calls = 0;
    const fetchFn = (async () => {
        calls++;
        return jsonResponse({});
    }) as FetchFn;

    const result = await fetchCommandCodeUsage(
        { access: "test-key", expires: Date.now() - 1 },
        new AbortController().signal,
        fetchFn,
    );

    assert.equal(result.status, "expired");
    assert.equal(calls, 0);
});

test("fetchCommandCodeQuota requests only credits and returns quota windows", async () => {
    const paths: string[] = [];
    const fetchFn = (async (input) => {
        const url = new URL(String(input));
        paths.push(url.pathname);
        return jsonResponse({
            credits: { monthlyCredits: 80, purchasedCredits: 10, freeCredits: 2 },
            windowLimits: {
                fiveHour: { used: 20, cap: 100, exceeded: false, resetAt: 1_800_000_000_000 },
                weekly: { used: 40, cap: 200, exceeded: false, resetAt: 1_800_000_000_000 },
            },
        });
    }) as FetchFn;

    const result = await fetchCommandCodeQuota(
        { access: "test-key" },
        new AbortController().signal,
        fetchFn,
    );

    assert.equal(result.status, "success");
    assert.deepEqual(paths, ["/alpha/billing/credits"]);
    assert.equal(result.quota?.fiveHour?.used, 20);
    assert.equal(result.quota?.fiveHour?.cap, 100);
    assert.equal(result.quota?.weekly?.cap, 200);
});

test("fetchCommandCodeQuota maps a missing windowLimits to null quota", async () => {
    const fetchFn = (async () => jsonResponse({ credits: { monthlyCredits: 80 } })) as FetchFn;
    const result = await fetchCommandCodeQuota(
        { access: "test-key" },
        new AbortController().signal,
        fetchFn,
    );

    assert.equal(result.status, "success");
    assert.equal(result.quota, null);
});

test("fetchCommandCodeQuota reports an expired credential without an API call", async () => {
    let calls = 0;
    const fetchFn = (async () => { calls += 1; return jsonResponse({}); }) as FetchFn;
    const result = await fetchCommandCodeQuota(
        { access: "test-key", expires: Date.now() - 1 },
        new AbortController().signal,
        fetchFn,
    );

    assert.equal(result.status, "expired");
    assert.equal(calls, 0);
});

test("toCommandCodeQuotaResult derives quota from a successful usage result", () => {
    const result = toCommandCodeQuotaResult({
        status: "success",
        usage: {
            user: { email: "lin@example.com" },
            org: null,
            credits: {
                credits: { monthlyCredits: 80 },
                windowLimits: { fiveHour: { used: 20, cap: 100, exceeded: false }, weekly: null },
            },
            subscription: null,
            summary: null,
            errors: [],
            observedAt: new Date(),
        },
    });
    assert.equal(result.status, "success");
    assert.equal(result.quota?.fiveHour?.used, 20);
    assert.equal(result.quota?.weekly, null);
});

test("toCommandCodeQuotaResult maps a failed usage result to error", () => {
    const result = toCommandCodeQuotaResult({ status: "error", usage: null, error: "network failure" });
    assert.equal(result.status, "error");
    assert.equal(result.quota, null);
});

test("toCommandCodeQuotaResult maps an expired usage result to expired", () => {
    const result = toCommandCodeQuotaResult({ status: "expired", usage: null, error: "login expired" });
    assert.equal(result.status, "expired");
    assert.equal(result.quota, null);
});
