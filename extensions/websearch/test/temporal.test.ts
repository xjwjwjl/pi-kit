import assert from "node:assert/strict";
import test from "node:test";
import {
	addCurrentDateContext,
	buildCurrentDateInstruction,
	getCurrentLocalDate,
	resolveTimeZone,
} from "../temporal.ts";

const FIXED_DATE = new Date("2026-07-16T00:30:00Z");

test("formats dates in the requested IANA time zone", () => {
	assert.equal(getCurrentLocalDate(FIXED_DATE, "Asia/Shanghai"), "2026-07-16");
	assert.equal(getCurrentLocalDate(FIXED_DATE, "America/Los_Angeles"), "2026-07-15");
});

test("uses a valid system-zone fallback for invalid configured zones", () => {
	assert.notEqual(resolveTimeZone("Not/A_Real_Time_Zone"), "Not/A_Real_Time_Zone");
});

test("adds date and time-zone context for relative-time requests", () => {
	const corrected = addCurrentDateContext("武汉 2025年7月 今日天气", FIXED_DATE, "Asia/Shanghai");
	assert.match(corrected, /2026-07-16 \(Asia\/Shanghai\)/);
	assert.match(corrected, /conflicting historical date/i);
	assert.match(addCurrentDateContext("武汉明天天气", FIXED_DATE, "Asia/Shanghai"), /2026-07-16 \(Asia\/Shanghai\)/);
	assert.equal(addCurrentDateContext("武汉 2025年7月11日天气", FIXED_DATE, "Asia/Shanghai"), "武汉 2025年7月11日天气");
	assert.match(buildCurrentDateInstruction(FIXED_DATE, "Asia/Shanghai"), /2026-07-16 \(Asia\/Shanghai\)/);
});
