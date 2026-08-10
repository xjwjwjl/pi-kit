import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { createReadStream, type Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, basename } from "node:path";
import { createInterface } from "node:readline";
import { rangeContains } from "./time-range.ts";
import { isRecord, nonNegativeNumber, stringValue, timestampMs, type JsonRecord } from "./session-json.ts";
import type { ScanProgress, ScanResult, TimeRange, TokenEvent } from "./types.ts";

const DEFAULT_CONCURRENCY = 8;

type ParsedSession = {
	sessionId: string;
	sessionFile: string;
	sessionCreatedAt: number;
	scope: string;
	events: TokenEvent[];
	malformedLines: number;
};

export interface ScanTokenEventsOptions {
	rootDir?: string;
	range: TimeRange;
	signal?: AbortSignal;
	concurrency?: number;
	onProgress?: (progress: ScanProgress) => void;
}

export function defaultSessionRoot(): string {
	return join(getAgentDir(), "sessions");
}

function sessionHeader(entry: JsonRecord): { id: string; createdAt: number; scope: string } | undefined {
	if (entry.type !== "session") return undefined;
	const id = stringValue(entry.id);
	if (!id) return undefined;
	return {
		id,
		createdAt: timestampMs(entry.timestamp) ?? 0,
		scope: stringValue(entry.cwd) ?? "unknown",
	};
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
			const filePath = join(directory, entry.name);
			if (entry.isDirectory()) pending.push(filePath);
			else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(filePath);
		}
	}

	return files;
}

function assistantEvent(
	entry: JsonRecord,
	header: { id: string; createdAt: number; scope: string },
	filePath: string,
): TokenEvent | undefined {
	if (entry.type !== "message" || !isRecord(entry.message)) return undefined;
	const message = entry.message;
	if (message.role !== "assistant") return undefined;

	// Strict attribution: do not infer provider/model from model_change entries or filenames.
	const provider = stringValue(message.provider);
	const requestedModel = stringValue(message.model);
	const responseModel = stringValue(message.responseModel);
	const model = responseModel ?? requestedModel;
	if (!provider || !model) return undefined;

	const entryId = stringValue(entry.id);
	const timestamp = timestampMs(message.timestamp) ?? timestampMs(entry.timestamp);
	if (!entryId || timestamp === undefined) return undefined;

	const usage = isRecord(message.usage) ? message.usage : undefined;
	const cost = usage && isRecord(usage.cost) ? nonNegativeNumber(usage.cost.total) : 0;
	const stopReason = stringValue(message.stopReason);
	const api = stringValue(message.api);

	return {
		entryId,
		sessionId: header.id,
		sessionFile: filePath,
		sessionCreatedAt: header.createdAt,
		timestampMs: timestamp,
		scope: header.scope,
		provider,
		model,
		requestedModel: requestedModel && requestedModel !== model ? requestedModel : undefined,
		api,
		inputTokens: usage ? nonNegativeNumber(usage.input) : 0,
		outputTokens: usage ? nonNegativeNumber(usage.output) : 0,
		cacheReadTokens: usage ? nonNegativeNumber(usage.cacheRead) : 0,
		cacheWriteTokens: usage ? nonNegativeNumber(usage.cacheWrite) : 0,
		cost,
		stopReason,
	};
}

