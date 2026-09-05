import assert from "node:assert/strict";
import test from "node:test";
import { QuotaController } from "../src/quota-controller.ts";

const ctx = {
	hasUI: false,
	ui: { setStatus() {}, theme: { fg: (_color: string, text: string) => text } },
} as never;

test("cleans up its idle refresh timer on replacement and shutdown", () => {
	const timers: Array<{ callback: () => void; delay: number; cleared: boolean; unrefed: boolean }> = [];
	const originalSetTimeout = globalThis.setTimeout;
	const originalClearTimeout = globalThis.clearTimeout;
	const originalDateNow = Date.now;
	Date.now = () => Date.UTC(2026, 7, 25, 12, 3, 0);
	globalThis.setTimeout = ((callback: () => void, delay: number) => {
		const timer = { callback, delay, cleared: false, unrefed: false, unref() { this.unrefed = true; } };
		timers.push(timer);
		return timer as unknown as ReturnType<typeof setTimeout>;
	}) as typeof setTimeout;
	globalThis.clearTimeout = ((timer: { cleared?: boolean }) => { timer.cleared = true; }) as typeof clearTimeout;

	try {
		const controller = new QuotaController({ readCredential: () => null });
		controller.start(ctx);
		assert.equal(timers.length, 1);
		assert.equal(timers[0]!.delay, 2 * 60 * 1000);
		assert.equal(timers[0]!.unrefed, true);
		controller.start(ctx);
		assert.equal(timers[0]!.cleared, true);
		assert.equal(timers.length, 2);
		controller.stop(ctx);
		assert.equal(timers[1]!.cleared, true);
	} finally {
		globalThis.setTimeout = originalSetTimeout;
		globalThis.clearTimeout = originalClearTimeout;
		Date.now = originalDateNow;
	}
});
