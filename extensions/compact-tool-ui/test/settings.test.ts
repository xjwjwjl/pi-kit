import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
	delete process.env.PI_CODING_AGENT_DIR;
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
			JSON.stringify({ compactToolUi: { edit: { inlineDiffMaxLines: 0 }, renderShell: "default" } }),
		);
		await writeFile(projectSettingsPath(cwd), JSON.stringify({ compactToolUi: { edit: { inlineDiffMaxLines: 32 } } }));

		const layers = await loadCompactToolUiLayers(cwd, true);
		assert.deepEqual(layers.global, { edit: { inlineDiffMaxLines: 0 }, renderShell: "default" });
		assert.deepEqual(layers.project, { edit: { inlineDiffMaxLines: 32 } });
	});

	assert.equal(projectSettingsPath(path.join(os.tmpdir(), "some-project")), path.join(os.tmpdir(), "some-project", ".pi", "settings.json"));
});

test("project values override global ones per field", async () => {
	const merged = layerCompactToolUiSettings({
		global: { edit: { inlineDiffMaxLines: 64 }, renderShell: "default" },
		project: { edit: { inlineDiffMaxLines: 32 } },
	});

	assert.deepEqual(merged, { edit: { inlineDiffMaxLines: 32 }, renderShell: "default" });
	assert.deepEqual(layerCompactToolUiSettings({ global: merged, project: { renderShell: "self" } }), {
		edit: { inlineDiffMaxLines: 32 },
		renderShell: "self",
	});
});

test("untrusted projects ignore the project layer", async () => {
	await withTempHomeAndProject(async ({ home, cwd }) => {
		await writeFile(globalSettingsPath(home), JSON.stringify({ compactToolUi: { renderShell: "default" } }));
		await writeFile(projectSettingsPath(cwd), JSON.stringify({ compactToolUi: { renderShell: "self", edit: { inlineDiffMaxLines: -1 } } }));

		const layers = await loadCompactToolUiLayers(cwd, false);
		assert.deepEqual(layers.project, {});
		assert.deepEqual(await resolveCompactToolUiOptions(cwd, false), {
			renderShell: "default",
			edit: { inlineDiffMaxLines: DEFAULT_EDIT_DISPLAY_OPTIONS.inlineDiffMaxLines },
		});
		assert.deepEqual(await resolveCompactToolUiOptions(cwd, true), {
			renderShell: "self",
			edit: { inlineDiffMaxLines: INLINE_DIFF_NEVER },
		});
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
		await saveCompactToolUiSettings("global", cwd, { edit: { inlineDiffMaxLines: 128 } });
		const saved = JSON.parse(await readFile(settingsPath, "utf8"));
		assert.deepEqual(saved.compactToolUi, { renderShell: "default", edit: { inlineDiffMaxLines: 128 } });
		await assert.rejects(readFile(globalSettingsPath(home), "utf8"));
	});
});

test("obsolete and malformed Bash settings are ignored without writing a migration", async () => {
	await withTempHomeAndProject(async ({ home, cwd }) => {
		const settingsPath = globalSettingsPath(home);
		for (const bash of [
			{ tailPreview: "all", previewLines: 8 },
			{ tailPreview: "running", previewLines: 5 },
			{ tailPreview: "failed", previewLines: 2 },
			{ tailPreview: "off", previewLines: 1 },
			{ tailPreview: "sometimes", previewLines: 0, unknownOption: true },
			{ tailPreview: ["all"], previewLines: { invalid: true } },
			{ runningTailPreview: true, successfulTailPreview: true, failedTailPreview: true, successfulOutputSummary: false, settledTailPreview: true },
			["all"],
			"running",
			null,
		]) {
			const raw = JSON.stringify({ compactToolUi: { bash, unknownOption: true } });
			await writeFile(settingsPath, raw);
			await writeFile(projectSettingsPath(cwd), raw);

			assert.deepEqual(await loadCompactToolUiSettings("global", cwd), {});
			assert.deepEqual(await loadCompactToolUiLayers(cwd, true), { global: {}, project: {} });
			assert.deepEqual(await resolveCompactToolUiOptions(cwd, true), {
				edit: { inlineDiffMaxLines: DEFAULT_EDIT_DISPLAY_OPTIONS.inlineDiffMaxLines },
				renderShell: "self",
			});
			assert.equal(await hasIgnoredProjectSettings(cwd), false);
			assert.equal(await readFile(settingsPath, "utf8"), raw, "loading must not rewrite global settings");
			assert.equal(await readFile(projectSettingsPath(cwd), "utf8"), raw, "loading must not rewrite project settings");
		}
	});
});

test("settings collapse any negative inline diff maximum to the never sentinel", async () => {
	await withTempHomeAndProject(async ({ home, cwd }) => {
		await writeFile(globalSettingsPath(home), JSON.stringify({ compactToolUi: { edit: { inlineDiffMaxLines: -5 } } }));

		assert.equal((await loadCompactToolUiSettings("global", cwd)).edit?.inlineDiffMaxLines, INLINE_DIFF_NEVER);
		assert.equal(effectiveCompactToolUiSettings({}).edit.inlineDiffMaxLines, DEFAULT_EDIT_DISPLAY_OPTIONS.inlineDiffMaxLines);
	});
});