async function parseSessionFile(filePath: string, signal?: AbortSignal): Promise<ParsedSession | undefined> {
	if (signal?.aborted) return undefined;

	const stream = createReadStream(filePath, { encoding: "utf8" });
	const reader = createInterface({ input: stream, crlfDelay: Infinity });
	const abort = () => stream.destroy();
	signal?.addEventListener("abort", abort, { once: true });

	let header: { id: string; createdAt: number; scope: string } | undefined;
	const events: TokenEvent[] = [];
	let malformedLines = 0;

	try {
		for await (const line of reader) {
			if (signal?.aborted) return undefined;
			if (!line.trim()) continue;

			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				malformedLines++;
				continue;
			}
			if (!isRecord(parsed)) {
				malformedLines++;
				continue;
			}

			if (!header) {
				header = sessionHeader(parsed);
				if (!header) return undefined;
				continue;
			}

			const event = assistantEvent(parsed, header, filePath);
			if (event) events.push(event);
		}
	} catch {
		return undefined;
	} finally {
		reader.close();
		stream.destroy();
		signal?.removeEventListener("abort", abort);
	}

	if (!header || signal?.aborted) return undefined;
	return {
		sessionId: header.id,
		sessionFile: filePath,
		sessionCreatedAt: header.createdAt,
		scope: header.scope,
		events,
		malformedLines,
	};
}

function preferredEvent(previous: TokenEvent, next: TokenEvent): TokenEvent {
	if (next.sessionCreatedAt < previous.sessionCreatedAt) return next;
	if (next.sessionCreatedAt > previous.sessionCreatedAt) return previous;
	return next.sessionFile.localeCompare(previous.sessionFile) < 0 ? next : previous;
}

export async function scanTokenEvents(options: ScanTokenEventsOptions): Promise<ScanResult> {
	const rootDir = options.rootDir ?? defaultSessionRoot();
	const signal = options.signal;
	const report = options.onProgress;
	const scanStartedAt = Date.now();

	if (signal?.aborted) {
		return {
			aborted: true,
			events: [],
			totalFiles: 0,
			loadedFiles: 0,
			skippedFiles: 0,
			deduplicatedEvents: 0,
			malformedLines: 0,
			scannedAt: scanStartedAt,
		};
	}

	report?.({ phase: "discovering", discovered: 0, loaded: 0, total: 0, skipped: 0 });
	const files = await discoverSessionFiles(rootDir, signal);
	const total = files.length;
	report?.({ phase: "scanning", discovered: total, loaded: 0, total, skipped: 0 });

	const parsed: ParsedSession[] = [];
	let loaded = 0;
	let skipped = 0;
	let malformedLines = 0;
	let nextIndex = 0;
	const concurrency = Math.max(1, Math.min(options.concurrency ?? DEFAULT_CONCURRENCY, total || 1));

	const worker = async () => {
		while (!signal?.aborted) {
			const index = nextIndex++;
			const filePath = files[index];
			if (!filePath) return;
			const result = await parseSessionFile(filePath, signal);
			if (result) {
				parsed.push(result);
				malformedLines += result.malformedLines;
			} else {
				skipped++;
			}
			loaded++;
			report?.({
				phase: "scanning",
				discovered: total,
				loaded,
				total,
				skipped,
				currentFile: basename(filePath),
			});
		}
	};

	await Promise.all(Array.from({ length: concurrency }, () => worker()));
	if (signal?.aborted) {
		return {
			aborted: true,
			events: [],
			totalFiles: total,
			loadedFiles: loaded,
			skippedFiles: skipped,
			deduplicatedEvents: 0,
			malformedLines,
			scannedAt: Date.now(),
		};
	}

	report?.({ phase: "finalizing", discovered: total, loaded, total, skipped });
	const inRange = parsed.flatMap((session) => session.events).filter((event) => rangeContains(options.range, event.timestampMs));
	const unique = new Map<string, TokenEvent>();
	for (const event of inRange) {
		const previous = unique.get(event.entryId);
		unique.set(event.entryId, previous ? preferredEvent(previous, event) : event);
	}

	const events = [...unique.values()].sort(
		(a, b) => b.timestampMs - a.timestampMs || a.entryId.localeCompare(b.entryId),
	);

	return {
		aborted: false,
		events,
		totalFiles: total,
		loadedFiles: loaded,
		skippedFiles: skipped,
		deduplicatedEvents: inRange.length - events.length,
		malformedLines,
		scannedAt: Date.now(),
	};
}
