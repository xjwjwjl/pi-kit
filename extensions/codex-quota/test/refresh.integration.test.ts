import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

type WorkerResult = { code: number | null; stderr: string };

function runRefreshWorker(
  workerPath: string,
  loaderPath: string,
  agentDir: string,
  donePath: string,
  mode: "failure" | "success" | "cancel",
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--experimental-strip-types",
      "--experimental-loader",
      loaderPath,
      workerPath,
      agentDir,
      donePath,
      mode,
    ], { cwd: process.cwd(), env, stdio: ["ignore", "ignore", "pipe"] });
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
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ code, stderr });
    });
  });
}

function createScenario() {
  const root = mkdtempSync(join(tmpdir(), "codex-quota-refresh-"));
  const agentDir = join(root, ".pi", "agent");
  const counterPath = join(root, "requests.log");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "auth.json"), JSON.stringify({
    "openai-codex": {
      type: "oauth",
      access: "test-access-token",
      refresh: "test-refresh-token",
      expires: Date.now() + 60 * 60 * 1000,
    },
  }), "utf-8");

  return { root, agentDir, counterPath };
}

function scenarioEnv(
  scenario: ReturnType<typeof createScenario>,
  delayMs: number,
  curlMode: "failure" | "success" = "failure",
) {
  return {
    ...process.env,
    HOME: scenario.root,
    USERPROFILE: scenario.root,
    PI_CODING_AGENT_DIR: scenario.agentDir,
    CODEX_QUOTA_COUNTER: scenario.counterPath,
    CODEX_QUOTA_FAKE_CURL_DELAY_MS: String(delayMs),
    CODEX_QUOTA_FAKE_CURL_MODE: curlMode,
  };
}

function requestCount(counterPath: string): number {
  try {
    return readFileSync(counterPath, "utf-8").trim().split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
}

test("deduplicates a failed refresh across processes", async () => {
  const scenario = createScenario();
  const workerPath = "./test/refresh-worker.ts";
  const loaderPath = "./test/refresh-test-loader.mjs";
  const firstDonePath = join(scenario.root, "first.done");
  const secondDonePath = join(scenario.root, "second.done");
  const env = scenarioEnv(scenario, 250);

  try {
    const first = runRefreshWorker(
      workerPath,
      loaderPath,
      scenario.agentDir,
      firstDonePath,
      "failure",
      env,
      15_000,
    );
    await new Promise((resolve) => setTimeout(resolve, 40));
    const second = runRefreshWorker(
      workerPath,
      loaderPath,
      scenario.agentDir,
      secondDonePath,
      "failure",
      env,
      15_000,
    );
    const results = await Promise.all([first, second]);

    assert.deepEqual(results.map((result) => result.code), [0, 0]);
    assert.equal(requestCount(scenario.counterPath), 1);
    assert.ok(readFileSync(join(scenario.agentDir, "codex-quota-cache.json"), "utf-8"));
    assert.equal(readdirSync(scenario.agentDir).some((name) => name.endsWith(".tmp")), false);
  } finally {
    rmSync(scenario.root, { recursive: true, force: true });
  }
});

test("deduplicates a successful refresh across processes", async () => {
  const scenario = createScenario();
  const workerPath = "./test/refresh-worker.ts";
  const loaderPath = "./test/refresh-test-loader.mjs";
  const firstDonePath = join(scenario.root, "first-success.done");
  const secondDonePath = join(scenario.root, "second-success.done");
  const env = scenarioEnv(scenario, 250, "success");

  try {
    const first = runRefreshWorker(
      workerPath,
      loaderPath,
      scenario.agentDir,
      firstDonePath,
      "success",
      env,
      15_000,
    );
    await new Promise((resolve) => setTimeout(resolve, 40));
    const second = runRefreshWorker(
      workerPath,
      loaderPath,
      scenario.agentDir,
      secondDonePath,
      "success",
      env,
      15_000,
    );
    const results = await Promise.all([first, second]);

    assert.deepEqual(results.map((result) => result.code), [0, 0]);
    assert.equal(requestCount(scenario.counterPath), 1);
    assert.ok(readFileSync(join(scenario.agentDir, "codex-quota-cache.json"), "utf-8"));
  } finally {
    rmSync(scenario.root, { recursive: true, force: true });
  }
});

test("cancels an in-flight curl when the session shuts down", async () => {
  const scenario = createScenario();
  const workerPath = "./test/refresh-worker.ts";
  const loaderPath = "./test/refresh-test-loader.mjs";
  const donePath = join(scenario.root, "cancel.done");
  const env = scenarioEnv(scenario, 5_000);

  try {
    const result = await runRefreshWorker(
      workerPath,
      loaderPath,
      scenario.agentDir,
      donePath,
      "cancel",
      env,
      3_000,
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(requestCount(scenario.counterPath), 1);
    assert.equal(existsSync(join(scenario.agentDir, "codex-quota-cache.json")), false);
    assert.equal(readdirSync(scenario.agentDir).some((name) => name.includes("codex-quota-cache.json.snapshot.")), false);
  } finally {
    rmSync(scenario.root, { recursive: true, force: true });
  }
});
