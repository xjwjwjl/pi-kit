import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadToolsUiDisplaySettings, saveToolsUiDisplaySettings } from "../settings/tools-ui-display.js";

async function withTempHomeAndProject(fn: (paths: { home: string; cwd: string }) => Promise<void>) {
	const root = await mkdtemp(path.join(os.tmpdir(), "tools-ui-display-settings-"));
	const oldHome = process.env.HOME;
	const oldUserProfile = process.env.USERPROFILE;
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
		await rm(root, { recursive: true, force: true });
	}
}

test("settings load ignores project toolsUiDisplay overrides", async () => {
	await withTempHomeAndProject(async ({ home, cwd }) => {
		await writeFile(
			path.join(home, ".pi", "agent", "settings.json"),
			JSON.stringify({ toolsUiDisplay: { bash: { runningTailPreview: true, previewLines: 5 }, edit: { inlineDiffMaxLines: 0 }, renderShell: "default" } }),
		);
		await writeFile(
			path.join(cwd, ".pi", "settings.json"),
			JSON.stringify({ toolsUiDisplay: { bash: { successfulOutputSummary: false, successfulTailPreview: true }, renderShell: "self" } }),
		);

		const loaded = await loadToolsUiDisplaySettings();
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

test("settings load migrates legacy settledTailPreview to successfulTailPreview", async () => {
	await withTempHomeAndProject(async ({ home }) => {
		await writeFile(
			path.join(home, ".pi", "agent", "settings.json"),
			JSON.stringify({ toolsUiDisplay: { bash: { settledTailPreview: true } } }),
		);

		const loaded = await loadToolsUiDisplaySettings();
		assert.equal(loaded.effective.bash?.successfulTailPreview, true);
		assert.equal("settledTailPreview" in (loaded.effective.bash ?? {}), false);
	});
});

test("saving settings merges nested toolsUiDisplay keys instead of replacing them", async () => {
	await withTempHomeAndProject(async ({ home, cwd }) => {
		const globalSettings = path.join(home, ".pi", "agent", "settings.json");
		const projectSettings = path.join(cwd, ".pi", "settings.json");
		await writeFile(
			globalSettings,
			JSON.stringify({
				unrelated: true,
				toolsUiDisplay: {
					read: { compact: true },
					bash: { runningTailPreview: true },
					edit: { inlineDiffMaxLines: 32, futureOption: true },
				},
			}),
		);
		await writeFile(projectSettings, JSON.stringify({ toolsUiDisplay: { renderShell: "self" } }));

		await saveToolsUiDisplaySettings({ bash: { previewLines: 8, successfulTailPreview: true }, edit: { inlineDiffMaxLines: 0 }, renderShell: "default" });
		const saved = JSON.parse(await readFile(globalSettings, "utf8"));
		const projectSaved = JSON.parse(await readFile(projectSettings, "utf8"));

		assert.equal(saved.unrelated, true);
		assert.deepEqual(saved.toolsUiDisplay.read, { compact: true });
		assert.deepEqual(saved.toolsUiDisplay.bash, { runningTailPreview: true, previewLines: 8, successfulTailPreview: true });
		assert.deepEqual(saved.toolsUiDisplay.edit, { inlineDiffMaxLines: 0, futureOption: true });
		assert.equal(saved.toolsUiDisplay.renderShell, "default");
		assert.deepEqual(projectSaved, { toolsUiDisplay: { renderShell: "self" } });
	});
});
