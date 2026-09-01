import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

type WorkerResult = { code: number | null; stderr: string };

function runSessionWorker(
  agentDir: string,
  donePath: string,
  scenario: "session-start" | "credential-changed" | "retry",
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--experimental-strip-types",
      "--experimental-loader",
      "./test/refresh-test-loader.mjs",
      "./test/session-refresh-worker.ts",
      agentDir,
      donePath,
      scenario,
    ], { cwd: process.cwd(), env, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`session worker timed out (${scenario}): ${stderr.trim()}`));
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

function createScenario(hasCredential: boolean) {
  const root = mkdtempSync(join(tmpdir(), "codex-quota-session-"));
  const agentDir = join(root, ".pi", "agent");
  mkdirSync(agentDir, { recursive: true });
  const credential = hasCredential ? {
    "openai-codex": {
      type: "oauth",
      access: "test-access-token",
      refresh: "test-refresh-token",
      expires: Date.now() + 60 * 60 * 1000,
    },
  } : {};
  writeFileSync(join(agentDir, "auth.json"), JSON.stringify(credential), "utf-8");
  return { root, agentDir };
}

function sessionEnv(root: string, agentDir: string) {
  return {
    ...process.env,
    HOME: root,
    USERPROFILE: root,
    PI_CODING_AGENT_DIR: agentDir,
    CODEX_QUOTA_FAKE_CURL_DELAY_MS: "150",
    CODEX_QUOTA_FAKE_CURL_MODE: "success",
  };
}

test("session_start triggers an immediate quota refresh", async () => {
  const scenario = createScenario(true);
  const donePath = join(scenario.root, "session.done");
  const env = sessionEnv(scenario.root, scenario.agentDir);

  try {
    const result = await runSessionWorker(
      scenario.agentDir,
      donePath,
      "session-start",
      env,
      5_000,
    );
    assert.equal(result.code, 0, result.stderr);
    const recorded = JSON.parse(readFileSync(donePath, "utf-8")) as { status?: string };
    assert.ok(
      recorded.status?.includes("%"),
      `expected a quota status without waiting for the boundary timer, got ${JSON.stringify(recorded)}`,
    );
  } finally {
    rmSync(scenario.root, { recursive: true, force: true });
  }
});

test("credential-changed triggers an immediate quota refresh", async () => {
  const scenario = createScenario(false);
  const donePath = join(scenario.root, "credential.done");
  const env = sessionEnv(scenario.root, scenario.agentDir);

  try {
    const result = await runSessionWorker(
      scenario.agentDir,
      donePath,
      "credential-changed",
      env,
      5_000,
    );
    assert.equal(result.code, 0, result.stderr);
    const recorded = JSON.parse(readFileSync(donePath, "utf-8")) as { status?: string };
    assert.ok(
      recorded.status?.includes("%"),
      `expected a quota status after the credential-changed event, got ${JSON.stringify(recorded)}`,
    );
  } finally {
    rmSync(scenario.root, { recursive: true, force: true });
  }
});

test("failed refresh auto-retries with backoff and recovers", async () => {
  const scenario = createScenario(true);
  const counterPath = join(scenario.root, "requests.log");
  const donePath = join(scenario.root, "retry.done");
  const env = {
    ...sessionEnv(scenario.root, scenario.agentDir),
    CODEX_QUOTA_COUNTER: counterPath,
    // 首次请求失败、第二次成功：验证退避定时器能在不等待 5 分钟边界的情况下自动重试并恢复。
    CODEX_QUOTA_FAKE_CURL_MODE: "fail-once",
    CODEX_QUOTA_FAKE_CURL_DELAY_MS: "100",
  };

  try {
    const result = await runSessionWorker(
      scenario.agentDir,
      donePath,
      "retry",
      env,
      12_000,
    );
    assert.equal(result.code, 0, result.stderr);
    const recorded = JSON.parse(readFileSync(donePath, "utf-8")) as { status?: string };
    assert.ok(
      recorded.status?.includes("%"),
      `expected recovery via backoff retry, got ${JSON.stringify(recorded)}`,
    );
    const requests = readFileSync(counterPath, "utf-8").trim().split("\n").filter(Boolean).length;
    assert.equal(requests, 2, "expected one failed fetch plus one backoff retry");
  } finally {
    rmSync(scenario.root, { recursive: true, force: true });
  }
});
