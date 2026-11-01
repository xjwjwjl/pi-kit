// Isolated CLI fixture: no network or real provider credentials are used.
import fs from "node:fs";
import path from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { InteractiveMode, ToolExecutionComponent, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";

const directory = process.env.FOLD_E2E_DIR!;

export default function fakeProvider(pi: ExtensionAPI): void {
  pi.registerProvider("task-fold-e2e", {
    baseUrl: "http://127.0.0.1:1",
    apiKey: "fake",
    api: "task-fold-e2e-api",
    models: [{
      id: "fold-model", name: "fold-model", reasoning: true, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 20_000, maxTokens: 1_000,
    }],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(async () => {
        const userCount = context.messages.filter((message) => message.role === "user").length;
        const toolCount = context.messages.filter((message) => message.role === "toolResult").length;
        const callTool = toolCount < userCount;
        const message = {
          role: "assistant" as const, api: model.api, provider: model.provider, model: model.id,
          content: callTool
            ? [{ type: "thinking" as const, thinking: "FOLD_E2E_THINK" },
                { type: "text" as const, text: "FOLD_E2E_PROGRESS" },
                { type: "toolCall" as const, id: `e2e-call-${userCount}`, name: "bash", arguments: { command: "printf FOLD_E2E_TOOL_OUTPUT" } }]
            : [{ type: "thinking" as const, thinking: "FOLD_E2E_FINAL_THINK" }, { type: "text" as const, text: "FOLD_E2E_ANSWER" }],
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: callTool ? "toolUse" as const : "stop" as const,
          timestamp: Date.now(),
        };
        const partial: AssistantMessage = { ...message, content: [] };
        const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 5));
        stream.push({ type: "start", partial });
        await pause();
        for (const [contentIndex, block] of message.content.entries()) {
          if (block.type === "thinking") {
            partial.content.push({ type: "thinking", thinking: "" });
            stream.push({ type: "thinking_start", contentIndex, partial });
            await pause();
            partial.content[contentIndex] = block;
            stream.push({ type: "thinking_delta", contentIndex, delta: block.thinking, partial });
            stream.push({ type: "thinking_end", contentIndex, content: block.thinking, partial });
          } else if (block.type === "text") {
            partial.content.push({ type: "text", text: "" });
            stream.push({ type: "text_start", contentIndex, partial });
            await pause();
            partial.content[contentIndex] = block;
            stream.push({ type: "text_delta", contentIndex, delta: block.text, partial });
            stream.push({ type: "text_end", contentIndex, content: block.text, partial });
          } else {
            partial.content.push({ ...block, arguments: {} });
            stream.push({ type: "toolcall_start", contentIndex, partial });
            await pause();
            partial.content[contentIndex] = block;
            stream.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(block.arguments), partial });
            stream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial });
          }
          await pause();
        }
        stream.push({ type: "done", reason: message.stopReason, message });
        stream.end();
      });
      return stream;
    },
  });

  pi.on("session_start", () => fs.writeFileSync(path.join(directory, "ready"), "ready"));
  pi.on("agent_settled", () => fs.writeFileSync(path.join(directory, "settled"), "settled"));
  pi.registerCommand("snapshot", {
    description: "Save transcript for the isolated integration test",
    async handler(args, ctx) {
      const prototype = InteractiveMode.prototype as any;
      const original = prototype.setExtensionWidget;
      let mode: any;
      prototype.setExtensionWidget = function (this: unknown, ...values: unknown[]) {
        mode = this;
        return Reflect.apply(original, this, values);
      };
      try { ctx.ui.setWidget("task-fold-e2e-snapshot", undefined); }
      finally { prototype.setExtensionWidget = original; }
      const text = mode.chatContainer.render(120).map(stripTerminalSequences).join("\n");
      const toolShells = mode.chatContainer.children
        .filter((component: unknown) => component instanceof ToolExecutionComponent)
        .map((component: any) => component.toolDefinition?.renderShell ?? "default");
      fs.writeFileSync(path.join(directory, `snapshot-${args.trim()}.json`), JSON.stringify({ toolShells }));
      fs.writeFileSync(path.join(directory, `snapshot-${args.trim()}`), text);
    },
  });
}
