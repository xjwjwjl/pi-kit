import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
	effectiveCompactToolUiSettings,
	hasIgnoredProjectSettings,
	layerCompactToolUiSettings,
	loadCompactToolUiLayers,
	loadCompactToolUiSettings,
	projectSettingsPath,
	resolveCompactToolUiOptions,
	saveCompactToolUiSettings,
} from "../settings/compact-tool-ui.js";
import { DEFAULT_EDIT_DISPLAY_OPTIONS, INLINE_DIFF_NEVER } from "../settings/options.js";

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

function globalSettingsPath(home: string) {
	return path.join(home, ".pi", "agent", "settings.json");
}

test("settings keep the global and project layers apart", async () => {
	await withTempHomeAndProject(async ({ home, cwd }) => {
		await writeFile(
			globalSettingsPath(home),
			JSON.stringify({ compactToolUi: { bash: { tailPreview: "running", previewLines: 5 }, edit: { inlineDiffMaxLines: 0 }, renderShell: "default" } }),
		);
		await writeFile(projectSettingsPath(cwd), JSON.stringify({ compactToolUi: { bash: { tailPreview: "all" } } }));

		const layers = await loadCompactToolUiLayers(cwd, true);
		assert.deepEqual(layers.global.bash, { tailPreview: "running", previewLines: 5 });
		assert.deepEqual(layers.project.bash, { tailPreview: "all" });
	});

	assert.equal(projectSettingsPath(path.join(os.tmpdir(), "some-project")), path.join(os.tmpdir(), "some-project", ".pi", "settings.json"));
});

test("project values override global ones per field", async () => {
	const merged = layerCompactToolUiSettings({
		global: { bash: { tailPreview: "running", previewLines: 5 }, edit: { inlineDiffMaxLines: 64 }, renderShell: "default" },
		project: { bash: { tailPreview: "failed" } },
	});

	assert.deepEqual(merged.bash, { tailPreview: "failed", previewLines: 5 });
	assert.equal(merged.edit?.inlineDiffMaxLines, 64);
	assert.equal(merged.renderShell, "default");
});

test("untrusted projects ignore the project layer", async () => {
	await withTempHomeAndProject(async ({ home, cwd }) => {
		await writeFile(globalSettingsPath(home), JSON.stringify({ compactToolUi: { bash: { tailPreview: "running" } } }));
		await writeFile(projectSettingsPath(cwd), JSON.stringify({ compactToolUi: { bash: { tailPreview: "all" }, edit: { inlineDiffMaxLines: -1 } } }));

		const layers = await loadCompactToolUiLayers(cwd, false);
		assert.deepEqual(layers.project, {});
		assert.equal((await resolveCompactToolUiOptions(cwd, false)).bash.tailPreview, "running");
		assert.equal((await resolveCompactToolUiOptions(cwd, false)).edit.inlineDiffMaxLines, DEFAULT_EDIT_DISPLAY_OPTIONS.inlineDiffMaxLines);
		assert.equal((await resolveCompactToolUiOptions(cwd, true)).bash.tailPreview, "all");
		assert.equal((await resolveCompactToolUiOptions(cwd, true)).edit.inlineDiffMaxLines, INLINE_DIFF_NEVER);
	});
});

test("hasIgnoredProjectSettings only reports real project blocks", async () => {
	await withTempHomeAndProject(async ({ cwd }) => {
		assert.equal(await hasIgnoredProjectSettings(cwd), false);
		await writeFile(projectSettingsPath(cwd), JSON.stringify({ unrelated: true, compactToolUi: { renderShell: "self" } }));
		assert.equal(await hasIgnoredProjectSettings(cwd), true);
	});
});

test("settings honor PI_CODING_AGENT_DIR", async () => {
	await withTempHomeAndProject(async ({ home, cwd }) => {
		const agentDir = path.join(home, "custom-agent");
		const settingsPath = path.join(agentDir, "settings.json");
		process.env.PI_CODING_AGENT_DIR = agentDir;
		await mkdir(agentDir, { recursive: true });
		await writeFile(settingsPath, JSON.stringify({ compactToolUi: { renderShell: "default" } }));

		assert.equal((await loadCompactToolUiSettings("global", cwd)).renderShell, "default");
		await saveCompactToolUiSettings("global", cwd, { bash: { previewLines: 8 } });
		const saved = JSON.parse(await readFile(settingsPath, "utf8"));
		assert.equal(saved.compactToolUi.bash.previewLines, 8);
		await assert.rejects(readFile(globalSettingsPath(home), "utf8"));
	});
});

