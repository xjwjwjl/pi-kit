import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { createReadStream, type Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
	displayText,
	isRecord,
	limitText,
	modelLabel,
	normalizeText,
	textFromContent,
	timestampMs,
	type JsonRecord,
} from "./session-json.ts";
import type { GlobalSession, SessionScanProgress, SessionScanResult } from "./types.ts";

const DEFAULT_CONCURRENCY = 10;
const PREVIEW_TEXT_LIMIT = 4_000;

type ParseOutcome =
	| { type: "session"; session: GlobalSession }
	| { type: "skipped" }
	| { type: "aborted" };

export interface ScanSessionsOptions {
	/** Override only for tests or explicit embedding; normal use scans Pi's default global directory. */
	rootDir?: string;
	signal?: AbortSignal;
	concurrency?: number;
	onProgress?: (progress: SessionScanProgress) => void;
}

export function defaultSessionRoot(): string {
	return join(getAgentDir(), "sessions");
}

function isSessionHeader(entry: JsonRecord): boolean {
	return (
		entry.type === "session" &&
		typeof entry.id === "string" &&
		entry.id.trim().length > 0 &&
		typeof entry.cwd === "string"
	);
}

async function discoverSessionFiles(rootDir: string, signal?: AbortSignal): Promise<string[]> {
	const files: string[] = [];
	const pending = [rootDir];

	while (pending.length > 0) {
		if (signal?.aborted) break;
		const directory = pending.pop()!;
		let entries: Dirent[];
		try {
			entries = await readdir(directory, { withFileTypes: true });
		} catch {
			continue;
		}

		for (const entry of entries) {
			if (signal?.aborted) break;
			const path = join(directory, entry.name);
			if (entry.isDirectory()) {
				pending.push(path);
			} else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
				files.push(path);
			}
		}
	}

	return files;
}

function entryActivityMs(entry: JsonRecord): number | undefined {
	const entryTime = timestampMs(entry.timestamp);
	const message = isRecord(entry.message) ? entry.message : undefined;
	const messageTime = timestampMs(message?.timestamp);
	if (entryTime === undefined) return messageTime;
	if (messageTime === undefined) return entryTime;
	return Math.max(entryTime, messageTime);
}

async function parseSessionMetadata(filePath: string, signal?: AbortSignal): Promise<ParseOutcome> {
	if (signal?.aborted) return { type: "aborted" };

	let fileStats: Awaited<ReturnType<typeof stat>>;
	try {
		fileStats = await stat(filePath);
	} catch {
		return { type: "skipped" };
	}
	if (signal?.aborted) return { type: "aborted" };

	const stream = createReadStream(filePath, { encoding: "utf8" });
	const reader = createInterface({ input: stream, crlfDelay: Infinity });
	const abort = () => stream.destroy();
	signal?.addEventListener("abort", abort, { once: true });

	let header: JsonRecord | undefined;
	let name: string | undefined;
	let model: string | undefined;
	let messageCount = 0;
	let firstPrompt = "";
	let lastReply = "";
	let lastActivityMs: number | undefined;
	const allMessages: string[] = [];

	try {
		for await (const line of reader) {
			if (signal?.aborted) return { type: "aborted" };
			if (!line.trim()) continue;

			let entry: unknown;
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}
			if (!isRecord(entry)) continue;

			if (!header) {
				if (!isSessionHeader(entry)) return { type: "skipped" };
				header = entry;
				continue;
			}

			if (entry.type === "session_info") {
				name = typeof entry.name === "string" ? normalizeText(entry.name) || undefined : undefined;
			}
			if (entry.type === "model_change") {
				model = modelLabel(entry.provider, entry.modelId) ?? model;
			}
			if (entry.type !== "message") continue;

			messageCount++;
			const activity = entryActivityMs(entry);
			if (activity !== undefined) lastActivityMs = Math.max(lastActivityMs ?? activity, activity);

			const message = isRecord(entry.message) ? entry.message : undefined;
			if (!message) continue;
			const role = typeof message.role === "string" ? message.role : "";
			if (role !== "user" && role !== "assistant") continue;

			const content = textFromContent(message.content);
			const searchableContent = normalizeText(content);
			if (searchableContent) allMessages.push(searchableContent);
			if (role === "user" && !firstPrompt && searchableContent) {
				firstPrompt = limitText(searchableContent, PREVIEW_TEXT_LIMIT);
			}
			if (role === "assistant" && searchableContent) {
				lastReply = limitText(searchableContent, PREVIEW_TEXT_LIMIT);
			}
			if (role === "assistant") {
				model = modelLabel(message.provider, message.model) ?? model;
			}
		}
	} catch {
		return signal?.aborted ? { type: "aborted" } : { type: "skipped" };
	} finally {
		reader.close();
		stream.destroy();
		signal?.removeEventListener("abort", abort);
	}

	if (signal?.aborted) return { type: "aborted" };
	if (!header) return { type: "skipped" };

	const createdMs = timestampMs(header.timestamp);
	const created = new Date(createdMs ?? fileStats.birthtimeMs);
	const modified = new Date(lastActivityMs ?? createdMs ?? fileStats.mtimeMs);
	const cwd = displayText(header.cwd as string);
	const allMessagesText = allMessages.join(" ");
	const searchText = [cwd, name ?? "", model ?? "", firstPrompt, lastReply, allMessagesText]
		.join("\n")
		.toLocaleLowerCase();

	return {
		type: "session",
		session: {
			path: filePath,
			id: header.id as string,
			cwd,
			name,
			created,
			modified,
			messageCount,
			firstPrompt,
			lastReply,
			model,
			allMessagesText,
			searchText,
		},
	};
}

/**
 * Read all standard Pi session files without opening them through SessionManager.
 * This keeps browsing and preview strictly read-only, including for legacy sessions
 * that Pi would otherwise migrate when opened.
 */
export async function scanGlobalSessions(options: ScanSessionsOptions = {}): Promise<SessionScanResult> {
	const rootDir = options.rootDir ?? defaultSessionRoot();
	const signal = options.signal;
	let loaded = 0;
	let skipped = 0;
	let total = 0;
	let discovered = 0;
	let phase: SessionScanProgress["phase"] = "discovering";
	let lastProgressAt = 0;

	const report = (force = false) => {
		const now = Date.now();
		if (!force && now - lastProgressAt < 75) return;
		lastProgressAt = now;
		options.onProgress?.({ phase, loaded, total, skipped, discovered });
	};

	report(true);
	const files = await discoverSessionFiles(rootDir, signal);
	discovered = files.length;
	total = files.length;
	phase = "scanning";
	report(true);

	if (signal?.aborted) {
		return { sessions: [], totalFiles: total, skippedFiles: skipped, aborted: true };
	}

	const sessions: GlobalSession[] = [];
	let nextIndex = 0;
	const concurrency = Math.max(1, Math.min(options.concurrency ?? DEFAULT_CONCURRENCY, files.length || 1));

	const worker = async () => {
		while (!signal?.aborted) {
			const index = nextIndex++;
			const filePath = files[index];
			if (!filePath) return;

			const outcome = await parseSessionMetadata(filePath, signal);
			if (outcome.type === "aborted") return;
			if (outcome.type === "session") sessions.push(outcome.session);
			else skipped++;
			loaded++;
			report();
		}
	};

	await Promise.all(Array.from({ length: concurrency }, () => worker()));
	const aborted = signal?.aborted ?? false;
	if (!aborted) {
		sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime() || b.created.getTime() - a.created.getTime());
	}
	report(true);

	return {
		sessions,
		totalFiles: total,
		skippedFiles: skipped,
		aborted,
	};
}
