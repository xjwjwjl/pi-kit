import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

type WorkerResult = { code: number | null; stderr: string };

function runRefreshWorker(workerPath: string, loaderPath: string, agentDir: string, donePath: string, mode: "failure" | "success" | "cancel", env: NodeJS.ProcessEnv, timeoutMs: number): Promise<WorkerResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["--experimental-strip-types", "--experimental-loader", loaderPath, workerPath, agentDir, donePath, mode], { cwd: process.cwd(), env, stdio: ["ignore", "ignore", "pipe"] });
		let stderr = "";
		let settled = false;
		const timeout = setTimeout(() => {
			if (settled) return;
			settled = true;
			child.kill();
			reject(new Error(`refresh worker timed out (${mode}): ${stderr.trim()}`));
		}, timeoutMs);
		child.stderr.setEncoding("utf-8");
		child.stderr.on("data", (chunk: string) => { stderr += chunk; });
		child.on("error", (error) => { if (!settled) { settled = true; clearTimeout(timeout); reject(error); } });
		child.on("close", (code) => { if (!settled) { settled = true; clearTimeout(timeout); resolve({ code, stderr }); } });
	});
}

function createScenario() {
	const root = mkdtempSync(join(tmpdir(), "codex-usage-refresh-"));
	const agentDir = join(root, ".pi", "agent");
	const counterPath = join(root, "requests.log");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ "openai-codex": { type: "oauth", access: "test-access-token", expires: Date.now() + 60 * 60 * 1000 } }), "utf-8");
	return { root, agentDir, counterPath };
}

function scenarioEnv(scenario: ReturnType<typeof createScenario>, delayMs: number, mode: "failure" | "success" = "failure") {
	return { ...process.env, HOME: scenario.root, USERPROFILE: scenario.root, PI_CODING_AGENT_DIR: scenario.agentDir, CODEX_USAGE_COUNTER: scenario.counterPath, CODEX_USAGE_FAKE_CURL_DELAY_MS: String(delayMs), CODEX_USAGE_FAKE_CURL_MODE: mode };
}

function requestCount(counterPath: string): number {
	try { return readFileSync(counterPath, "utf-8").trim().split("\n").filter(Boolean).length; } catch { return 0; }
}

test("deduplicates a failed background refresh across processes", async () => {
	const scenario = createScenario();
	const loader = "./test/refresh-test-loader.mjs";
	try {
		const first = runRefreshWorker("./test/refresh-worker.ts", loader, scenario.agentDir, join(scenario.root, "first.done"), "failure", scenarioEnv(scenario, 250), 15_000);
		await new Promise((resolve) => setTimeout(resolve, 40));
		const second = runRefreshWorker("./test/refresh-worker.ts", loader, scenario.agentDir, join(scenario.root, "second.done"), "failure", scenarioEnv(scenario, 250), 15_000);
		const results = await Promise.all([first, second]);
		assert.deepEqual(results.map((result) => result.code), [0, 0]);
		assert.equal(requestCount(scenario.counterPath), 1);
		assert.ok(readFileSync(join(scenario.agentDir, "codex-usage-cache.json"), "utf-8"));
		assert.equal(readdirSync(scenario.agentDir).some((name) => name.endsWith(".tmp")), false);
	} finally {
		rmSync(scenario.root, { recursive: true, force: true });
	}
});

test("deduplicates a successful background refresh across processes", async () => {
	const scenario = createScenario();
	const loader = "./test/refresh-test-loader.mjs";
	try {
		const first = runRefreshWorker("./test/refresh-worker.ts", loader, scenario.agentDir, join(scenario.root, "first-success.done"), "success", scenarioEnv(scenario, 250, "success"), 15_000);
		await new Promise((resolve) => setTimeout(resolve, 40));
		const second = runRefreshWorker("./test/refresh-worker.ts", loader, scenario.agentDir, join(scenario.root, "second-success.done"), "success", scenarioEnv(scenario, 250, "success"), 15_000);
		const results = await Promise.all([first, second]);
		assert.deepEqual(results.map((result) => result.code), [0, 0]);
		assert.equal(requestCount(scenario.counterPath), 1);
	} finally {
		rmSync(scenario.root, { recursive: true, force: true });
	}
});

test("session shutdown cancels an in-flight curl and leaves no cache artifacts", async () => {
	const scenario = createScenario();
	const loader = "./test/refresh-test-loader.mjs";
	try {
		const result = await runRefreshWorker("./test/refresh-worker.ts", loader, scenario.agentDir, join(scenario.root, "cancel.done"), "cancel", scenarioEnv(scenario, 5_000), 10_000);
		assert.equal(result.code, 0, result.stderr);
		assert.equal(requestCount(scenario.counterPath), 1);
		assert.equal(existsSync(join(scenario.agentDir, "codex-usage-cache.json")), false);
		assert.equal(readdirSync(scenario.agentDir).some((name) => name.includes("codex-usage-cache.json.snapshot.")), false);
	} finally {
		rmSync(scenario.root, { recursive: true, force: true });
	}
});
