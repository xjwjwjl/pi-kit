import assert from "node:assert/strict";
import test from "node:test";
import { formatQuotaStatus } from "../src/quota-status.ts";

const plain = (_color: string, text: string) => text;

test("formats the short Codex quota window", () => {
	const colors: string[] = [];
	const paint = (color: "success" | "warning" | "error" | "muted", text: string) => {
		colors.push(color);
		return text;
	};
	const status = formatQuotaStatus({
		status: "success",
		usage: { rate_limit: { primary_window: { used_percent: 72, limit_window_seconds: 18_000 } } },
	}, paint);
	assert.equal(status, "Codex·5h 28%");
	assert.deepEqual(colors, ["muted", "warning"]);
});

test("falls back to the long window when the short window has no percentage", () => {
	assert.equal(formatQuotaStatus({
		status: "success",
		usage: {
			rate_limit: {
				primary_window: { limit_window_seconds: 18_000 },
				secondary_window: { used_percent: 12, limit_window_seconds: 604_800 },
			},
		},
	}, plain), "Codex·7d 88%");
});

test("reports expired and unavailable results", () => {
	assert.equal(formatQuotaStatus({ status: "expired", usage: null, error: "OAuth token expired" }, plain), "Codex·token expired");
	assert.equal(formatQuotaStatus({ status: "error", usage: null, error: "network failure" }, plain), "Codex·quota unavailable");
});
