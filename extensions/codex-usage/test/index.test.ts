import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { formatReport, formatWindowDuration, scanSessionsInRanges } from "../index.ts";

function jsonl(...entries: unknown[]): string {
	return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

async function temporarySessions(t: test.TestContext): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "codex-usage-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	return root;
}

test("scanner filters old files, counts quality, normalizes formats, and deduplicates forks", async (t) => {
	const root = await temporarySessions(t);
	const nested = join(root, "project", "forks");
	await mkdir(nested, { recursive: true });

	const originalFile = join(root, "original.jsonl");
	await writeFile(
		originalFile,
		jsonl(
			{
				type: "message",
				id: "shared-entry",
				timestamp: "2026-08-28T10:15:00.000Z",
				provider: "openai-codex",
				responseModel: "actual-model",
				usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 5, totalTokens: 130, cost: { total: 0.1 } },
				message: { role: "assistant" },
			},
			{
				type: "message",
				id: "legacy-entry",
				timestamp: "2026-08-28T10:20:00.000Z",
				message: {
					role: "assistant",
					provider: "openai-codex",
					modelId: "legacy-model",
					usage: {
						input_tokens: "7",
						output_tokens: "3",
						cache_read_input_tokens: "2",
						cache_creation_input_tokens: "1",
						cost: "0.01",
					},
				},
			},
			{
				type: "message",
				id: "other-provider",
				timestamp: "2026-08-28T10:25:00.000Z",
				message: { role: "assistant", provider: "other", usage: { totalTokens: 999 } },
			},
		) + "{not-json\n",
	);
	await utimes(originalFile, new Date("2026-08-28T10:30:00.000Z"), new Date("2026-08-28T10:30:00.000Z"));

	const forkFile = join(nested, "fork.jsonl");
	await writeFile(
		forkFile,
		jsonl({
			type: "message",
			id: "shared-entry",
			timestamp: "2026-08-28T10:15:00.000Z",
			provider: "openai-codex",
			responseModel: "actual-model",
			usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 5, totalTokens: 130, cost: { total: 0.1 } },
			message: { role: "assistant" },
		}),
	);
	await utimes(forkFile, new Date("2026-08-28T10:30:00.000Z"), new Date("2026-08-28T10:30:00.000Z"));

	const staleFile = join(root, "stale.jsonl");
	await writeFile(
		staleFile,
		jsonl({
			type: "message",
			id: "stale-entry",
			timestamp: "2026-08-28T10:30:00.000Z",
			provider: "openai-codex",
			model: "stale-model",
			usage: { input: 999, output: 1, totalTokens: 1000 },
		}),
	);
	await utimes(staleFile, new Date("2026-08-01T00:00:00.000Z"), new Date("2026-08-01T00:00:00.000Z"));

	const result = await scanSessionsInRanges([
		{ start: new Date("2026-08-28T10:00:00.000Z"), end: new Date("2026-08-28T11:00:00.000Z") },
	], root);
	const [stats] = result.stats;

	assert.equal(stats.totalTokens, 140);
	assert.equal(stats.input, 107);
	assert.equal(stats.output, 23);
	assert.equal(stats.cacheRead, 7);
	assert.equal(stats.cacheWrite, 6);
	assert.equal(stats.cost, 0.11);
	assert.equal(stats.sessions, 1);
	assert.equal(stats.models["actual-model"]?.totalTokens, 130);
	assert.equal(stats.models["legacy-model"]?.totalTokens, 10);
	assert.equal(result.quality.totalFiles, 3);
	assert.equal(result.quality.parsedFiles, 2);
	assert.equal(result.quality.skippedFiles, 1);
	assert.equal(result.quality.malformedLines, 1);
	assert.equal(result.quality.duplicateEntries, 1);
});

test("uses actual quota durations and never reports an unavailable quota as available", () => {
	assert.equal(formatWindowDuration({ limit_window_seconds: 5 * 60 * 60 }), "5h");
	assert.equal(formatWindowDuration({ limit_window_seconds: 90 * 60 }), "90m");

	const report = formatReport({
		email: "unknown",
		plan: "unknown",
		allowed: null,
		limitReached: false,
		apiError: "network failure",
		fiveHWindow: null,
		sevenDWindow: null,
		fiveHRange: null,
		sevenDRange: null,
		fiveH: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, sessions: 0, models: {} },
		sevenD: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, sessions: 0, models: {} },
		scanQuality: { totalFiles: 0, parsedFiles: 0, skippedFiles: 0, malformedLines: 0, duplicateEntries: 0 },
		now: new Date("2026-08-28T10:00:00.000Z"),
	});

	assert.match(report, /Codex Usage  UNAVAILABLE/);
	assert.match(report, /scan 0\/0 files/);
	assert.doesNotMatch(report, /Codex Usage  AVAILABLE/);
});
