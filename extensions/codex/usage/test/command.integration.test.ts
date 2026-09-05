import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

type Scenario = { root: string; agentDir: string; counterPath: string };

function createScenario(): Scenario {
	const root = mkdtempSync(join(tmpdir(), "codex-usage-command-"));
	const agentDir = join(root, ".pi", "agent");
	mkdirSync(agentDir, { recursive: true });
	const counterPath = join(root, "requests.log");
	writeFileSync(join(agentDir, "auth.json"), "{}", "utf-8");
	return { root, agentDir, counterPath };
}

function runWorker(scenario: Scenario, mode: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [
			"--experimental-strip-types",
			"--experimental-loader",
			"./test/refresh-test-loader.mjs",
			"./test/command-worker.ts",
			scenario.agentDir,
			join(scenario.root, `${mode}.done`),
			mode,
		], {
			cwd: process.cwd(),
			env: {
				...process.env,
				HOME: scenario.root,
				USERPROFILE: scenario.root,
				PI_CODING_AGENT_DIR: scenario.agentDir,
				CODEX_USAGE_COUNTER: scenario.counterPath,
				CODEX_USAGE_FAKE_CURL_DELAY_MS: "50",
			},
			stdio: ["ignore", "ignore", "pipe"],
		});
		let stderr = "";
		child.stderr.setEncoding("utf-8");
		child.stderr.on("data", (chunk: string) => { stderr += chunk; });
		child.on("error", reject);
		child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`command worker exited ${code}: ${stderr}`)));
	});
}

function requestCount(path: string): number {
	try { return readFileSync(path, "utf-8").trim().split("\n").filter(Boolean).length; } catch { return 0; }
}

for (const mode of ["success", "cached-success", "retry-reset", "failure"] as const) {
	test(`command ${mode} uses one live request and updates the controller`, async () => {
		const scenario = createScenario();
		const donePath = join(scenario.root, `${mode}.done`);
		try {
			await runWorker(scenario, mode);
			const done = JSON.parse(readFileSync(donePath, "utf-8")) as { notifications: string[]; statuses: Array<string | undefined>; cache: Record<string, { retryCount: number; nextRetryAt?: number }> | null };
			assert.equal(requestCount(scenario.counterPath), 1);
			assert.ok(done.notifications.some((message) => message.includes("Codex Usage")));
			if (mode === "failure") {
				assert.ok(done.notifications.some((message) => message.includes("unavailable")));
				assert.equal(done.statuses.at(-1), "Codex·quota unavailable");
			} else {
				assert.equal(done.statuses.at(-1), "Codex·5h 76%");
				if (mode === "retry-reset") {
					const entry = Object.values(done.cache ?? {})[0];
					assert.equal(entry?.retryCount, 0);
					assert.equal(entry?.nextRetryAt, undefined);
				}
			}
		} finally {
			rmSync(scenario.root, { recursive: true, force: true });
		}
	});
}
