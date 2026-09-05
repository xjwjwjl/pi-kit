import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";

test("uses defaults when optional config file is absent", () => {
  const result = loadConfig(join(tmpdir(), "gogate-failover-does-not-exist.json"));
  assert.equal(result.config.enabled, true);
  assert.equal(result.config.provider, "gogate");
  assert.equal(result.config.models, undefined);
});

test("normalizes explicit model pool and limits", () => {
  const directory = mkdtempSync(join(tmpdir(), "gogate-failover-"));
  const path = join(directory, "config.json");
  try {
    writeFileSync(path, JSON.stringify({
      enabled: true,
      provider: "gogate",
      models: ["gogate/a", "gogate/a", "gogate/b", 42],
      cooldownMs: 1234,
      maxSwitchesPerRun: 1,
    }));

    const result = loadConfig(path);
    assert.deepEqual(result.config.models, ["gogate/a", "gogate/b"]);
    assert.equal(result.config.cooldownMs, 1234);
    assert.equal(result.config.maxSwitchesPerRun, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
