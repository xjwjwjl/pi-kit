import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  getGlobalSettingsPath,
  getProjectSettingsPath,
  loadFastModeConfig,
  mergeConfig,
  normalizeBlacklist,
  normalizeConfig,
  saveFastModePatch,
} from "../src/config.ts";

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-fast-mode-config-"));
  await mkdir(path.join(root, "agent"), { recursive: true });
  await mkdir(path.join(root, "project", ".pi"), { recursive: true });
  return root;
}

test("normalizeBlacklist trims, deduplicates, and ignores invalid values", () => {
  assert.deepEqual(normalizeBlacklist([" gpt-5.5 ", "gpt-5.5", "", 1, null]), ["gpt-5.5"]);
  assert.deepEqual(normalizeBlacklist([]), []);
  assert.equal(normalizeBlacklist("bad"), undefined);
});

test("normalizeConfig falls back safely", () => {
  assert.deepEqual(normalizeConfig(null), { enabled: true, blacklist: [] });
  assert.deepEqual(normalizeConfig({ enabled: true, blacklist: [" gpt-5.4 "] }), {
    enabled: true,
    blacklist: ["gpt-5.4"],
  });
});

test("project fields override global fields independently", () => {
  assert.deepEqual(
    mergeConfig(
      { enabled: false, blacklist: ["gpt-5.4"] },
      { enabled: true },
    ),
    { enabled: true, blacklist: ["gpt-5.4"] },
  );

  assert.deepEqual(
    mergeConfig(
      { enabled: true, blacklist: ["gpt-5.4"] },
      { blacklist: [] },
    ),
    { enabled: true, blacklist: [] },
  );
});

test("loadFastModeConfig uses a project section when trusted", async () => {
  const root = await makeTempRoot();
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "project");
  try {
    await writeFile(
      getGlobalSettingsPath(agentDir),
      JSON.stringify({ "codex-fast-mode": { enabled: false, blacklist: ["gpt-5.4"] } }),
      "utf8",
    );
    await writeFile(
      getProjectSettingsPath(cwd),
      JSON.stringify({ "codex-fast-mode": { enabled: true, blacklist: [] } }),
      "utf8",
    );

    const loaded = await loadFastModeConfig({ cwd, agentDir, includeProject: true });
    assert.deepEqual(loaded.config, { enabled: true, blacklist: [] });
    assert.equal(loaded.scope, "project");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("untrusted project settings are ignored", async () => {
  const root = await makeTempRoot();
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "project");
  try {
    await writeFile(
      getGlobalSettingsPath(agentDir),
      JSON.stringify({ "codex-fast-mode": { enabled: false } }),
      "utf8",
    );
    await writeFile(
      getProjectSettingsPath(cwd),
      JSON.stringify({ "codex-fast-mode": { enabled: true } }),
      "utf8",
    );

    const loaded = await loadFastModeConfig({ cwd, agentDir, includeProject: false });
    assert.deepEqual(loaded.config, { enabled: false, blacklist: [] });
    assert.equal(loaded.scope, "global");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("saveFastModePatch preserves unrelated settings", async () => {
  const root = await makeTempRoot();
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "project");
  try {
    const settingsPath = getGlobalSettingsPath(agentDir);
    await writeFile(
      settingsPath,
      JSON.stringify({ unrelated: true, "codex-fast-mode": { blacklist: ["gpt-5.4"] } }),
      "utf8",
    );

    await saveFastModePatch(
      { cwd, agentDir, scope: "global" },
      { enabled: true },
    );

    const saved = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(saved.unrelated, true);
    assert.deepEqual(saved["codex-fast-mode"], {
      blacklist: ["gpt-5.4"],
      enabled: true,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
