import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import type {
    ModelStats,
    ScanQuality,
    SessionScanResult,
    TimeRange,
    WindowStats,
} from "./usage-types.ts";

function defaultSessionsDir(): string {
    const agentDir = process.env.PI_CODING_AGENT_DIR
        ?? path.join(process.env.HOME || process.env.USERPROFILE || "", ".pi", "agent");
    return path.join(agentDir, "sessions");
}

export function emptyStats(): WindowStats {
    return {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: 0,
        sessions: 0,
        models: {},
    };
}

export function emptyScanQuality(): ScanQuality {
    return {
        totalFiles: 0,
        parsedFiles: 0,
        skippedFiles: 0,
        malformedLines: 0,
        duplicateEntries: 0,
    };
}

function ensureModelStats(stats: WindowStats, model: string): ModelStats {
    const key = model || "unknown";
    if (!stats.models[key]) {
        stats.models[key] = {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: 0,
        };
    }
    return stats.models[key]!;
}

function messageTimestampMs(obj: any): number | null {
    const raw = obj?.timestamp ?? obj?.message?.timestamp;
    if (typeof raw === "number" && Number.isFinite(raw)) return raw;
    if (typeof raw === "string") {
        const parsed = Date.parse(raw);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}

function readNonNegativeNumber(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
    if (typeof value === "string" && value.trim()) {
        const parsed = Number(value);
        if (Number.isFinite(parsed) && parsed >= 0) return parsed;
    }
    return null;
}

function firstNumber(...values: unknown[]): number | null {
    for (const value of values) {
        const parsed = readNonNegativeNumber(value);
        if (parsed !== null) return parsed;
    }
    return null;
}

function nonNegativeNumber(value: unknown): number {
    return readNonNegativeNumber(value) ?? 0;
}

function stringField(obj: any, field: string): string | null {
    const value = obj?.[field] ?? obj?.message?.[field];
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed || null;
}

function sessionUsage(obj: any): any | null {
    const usage = obj?.usage ?? obj?.message?.usage;
    return usage && typeof usage === "object" && !Array.isArray(usage) ? usage : null;
}

function sessionEntryId(obj: any): string | null {
    return stringField(obj, "id");
}

function sessionModel(obj: any): string {
    return stringField(obj, "responseModel")
        ?? stringField(obj, "model")
        ?? stringField(obj, "modelId")
        ?? "unknown";
}

function usageInput(usage: any): number {
    return firstNumber(usage?.input, usage?.inputTokens, usage?.input_tokens, usage?.promptTokens, usage?.prompt_tokens) ?? 0;
}

function usageOutput(usage: any): number {
    return firstNumber(usage?.output, usage?.outputTokens, usage?.output_tokens, usage?.completionTokens, usage?.completion_tokens) ?? 0;
}

function usageCacheRead(usage: any): number {
    return firstNumber(usage?.cacheRead, usage?.cacheReadTokens, usage?.cache_read, usage?.cache_read_input_tokens) ?? 0;
}

function usageCacheWrite(usage: any): number {
    return firstNumber(usage?.cacheWrite, usage?.cacheWriteTokens, usage?.cache_write, usage?.cache_creation_input_tokens) ?? 0;
}

function usageTotalTokens(usage: any, input: number, output: number): number {
    const direct = firstNumber(usage?.totalTokens, usage?.total_tokens, usage?.tokens, usage?.tokenCount, usage?.token_count);
    if (direct !== null && direct > 0) return direct;
    const nested = firstNumber(usage?.tokens?.total, usage?.tokens?.totalTokens, usage?.tokens?.total_tokens);
    if (nested !== null && nested > 0) return nested;
    return direct === 0 && input === 0 && output === 0 ? 0 : input + output;
}

function usageCost(usage: any): number {
    const cost = usage?.cost;
    if (cost && typeof cost === "object" && !Array.isArray(cost)) return firstNumber(cost.total) ?? 0;
    return nonNegativeNumber(cost);
}

function addUsageStats(stats: WindowStats, model: string, usage: any): void {
    const input = usageInput(usage);
    const output = usageOutput(usage);
    const cacheRead = usageCacheRead(usage);
    const cacheWrite = usageCacheWrite(usage);
    const totalTokens = usageTotalTokens(usage, input, output);
    const cost = usageCost(usage);
    const reasoning = firstNumber(usage?.reasoning) ?? 0;
    stats.input += input;
    stats.output += output;
    stats.cacheRead += cacheRead;
    stats.cacheWrite += cacheWrite;
    stats.totalTokens += totalTokens + reasoning;
    stats.cost += cost;
    const modelStats = ensureModelStats(stats, model);
    modelStats.input += input;
    modelStats.output += output;
    modelStats.cacheRead += cacheRead;
    modelStats.cacheWrite += cacheWrite;
    modelStats.totalTokens += totalTokens + reasoning;
    modelStats.cost += cost;
}

interface SessionFileCandidates {
    files: string[];
    totalFiles: number;
    skippedFiles: number;
}

function findSessionFiles(root: string, earliestStartMs: number): SessionFileCandidates {
    const files: string[] = [];
    let totalFiles = 0;
    let skippedFiles = 0;
    const directories = [root];
    while (directories.length > 0) {
        const directory = directories.pop()!;
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { continue; }
        for (const entry of entries) {
            const filePath = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                directories.push(filePath);
                continue;
            }
            if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
            totalFiles += 1;
            try {
                if (fs.statSync(filePath).mtimeMs < earliestStartMs) {
                    skippedFiles += 1;
                    continue;
                }
            } catch {
                skippedFiles += 1;
                continue;
            }
            files.push(filePath);
        }
    }
    return { files, totalFiles, skippedFiles };
}

