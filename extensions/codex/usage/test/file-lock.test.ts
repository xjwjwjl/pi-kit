import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isLockBusyError, LOCK_STALE_MS, LOCK_WAIT_MS, withDirectoryLock } from "../src/file-lock.ts";

test("only treats an existing lock as lock contention", () => {
	assert.equal(isLockBusyError({ code: "EEXIST" }), true);
	assert.equal(isLockBusyError({ code: "EACCES" }), false);
	assert.equal(isLockBusyError({ code: "EPERM" }), false);
	assert.equal(isLockBusyError(new Error("permission denied")), false);
});

test("waits long enough to reclaim a stale lock", () => {
	assert.ok(LOCK_WAIT_MS > LOCK_STALE_MS);
});

test("does not wait on an invalid lock path", async () => {
	const directory = mkdtempSync(join(tmpdir(), "codex-usage-lock-path-"));
	const parentFile = join(directory, "not-a-directory");
	writeFileSync(parentFile, "file", "utf-8");
	try {
		await assert.rejects(withDirectoryLock(join(parentFile, "refresh.lock"), async () => true));
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
