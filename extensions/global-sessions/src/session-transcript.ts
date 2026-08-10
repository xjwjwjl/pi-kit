import { readFile } from "node:fs/promises";
import { displayText, isRecord, modelLabel, textFromContent, type JsonRecord } from "./session-json.ts";
import type { SessionTranscript, TranscriptMessage } from "./types.ts";

function messageFromEntry(entry: JsonRecord): TranscriptMessage | undefined {
	const id = typeof entry.id === "string" ? entry.id : "";
	if (!id) return undefined;
	const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : undefined;

	if (entry.type === "message") {
		const message = isRecord(entry.message) ? entry.message : undefined;
		const role = typeof message?.role === "string" ? message.role : "";
		if (role !== "user" && role !== "assistant") return undefined;
		const content = textFromContent(message?.content);
		if (!content) return undefined;
		return { id, role, content, timestamp };
	}

	if (entry.type === "custom_message" && entry.display === true) {
		const content = textFromContent(entry.content);
		if (!content) return undefined;
		return { id, role: "custom", content, timestamp };
	}

	if (entry.type === "compaction" || entry.type === "branch_summary") {
		const summary = typeof entry.summary === "string" ? displayText(entry.summary) : "";
		if (!summary) return undefined;
		return { id, role: "summary", content: summary, timestamp };
	}

	return undefined;
}

/**
 * Loads the branch Pi will resume, without SessionManager.open(). The latter may
 * migrate and rewrite legacy files, while this parser is intentionally read-only.
 */
export async function loadSessionTranscript(filePath: string, signal?: AbortSignal): Promise<SessionTranscript> {
	const content = await readFile(filePath, { encoding: "utf8", signal });
	if (signal?.aborted) throw new DOMException("Transcript loading was cancelled", "AbortError");

	let headerSeen = false;
	const entries: JsonRecord[] = [];
	for (const line of content.split(/\r?\n/)) {
		if (!line.trim()) continue;
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			continue;
		}
		if (!isRecord(value)) continue;

		if (!headerSeen) {
			if (value.type !== "session") throw new Error("The selected file is not a valid Pi session.");
			headerSeen = true;
			continue;
		}
		if (typeof value.id === "string" && value.id) entries.push(value);
	}

	if (!headerSeen) throw new Error("The selected file does not contain a Pi session header.");
	if (entries.length === 0) return { messages: [], model: undefined, alternateBranchCount: 0 };

	const byId = new Map(entries.map((entry) => [entry.id as string, entry]));
	const childCount = new Map<string, number>();
	for (const entry of entries) {
		if (typeof entry.parentId !== "string" || !entry.parentId) continue;
		childCount.set(entry.parentId, (childCount.get(entry.parentId) ?? 0) + 1);
	}
	const alternateBranchCount = [...childCount.values()].reduce((count, children) => count + Math.max(0, children - 1), 0);

	const activeEntries: JsonRecord[] = [];
	const visited = new Set<string>();
	let current = entries.at(-1);
	while (current) {
		const id = current.id as string;
		if (visited.has(id)) break;
		visited.add(id);
		activeEntries.push(current);
		const parentId = typeof current.parentId === "string" ? current.parentId : undefined;
		current = parentId ? byId.get(parentId) : undefined;
	}
	activeEntries.reverse();

	let model: string | undefined;
	const messages: TranscriptMessage[] = [];
	for (const entry of activeEntries) {
		if (entry.type === "model_change") {
			model = modelLabel(entry.provider, entry.modelId) ?? model;
		}
		if (entry.type === "message" && isRecord(entry.message) && entry.message.role === "assistant") {
			model = modelLabel(entry.message.provider, entry.message.model) ?? model;
		}
		const message = messageFromEntry(entry);
		if (message) messages.push(message);
	}

	return { messages, model, alternateBranchCount };
}
