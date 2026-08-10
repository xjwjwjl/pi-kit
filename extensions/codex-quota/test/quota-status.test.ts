import assert from "node:assert/strict";
import test from "node:test";
import { formatQuotaStatus } from "../index.ts";

const plain = (_color: string, text: string) => text;

test("formats the short Codex quota window with its threshold color", () => {
  const colors: string[] = [];
  const paint = (color: string, text: string) => {
    colors.push(color);
    return text;
  };
  const status = formatQuotaStatus({
    usage: { rate_limit: { primary_window: { used_percent: 72, limit_window_seconds: 18_000 } } },
  }, paint);

  assert.equal(status, "Codex·5h 72%");
  assert.deepEqual(colors, ["muted", "warning"]);
});

test("falls back to the long window when the short window has no percentage", () => {
  assert.equal(formatQuotaStatus({
    usage: {
      rate_limit: {
        primary_window: { limit_window_seconds: 18_000 },
        secondary_window: { used_percent: 12, limit_window_seconds: 604_800 },
      },
    },
  }, plain), "Codex·7d 12%");
});

test("reports unavailable quota without usage data", () => {
  assert.equal(formatQuotaStatus({ usage: null, error: true }, plain), "Codex·quota unavailable");
});
