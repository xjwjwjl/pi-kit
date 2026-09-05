import assert from "node:assert/strict";
import test from "node:test";
import {
	buildConsumeResetCreditPayload,
	parseConsumeResetCreditResponse,
	parseResetCreditsResponse,
} from "../src/reset-api.ts";

test("builds the reset-credit payload using the backend field names", () => {
	assert.deepEqual(
		buildConsumeResetCreditPayload({ idempotencyKey: "attempt-1", creditId: "credit-1" }),
		{ idempotency_key: "attempt-1", credit_id: "credit-1" },
	);
	assert.deepEqual(
		buildConsumeResetCreditPayload({ idempotencyKey: "attempt-2" }),
		{ idempotency_key: "attempt-2" },
	);
});

test("parses available reset credits and preserves the available count", () => {
	const result = parseResetCreditsResponse({
		available_count: 2,
		total_earned_count: 4,
		credits: [
			{
				id: "credit-1",
				status: "available",
				reset_type: "codex_rate_limits",
				expires_at: 1_800_000_000,
				title: "Weekly reset",
			},
			{ id: "credit-2", status: "available" },
			{ invalid: true },
		],
	});

	assert.equal(result.availableCount, 2);
	assert.equal(result.totalEarnedCount, 4);
	assert.equal(result.credits.length, 2);
	assert.equal(result.credits[0]?.id, "credit-1");
	assert.equal(result.credits[0]?.title, "Weekly reset");
});

test("falls back to the number of valid credit rows when the count is omitted", () => {
	const result = parseResetCreditsResponse({ credits: [{ id: "credit-1" }, { id: "credit-2" }] });
	assert.equal(result.availableCount, 2);
});

test("normalizes ISO string timestamps to epoch seconds", () => {
	const result = parseResetCreditsResponse({
		credits: [
			{
				id: "credit-iso",
				title: "Full reset",
				granted_at: "2026-08-21T23:17:50.706581Z",
				expires_at: "2026-09-20T23:17:50.706581Z",
			},
		],
	});

	assert.equal(result.credits.length, 1);
	assert.equal(result.credits[0]!.granted_at, 1787354270);
	assert.equal(result.credits[0]!.expires_at, 1789946270);
});

test("keeps null expiry explicit and rejects invalid timestamps", () => {
	const result = parseResetCreditsResponse({
		credits: [
			{ id: "credit-null", expires_at: null },
			{ id: "credit-invalid", expires_at: "not-a-date" },
			{ id: "credit-missing" },
			{ id: "credit-num", expires_at: 1788895070 },
		],
	});

	assert.equal(result.credits[0]!.expires_at, null);
	assert.equal(result.credits[1]!.expires_at, undefined);
	assert.equal(result.credits[2]!.expires_at, undefined);
	assert.equal(result.credits[3]!.expires_at, 1788895070);
});

test("accepts every documented consume outcome and rejects unknown outcomes", () => {
	for (const outcome of ["reset", "nothingToReset", "noCredit", "alreadyRedeemed"] as const) {
		assert.equal(parseConsumeResetCreditResponse({ outcome }), outcome);
	}
	assert.throws(
		() => parseConsumeResetCreditResponse({ outcome: "unexpected" }),
		/invalid reset-credit consume response/,
	);
});
