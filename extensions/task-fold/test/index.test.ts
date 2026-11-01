import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AssistantMessageComponent, InteractiveMode } from "@earendil-works/pi-coding-agent";
import { MouseRegion, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { ActivityView } from "../src/activity-view.ts";
import { assistant, makeHarness, result, successfulTask, user } from "./harness.ts";

const LEFT_100 = "─".repeat(42);
const RIGHT_100 = "─".repeat(44);
const COLLAPSED_100 = ` ▹ ${LEFT_100} Workings ${RIGHT_100}`;
const EXPANDED_100 = ` ▿ ${LEFT_100} Workings ${RIGHT_100}`;

async function start(options: { agentDir?: string; hintSeen?: boolean } = {}) {
  const harness = makeHarness("tui", options);
  await harness.emit("session_start");
  assert.deepEqual(harness.notices, []);
  return harness;
}

async function close(harness: ReturnType<typeof makeHarness>) {
  await harness.emit("session_shutdown");
  harness.cleanup();
}

function summaryText(view: ActivityView): string {
  return stripTerminalSequences(view.render(100)[1] ?? "").trimEnd();
}

async function activityTask(
  h: ReturnType<typeof makeHarness>,
  options: {
    suffix: string;
    thinking?: boolean;
    tools?: number;
    failures?: number;
    finalText?: string;
  },
) {
  await h.emit("agent_start");
  h.manager.appendMessage(user(`prompt-${options.suffix}`));
  const toolCount = options.tools ?? 0;
  const content: any[] = [];
  if (options.thinking) content.push({ type: "thinking", thinking: `THINKING-${options.suffix}` });
  content.push({ type: "text", text: `progress-${options.suffix}` });
  for (let index = 0; index < toolCount; index++) {
    content.push({
      type: "toolCall",
      id: `${options.suffix}-tool-${index}`,
      name: `tool-${options.suffix}-${index}`,
      arguments: { index },
    });
  }
  if (toolCount > 0) {
    h.manager.appendMessage(assistant(content, "toolUse"));
    for (let index = 0; index < toolCount; index++) {
      h.manager.appendMessage(result(
        `${options.suffix}-tool-${index}`,
        `OUTPUT-${options.suffix}-${index}`,
        index < (options.failures ?? 0),
      ));
    }
  } else {
    h.manager.appendMessage(assistant(content));
  }
  if (options.finalText !== undefined) {
    h.manager.appendMessage(assistant([{ type: "text", text: options.finalText }]));
  }
  h.rebuild();
  await h.emit("agent_settled", { aborted: false });
}

test("folds before the activity, preserves prose and transcript, and toggles the whole row", async () => {
  const h = await start();
  try {
    const task = await successfulTask(h, "one");
    const before = JSON.stringify(h.manager.getBranch());
    const beforeSummary = h.text();
    assert.match(beforeSummary, /THINKING-one/);
    assert.match(beforeSummary, /OUTPUT-one/);
    assert.doesNotMatch(beforeSummary, /─/);

    await h.emit("agent_settled", { aborted: false });
    const rendered = h.text();
    const lines = h.mode.chatContainer.render(100).map(stripTerminalSequences);
    const userIndex = lines.findIndex((line) => line.includes("USER: prompt-one"));
    const progressIndex = lines.findIndex((line) => line.includes("progress-one"));
    const answerIndex = lines.findIndex((line) => line.includes("answer-one"));
    const summaryIndex = lines.findIndex((line) => line.includes("Workings"));
    assert.ok(summaryIndex > userIndex && summaryIndex < progressIndex && summaryIndex < answerIndex,
      "rail must open the turn before activity and the answer");
    assert.equal(lines[summaryIndex - 1], "", "rail must keep one blank line after the user prompt");
    assert.equal(summaryText(h.summaries()[0]!), COLLAPSED_100);
    assert.match(rendered, /progress-one/);
    assert.match(rendered, /answer-one/);
    assert.doesNotMatch(rendered, /THINKING-one|FINAL-THINKING-one|ARGS-one|OUTPUT-one/);
    assert.equal(JSON.stringify(h.manager.getBranch()), before);
    assert.equal((h.assistants()[0] as any).lastMessage, task.first);
    assert.deepEqual(h.tools()[0]!.render(100), []);

    const summary = h.summaries()[0]!;
    assert.deepEqual(summary.handleMouse({ type: "click", button: "left", y: 1 } as never), { handled: true, focus: true });
    assert.equal(summaryText(summary), EXPANDED_100);
    assert.match(h.text(), /THINKING-one/);
    assert.match(h.text(), /OUTPUT-one/);
    assert.equal(JSON.stringify(h.manager.getBranch()), before);

    summary.handleInput("\r");
    assert.equal(summaryText(summary), COLLAPSED_100);
    summary.handleInput(" ");
    assert.equal(summaryText(summary), EXPANDED_100);
  } finally { await close(h); }
});

test("centered Workings rail covers all content combinations", async () => {
  const summaries: string[] = [];
  for (const options of [
    { suffix: "both", thinking: true, tools: 12, finalText: "done-both" },
    { suffix: "tools", tools: 12, finalText: "done-tools" },
    { suffix: "thinking", thinking: true, finalText: "done-thinking" },
    { suffix: "neither", finalText: "done-neither" },
  ]) {
    const h = await start();
    try {
      await activityTask(h, options);
      const summary = h.summaries()[0];
      summaries.push(summary ? summaryText(summary) : "<none>");
      if (summary) {
        assert.equal((summaryText(summary).match(/─/g) ?? []).length, 86);
        assert.match(summaryText(summary), /─{42} Workings ─{44}/);
        assert.match(summaryText(summary), /─+ Workings ─+/);
      }
      if (options.suffix === "neither") {
        assert.equal(h.summaries().length, 0);
        assert.doesNotMatch(h.text(), /─/);
      }
    } finally { await close(h); }
  }
  assert.deepEqual(summaries, [
    COLLAPSED_100,
    COLLAPSED_100,
    COLLAPSED_100,
    "<none>",
  ]);
});

test("rail renders as a full-width tool-row cell", async () => {
  const h = await start();
  try {
    await activityTask(h, { suffix: "box", thinking: true, tools: 1, finalText: "done" });
    const summary = h.summaries()[0]!;
    const backgrounds: Array<{ color: string; text: string }> = [];
    h.ctx.ui.theme.bg = (color: string, text: string) => {
      backgrounds.push({ color, text });
      return text;
    };
    summary.invalidate();
    const lines = summary.render(60);
    assert.equal(lines.length, 2);
    assert.equal(backgrounds.length, 1);
    assert.equal(backgrounds[0]!.color, "toolPendingBg");
    assert.equal(visibleWidth(stripTerminalSequences(backgrounds[0]!.text)), 60);
    const plain = stripTerminalSequences(backgrounds[0]!.text);
    assert.ok(plain.startsWith(" "));
    assert.ok(plain.endsWith(" "));
    assert.match(plain, /─{22} Workings ─{24}/);
  } finally { await close(h); }
});

test("tool failures do not alter the collapsed rail", async () => {
  for (const failures of [1, 2]) {
    const h = await start();
    try {
      await activityTask(h, { suffix: `failure-${failures}`, thinking: true, tools: 12, failures, finalText: "done" });
      const summary = h.summaries()[0]!;
      assert.equal(summaryText(summary), COLLAPSED_100);
      assert.doesNotMatch(summaryText(summary), /failed|\d/);

      const calls: Array<{ kind: "fg"; color: string; text: string }> = [];
      h.ctx.ui.theme.fg = (color: string, text: string) => {
        calls.push({ kind: "fg", color, text });
        return text;
      };
      summary.invalidate();
      summary.render(100);
      assert.ok(calls.some((call) => call.color === "muted" && call.text === "▹ "));
      assert.equal(calls.filter((call) => call.color === "dim" && call.text === LEFT_100).length, 1);
      assert.equal(calls.filter((call) => call.color === "dim" && call.text === RIGHT_100).length, 1);
      assert.ok(calls.some((call) => call.color === "muted" && call.text === "Workings"));
      assert.ok(!calls.some((call) => call.color === "error"));
      assert.ok(!calls.some((call) => call.text.includes("failed")));
    } finally { await close(h); }
  }
});

test("expanding restores native thinking and tools in their original positions", async () => {
  const h = await start();
  try {
    await h.emit("agent_start");
    h.manager.appendMessage(user("order"));
    h.manager.appendMessage(assistant([
      { type: "thinking", thinking: "FIRST-THINK" },
      { type: "toolCall", id: "order-1", name: "alpha", arguments: { one: 1 } },
    ], "toolUse"));
    h.manager.appendMessage(result("order-1", "ALPHA-OUT"));
    h.manager.appendMessage(assistant([
      { type: "thinking", thinking: "SECOND-THINK" },
      { type: "toolCall", id: "order-2", name: "beta", arguments: { two: 2 } },
    ], "toolUse"));
    h.manager.appendMessage(result("order-2", "BETA-FAILED", true));
    h.manager.appendMessage(assistant([{ type: "text", text: "final-order" }]));
    h.rebuild();
    await h.emit("agent_settled", { aborted: false });
    assert.equal((h.text().match(/Workings/g) ?? []).length, 1);

    await h.command();
    const rendered = h.text();
    const indexes = ["FIRST-THINK", "ALPHA-OUT", "SECOND-THINK", "BETA-FAILED", "final-order"]
      .map((value) => rendered.indexOf(value));
    assert.ok(indexes.every((index) => index >= 0), indexes.join(","));
    assert.deepEqual(indexes, [...indexes].sort((a, b) => a - b));
    assert.ok(rendered.indexOf("USER: order") < rendered.indexOf("Workings"));
    assert.ok(rendered.indexOf("Workings") < rendered.indexOf("FIRST-THINK"));
    assert.equal((rendered.match(/Workings/g) ?? []).length, 1);
    assert.equal((rendered.match(/ALPHA-OUT/g) ?? []).length, 1);
    assert.equal((rendered.match(/BETA-FAILED/g) ?? []).length, 1);
  } finally { await close(h); }
});

test("the first-use hint appears once, disappears after expansion, and persists", async () => {
  const agentDir = mkdtempSync(join(tmpdir(), "task-fold-hint-"));
  const first = makeHarness("tui", { agentDir, hintSeen: false });
  let second: ReturnType<typeof makeHarness> | undefined;
  try {
    await first.emit("session_start");
    await activityTask(first, { suffix: "hint", tools: 1, finalText: "done" });
    const summary = first.summaries()[0]!;
    assert.match(summaryText(summary), /click or press Enter to expand$/);

    summary.handleMouse({ type: "click", button: "left", y: 1 } as never);
    assert.doesNotMatch(summaryText(summary), /click or press Enter/);
    assert.deepEqual(JSON.parse(readFileSync(join(agentDir, "task-fold.json"), "utf8")), { hintSeen: true });
    await close(first);

    second = makeHarness("tui", { agentDir });
    await second.emit("session_start");
    await activityTask(second, { suffix: "later", tools: 1, finalText: "done" });
    assert.doesNotMatch(summaryText(second.summaries()[0]!), /click or press Enter/);
  } finally {
    first.cleanup();
    if (second) await close(second);
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("only the first visible folded row carries the first-use hint", async () => {
  const h = await start({ hintSeen: false });
  try {
    await activityTask(h, { suffix: "first-hint", tools: 1, finalText: "one" });
    await activityTask(h, { suffix: "second-hint", tools: 1, finalText: "two" });
    const [first, second] = h.summaries();
    assert.match(summaryText(first!), /click or press Enter/);
    assert.doesNotMatch(summaryText(second!), /click or press Enter/);
  } finally { await close(h); }
});

test("Enter, Space, Escape, and per-turn expansion state work independently", async () => {
  const h = await start();
  try {
    await activityTask(h, { suffix: "a", tools: 1, finalText: "a" });
    await activityTask(h, { suffix: "b", tools: 1, finalText: "b" });
    const [first, second] = h.summaries();
    h.mode.ui.setFocus(first!);

    first!.handleInput("\r");
    assert.equal(summaryText(first!), EXPANDED_100);
    assert.equal(summaryText(second!), COLLAPSED_100);
    first!.handleInput(" ");
    assert.equal(summaryText(first!), COLLAPSED_100);
    second!.handleInput(" ");
    assert.equal(summaryText(second!), EXPANDED_100);
    assert.equal(summaryText(first!), COLLAPSED_100);
    second!.handleInput("\u001b");
    assert.equal(summaryText(second!), COLLAPSED_100);
    assert.equal(h.mode.focused, h.mode.editor);
  } finally { await close(h); }
});

test("the transcript container routes a click to the row and focuses it", async () => {
  const h = await start();
  try {
    await activityTask(h, { suffix: "dispatch", tools: 1, finalText: "done" });
    const summary = h.summaries()[0]!;
    const index = h.mode.chatContainer.children.indexOf(summary);
    const precedingHeight = h.mode.chatContainer.children
      .slice(0, index)
      .reduce((height, child) => height + child.render(100).length, 0);
    const totalHeight = h.mode.chatContainer.children.reduce((height, child) => height + child.render(100).length, 0);
    assert.deepEqual(summary.handleMouse({ type: "click", button: "left", x: 90, y: 1 } as never), {
      handled: true, focus: true,
    });
    assert.equal(summaryText(summary), EXPANDED_100);
    summary.handleInput("\r");
    assert.equal(summaryText(summary), COLLAPSED_100);
    const result = h.mode.chatContainer.handleMouse({
      type: "click", button: "left", x: 80, y: precedingHeight + 1,
      screenX: 80, screenY: precedingHeight + 1, width: 100, height: totalHeight,
      shift: false, alt: false, ctrl: false,
    });
    assert.equal(result?.focusTarget, summary);
    assert.equal(summaryText(summary), EXPANDED_100);
  } finally { await close(h); }
});

test("text-only tasks do not create a row", async () => {
  const h = await start();
  try {
    await activityTask(h, { suffix: "text", finalText: "answer" });
    assert.equal(h.summaries().length, 0);
    assert.doesNotMatch(h.text(), /─/);
  } finally { await close(h); }
});

test("aborted, failed, truncated, deferred, and pending tasks are not folded", async () => {
  for (const [stopReason, aborted] of [["aborted", true], ["error", false], ["length", false], ["deferred", false], ["pending", false]] as const) {
    const h = await start();
    try {
      await h.emit("agent_start");
      h.manager.appendMessage(user("question"));
      h.manager.appendMessage(assistant([{ type: "thinking", thinking: `FAILURE-${stopReason}` }], stopReason));
      h.rebuild();
      await h.emit("agent_settled", { aborted });
      assert.match(h.text(), new RegExp(`FAILURE-${stopReason}`));
      assert.equal(h.summaries().length, 0);
    } finally { await close(h); }
  }
});

test("retries and queued user messages stay in one settled batch", async () => {
  const h = await start();
  try {
    await h.emit("agent_start");
    h.manager.appendMessage(user("first"));
    h.manager.appendMessage(assistant([{ type: "thinking", thinking: "THINK-RETRY" }], "error"));
    await h.emit("agent_end", { messages: [] });
    await h.emit("agent_start");
    h.manager.appendMessage(user("steering"));
    h.manager.appendMessage(assistant([{ type: "thinking", thinking: "THINK-OK" }, { type: "text", text: "done" }]));
    h.rebuild();
    assert.match(h.text(), /THINK-RETRY/);
    await h.emit("agent_settled", { aborted: false });
    assert.equal(h.summaries().length, 1);
    assert.equal(summaryText(h.summaries()[0]!), COLLAPSED_100);
    assert.doesNotMatch(h.text(), /THINK-RETRY|THINK-OK/);
    assert.match(h.text(), /USER: first/);
    assert.match(h.text(), /USER: steering/);
    assert.match(h.text(), /done/);
  } finally { await close(h); }
});

test("multiple tasks can be toggled individually or all at once", async () => {
  const h = await start();
  try {
    await activityTask(h, { suffix: "a", tools: 1, finalText: "a" });
    await activityTask(h, { suffix: "b", tools: 1, finalText: "b" });
    assert.equal(h.summaries().length, 2);
    await h.command();
    assert.equal(summaryText(h.summaries()[0]!), COLLAPSED_100);
    assert.equal(summaryText(h.summaries()[1]!), EXPANDED_100);
    await h.command("show");
    assert.equal(summaryText(h.summaries()[0]!), EXPANDED_100);
    assert.equal(summaryText(h.summaries()[1]!), EXPANDED_100);
    await h.command("hide");
    assert.equal(summaryText(h.summaries()[0]!), COLLAPSED_100);
    assert.equal(summaryText(h.summaries()[1]!), COLLAPSED_100);
  } finally { await close(h); }
});

test("rebuild and branch navigation re-associate only active entries", async () => {
  const h = await start();
  try {
    const task = await successfulTask(h, "tree");
    await h.emit("agent_settled", { aborted: false });
    h.rebuild();
    assert.equal(summaryText(h.summaries()[0]!), COLLAPSED_100);
    assert.doesNotMatch(h.text(), /THINKING-tree|OUTPUT-tree/);

    h.manager.branch(task.userId);
    h.rebuild();
    assert.equal(h.summaries().length, 0);
    h.manager.appendMessage(assistant([{ type: "thinking", thinking: "OTHER-BRANCH" }, { type: "text", text: "alternative" }]));
    h.rebuild();
    assert.match(h.text(), /OTHER-BRANCH/);
    h.manager.branch(task.finalId);
    h.rebuild();
    assert.equal(summaryText(h.summaries()[0]!), COLLAPSED_100);
    assert.doesNotMatch(h.text(), /THINKING-tree/);
  } finally { await close(h); }
});

test("compaction keeps retained folded activity and excludes dropped tools", async () => {
  const h = await start();
  try {
    const task = await successfulTask(h, "compact");
    await h.emit("agent_settled", { aborted: false });
    h.manager.appendCompaction("summary", task.finalId, 100);
    h.rebuild();
    assert.equal(summaryText(h.summaries()[0]!), COLLAPSED_100);
    await h.command();
    assert.match(h.text(), /FINAL-THINKING-compact/);
    assert.doesNotMatch(h.text(), /OUTPUT-compact/);
  } finally { await close(h); }
});

test("shutdown restores native components and removes the row", async () => {
  const h = await start();
  try {
    const original = (InteractiveMode.prototype as any).renderSessionEntries;
    await successfulTask(h, "reload");
    await h.emit("agent_settled", { aborted: false });
    const component = h.assistants()[0]!;
    assert.doesNotMatch(h.text(), /THINKING-reload/);
    await close(h);
    assert.match(component.render(100).join("\n"), /THINKING-reload/);
    assert.equal(h.summaries().length, 0);
    assert.notEqual((InteractiveMode.prototype as any).renderSessionEntries, original);
    h.rebuild();
    assert.match(h.text(), /THINKING-reload/);
  } finally { await close(h); }
});

test("session restart restores completed historical turns as folded rails", async () => {
  const h = await start();
  try {
    await activityTask(h, { suffix: "history-a", thinking: true, tools: 1, finalText: "answer-a" });
    await activityTask(h, { suffix: "history-b", tools: 2, finalText: "answer-b" });
    h.manager.appendMessage(user("aborted-history"));
    h.manager.appendMessage(assistant([{ type: "thinking", thinking: "ABORTED-HISTORY" }], "aborted"));
    h.rebuild();
    assert.equal(h.summaries().length, 2);

    await h.emit("session_shutdown");
    h.rebuild();
    assert.equal(h.summaries().length, 0);
    assert.match(h.text(), /THINKING-history-a/);

    const beforeRestore = h.renderRequests;
    await h.emit("session_start");
    assert.equal(h.renderRequests - beforeRestore, 1, "historical groups should restore in one refresh");
    h.rebuild();
    assert.equal(h.summaries().length, 2);
    assert.equal((h.text().match(/Workings/g) ?? []).length, 2);
    assert.doesNotMatch(h.text(), /THINKING-history-a|OUTPUT-history-a|OUTPUT-history-b/);
    assert.match(h.text(), /ABORTED-HISTORY/);
    assert.match(h.text(), /answer-a/);
    assert.match(h.text(), /answer-b/);

    await h.command();
    assert.equal(summaryText(h.summaries()[1]!), EXPANDED_100);
    assert.equal(summaryText(h.summaries()[0]!), COLLAPSED_100);
  } finally { await close(h); }
});

test("session_tree restores newly visible branch history without duplicates", async () => {
  const h = makeHarness();
  try {
    const rootId = h.manager.appendMessage(user("root"));
    const branchAId = h.manager.appendMessage(assistant([
      { type: "thinking", thinking: "BRANCH-A-THINK" },
      { type: "text", text: "answer-a" },
    ]));
    h.manager.branch(rootId);
    h.manager.appendMessage(user("branch-b"));
    const branchBId = h.manager.appendMessage(assistant([
      { type: "thinking", thinking: "BRANCH-B-THINK" },
      { type: "text", text: "answer-b" },
    ]));
    await h.emit("session_start");
    assert.deepEqual(h.notices, []);
    h.rebuild();
    assert.equal(h.summaries().length, 1);
    assert.match(h.text(), /answer-b/);
    assert.doesNotMatch(h.text(), /BRANCH-B-THINK/);

    h.manager.branch(branchAId);
    await h.emit("session_tree");
    h.rebuild();
    assert.equal(h.summaries().length, 1);
    assert.match(h.text(), /answer-a/);
    assert.doesNotMatch(h.text(), /BRANCH-A-THINK/);

    await h.emit("session_tree");
    h.rebuild();
    assert.equal(h.summaries().length, 1, "restoring the same branch twice must not duplicate rails");

    h.manager.branch(branchBId);
    await h.emit("session_tree");
    h.rebuild();
    assert.equal(h.summaries().length, 1);
    assert.match(h.text(), /answer-b/);
    assert.doesNotMatch(h.text(), /BRANCH-B-THINK/);
  } finally { await close(h); }
});

test("disposal does not overwrite wrappers installed later by another extension", async () => {
  const proto = InteractiveMode.prototype as any;
  const nativeRender = proto.renderSessionEntries;
  const h = await start();
  try {
    await successfulTask(h, "stack");
    await h.emit("agent_settled", { aborted: false });
    const message = h.assistants()[0]!;
    const ours = message.updateContent;
    let calls = 0;
    const outer: AssistantMessageComponent["updateContent"] = function (this: AssistantMessageComponent, raw, streaming) {
      calls++;
      return ours.call(this, raw, streaming);
    };
    Object.defineProperty(message, "updateContent", { value: outer, configurable: true, writable: true });
    const previous = proto.renderSessionEntries;
    const outerRender = function (this: unknown, ...args: unknown[]) { return Reflect.apply(previous, this, args); };
    proto.renderSessionEntries = outerRender;
    await close(h);
    assert.equal(message.updateContent, outer);
    assert.equal(proto.renderSessionEntries, outerRender);
    assert.ok(calls > 0);
    assert.match(message.render(100).join("\n"), /THINKING-stack/);
  } finally {
    await close(h);
    proto.renderSessionEntries = nativeRender;
  }
});

test("summary and details fit narrow terminal widths", async () => {
  const h = await start();
  try {
    await successfulTask(h, "narrow");
    await h.emit("agent_settled", { aborted: false });
    const summary = h.summaries()[0]!;
    for (const width of [1, 2, 8, 20, 80]) {
      for (const line of summary.render(width)) assert.ok(visibleWidth(line) <= width);
      summary.handleInput("\r");
      for (const line of summary.render(width)) assert.ok(visibleWidth(line) <= width);
      summary.handleInput("\r");
    }
  } finally { await close(h); }
});

test("non-interactive modes are untouched", async () => {
  const h = makeHarness("print");
  const original = (InteractiveMode.prototype as any).renderSessionEntries;
  await h.emit("session_start");
  await h.emit("agent_start");
  await h.emit("agent_settled", { aborted: false });
  assert.equal((InteractiveMode.prototype as any).renderSessionEntries, original);
  assert.deepEqual(h.notices, []);
  await close(h);
});

test("a second instance cannot claim an active adapter", async () => {
  const first = await start();
  const second = makeHarness();
  try {
    await second.emit("session_start");
    assert.match(second.notices[0]!, /another task-fold instance is already active/);
    await successfulTask(first, "first-instance");
    await first.emit("agent_settled", { aborted: false });
    assert.equal(summaryText(first.summaries()[0]!), COLLAPSED_100);
  } finally {
    await close(second);
    await close(first);
  }
});

test("an incompatible component association fails open and disables the extension", async () => {
  const h = await start();
  try {
    await h.emit("agent_start");
    h.manager.appendMessage(user("question"));
    h.manager.appendMessage(assistant([{ type: "thinking", thinking: "unassociated" }]));
    await h.emit("agent_settled", { aborted: false });
    assert.match(h.notices[0]!, /could not associate completed messages/);
    await h.command();
    assert.match(h.notices.at(-1)!, /not active/);
  } finally { await close(h); }
});

test("bridge failure restores the prototype and disables safely", async () => {
  const h = makeHarness();
  const original = (InteractiveMode.prototype as any).setExtensionWidget;
  h.ctx.ui.setWidget = () => { throw new Error("probe failed"); };
  await h.emit("session_start");
  assert.equal((InteractiveMode.prototype as any).setExtensionWidget, original);
  assert.match(h.notices[0]!, /task-fold disabled: probe failed/);
  await h.command();
  assert.match(h.notices.at(-1)!, /not active/);
  await close(h);
});

test("summary rows remain top-level siblings for native Pi settings", async () => {
  const h = await start();
  try {
    await successfulTask(h, "flat");
    await h.emit("agent_settled", { aborted: false });
    assert.ok(h.mode.chatContainer.children.includes(h.summaries()[0]!));
    assert.ok(!h.mode.chatContainer.children.some((child) => child instanceof MouseRegion));
  } finally { await close(h); }
});
