import assert from "node:assert/strict";
import test from "node:test";
import {
	formatConsumeResetCreditResult,
	formatCreditChoice,
	formatResetCredits,
} from "../src/reset-format.ts";

const now = new Date("2026-09-04T00:00:00.000Z");

test("formats reset-credit status without exposing opaque ids", () => {
	const text = formatResetCredits({
		availableCount: 2,
		credits: [
			{ id: "secret-credit-1", title: "Weekly reset", expires_at: 1_800_000_000 },
			{ id: "secret-credit-2", title: null, expires_at: null },
		],
	}, now);

	assert.match(text, /2 reset credits available/);
	assert.match(text, /Weekly reset/);
	assert.match(text, /Reset credit · no expiry/);
	assert.doesNotMatch(text, /secret-credit/);
});

test("formats a unique selectable credit label", () => {
	assert.equal(
		formatCreditChoice({ id: "credit-1", title: "Reset", expires_at: 1_800_000_000 }, 0, now),
		"Reset · expires 2027-01-15 · 134d left",
	);
});

test("formats ISO string expiry with the same label rules", () => {
	assert.equal(
		formatCreditChoice(
			{ id: "credit-1", title: "Reset", expires_at: "2026-09-20T23:17:50.706581Z" },
			0,
			new Date("2026-09-04T00:00:00.000Z"),
		),
		"Reset · expires 2026-09-20 · 17d left",
	);
});

test("normalizes the canonical full-reset title and keeps d-left suffix", () => {
	assert.equal(
		formatCreditChoice(
			{ id: "credit-1", title: "Full reset (Weekly + 5 hr)", expires_at: "2026-09-20T23:17:50.706581Z" },
			0,
			new Date("2026-09-04T00:00:00.000Z"),
		),
		"Weekly + 5h reset credits · expires 2026-09-20 · 17d left",
	);
});

test("marks expired credits and invalid strings as no deadline", () => {
	assert.equal(
		formatCreditChoice({ id: "credit-1", title: "Reset", expires_at: "2020-01-01T00:00:00Z" }, 0, now),
		"Reset · expired",
	);
	assert.equal(
		formatCreditChoice({ id: "credit-1", title: "Reset", expires_at: "garbage" }, 0, now),
		"Reset · no expiry",
	);
});

test("formats consume outcomes for the user", () => {
	assert.match(
		formatConsumeResetCreditResult({ status: "success", outcome: "reset" }),
		/consumed/,
	);
	assert.match(
		formatConsumeResetCreditResult({ status: "success", outcome: "nothingToReset" }),
		/no eligible rate-limit window/,
	);
	assert.match(
		formatConsumeResetCreditResult({ status: "error", outcome: null, error: "network failure" }),
		/network failure/,
	);
});
