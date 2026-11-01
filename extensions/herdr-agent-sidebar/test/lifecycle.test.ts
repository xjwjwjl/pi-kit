import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { createExtensionHarness, stateLabels } from "./harness.ts";

function assertFullLabels(labels: Record<string, string>) {
  assert.deepEqual(Object.keys(labels).sort(), ["blocked", "done", "idle", "unknown", "working"]);
  assert.equal(labels.working, "working");
  assert.equal(labels.blocked, "reply needed");
  assert.equal(labels.idle, "idle");
}

test("TUI session initialization and completion report full Pi-scoped labels", async (t) => {
  const h = createExtensionHarness(t);
  await h.emit("session_start");
  await h.emit("agent_start");
  await h.emit("turn_end", { outcome: "completed" });
  await h.emit("agent_before_settle", { outcome: "completed" });
  assert.equal(h.reports.length, 2, "turn and boundary events must not publish completion early");
  await h.emit("agent_settled");

  assert.equal(h.reports.length, 3);
  assert.equal(stateLabels(h.reports[0]).done, "done");
  const labels = stateLabels(h.reports[2]);
  assertFullLabels(labels);
  assert.match(labels.done, /^done · \d{2}-\d{2} \d{2}:\d{2}$/);
  for (const report of h.reports) {
    assert.equal(report.binary, "/mock/herdr");
    assert.deepEqual(report.args.slice(0, 9), [
      "pane", "report-metadata", "w-test:p-test", "--source", "pi-completion-time",
      "--agent", "pi", "--applies-to-source", "herdr:pi",
    ]);
  }
});

test("aborted turn reports stopped without agent_before_settle", async (t) => {
  const h = createExtensionHarness(t);
  await h.emit("session_start");
  await h.emit("agent_start");
  await h.emit("turn_end", { outcome: "aborted" });
  await h.emit("agent_settled");
  assert.equal(stateLabels(h.reports.at(-1)!).done, "stopped");
});

test("cancellation during a tool overrides a completed turn outcome", async (t) => {
  const h = createExtensionHarness(t);
  const controller = new AbortController();
  await h.emit("session_start");
  h.ctx.signal = controller.signal;
  await h.emit("agent_start");
  controller.abort();
  await h.emit("turn_end", { outcome: "completed" });
  h.ctx.signal = undefined;
  await h.emit("agent_settled");
  assert.equal(stateLabels(h.reports.at(-1)!).done, "stopped");
});

test("cancelling retry backoff reports stopped instead of the preceding error", async (t) => {
  const h = createExtensionHarness(t);
  const controller = new AbortController();
  await h.emit("session_start");
  h.ctx.signal = controller.signal;
  await h.emit("agent_start");
  await h.emit("turn_end", { outcome: "error" });
  // The attempt signal has already been released during backoff. Pi skips the
  // before-settle boundary when the user cancels the outer run.
  h.ctx.signal = undefined;
  await h.emit("agent_settled");
  assert.equal(controller.signal.aborted, false);
  assert.equal(stateLabels(h.reports.at(-1)!).done, "stopped");
});

test("an abort after the before-settle handler still overrides its outcome", async (t) => {
  const h = createExtensionHarness(t);
  const controller = new AbortController();
  await h.emit("session_start");
  h.ctx.signal = controller.signal;
  await h.emit("agent_start");
  await h.emit("agent_before_settle", { outcome: "completed" });
  controller.abort();
  h.ctx.signal = undefined;
  await h.emit("agent_settled");
  assert.equal(stateLabels(h.reports.at(-1)!).done, "stopped");
});

test("a terminal error still reports failed at final settlement", async (t) => {
  const h = createExtensionHarness(t);
  await h.emit("session_start");
  await h.emit("agent_start");
  await h.emit("turn_end", { outcome: "error" });
  await h.emit("agent_before_settle", { outcome: "error" });
  await h.emit("agent_settled");
  assert.equal(stateLabels(h.reports.at(-1)!).done, "failed");
});

test("a successful retry does not inherit the previous attempt outcome or signal", async (t) => {
  const h = createExtensionHarness(t);
  const previous = new AbortController();
  await h.emit("session_start");
  h.ctx.signal = previous.signal;
  await h.emit("agent_start");
  await h.emit("turn_end", { outcome: "error" });
  previous.abort();
  h.ctx.signal = new AbortController().signal;
  await h.emit("agent_start");
  await h.emit("turn_end", { outcome: "completed" });
  await h.emit("agent_before_settle", { outcome: "completed" });
  await h.emit("agent_settled");
  assert.match(stateLabels(h.reports.at(-1)!).done, /^done · /);
});

test("continuation replaces the earlier before-settle outcome", async (t) => {
  const h = createExtensionHarness(t);
  await h.emit("session_start");
  await h.emit("agent_start");
  await h.emit("agent_before_settle", { outcome: "completed" });
  await h.emit("agent_start");
  await h.emit("turn_end", { outcome: "aborted" });
  await h.emit("agent_settled");
  assert.equal(stateLabels(h.reports.at(-1)!).done, "stopped");
});

test("settlement without an observed outcome does not write a completion label", async (t) => {
  const h = createExtensionHarness(t);
  await h.emit("session_start");
  await h.emit("agent_settled");
  assert.equal(h.reports.length, 1);
});