interface ParsedUsageEntry {
    entryId: string | null;
    model: string;
    usage: any;
    indexes: number[];
}

/**
 * Scan the local Pi session store for Command Code assistant messages and
 * aggregate token/cost/session usage into the given time ranges.
 *
 * Source records are nested, e.g.:
 *   { type: "message", message: { role: "assistant", provider: "commandcode", model, usage: {...} }, timestamp }
 */
export async function scanSessionsInRanges(
    ranges: Array<TimeRange | null>,
    sessionsDir = defaultSessionsDir(),
): Promise<SessionScanResult> {
    const stats = ranges.map(() => emptyStats());
    const quality = emptyScanQuality();
    if (!ranges.some((range) => Boolean(range)) || !fs.existsSync(sessionsDir)) return { stats, quality };
    const activeRanges = ranges.filter((range): range is TimeRange => Boolean(range));
    const earliestStartMs = Math.min(...activeRanges.map((range) => range.start.getTime()));
    const candidates = findSessionFiles(sessionsDir, earliestStartMs);
    quality.totalFiles = candidates.totalFiles;
    quality.skippedFiles = candidates.skippedFiles;

    const seenEntryIds = new Set<string>();
    for (const filePath of candidates.files) {
        const entries: ParsedUsageEntry[] = [];
        let completed = false;
        let stream: fs.ReadStream | undefined;
        let rl: readline.Interface | undefined;
        try {
            stream = fs.createReadStream(filePath, { encoding: "utf-8" });
            rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
            for await (const line of rl) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                let obj: any;
                try { obj = JSON.parse(trimmed); } catch { quality.malformedLines += 1; continue; }
                if (!obj || typeof obj !== "object" || Array.isArray(obj)) { quality.malformedLines += 1; continue; }
                const source = obj?.message ?? obj;
                if (source?.role !== "assistant" || source?.provider !== "commandcode") continue;
                const timestamp = messageTimestampMs(obj);
                const usage = sessionUsage(obj);
                if (timestamp === null || !usage) continue;
                const indexes = ranges.flatMap((range, index) =>
                    range && timestamp >= range.start.getTime() && timestamp < range.end.getTime() ? [index] : [],
                );
                if (indexes.length === 0) continue;
                entries.push({ entryId: sessionEntryId(obj), model: sessionModel(obj), usage, indexes });
            }
            completed = true;
        } catch {
            quality.skippedFiles += 1;
        } finally {
            rl?.close();
            stream?.destroy();
        }
        if (!completed) continue;
        quality.parsedFiles += 1;
        const inWindows = ranges.map(() => false);
        for (const entry of entries) {
            if (entry.entryId && seenEntryIds.has(entry.entryId)) {
                quality.duplicateEntries += 1;
                continue;
            }
            if (entry.entryId) seenEntryIds.add(entry.entryId);
            for (const index of entry.indexes) {
                inWindows[index] = true;
                addUsageStats(stats[index]!, entry.model, entry.usage);
            }
        }
        for (let index = 0; index < inWindows.length; index += 1) {
            if (inWindows[index]) stats[index]!.sessions++;
        }
    }
    return { stats, quality };
}