test("settings reject unknown tail preview values and clamp preview lines", async () => {
	await withTempHomeAndProject(async ({ home, cwd }) => {
		await writeFile(
			globalSettingsPath(home),
			JSON.stringify({ compactToolUi: { bash: { tailPreview: "sometimes", previewLines: 0 } } }),
		);

		const loaded = await loadCompactToolUiSettings("global", cwd);
		assert.deepEqual(loaded.bash, { previewLines: 1 });
		assert.equal(effectiveCompactToolUiSettings(loaded).bash.tailPreview, "off");
	});
});

test("settings collapse any negative inline diff maximum to the never sentinel", async () => {
	await withTempHomeAndProject(async ({ home, cwd }) => {
		await writeFile(globalSettingsPath(home), JSON.stringify({ compactToolUi: { edit: { inlineDiffMaxLines: -5 } } }));

		assert.equal((await loadCompactToolUiSettings("global", cwd)).edit?.inlineDiffMaxLines, INLINE_DIFF_NEVER);
		assert.equal(effectiveCompactToolUiSettings({}).edit.inlineDiffMaxLines, DEFAULT_EDIT_DISPLAY_OPTIONS.inlineDiffMaxLines);
	});
});

test("settings ignore removed legacy bash preview keys and drop them on save", async () => {
	await withTempHomeAndProject(async ({ home, cwd }) => {
		const settingsPath = globalSettingsPath(home);
		await writeFile(
			settingsPath,
			JSON.stringify({
				compactToolUi: { bash: { settledTailPreview: true, runningTailPreview: true, successfulOutputSummary: false, failedTailPreview: true } },
			}),
		);

		assert.deepEqual(await loadCompactToolUiSettings("global", cwd), {});
		assert.equal((await resolveCompactToolUiOptions(cwd, false)).bash.tailPreview, "off");

		await saveCompactToolUiSettings("global", cwd, { bash: { tailPreview: "failed" } });
		const saved = JSON.parse(await readFile(settingsPath, "utf8"));
		assert.deepEqual(saved.compactToolUi.bash, { tailPreview: "failed" });
	});
});

test("saving a layer writes only that file and keeps unrelated keys", async () => {
	await withTempHomeAndProject(async ({ home, cwd }) => {
		const globalPath = globalSettingsPath(home);
		const projectPath = projectSettingsPath(cwd);
		await writeFile(globalPath, JSON.stringify({ unrelated: true, compactToolUi: { edit: { inlineDiffMaxLines: 32, futureOption: true } } }));
		await writeFile(projectPath, JSON.stringify({ compactToolUi: { read: { compact: true }, bash: { tailPreview: "running" } } }));

		await saveCompactToolUiSettings("project", cwd, { bash: { tailPreview: "all", previewLines: 3 }, edit: { inlineDiffMaxLines: 0 }, renderShell: "default" });

		const savedGlobal = JSON.parse(await readFile(globalPath, "utf8"));
		const savedProject = JSON.parse(await readFile(projectPath, "utf8"));
		assert.deepEqual(savedGlobal, { unrelated: true, compactToolUi: { edit: { inlineDiffMaxLines: 32, futureOption: true } } });
		assert.deepEqual(savedProject.compactToolUi, {
			read: { compact: true },
			bash: { tailPreview: "all", previewLines: 3 },
			edit: { inlineDiffMaxLines: 0 },
			renderShell: "default",
		});
	});
});

test("clearing a project value removes the key and falls back to global", async () => {
	await withTempHomeAndProject(async ({ home, cwd }) => {
		await writeFile(globalSettingsPath(home), JSON.stringify({ compactToolUi: { bash: { tailPreview: "running", previewLines: 5 } } }));
		await writeFile(projectSettingsPath(cwd), JSON.stringify({ compactToolUi: { bash: { tailPreview: "all", previewLines: 8 }, renderShell: "default" } }));

		// Clear everything the project overrides; the block itself should disappear.
		await saveCompactToolUiSettings("project", cwd, {});
		const saved = JSON.parse(await readFile(projectSettingsPath(cwd), "utf8"));
		assert.deepEqual(saved, {});

		const options = await resolveCompactToolUiOptions(cwd, true);
		assert.equal(options.bash.tailPreview, "running");
		assert.equal(options.bash.previewLines, 5);
		assert.equal(options.renderShell, "self");
	});
});