for (const mode of ["rpc", "json", "print"] as const) {
  test(`${mode} mode neither writes metadata nor publishes blocked events`, async (t) => {
    const h = createExtensionHarness(t, { mode });
    await h.emit("session_start");
    await h.emit("agent_start");
    await h.emit("tool_execution_start", { toolName: "ask_user", toolCallId: "q1" });
    await h.emit("tool_execution_end", { toolName: "ask_user", toolCallId: "q1" });
    await h.emit("turn_end", { outcome: "completed" });
    await h.emit("agent_before_settle", { outcome: "completed" });
    await h.emit("agent_settled");
    await h.emit("session_shutdown");
    assert.deepEqual(h.reports, []);
    assert.deepEqual(h.emitted, []);
  });
}

test("outside Herdr the extension has no metadata or blocked-event side effects", async (t) => {
  const h = createExtensionHarness(t, { herdr: false });
  await h.emit("session_start");
  await h.emit("agent_start");
  await h.emit("tool_execution_start", { toolName: "ask_user", toolCallId: "q1" });
  await h.emit("tool_execution_end", { toolName: "ask_user", toolCallId: "q1" });
  await h.emit("turn_end", { outcome: "completed" });
  await h.emit("agent_before_settle", { outcome: "completed" });
  await h.emit("agent_settled");
  await h.emit("session_shutdown");
  assert.deepEqual(h.reports, []);
  assert.deepEqual(h.emitted, []);
});

test("shutdown clears only this source's labels and is idempotent", async (t) => {
  const h = createExtensionHarness(t);
  await h.emit("session_start");
  await h.emit("session_shutdown");
  await h.emit("session_shutdown");
  assert.equal(h.reports.length, 2);
  const cleanup = h.reports[1];
  assert.ok(cleanup.args.includes("--clear-state-labels"));
  assert.equal(cleanup.args[cleanup.args.indexOf("--source") + 1], "pi-completion-time");
  assert.deepEqual(stateLabels(cleanup), {});
  await h.emit("agent_before_settle", { outcome: "completed" });
  await h.emit("agent_settled");
  assert.equal(h.reports.length, 2, "closed sessions must not rewrite labels");
});

test("shutdown drains in-flight reports before clearing labels", async (t) => {
  const h = createExtensionHarness(t, { manualReports: true });
  const starting = h.emit("session_start");
  await setImmediate();
  assert.equal(h.reports.length, 1);
  const shuttingDown = h.emit("session_shutdown");
  await setImmediate();
  assert.equal(h.reports.length, 1, "cleanup must wait for the in-flight write");
  h.reports[0].complete();
  await setImmediate();
  assert.equal(h.reports.length, 2);
  assert.ok(h.reports[1].args.includes("--clear-state-labels"));
  h.reports[1].complete();
  await Promise.all([starting, shuttingDown]);
});

test("a failed in-flight report does not prevent shutdown cleanup", async (t) => {
  const h = createExtensionHarness(t, { manualReports: true });
  const errors: unknown[][] = [];
  t.mock.method(console, "error", (...args: unknown[]) => errors.push(args));
  const starting = h.emit("session_start");
  await setImmediate();
  const shuttingDown = h.emit("session_shutdown");
  h.reports[0].complete(new Error("mock CLI failure"));
  await setImmediate();
  assert.equal(errors.length, 1);
  assert.match(String(errors[0][0]), /mock CLI failure/);
  assert.equal(h.reports.length, 2);
  assert.ok(h.reports[1].args.includes("--clear-state-labels"));
  h.reports[1].complete();
  await Promise.all([starting, shuttingDown]);
});

test("metadata keeps the captured pane target if environment variables change", async (t) => {
  const h = createExtensionHarness(t);
  await h.emit("session_start");
  process.env.HERDR_BIN_PATH = "/another/herdr";
  process.env.HERDR_PANE_ID = "another-pane";
  await h.emit("agent_start");
  await h.emit("agent_before_settle", { outcome: "completed" });
  await h.emit("agent_settled");
  await h.emit("session_shutdown");
  assert.ok(h.reports.every((report) => report.binary === "/mock/herdr"));
  assert.ok(h.reports.every((report) => report.args[2] === "w-test:p-test"));
});

test("shutdown balances an active ask_user blocked signal", async (t) => {
  const h = createExtensionHarness(t);
  await h.emit("session_start");
  await h.emit("tool_execution_start", { toolName: "ask_user", toolCallId: "q1" });
  await h.emit("session_shutdown");
  assert.equal(h.emitted.length, 2, "shutdown itself must publish the unblocked signal");
  await h.emit("tool_execution_end", { toolName: "ask_user", toolCallId: "q1" });
  assert.deepEqual(h.emitted, [
    { channel: "herdr:blocked", data: { active: true, label: "reply needed" } },
    { channel: "herdr:blocked", data: { active: false } },
  ]);
});

test("session replacement drops the previous outcome and blocked calls", async (t) => {
  const h = createExtensionHarness(t);
  await h.emit("session_start");
  await h.emit("agent_start");
  await h.emit("turn_end", { outcome: "error" });
  await h.emit("tool_execution_start", { toolName: "ask_user", toolCallId: "old" });
  await h.emit("session_start");
  await h.emit("agent_settled");
  assert.equal(stateLabels(h.reports.at(-1)!).done, "done");
  await h.emit("tool_execution_start", { toolName: "ask_user", toolCallId: "new" });
  await h.emit("tool_execution_end", { toolName: "ask_user", toolCallId: "old" });
  await h.emit("tool_execution_end", { toolName: "ask_user", toolCallId: "new" });
  assert.deepEqual(h.emitted.map(({ data }) => data), [
    { active: true, label: "reply needed" },
    { active: false },
    { active: true, label: "reply needed" },
    { active: false },
  ]);
});
