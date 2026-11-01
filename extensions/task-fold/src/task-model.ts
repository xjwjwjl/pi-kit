import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export interface FoldGroup {
  readonly assistantIds: ReadonlySet<string>;
  collapsed: boolean;
}

export interface ActivityCounts {
  tools: number;
  failed: number;
}

export interface ActivityThinking {
  kind: "thinking";
  text: string;
}

export interface ActivityImage {
  data: string;
  mimeType: string;
}

export interface ActivityTool {
  kind: "tool";
  toolCallId: string;
  name: string;
  args: unknown;
  output: string;
  images: ActivityImage[];
  failed: boolean;
}

export type ActivityItem = ActivityThinking | ActivityTool;

export interface VisibleActivity {
  counts: ActivityCounts;
  items: ActivityItem[];
}

export function isAssistantEntry(entry: SessionEntry): entry is Extract<SessionEntry, { type: "message" }> & { message: AssistantMessage } {
  return entry.type === "message" && entry.message.role === "assistant" && Array.isArray(entry.message.content);
}

/** One settlement can include retries, steering, and follow-ups. Do not split it at agent_end. */
export function completedGroup(
  branch: readonly SessionEntry[],
  previousEntryIds: ReadonlySet<string>,
  aborted: boolean,
): FoldGroup | undefined {
  if (aborted) return undefined;
  const assistants = branch.filter(isAssistantEntry).filter((entry) => !previousEntryIds.has(entry.id));
  if (!isCompletedGroup(assistants)) return undefined;
  return { assistantIds: new Set(assistants.map((entry) => entry.id)), collapsed: true };
}

/** Rebuild completed visible user turns on reload or resume. */
export function restoredGroups(entries: readonly SessionEntry[]): FoldGroup[] {
  const groups: FoldGroup[] = [];
  let assistants: Array<Extract<SessionEntry, { type: "message" }> & { message: AssistantMessage }> = [];
  let inUserTurn = false;

  const flush = () => {
    if (inUserTurn && isCompletedGroup(assistants)) {
      groups.push({ assistantIds: new Set(assistants.map((entry) => entry.id)), collapsed: true });
    }
    assistants = [];
    inUserTurn = false;
  };

  for (const entry of entries) {
    if (entry.type === "message" && entry.message.role === "user") {
      flush();
      inUserTurn = true;
    } else if (inUserTurn && isAssistantEntry(entry)) {
      assistants.push(entry);
    }
  }
  flush();
  return groups;
}

function isCompletedGroup(assistants: ReadonlyArray<{ message: AssistantMessage }>): boolean {
  const last = assistants.at(-1)?.message;
  // Deferred/pending and unknown stop reasons are not known to be completed.
  if (!last || (last.stopReason !== "stop" && last.stopReason !== "toolUse")) return false;
  return assistants.some(({ message }) => hasActivity(message));
}

function hasActivity(message: AssistantMessage): boolean {
  return message.content.some((block) =>
    (block.type === "thinking" && Boolean(block.thinking?.trim())) || block.type === "toolCall"
  );
}

function resultDetails(message: ToolResultMessage): { output: string; images: ActivityImage[] } {
  const output: string[] = [];
  const images: ActivityImage[] = [];
  for (const block of message.content) {
    if (block.type === "text" && block.text.trim()) output.push(block.text);
    else if (block.type === "image" && block.data && block.mimeType) {
      images.push({ data: block.data, mimeType: block.mimeType });
    }
  }
  return { output: output.join("\n"), images };
}

/** Count and describe only the part of the group currently visible after branch selection and compaction. */
export function visibleActivity(group: FoldGroup, entries: readonly SessionEntry[]): VisibleActivity {
  const counts: ActivityCounts = { tools: 0, failed: 0 };
  const results = new Map<string, ToolResultMessage>();
  for (const entry of entries) {
    if (entry.type === "message" && entry.message.role === "toolResult") {
      results.set(entry.message.toolCallId, entry.message);
    }
  }

  const items: ActivityItem[] = [];
  let pendingThinking: string[] = [];
  const flushThinking = () => {
    const text = pendingThinking.join("\n\n").trim();
    if (text) items.push({ kind: "thinking", text });
    pendingThinking = [];
  };

  for (const entry of entries) {
    if (!isAssistantEntry(entry) || !group.assistantIds.has(entry.id)) continue;
    for (const block of entry.message.content) {
      if (block.type === "thinking") {
        if (block.thinking?.trim()) pendingThinking.push(block.thinking.trim());
        continue;
      }
      flushThinking();
      if (block.type !== "toolCall") continue;
      const result = results.get(block.id);
      const details = result ? resultDetails(result) : { output: "", images: [] };
      items.push({
        kind: "tool",
        toolCallId: block.id,
        name: block.name,
        args: block.arguments,
        output: details.output,
        images: details.images,
        failed: result?.isError === true,
      });
      counts.tools++;
      if (result?.isError) counts.failed++;
    }
    flushThinking();
  }
  return { counts, items };
}
