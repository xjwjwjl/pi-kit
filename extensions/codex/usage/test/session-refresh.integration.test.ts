import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

type WorkerResult = { code: number | null; stderr: string };

function runSessionWorker(agentDir: string, donePath: string, scenario: "session-start" | "credential-changed" | "retry", env: NodeJS.ProcessEnv, timeoutMs: number): Promise<WorkerResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["--experimental-strip-types", "--experimental-loader", "./test/refresh-test-loader.mjs", "./test/session-refresh-worker.ts", agentDir, donePath, scenario], { cwd: process.cwd(), env, stdio: ["ignore", "ignore", "pipe"] });
		let stderr = "";
		let settled = false;
		const timeout = setTimeout(() => { if (!settled) { settled = true; child.kill(); reject(new Error(`session worker timed out (${scenario}): ${stderr.trim()}`)); } }, timeoutMs);
		child.stderr.setEncoding("utf-8");
		child.stderr.on("data", (chunk: string) => { stderr += chunk; });
		child.on("error", (error) => { if (!settled) { settled = true; clearTimeout(timeout); reject(error); } });
		child.on("close", (code) => { if (!settled) { settled = true; clearTimeout(timeout); resolve({ code, stderr }); } });
	});
}

function createScenario(hasCredential: boolean) {
	const root = mkdtempSync(join(tmpdir(), "codex-usage-session-"));
	const agentDir = join(root, ".pi", "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "auth.json"), JSON.stringify(hasCredential ? { "openai-codex": { type: "oauth", access: "test-access-token", expires: Date.now() + 60 * 60 * 1000 } } : {}), "utf-8");
	return { root, agentDir };
}

function sessionEnv(root: string, agentDir: string, extra: NodeJS.ProcessEnv = {}) {
	return { ...process.env, HOME: root, USERPROFILE: root, PI_CODING_AGENT_DIR: agentDir, CODEX_USAGE_FAKE_CURL_DELAY_MS: "150", CODEX_USAGE_FAKE_CURL_MODE: "success", ...extra };
}

test("session_start triggers an immediate quota refresh", async () => {
	const scenario = createScenario(true);
	try {
		const result = await runSessionWorker(scenario.agentDir, join(scenario.root, "session.done"), "session-start", sessionEnv(scenario.root, scenario.agentDir), 15_000);
		assert.equal(result.code, 0, result.stderr);
		const recorded = JSON.parse(readFileSync(join(scenario.root, "session.done"), "utf-8")) as { status?: string };
		assert.ok(recorded.status?.includes("%"));
	} finally { rmSync(scenario.root, { recursive: true, force: true }); }
});

test("credential-changed switches to the new credential and refreshes immediately", async () => {
	const scenario = createScenario(false);
	try {
		const result = await runSessionWorker(scenario.agentDir, join(scenario.root, "credential.done"), "credential-changed", sessionEnv(scenario.root, scenario.agentDir), 15_000);
		assert.equal(result.code, 0, result.stderr);
		const recorded = JSON.parse(readFileSync(join(scenario.root, "credential.done"), "utf-8")) as { status?: string };
		assert.ok(recorded.status?.includes("%"));
	} finally { rmSync(scenario.root, { recursive: true, force: true }); }
});

test("failed background refresh retries with backoff and recovers", async () => {
	const scenario = createScenario(true);
	const counterPath = join(scenario.root, "requests.log");
	try {
		const result = await runSessionWorker(scenario.agentDir, join(scenario.root, "retry.done"), "retry", sessionEnv(scenario.root, scenario.agentDir, { CODEX_USAGE_COUNTER: counterPath, CODEX_USAGE_FAKE_CURL_MODE: "fail-once", CODEX_USAGE_FAKE_CURL_DELAY_MS: "100" }), 12_000);
		assert.equal(result.code, 0, result.stderr);
		const recorded = JSON.parse(readFileSync(join(scenario.root, "retry.done"), "utf-8")) as { status?: string };
		assert.ok(recorded.status?.includes("%"));
		const requests = readFileSync(counterPath, "utf-8").trim().split("\n").filter(Boolean).length;
		assert.equal(requests, 2);
	} finally { rmSync(scenario.root, { recursive: true, force: true }); }
});
