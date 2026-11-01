import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import {
  AssistantMessageComponent,
  initTheme,
  InteractiveMode,
  SessionManager,
  ToolExecutionComponent,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Container, type Component, Text, stripTerminalSequences } from "@earendil-works/pi-tui";
import extension from "../index.ts";
import { ActivityView } from "../src/activity-view.ts";

initTheme("dark", false);

type Handler = (event: any, ctx: any) => unknown;
type Command = { handler: (args: string, ctx: any) => Promise<void> };

type FakeMode = {
  runtimeHost: {
    session: {
      sessionManager: SessionManager;
      settingsManager: { getShowImages(): boolean; getImageWidthCells(): number };
    };
  };
  chatContainer: Container;
  renderer: undefined;
  extensionWidgetsAbove: Map<string, unknown>;
  extensionWidgetsBelow: Map<string, unknown>;
  ui: { requestRender(): void; setFocus(component: Component | null): void };
  editor: Component;
  settingsManager: { getShowImages(): boolean; getImageWidthCells(): number };
  focused: Component | null;
  renderWidgets(): void;
  setExtensionWidget(key: string, value: undefined): void;
  renderSessionEntries(entries: ReturnType<SessionManager["getBranch"]>): void;
  renderSessionItems(items: any[]): void;
};

export function assistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
  return {
    role: "assistant", content, api: "openai-responses", provider: "test", model: "test", timestamp: Date.now(),
    stopReason,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}

export function user(text: string): UserMessage {
  return { role: "user", content: text, timestamp: Date.now() };
}

export function result(id: string, text: string, isError = false): ToolResultMessage {
  return { role: "toolResult", toolCallId: id, toolName: "test", content: [{ type: "text", text }], isError, timestamp: Date.now() };
}

export function makeHarness(modeName: "tui" | "print" = "tui", options: { agentDir?: string; hintSeen?: boolean } = {}) {
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, Command>();
  const notices: string[] = [];
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = options.agentDir ?? mkdtempSync(join(tmpdir(), "task-fold-test-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  if (options.hintSeen !== false) {
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "task-fold.json"), '{"hintSeen":true}\n');
  }
  let renderRequests = 0;
  const manager = SessionManager.inMemory("/tmp/task-fold-test");
  const mode = Object.create(InteractiveMode.prototype) as FakeMode;
  const settingsManager = { getShowImages: () => true, getImageWidthCells: () => 60 };
  mode.runtimeHost = { session: { sessionManager: manager, settingsManager } };
  mode.chatContainer = new Container();
  mode.renderer = undefined;
  mode.extensionWidgetsAbove = new Map();
  mode.extensionWidgetsBelow = new Map();
  mode.editor = new Text("editor", 0, 0);
  mode.focused = mode.editor;
  mode.ui = {
    requestRender: () => { renderRequests++; },
    setFocus: (component) => { mode.focused = component; },
  };
  mode.renderWidgets = () => {};
  mode.renderSessionItems = (items) => {
    const pending = new Map<string, ToolExecutionComponent>();
    for (const item of items) {
      if (item.role === "user") {
        mode.chatContainer.addChild(new Text(`USER: ${typeof item.content === "string" ? item.content : "message"}`, 0, 0));
      } else if (item.role === "assistant") {
        mode.chatContainer.addChild(new AssistantMessageComponent(item));
        for (const block of item.content) {
          if (block.type !== "toolCall") continue;
          const tool = new ToolExecutionComponent(block.name, block.id, block.arguments, { showImages: false }, undefined, mode.ui as never, manager.getCwd());
          mode.chatContainer.addChild(tool);
          pending.set(block.id, tool);
        }
      } else if (item.role === "toolResult") {
        pending.get(item.toolCallId)?.updateResult(item);
      }
    }
  };
  const ctx = {
    mode: modeName,
    hasUI: modeName === "tui",
    sessionManager: manager,
    ui: {
      setWidget: (key: string, value: undefined) => mode.setExtensionWidget(key, value),
      theme: {
        fg: (_color: string, text: string) => text,
        bg: (_color: string, text: string) => text,
        bold: (text: string) => text,
      },
      notify: (message: string) => notices.push(message),
    },
  };
  const pi = {
    on(name: string, handler: Handler) { handlers.set(name, handler); },
    registerCommand(name: string, command: Command) { commands.set(name, command); },
  };
  extension(pi as unknown as ExtensionAPI);
  return {
    mode, manager, ctx, notices, agentDir,
    get renderRequests() { return renderRequests; },
    cleanup() {
      if (process.env.PI_CODING_AGENT_DIR === agentDir) {
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      }
      if (!options.agentDir) rmSync(agentDir, { recursive: true, force: true });
    },
    async emit(name: string, event: any = {}) {
      const handler = handlers.get(name);
      if (handler) await handler(event, ctx);
    },
    async command(args = "") {
      const command = commands.get("task-fold");
      assert.ok(command);
      await command.handler(args, ctx);
    },
    rebuild() {
      mode.chatContainer.clear();
      mode.renderSessionEntries(manager.buildContextEntries());
    },
    text(width = 100) {
      return mode.chatContainer.render(width).map(stripTerminalSequences).join("\n");
    },
    assistants() {
      return mode.chatContainer.children.filter((child): child is AssistantMessageComponent => child instanceof AssistantMessageComponent);
    },
    tools() {
      return mode.chatContainer.children.filter((child): child is ToolExecutionComponent => child instanceof ToolExecutionComponent);
    },
    summaries() {
      return mode.chatContainer.children.filter((child): child is ActivityView => child instanceof ActivityView);
    },
  };
}

export async function successfulTask(harness: ReturnType<typeof makeHarness>, suffix: string, options: { isError?: boolean } = {}) {
  await harness.emit("agent_start");
  const userId = harness.manager.appendMessage(user(`prompt-${suffix}`));
  const first = assistant([
    { type: "thinking", thinking: `THINKING-${suffix}` },
    { type: "text", text: `progress-${suffix}` },
    { type: "toolCall", id: `call-${suffix}`, name: "test", arguments: { sentinel: `ARGS-${suffix}` } },
  ], "toolUse");
  const assistantId = harness.manager.appendMessage(first);
  harness.manager.appendMessage(result(`call-${suffix}`, `OUTPUT-${suffix}`, options.isError));
  const final = assistant([{ type: "thinking", thinking: `FINAL-THINKING-${suffix}` }, { type: "text", text: `answer-${suffix}` }]);
  const finalId = harness.manager.appendMessage(final);
  harness.rebuild();
  await harness.emit("agent_end", { messages: [first, final] });
  return { userId, assistantId, finalId, first, final };
}
