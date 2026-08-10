import assert from "node:assert/strict";
import test from "node:test";
import codexQuota from "../index.ts";

test("cleans up its idle refresh timer on replacement and shutdown", async () => {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => void | Promise<void>>();
  const timers: Array<{ callback: () => void; delay: number; cleared: boolean; unrefed: boolean }> = [];
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;

  globalThis.setInterval = ((callback: () => void, delay: number) => {
    const timer = { callback, delay, cleared: false, unrefed: false, unref() { this.unrefed = true; } };
    timers.push(timer);
    return timer as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval;
  globalThis.clearInterval = ((timer: { cleared?: boolean }) => {
    timer.cleared = true;
  }) as typeof clearInterval;

  try {
    codexQuota({
      on(event: string, handler: (event: unknown, ctx: unknown) => void | Promise<void>) {
        handlers.set(event, handler);
      },
      events: { on() {} },
    } as never);

    const ctx = {
      hasUI: false,
      isIdle: () => true,
      modelRegistry: { authStorage: { get: () => undefined } },
      ui: { setStatus() {}, theme: { fg: (_color: string, text: string) => text } },
    };
    const sessionStart = handlers.get("session_start");
    const sessionShutdown = handlers.get("session_shutdown");
    assert.ok(sessionStart);
    assert.ok(sessionShutdown);

    await sessionStart({}, ctx);
    assert.equal(timers.length, 1);
    assert.equal(timers[0].delay, 3 * 60 * 1000);
    assert.equal(timers[0].unrefed, true);

    await sessionStart({}, ctx);
    assert.equal(timers[0].cleared, true);
    assert.equal(timers.length, 2);

    await sessionShutdown({}, ctx);
    assert.equal(timers[1].cleared, true);
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});
