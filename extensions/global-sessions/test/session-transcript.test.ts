import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadSessionTranscript } from "../src/session-transcript.ts";

function jsonl(...entries: unknown[]): string {
	return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

async function temporaryFile(t: test.TestContext, content: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "global-sessions-transcript-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const file = join(directory, "session.jsonl");
	await writeFile(file, content);
	return file;
}

test("transcript follows the active resumable branch without mutating the source file", async (t) => {
	const source = jsonl(
		{ type: "session", version: 3, id: "session", timestamp: "2026-07-01T00:00:00.000Z", cwd: "D:\\code\\alpha" },
		{ type: "message", id: "u1", parentId: null, timestamp: "2026-07-01T00:00:01.000Z", message: { role: "user", content: "Start" } },
		{ type: "message", id: "a1", parentId: "u1", timestamp: "2026-07-01T00:00:02.000Z", message: { role: "assistant", provider: "openai", model: "root-model", content: "Choose a branch" } },
		{ type: "message", id: "old", parentId: "a1", timestamp: "2026-07-01T00:00:03.000Z", message: { role: "user", content: "Old abandoned branch" } },
		{ type: "message", id: "old-a", parentId: "old", timestamp: "2026-07-01T00:00:04.000Z", message: { role: "assistant", provider: "openai", model: "old-model", content: "Old branch reply" } },
		{ type: "message", id: "active", parentId: "a1", timestamp: "2026-07-01T00:00:05.000Z", message: { role: "user", content: "Active branch" } },
		{ type: "model_change", id: "active-model", parentId: "active", timestamp: "2026-07-01T00:00:06.000Z", provider: "openai", modelId: "active-model" },
		{ type: "custom_message", id: "custom", parentId: "active-model", timestamp: "2026-07-01T00:00:07.000Z", customType: "example", display: true, content: "Visible extension context" },
		{ type: "session_info", id: "info", parentId: "custom", timestamp: "2026-07-01T00:00:08.000Z", name: "Active session" },
	);
	const file = await temporaryFile(t, source);

	const transcript = await loadSessionTranscript(file);
	assert.equal(transcript.alternateBranchCount, 1);
	assert.equal(transcript.model, "openai/active-model");
	assert.deepEqual(transcript.messages.map((message) => message.content), ["Start", "Choose a branch", "Active branch", "Visible extension context"]);
	assert.deepEqual(transcript.messages.map((message) => message.role), ["user", "assistant", "user", "custom"]);
	assert.equal(await readFile(file, "utf8"), source);
});

test("transcript preserves compaction summaries on the active branch", async (t) => {
	const file = await temporaryFile(
		t,
		jsonl(
			{ type: "session", version: 3, id: "session", timestamp: "2026-07-01T00:00:00.000Z", cwd: "D:\\code\\alpha" },
			{ type: "message", id: "u1", parentId: null, timestamp: "2026-07-01T00:00:01.000Z", message: { role: "user", content: "Start" } },
			{ type: "compaction", id: "compact", parentId: "u1", timestamp: "2026-07-01T00:00:02.000Z", summary: "Earlier work was summarized", firstKeptEntryId: "u1", tokensBefore: 100 },
			{ type: "message", id: "a1", parentId: "compact", timestamp: "2026-07-01T00:00:03.000Z", message: { role: "assistant", content: "Continue" } },
		),
	);

	const transcript = await loadSessionTranscript(file);
	assert.deepEqual(transcript.messages.map((message) => message.role), ["user", "summary", "assistant"]);
	assert.equal(transcript.messages[1]?.content, "Earlier work was summarized");
});

test("transcript rejects files without a Pi session header", async (t) => {
	const file = await temporaryFile(t, "{\"type\":\"message\"}\n");
	await assert.rejects(() => loadSessionTranscript(file), /valid Pi session|session header/);
});
