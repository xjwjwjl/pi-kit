import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

function runWorker(workerPath: string, lockPath: string, statePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--experimental-strip-types",
      workerPath,
      lockPath,
      statePath,
      "250",
    ], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`lock worker exited with ${code}: ${stderr.trim()}`));
      }
    });
  });
}

test("serializes the refresh lock across processes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "codex-quota-lock-"));
  const lockPath = join(directory, "refresh.lock");
  const statePath = join(directory, "state.json");
  const workerPath = join(process.cwd(), "test", "refresh-lock-worker.ts");
  writeFileSync(statePath, JSON.stringify({ active: 0, maxActive: 0, acquired: 0 }), "utf-8");

  try {
    const first = runWorker(workerPath, lockPath, statePath);
    await new Promise((resolve) => setTimeout(resolve, 25));
    const second = runWorker(workerPath, lockPath, statePath);
    await Promise.all([first, second]);

    const state = JSON.parse(readFileSync(statePath, "utf-8")) as {
      active: number;
      maxActive: number;
      acquired: number;
    };
    assert.equal(state.active, 0);
    assert.equal(state.maxActive, 1);
    assert.equal(state.acquired, 2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
