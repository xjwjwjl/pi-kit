import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { scanSessionsInRanges } from "../src/session-scanner.ts";
import type { TimeRange } from "../src/usage-types.ts";

const now = new Date("2026-09-03T12:00:00.000Z");
const hour = 60 * 60 * 1_000;

// A real Command Code assistant line: provider/model/usage nested under message.
function lineAt(timestampMs: number, model: string, usage: Record<string, unknown>, id: string): string {
    return JSON.stringify({
        type: "message",
        id,
        timestamp: timestampMs,
        message: {
            role: "assistant",
            provider: "commandcode",
            model,
            usage: {
                input: 100,
                output: 50,
                cacheRead: 20,
                cacheWrite: 0,
                reasoning: 5,
                totalTokens: 175,
                cost: { total: 0.0123 },
                ...usage,
            },
        },
    });
}

function makeRanges(): [TimeRange, TimeRange] {
    const nowMs = now.getTime();
    return [
        { start: new Date(nowMs - 5 * hour), end: new Date(nowMs) },
        { start: new Date(nowMs - 7 * 24 * hour), end: new Date(nowMs) },
    ];
}

test("scanSessionsInRanges aggregates commandcode usage by window and model", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-scan-"));
    const sessionsDir = join(dir, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    // File modified recently (within 5h) so it is not skipped.
    const file = join(sessionsDir, "session.jsonl");

    const nowMs = now.getTime();
    const lines = [
        lineAt(nowMs - hour, "z-ai/glm-5.3-flash", { input: 1000, output: 100, totalTokens: 1100, reasoning: 0, cost: { total: 0.5 } }, "a1"),
        lineAt(nowMs - 3 * hour, "Qwen/Qwen3.8-Flash", { input: 2000, output: 200, totalTokens: 2200, reasoning: 0, cost: { total: 0.3 } }, "a2"),
        // Older than 5 hours: only in weekly window.
        lineAt(nowMs - 2 * 24 * hour, "deepseek/deepseek-v4-flash-fast", { input: 3000, output: 300, totalTokens: 3300, reasoning: 0, cost: { total: 0.7 } }, "a3"),
        // Non-commandcode / non-assistant lines should be ignored.
        lineAt(nowMs - hour, "z-ai/glm-5.3-flash", { input: 1, totalTokens: 1, reasoning: 0, cost: { total: 0 } }, "b1").replace('"provider":"commandcode"', '"provider":"gogate'),
    ];
    writeFileSync(file, lines.join("\n") + "\n", "utf-8");

    try {
        const result = await scanSessionsInRanges(makeRanges(), sessionsDir);
        const [fiveHour, weekly] = result.stats;

        assert.equal(result.quality.totalFiles, 1);
        assert.equal(result.quality.parsedFiles, 1);
        assert.equal(result.quality.skippedFiles, 0);

        // 5-hour window: 2 commandcode entries (a1, a2). a3 and b1 excluded.
        assert.equal(fiveHour.sessions, 1); // one file with activity => one session
        assert.equal(fiveHour.totalTokens, 1100 + 2200);
        assert.equal(fiveHour.input, 1000 + 2000);
        assert.equal(fiveHour.output, 100 + 200);
        assert.equal(fiveHour.cacheRead, 20 + 20);
        assert.equal(fiveHour.cost, 0.5 + 0.3);
        assert.ok(fiveHour.models["z-ai/glm-5.3-flash"]);
        assert.ok(fiveHour.models["Qwen/Qwen3.8-Flash"]);
        assert.equal(Object.keys(fiveHour.models).length, 2);

        // Weekly window: a1, a2, a3.
        assert.equal(weekly.totalTokens, 1100 + 2200 + 3300);
        assert.equal(Object.keys(weekly.models).length, 3);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("scanSessionsInRanges deduplicates copied assistant entries across session files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-scan-duplicates-"));
    const sessionsDir = join(dir, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    const shared = lineAt(now.getTime() - hour, "z-ai/glm-5.3-flash", {
        input: 1_000,
        output: 100,
        cacheRead: 0,
        totalTokens: 1_100,
        reasoning: 0,
        cost: { total: 0.5 },
    }, "shared-entry");
    writeFileSync(join(sessionsDir, "parent.jsonl"), `${shared}\n`, "utf-8");
    writeFileSync(join(sessionsDir, "clone.jsonl"), `${shared}\n`, "utf-8");

    try {
        const result = await scanSessionsInRanges(makeRanges(), sessionsDir);
        assert.equal(result.stats[0]!.totalTokens, 1_100);
        assert.equal(result.stats[0]!.cost, 0.5);
        assert.equal(result.stats[0]!.sessions, 1);
        assert.equal(result.quality.duplicateEntries, 1);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("scanSessionsInRanges includes provider-attributed compaction and toolResult usage", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-scan-nonassistant-"));
    const sessionsDir = join(dir, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    const nowMs = now.getTime();
    const lines = [
        JSON.stringify({
            type: "model_change",
            id: "model-cc",
            timestamp: nowMs - 5 * hour,
            provider: "commandcode",
            modelId: "cc-model",
        }),
        lineAt(nowMs - 4 * hour, "cc-model", {
            input: 10,
            output: 5,
            cacheRead: 0,
            totalTokens: 15,
            reasoning: 0,
            cost: { total: 0.1 },
        }, "assistant-cc"),
        JSON.stringify({
            type: "compaction",
            id: "compaction-cc",
            timestamp: nowMs - 3 * hour,
            usage: {
                input: 20,
                output: 5,
                totalTokens: 25,
                reasoning: 2,
                cost: { total: 0.2 },
            },
        }),
        JSON.stringify({
            type: "message",
            id: "tool-cc",
            timestamp: nowMs - 2 * hour,
            message: {
                role: "toolResult",
                details: {
                    provider: "commandcode",
                    model: "cc-tool",
                    usage: {
                        input: 3,
                        output: 2,
                        totalTokens: 5,
                        reasoning: 0,
                        cost: { total: 0.03 },
                    },
                },
            },
        }),
        JSON.stringify({
            type: "model_change",
            id: "model-other",
            timestamp: nowMs - hour,
            provider: "openai-codex",
            modelId: "gpt-5",
        }),
        JSON.stringify({
            type: "compaction",
            id: "compaction-other",
            timestamp: nowMs - hour,
            usage: { input: 100, output: 10, totalTokens: 110, cost: { total: 1 } },
        }),
        JSON.stringify({
            type: "message",
            id: "tool-ambiguous",
            timestamp: nowMs - hour,
            message: {
                role: "toolResult",
                details: { usage: { input: 100, output: 10, totalTokens: 110, cost: { total: 1 } } },
            },
        }),
    ];
    writeFileSync(join(sessionsDir, "session.jsonl"), `${lines.join("\n")}\n`, "utf-8");

    try {
        const result = await scanSessionsInRanges(makeRanges(), sessionsDir);
        const fiveHour = result.stats[0]!;
        assert.equal(fiveHour.totalTokens, 15 + 25 + 2 + 5);
        assert.equal(fiveHour.input, 10 + 20 + 3);
        assert.equal(fiveHour.output, 5 + 5 + 2);
        assert.equal(fiveHour.cost, 0.1 + 0.2 + 0.03);
        assert.equal(fiveHour.sessions, 1);
        assert.equal(fiveHour.models["cc-model"]?.totalTokens, 15 + 25 + 2);
        assert.equal(fiveHour.models["cc-tool"]?.totalTokens, 5);
        assert.equal(fiveHour.models["gpt-5"], undefined);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("scanSessionsInRanges handles missing sessions dir and empty windows", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-scan-empty-"));
    try {
        const missing = await scanSessionsInRanges(makeRanges(), join(dir, "does-not-exist"));
        assert.deepEqual(missing.stats, missing.stats.map(() => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, sessions: 0, models: {} })));
        assert.equal(missing.quality.totalFiles, 0);
        assert.equal(missing.quality.parsedFiles, 0);

        const noRanges = await scanSessionsInRanges([null, null], sessionsDirOf(dir));
        assert.equal(noRanges.stats.length, 2);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

function sessionsDirOf(dir: string): string {
    return join(dir, "sessions");
}
