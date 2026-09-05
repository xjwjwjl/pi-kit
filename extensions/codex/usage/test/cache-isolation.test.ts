import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createCacheEntry, getQuotaCachePaths, loadPersistentCache, savePersistentCache } from "../src/quota-cache.ts";

const credential = { access: "new-cache-token" };
const result = { status: "success" as const, usage: { allowed: true, rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18_000 } } } };

test("only the codex-usage cache participates in persistence", async () => {
	const root = await mkdtemp(join(tmpdir(), "codex-usage-cache-isolation-"));
	const oldCache = join(root, "codex-quota-cache.json");
	await writeFile(oldCache, JSON.stringify({ legacy: { result, observedAt: Date.now(), lastAttemptAt: Date.now(), stale: false, retryCount: 0 } }), "utf-8");
	const paths = getQuotaCachePaths(root);
	try {
		const before = loadPersistentCache(paths);
		assert.deepEqual(before, {});
		savePersistentCache(credential, createCacheEntry(undefined, result, Date.now()), paths);
		assert.equal((await readFile(oldCache, "utf-8")).includes("new-cache-token"), false);
		assert.equal((await readFile(paths.cacheFile, "utf-8")).includes("new-cache-token"), false);
		assert.notEqual((await readFile(paths.cacheFile, "utf-8")).length, 0);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
