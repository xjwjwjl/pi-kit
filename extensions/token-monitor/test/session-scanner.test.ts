import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { scanTokenEvents } from "../src/session-scanner.ts";
import { customRange, parseLocalDateTime } from "../src/time-range.ts";

function jsonl(...entries: unknown[]): string {
	return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

async function temporaryRoot(t: test.TestContext): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "token-monitor-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	return root;
}

function assistant(
	id: string,
	timestamp: string,
	extra: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp,
		message: {
			role: "assistant",
			provider: "openai",
			model: "gpt-test",
			usage: {
				input: 100,
				output: 20,
				cacheRead: 10,
				cacheWrite: 5,
				cost: { total: 0.25 },
			},
			stopReason: "stop",
			...extra,
		},
	};
}

test("scanner keeps only explicitly attributed assistant messages and deduplicates forked entries", async (t) => {
	const root = await temporaryRoot(t);
	const originalFile = join(root, "original.jsonl");
	const forkFile = join(root, "fork.jsonl");
	await writeFile(
		originalFile,
		jsonl(
			{ type: "session", version: 3, id: "original", timestamp: "2026-07-20T00:00:00.000Z", cwd: "D:\\code\\original" },
			assistant("a1", "2026-07-21T10:00:00.000Z"),
			assistant("missing-provider", "2026-07-21T11:00:00.000Z", {
				provider: undefined,
			}),
			assistant("a3", "2026-07-22T10:00:00.000Z", {
				model: "requested-model",
				responseModel: "actual-model",
			}),
			{ type: "message", id: "tool", parentId: null, timestamp: "2026-07-22T11:00:00.000Z", message: { role: "toolResult", usage: { input: 900 } } },
			{ type: "compaction", id: "compact", parentId: null, timestamp: "2026-07-22T12:00:00.000Z", usage: { input: 900 } },
		),
	);
	await writeFile(
		forkFile,
		jsonl(
			{ type: "session", version: 3, id: "fork", timestamp: "2026-07-22T13:00:00.000Z", cwd: "D:\\code\\fork" },
			assistant("a1", "2026-07-21T10:00:00.000Z"),
			assistant("a4", "2026-07-22T13:30:00.000Z", { provider: "anthropic", model: "sonnet" }),
		),
	);

	const result = await scanTokenEvents({
		rootDir: root,
		range: customRange(Date.parse("2026-07-21T00:00:00.000Z"), Date.parse("2026-07-23T00:00:00.000Z")),
		concurrency: 1,
	});

	assert.deepEqual(new Set(result.events.map((event) => event.entryId)), new Set(["a1", "a3", "a4"]));
	assert.equal(result.events.length, 3);
	assert.equal(result.deduplicatedEvents, 1);
	assert.equal(result.events.find((event) => event.entryId === "a1")?.scope, "D:\\code\\original");
	assert.equal(result.events.find((event) => event.entryId === "a3")?.model, "actual-model");
	assert.equal(result.events.find((event) => event.entryId === "a3")?.requestedModel, "requested-model");
});

test("scanner applies an inclusive start and exclusive end range", async (t) => {
	const root = await temporaryRoot(t);
	await writeFile(
		join(root, "range.jsonl"),
		jsonl(
			{ type: "session", version: 3, id: "range", timestamp: "2026-07-01T00:00:00.000Z", cwd: "/tmp/range" },
			assistant("at-start", "2026-07-01T10:00:00.000Z"),
			assistant("at-end", "2026-07-01T11:00:00.000Z"),
		),
	);
	const result = await scanTokenEvents({
		rootDir: root,
		range: customRange(Date.parse("2026-07-01T10:00:00.000Z"), Date.parse("2026-07-01T11:00:00.000Z")),
	});
	assert.deepEqual(result.events.map((event) => event.entryId), ["at-start"]);
});

test("local custom date parsing rejects impossible dates", () => {
	assert.equal(parseLocalDateTime("2026-07-22 14:30"), new Date(2026, 6, 22, 14, 30).getTime());
	assert.equal(parseLocalDateTime("2026-02-30 14:30"), undefined);
	assert.equal(parseLocalDateTime("not a date"), undefined);
});