test("a normal save cleans all obsolete Bash keys but preserves unknown fields and the other layer", async () => {
	await withTempHomeAndProject(async ({ home, cwd }) => {
		const settingsPath = globalSettingsPath(home);
		const obsolete = {
			tailPreview: "all", previewLines: "malformed", settledTailPreview: true,
			runningTailPreview: true, successfulTailPreview: true, successfulOutputSummary: false, failedTailPreview: true,
		};
		await writeFile(settingsPath, JSON.stringify({
			otherExtension: { enabled: true },
			compactToolUi: {
				bash: { ...obsolete, futureOption: { enabled: true } },
				futureRootOption: [1, 2],
				edit: { inlineDiffMaxLines: 32, futureEditOption: true },
			},
		}));
		const projectRaw = JSON.stringify({ compactToolUi: { bash: obsolete, renderShell: "self" } });
		await writeFile(projectSettingsPath(cwd), projectRaw);

		const loaded = await loadCompactToolUiSettings("global", cwd);
		assert.deepEqual(loaded, { edit: { inlineDiffMaxLines: 32 } });
		await saveCompactToolUiSettings("global", cwd, { ...loaded, renderShell: "default" });
		assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
			otherExtension: { enabled: true },
			compactToolUi: {
				bash: { futureOption: { enabled: true } },
				futureRootOption: [1, 2],
				edit: { inlineDiffMaxLines: 32, futureEditOption: true },
				renderShell: "default",
			},
		});
		assert.equal(await readFile(projectSettingsPath(cwd), "utf8"), projectRaw);
	});
});

test("saving removes an obsolete-only Bash block", async () => {
	await withTempHomeAndProject(async ({ home, cwd }) => {
		await writeFile(globalSettingsPath(home), JSON.stringify({ compactToolUi: { bash: { tailPreview: "running", previewLines: 5 } } }));
		await saveCompactToolUiSettings("global", cwd, { renderShell: "default" });
		assert.deepEqual(JSON.parse(await readFile(globalSettingsPath(home), "utf8")), { compactToolUi: { renderShell: "default" } });
	});
});

test("saving a layer writes only that file and keeps unrelated keys", async () => {
	await withTempHomeAndProject(async ({ home, cwd }) => {
		const globalPath = globalSettingsPath(home);
		const projectPath = projectSettingsPath(cwd);
		await writeFile(globalPath, JSON.stringify({ unrelated: true, compactToolUi: { edit: { inlineDiffMaxLines: 32, futureOption: true } } }));
		await writeFile(projectPath, JSON.stringify({ compactToolUi: { read: { compact: true }, bash: { tailPreview: "running", futureOption: true } } }));

		await saveCompactToolUiSettings("project", cwd, { edit: { inlineDiffMaxLines: 0 }, renderShell: "default" });

		const savedGlobal = JSON.parse(await readFile(globalPath, "utf8"));
		const savedProject = JSON.parse(await readFile(projectPath, "utf8"));
		assert.deepEqual(savedGlobal, { unrelated: true, compactToolUi: { edit: { inlineDiffMaxLines: 32, futureOption: true } } });
		assert.deepEqual(savedProject.compactToolUi, {
			read: { compact: true },
			bash: { futureOption: true },
			edit: { inlineDiffMaxLines: 0 },
			renderShell: "default",
		});
	});
});

test("clearing a project value removes the key and falls back to global", async () => {
	await withTempHomeAndProject(async ({ home, cwd }) => {
		await writeFile(globalSettingsPath(home), JSON.stringify({ compactToolUi: { edit: { inlineDiffMaxLines: 32 }, renderShell: "default" } }));
		await writeFile(projectSettingsPath(cwd), JSON.stringify({ compactToolUi: { edit: { inlineDiffMaxLines: 128 }, renderShell: "self" } }));

		// Clear everything the project overrides; the block itself should disappear.
		await saveCompactToolUiSettings("project", cwd, { renderShell: null, edit: { inlineDiffMaxLines: null } });
		const saved = JSON.parse(await readFile(projectSettingsPath(cwd), "utf8"));
		assert.deepEqual(saved, {});

		const options = await resolveCompactToolUiOptions(cwd, true);
		assert.deepEqual(options, { edit: { inlineDiffMaxLines: 32 }, renderShell: "default" });
	});
});

