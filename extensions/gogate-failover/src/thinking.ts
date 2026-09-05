import type { AssistantMessage } from "@earendil-works/pi-ai";

/**
 * The affected gogate vision model can emit its reasoning as an unsigned text
 * block immediately before a tool call. Pi normally receives reasoning as a
 * `thinking` block and renders it separately. Reclassify only this narrow
 * shape; final text-only answers remain normal text.
 */
export function normalizeLeakedThinking(message: AssistantMessage): AssistantMessage {
  const hasToolCall = message.content.some((block) => block.type === "toolCall");
  if (!hasToolCall) return message;

  let changed = false;
  const content = message.content.flatMap((block) => {
    if (block.type !== "text" || block.textSignature || !block.text.trim()) {
      return [block];
    }

    changed = true;
    return [{ type: "thinking" as const, thinking: block.text }];
  });

  return changed ? { ...message, content } : message;
}
