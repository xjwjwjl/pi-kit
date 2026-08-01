import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadCompactToolUiSettings, saveCompactToolUiSettings } from "../settings/compact-tool-ui.js";

async function withTempHomeAndProject(fn: (paths: { home: string; cwd: string }) => Promise<void>) {
	const root = await mkdtemp(path.join(os.tmpdir(), "compact-tool-ui-settings-"));
	const oldHome = process.env.HOME;
	const oldUserProfile = process.env.USERPROFILE;
	const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
	const home = path.join(root, "home");
	const cwd = path.join(root, "project");
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	try {
		await mkdir(path.join(home, ".pi", "agent"), { recursive: true });
		await mkdir(path.join(cwd, ".pi"), { recursive: true });
		await fn({ home, cwd });
	} finally {
		if (oldHome === undefined) delete process.env.HOME;
		else process.env.HOME = oldHome;
		if (oldUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = oldUserProfile;
		if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
		await rm(root, { recursive: true, force: true });
	}
}

test("settings load ignores project compactToolUi overrides", async () => {
	await withTempHomeAndProject(async ({ home, cwd }) => {
		await writeFile(
			path.join(home, ".pi", "agent", "settings.json"),
			JSON.stringify({ compactToolUi: { bash: { runningTailPreview: true, previewLines: 5 }, edit: { inlineDiffMaxLines: 0 }, renderShell: "default" } }),
		);
		await writeFile(
			path.join(cwd, ".pi", "settings.json"),
			JSON.stringify({ compactToolUi: { bash: { successfulOutputSummary: false, successfulTailPreview: true }, renderShell: "self" } }),
		);

		const loaded = await loadCompactToolUiSettings();
		assert.deepEqual(loaded.effective.bash, {
			runningTailPreview: true,
			previewLines: 5,
		});
		assert.deepEqual(loaded.effective.edit, {
			inlineDiffMaxLines: 0,
		});
		assert.equal(loaded.effective.renderShell, "default");
	});
});

test("settings honor PI_CODING_AGENT_DIR", async () => {
	await withTempHomeAndProject(async ({ home }) => {
		const agentDir = path.join(home, "custom-agent");
		const settingsPath = path.join(agentDir, "settings.json");
		process.env.PI_CODING_AGENT_DIR = agentDir;
		await mkdir(agentDir, { recursive: true });
		await writeFile(settingsPath, JSON.stringify({ compactToolUi: { renderShell: "default" } }));

		assert.equal((await loadCompactToolUiSettings()).effective.renderShell, "default");
		await saveCompactToolUiSettings({ bash: { previewLines: 8 } });
		const saved = JSON.parse(await readFile(settingsPath, "utf8"));
		assert.equal(saved.compactToolUi.bash.previewLines, 8);
		await assert.rejects(readFile(path.join(home, ".pi", "agent", "settings.json"), "utf8"));
	});
});

test("settings load migrates legacy settledTailPreview to successfulTailPreview", async () => {
	await withTempHomeAndProject(async ({ home }) => {
		await writeFile(
			path.join(home, ".pi", "agent", "settings.json"),
			JSON.stringify({ compactToolUi: { bash: { settledTailPreview: true } } }),
		);

		const loaded = await loadCompactToolUiSettings();
		assert.equal(loaded.effective.bash?.successfulTailPreview, true);
		assert.equal("settledTailPreview" in (loaded.effective.bash ?? {}), false);
	});
});

test("saving settings merges nested compactToolUi keys instead of replacing them", async () => {
	await withTempHomeAndProject(async ({ home, cwd }) => {
		const globalSettings = path.join(home, ".pi", "agent", "settings.json");
		const projectSettings = path.join(cwd, ".pi", "settings.json");
		await writeFile(
			globalSettings,
			JSON.stringify({
				unrelated: true,
				compactToolUi: {
					read: { compact: true },
					bash: { runningTailPreview: true },
					edit: { inlineDiffMaxLines: 32, futureOption: true },
				},
			}),
		);
		await writeFile(projectSettings, JSON.stringify({ compactToolUi: { renderShell: "self" } }));

		await saveCompactToolUiSettings({ bash: { previewLines: 8, successfulTailPreview: true }, edit: { inlineDiffMaxLines: 0 }, renderShell: "default" });
		const saved = JSON.parse(await readFile(globalSettings, "utf8"));
		const projectSaved = JSON.parse(await readFile(projectSettings, "utf8"));

		assert.equal(saved.unrelated, true);
		assert.deepEqual(saved.compactToolUi.read, { compact: true });
		assert.deepEqual(saved.compactToolUi.bash, { runningTailPreview: true, previewLines: 8, successfulTailPreview: true });
		assert.deepEqual(saved.compactToolUi.edit, { inlineDiffMaxLines: 0, futureOption: true });
		assert.equal(saved.compactToolUi.renderShell, "default");
		assert.deepEqual(projectSaved, { compactToolUi: { renderShell: "self" } });
	});
});
