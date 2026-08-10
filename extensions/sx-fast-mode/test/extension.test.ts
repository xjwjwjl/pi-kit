/**
 * Unit tests for sx-fast-mode extension.
 *
 * Verifies the before_provider_request payload rewrite logic and
 * the /fast command behavior.
 */

import assert from "node:assert/strict";
import test from "node:test";
import sxFastMode from "../index.ts";

// ── Helpers ────────────────────────────────────────────────────────────

type HandlerMap = Map<string, (event: unknown, ctx: unknown) => unknown>;
type CommandMap = Map<string, { handler: (args: string, ctx: unknown) => void | Promise<void> }>;

function fakePi(): {
  pi: Record<string, unknown>;
  handlers: HandlerMap;
  commands: CommandMap;
} {
  const handlers: HandlerMap = new Map();
  const commands: CommandMap = new Map();

  const pi = {
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
      handlers.set(event, handler);
    },
    registerCommand(name: string, config: { handler: (args: string, ctx: unknown) => void }) {
      commands.set(name, config);
    },
  };

  return { pi, handlers, commands };
}

function fakeCtx(overrides: Record<string, unknown> = {}) {
  const notifications: Array<{ text: string; level: string }> = [];
  const statuses: Map<string, string | undefined> = new Map();

  return {
    ctx: {
      model: overrides.model,
      ui: {
        notify(text: string, level: string) {
          notifications.push({ text, level });
        },
        setStatus(key: string, text: string | undefined) {
          statuses.set(key, text);
        },
        getStatus(key: string) {
          return statuses.get(key);
        },
      },
    },
    notifications,
    statuses,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────

test("before_provider_request: injects service_tier for sx provider when fast mode is ON", async () => {
  const { pi, handlers, commands } = fakePi();
  sxFastMode(pi as never);

  const { ctx, notifications } = fakeCtx({
    model: { provider: "sx", id: "gpt-5.6-luna" },
  });

  // Enable fast mode via command
  const fastCmd = commands.get("fast");
  assert.ok(fastCmd);
  await fastCmd.handler("on", ctx);
  assert.equal(notifications[0]?.text, "SX Fast mode enabled — requests will use service_tier: priority");

  // Now test the hook
  const hook = handlers.get("before_provider_request");
  assert.ok(hook);

  const payload = { model: "gpt-5.6-luna", messages: [{ role: "user", content: "hi" }] };
  const result = hook({ payload }, ctx);

  assert.deepEqual(result, { ...payload, service_tier: "priority" });
});

test("before_provider_request: does NOT inject when fast mode is OFF", async () => {
  const { pi, handlers, commands } = fakePi();
  sxFastMode(pi as never);

  const { ctx } = fakeCtx({
    model: { provider: "sx", id: "gpt-5.6-luna" },
  });

  // Ensure OFF (default)
  const fastCmd = commands.get("fast");
  await fastCmd?.handler("off", ctx);

  const hook = handlers.get("before_provider_request");
  const payload = { model: "gpt-5.6-luna", messages: [{ role: "user", content: "hi" }] };
  const result = hook({ payload }, ctx);

  assert.equal(result, undefined); // no rewrite
});

test("before_provider_request: does NOT inject for non-sx providers", async () => {
  const { pi, handlers, commands } = fakePi();
  sxFastMode(pi as never);

  const { ctx } = fakeCtx({
    model: { provider: "deepseek", id: "deepseek-v4-flash" },
  });

  // Enable fast mode
  const fastCmd = commands.get("fast");
  await fastCmd?.handler("on", ctx);

  const hook = handlers.get("before_provider_request");
  const payload = { model: "deepseek-v4-flash", messages: [{ role: "user", content: "hi" }] };
  const result = hook({ payload }, ctx);

  assert.equal(result, undefined); // should not inject
});

test("before_provider_request: does NOT override existing service_tier", async () => {
  const { pi, handlers, commands } = fakePi();
  sxFastMode(pi as never);

  const { ctx } = fakeCtx({
    model: { provider: "sx", id: "gpt-5.6-luna" },
  });

  await commands.get("fast")?.handler("on", ctx);

  const hook = handlers.get("before_provider_request");
  const payload = {
    model: "gpt-5.6-luna",
    messages: [{ role: "user", content: "hi" }],
    service_tier: "auto",
  };
  const result = hook({ payload }, ctx);

  assert.equal(result, undefined); // should not override
});

test("before_provider_request: returns undefined when ctx.model is missing", async () => {
  const { pi, handlers, commands } = fakePi();
  sxFastMode(pi as never);

  const { ctx } = fakeCtx({ model: undefined });
  await commands.get("fast")?.handler("on", ctx);

  const hook = handlers.get("before_provider_request");
  const result = hook({ payload: { messages: [] } }, ctx);

  assert.equal(result, undefined);
});

test("/fast status: shows correct state", async () => {
  const { pi, commands } = fakePi();
  sxFastMode(pi as never);

  const { ctx, notifications } = fakeCtx();
  const fastCmd = commands.get("fast");
  assert.ok(fastCmd);

  // Reset to known state — module-level fastMode leaks across tests
  await fastCmd.handler("off", ctx);
  notifications.length = 0;

  await fastCmd.handler("status", ctx);
  assert.match(notifications[0]?.text ?? "", /OFF/);

  notifications.length = 0;
  await fastCmd.handler("on", ctx);
  await fastCmd.handler("status", ctx);
  assert.match(notifications[1]?.text ?? "", /ON/);

  notifications.length = 0;
  await fastCmd.handler("off", ctx);
  await fastCmd.handler("status", ctx);
  assert.match(notifications[1]?.text ?? "", /OFF/);
});

test("session_start: footer shows SX Fast: ON when enabled", async () => {
  const { pi, handlers, commands } = fakePi();
  sxFastMode(pi as never);

  const { ctx, statuses } = fakeCtx();

  // Enable fast mode first
  await commands.get("fast")?.handler("on", ctx);

  // Simulate session_start
  const sessionStart = handlers.get("session_start");
  assert.ok(sessionStart);
  sessionStart({}, ctx);

  assert.equal(statuses.get("sx-fast"), "SX Fast: ON");
});

test("session_start: footer is cleared when fast mode is OFF", async () => {
  const { pi, handlers, commands } = fakePi();
  sxFastMode(pi as never);

  const { ctx, statuses } = fakeCtx();

  // Reset to known state — module-level fastMode leaks across tests
  await commands.get("fast")?.handler("off", ctx);

  const sessionStart = handlers.get("session_start");
  assert.ok(sessionStart);
  sessionStart({}, ctx);

  assert.equal(statuses.get("sx-fast"), undefined);
});
