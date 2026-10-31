import assert from "node:assert/strict";
import test from "node:test";
import {
	buildCurrentDateHeader,
	getCurrentLocalDate,
	getSystemTimeZone,
	resolveTimeZone,
} from "../temporal.ts";

test("formats the local date in the requested time zone", () => {
	const now = new Date("2026-10-22T06:00:00Z");
	assert.equal(getCurrentLocalDate(now, "Asia/Shanghai"), "2026-10-22");
	assert.equal(getCurrentLocalDate(now, "UTC"), "2026-10-22");
	assert.equal(getCurrentLocalDate(new Date("2026-10-22T18:30:00Z"), "Asia/Shanghai"), "2026-10-23");
});

test("falls back to the system time zone for invalid zones", () => {
	assert.equal(resolveTimeZone("Not/AZone"), getSystemTimeZone());
	assert.equal(resolveTimeZone(undefined), getSystemTimeZone());
	assert.equal(resolveTimeZone("Asia/Shanghai"), "Asia/Shanghai");
});

test("builds a compact current-date header", () => {
	assert.equal(
		buildCurrentDateHeader(new Date("2026-10-22T06:00:00Z"), "Asia/Shanghai"),
		"Current date: 2026-10-22 (Asia/Shanghai)",
	);
});