test("field patches preserve omitted settings and return the latest committed layer", async () => {
	await withTempHomeAndProject(async ({ home, cwd }) => {
		const file = globalSettingsPath(home);
		await writeFile(file, JSON.stringify({ theme: "light", compactToolUi: {
			renderShell: "default", edit: { inlineDiffMaxLines: 128, future: true }, futureRoot: [1, 2],
		} }));
		const committed = await saveCompactToolUiSettings("global", cwd, { renderShell: "self" });
		assert.deepEqual(committed, { renderShell: "self", edit: { inlineDiffMaxLines: 128 } });
		assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { theme: "light", compactToolUi: {
			renderShell: "self", edit: { inlineDiffMaxLines: 128, future: true }, futureRoot: [1, 2],
		} });
		assert.deepEqual(await saveCompactToolUiSettings("global", cwd, {}), committed, "empty patch must not clear supported fields");
		assert.deepEqual(await saveCompactToolUiSettings("global", cwd, { renderShell: null }), { edit: { inlineDiffMaxLines: 128 } });
		assert.deepEqual(await saveCompactToolUiSettings("global", cwd, { edit: { inlineDiffMaxLines: null } }), {});
		assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { theme: "light", compactToolUi: {
			edit: { future: true }, futureRoot: [1, 2],
		} });
	});
});

test("patches are snapshotted before the first async wait and normalization never mutates arguments", async () => {
	await withTempHomeAndProject(async ({ home, cwd }) => {
		const file = globalSettingsPath(home);
		await writeFile(file, JSON.stringify({ compactToolUi: { renderShell: "default" } }));
		const patch: { edit: { inlineDiffMaxLines: number } } = { edit: { inlineDiffMaxLines: 31.9 } };
		const saving = saveCompactToolUiSettings("global", cwd, patch);
		patch.edit.inlineDiffMaxLines = 128;
		assert.deepEqual(await saving, { renderShell: "default", edit: { inlineDiffMaxLines: 31 } });
		assert.equal(patch.edit.inlineDiffMaxLines, 128);
		const frozen = Object.freeze({ edit: Object.freeze({ inlineDiffMaxLines: -5 }) });
		assert.deepEqual(await saveCompactToolUiSettings("global", cwd, frozen), {
			renderShell: "default", edit: { inlineDiffMaxLines: INLINE_DIFF_NEVER },
		});
		assert.equal(frozen.edit.inlineDiffMaxLines, -5);
	});
});

for (const broken of ["global", "project"] as const) {
	test(`invalid ${broken} JSON roots are isolated, reported and never overwritten`, async () => {
		await withTempHomeAndProject(async ({ home, cwd }) => {
			const globalPath = globalSettingsPath(home);
			const projectPath = projectSettingsPath(cwd);
			const badPath = broken === "global" ? globalPath : projectPath;
			for (const invalid of ["{ broken JSON", "[]", "null", '"text"', "123"]) {
				await writeFile(globalPath, JSON.stringify({ compactToolUi: { renderShell: "default" } }));
				await writeFile(projectPath, JSON.stringify({ compactToolUi: { edit: { inlineDiffMaxLines: 32 } } }));
				await writeFile(badPath, invalid);
				const layers = await loadCompactToolUiLayers(cwd, true);
				assert.deepEqual(Object.keys(layers.errors ?? {}), [broken]);
				assert.equal(layers.errors?.[broken]?.path, badPath);
				assert.ok(layers.errors?.[broken]?.message);
				assert.deepEqual(layers[broken], {});
				assert.deepEqual(await resolveCompactToolUiOptions(cwd, true), broken === "global"
					? { renderShell: "self", edit: { inlineDiffMaxLines: 32 } }
					: { renderShell: "default", edit: { inlineDiffMaxLines: 64 } });
				await assert.rejects(saveCompactToolUiSettings(broken, cwd, { renderShell: "self" }));
				assert.equal(await readFile(badPath, "utf8"), invalid);
				assert.deepEqual(await readdir(path.dirname(badPath)), ["settings.json"], "failed reads/writes must release their lock");
			}
		});
	});
}

test("untrusted malformed project settings do not enter the layer diagnostics", async () => {
	await withTempHomeAndProject(async ({ home, cwd }) => {
		await writeFile(globalSettingsPath(home), JSON.stringify({ compactToolUi: { renderShell: "default" } }));
		await writeFile(projectSettingsPath(cwd), "{ broken project JSON");
		assert.deepEqual(await loadCompactToolUiLayers(cwd, false), { global: { renderShell: "default" }, project: {} });
	});
});

test("loading missing settings creates neither configuration directories nor lock artifacts", async () => {
	await withTempHomeAndProject(async ({ home, cwd }) => {
		const agentDir = path.join(home, "missing-agent");
		process.env.PI_CODING_AGENT_DIR = agentDir;
		await rm(path.join(cwd, ".pi"), { recursive: true, force: true });
		assert.deepEqual(await loadCompactToolUiLayers(cwd, true), { global: {}, project: {} });
		await assert.rejects(readFile(path.join(agentDir, "settings.json")), { code: "ENOENT" });
		await assert.rejects(readdir(agentDir), { code: "ENOENT" });
		await assert.rejects(readdir(path.join(cwd, ".pi")), { code: "ENOENT" });
	});
});
