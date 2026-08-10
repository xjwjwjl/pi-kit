import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { filterSessions, findMatchSnippet, matchesSession, projectLabel, queryTerms, sessionTitle } from "../src/session-search.ts";
import { scanGlobalSessions } from "../src/session-scanner.ts";

async function temporaryRoot(t: test.TestContext): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "global-sessions-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	return root;
}

function jsonl(...entries: unknown[]): string {
	return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

test("scanner extracts search metadata from nested Pi sessions and skips invalid files", async (t) => {
	const root = await temporaryRoot(t);
	const projectDir = join(root, "--D--code-alpha--");
	await mkdir(projectDir);
	await writeFile(
		join(projectDir, "alpha.jsonl"),
		jsonl(
			{ type: "session", version: 3, id: "alpha-id", timestamp: "2026-07-01T09:00:00.000Z", cwd: "D:\\code\\alpha" },
			{ type: "message", id: "u1", parentId: null, timestamp: "2026-07-01T09:00:01.000Z", message: { role: "user", content: "Plan the migration" } },
			{ type: "message", id: "a1", parentId: "u1", timestamp: "2026-07-01T09:00:02.000Z", message: { role: "assistant", provider: "openai", model: "gpt-test", content: [{ type: "text", text: "Migration plan complete" }] } },
			{ type: "session_info", id: "name", parentId: "a1", timestamp: "2026-07-01T09:00:03.000Z", name: "Schema migration" },
		),
	);
	await writeFile(join(projectDir, "broken.jsonl"), "this is not json\n");

	const scan = await scanGlobalSessions({ rootDir: root, concurrency: 1 });
	assert.equal(scan.totalFiles, 2);
	assert.equal(scan.skippedFiles, 1);
	assert.equal(scan.sessions.length, 1);

	const [session] = scan.sessions;
	assert.equal(session?.id, "alpha-id");
	assert.equal(session?.cwd, "D:\\code\\alpha");
	assert.equal(session?.name, "Schema migration");
	assert.equal(session?.model, "openai/gpt-test");
	assert.equal(session?.firstPrompt, "Plan the migration");
	assert.equal(session?.lastReply, "Migration plan complete");
	assert.equal(session?.messageCount, 2);
	assert.match(session?.allMessagesText ?? "", /Plan the migration/);
	assert.match(session?.allMessagesText ?? "", /Migration plan complete/);
});

test("session search supports AND terms, quoted phrases, paths, models, and snippets", async (t) => {
	const root = await temporaryRoot(t);
	await writeFile(
		join(root, "search.jsonl"),
		jsonl(
			{ type: "session", version: 3, id: "search-id", timestamp: "2026-07-02T09:00:00.000Z", cwd: "D:\\code\\monitor" },
			{ type: "message", id: "u1", parentId: null, timestamp: "2026-07-02T09:00:01.000Z", message: { role: "user", content: "Inspect schema.sql" } },
			{ type: "message", id: "a1", parentId: "u1", timestamp: "2026-07-02T09:00:02.000Z", message: { role: "assistant", provider: "anthropic", model: "sonnet", content: "The migration is complete" } },
		),
	);

	const [session] = (await scanGlobalSessions({ rootDir: root })).sessions;
	assert.ok(session);
	assert.deepEqual(queryTerms('schema "migration is"'), ["schema", "migration is"]);
	assert.equal(matchesSession(session, 'schema "migration is"'), true);
	assert.equal(matchesSession(session, "monitor sonnet"), true);
	assert.equal(matchesSession(session, "schema missing"), false);
	assert.deepEqual(filterSessions([session], "monitor").map((item) => item.id), ["search-id"]);
	assert.match(findMatchSnippet(session, "migration") ?? "", /migration/i);
	assert.equal(sessionTitle(session), "Inspect schema.sql");
	assert.equal(projectLabel(session.cwd), "monitor");
});

test("scanner reports a pre-aborted operation without parsing files", async (t) => {
	const root = await temporaryRoot(t);
	await writeFile(join(root, "session.jsonl"), jsonl({ type: "session", version: 3, id: "id", timestamp: "2026-07-01T00:00:00.000Z", cwd: "D:\\code\\x" }));
	const controller = new AbortController();
	controller.abort();

	const result = await scanGlobalSessions({ rootDir: root, signal: controller.signal });
	assert.equal(result.aborted, true);
	assert.equal(result.sessions.length, 0);
});
