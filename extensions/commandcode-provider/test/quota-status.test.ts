import assert from "node:assert/strict";
import test from "node:test";
import { formatQuotaStatus } from "../src/quota-status.ts";
import type { CommandCodeQuotaResult } from "../src/quota-types.ts";

const plain = (_color: string, text: string) => text;

test("formats the short Command Code quota window", () => {
	const colors: string[] = [];
	const paint = (color: "success" | "warning" | "error" | "muted", text: string) => {
		colors.push(color);
		return text;
	};
	const status = formatQuotaStatus({
		status: "success",
		quota: { fiveHour: { used: 72, cap: 100, exceeded: false }, weekly: null },
	}, paint);
	assert.equal(status, "CommandCode·5h 28%");
	assert.deepEqual(colors, ["muted", "warning"]);
});

test("falls back to the weekly window when the short window has no cap", () => {
	assert.equal(formatQuotaStatus({
		status: "success",
		quota: { fiveHour: { used: 0, cap: 0, exceeded: false }, weekly: { used: 12, cap: 100, exceeded: false } },
	}, plain), "CommandCode·7d 88%");
});

test("reports expired and unavailable results", () => {
	assert.equal(formatQuotaStatus({ status: "expired", quota: null, error: "Command Code login has expired" }, plain), "CommandCode·login expired");
	assert.equal(formatQuotaStatus({ status: "error", quota: null, error: "network failure" }, plain), "CommandCode·quota unavailable");
});

test("reports unavailable when no usable quota window exists", () => {
	assert.equal(formatQuotaStatus(
		{ status: "success", quota: { fiveHour: null, weekly: null } },
		plain,
	), "CommandCode·quota unavailable");
});

function result(overrides: Partial<CommandCodeQuotaResult>): CommandCodeQuotaResult {
	return {
		status: "success",
		quota: { fiveHour: { used: 10, cap: 100, exceeded: false }, weekly: null },
		...overrides,
	};
}

test("thresholds: <10% is error, <=50% is warning, else success", () => {
	const colorFor = (used: number): string => {
		const colors: string[] = [];
		const paint = (color: string, _text: string) => {
			colors.push(color);
			return "";
		};
		formatQuotaStatus(result({ quota: { fiveHour: { used, cap: 100, exceeded: false }, weekly: null } }), paint as never);
		return colors[1]!;
	};
	assert.equal(colorFor(95), "error");
	assert.equal(colorFor(60), "warning");
	assert.equal(colorFor(10), "success");
});
