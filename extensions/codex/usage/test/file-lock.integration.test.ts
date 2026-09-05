import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

test("serializes the refresh lock across processes", async () => {
	const directory = mkdtempSync(join(tmpdir(), "codex-usage-lock-"));
	const lockPath = join(directory, "refresh.lock");
	const statePath = join(directory, "state.json");
	const workerPath = join(process.cwd(), "test", "refresh-lock-worker.ts");
	writeFileSync(statePath, JSON.stringify({ active: 0, maxActive: 0, acquired: 0 }), "utf-8");
	const run = (delay: number) => new Promise<void>((resolve, reject) => {
		const child = spawn(process.execPath, ["--experimental-strip-types", workerPath, lockPath, statePath, String(delay)], { stdio: ["ignore", "ignore", "pipe"] });
		let stderr = "";
		child.stderr.setEncoding("utf-8");
		child.stderr.on("data", (chunk: string) => { stderr += chunk; });
		child.on("error", reject);
		child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`worker exited ${code}: ${stderr}`)));
	});
	try {
		const first = run(250);
		await new Promise((resolve) => setTimeout(resolve, 25));
		const second = run(250);
		await Promise.all([first, second]);
		const state = JSON.parse(readFileSync(statePath, "utf-8")) as { active: number; maxActive: number; acquired: number };
		assert.equal(state.active, 0);
		assert.equal(state.maxActive, 1);
		assert.equal(state.acquired, 2);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});
