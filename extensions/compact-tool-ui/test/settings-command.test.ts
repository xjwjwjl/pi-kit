import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openCompactToolUiSettings } from "../commands/compact-tool-ui-settings.js";
import { effectiveCompactToolUiSettings, projectSettingsPath } from "../settings/compact-tool-ui.js";
import type { CompactToolUiOptionsRef } from "../settings/options.js";
import { SettingsList } from "./stubs/pi-tui.js";

const theme = {
	fg(_token: string, text: string) {
		return text;
	},
	bold(text: string) {
		return text;
	},
};

type Panel = { render(width: number): string[]; handleInput(data: string): void };

async function withTempProject(fn: (paths: { home: string; cwd: string; globalPath: string }) => Promise<void>) {
	const root = await mkdtemp(path.join(os.tmpdir(), "compact-tool-ui-panel-"));
	const oldHome = process.env.HOME;
	const oldUserProfile = process.env.USERPROFILE;
	const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
	const home = path.join(root, "home");
	const cwd = path.join(root, "project");
	const globalPath = path.join(home, ".pi", "agent", "settings.json");
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	delete process.env.PI_CODING_AGENT_DIR;
	SettingsList.instances.length = 0;
	notifications.length = 0;
	try {
		await mkdir(path.join(home, ".pi", "agent"), { recursive: true });
		await mkdir(path.join(cwd, ".pi"), { recursive: true });
		await fn({ home, cwd, globalPath });
	} finally {
		await quiet();
		if (oldHome === undefined) delete process.env.HOME;
		else process.env.HOME = oldHome;
		if (oldUserProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = oldUserProfile;
		if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
		await rm(root, { recursive: true, force: true });
	}
}

function createContext(cwd: string, projectTrusted: boolean) {
	let panel: Panel | undefined;
	const ctx = {
		mode: "tui",
		hasUI: true,
		cwd,
		isProjectTrusted: () => projectTrusted,
		ui: {
			notify(message: string) {
				notifications.push(message);
			},
			custom(callback: (tui: unknown, theme: unknown, kb: unknown, done: () => void) => Panel) {
				panel = callback({ requestRender() {} }, theme, {}, () => {});
				return Promise.resolve(panel);
			},
		},
	};
	return { ctx, panel: () => panel };
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 8000) {
	const started = Date.now();
	for (;;) {
		if (await predicate()) return;
		if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for condition; notifications=${JSON.stringify(notifications)}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

function list(): SettingsList {
	const instance = SettingsList.instances.at(-1);
	assert.ok(instance, "settings list should have been created");
	return instance;
}

function item(id: string) {
	const found = list().items.find((candidate) => candidate.id === id);
	assert.ok(found, `expected a ${id} row`);
	return found;
}

async function openPanel(cwd: string, projectTrusted: boolean) {
	const optionsRef: CompactToolUiOptionsRef = { current: effectiveCompactToolUiSettings({}) };
	const harness = createContext(cwd, projectTrusted);
	await openCompactToolUiSettings(optionsRef, harness.ctx as never);
	return { optionsRef, ...harness };
}

/**
 * Every notification the panels of the current test produced. The panel saves in the background and
 * resolves the agent dir at write time, so a lingering save would otherwise write into the next
 * test's home directory; the fixture drains these signals before tearing the environment down.
 */
const notifications: string[] = [];

/** Wait until the background saves stop reporting for `quietMs`. */
async function quiet(quietMs = 60) {
	let last = -1;
	while (last !== notifications.length) {
		last = notifications.length;
		await new Promise((resolve) => setTimeout(resolve, quietMs));
	}
}

/** Set a row the way a user would: press Enter until the ring reaches the wanted value. */
async function choose(id: string, value: string, maxPresses = 12) {
	for (let press = 0; press < maxPresses; press++) {
		if (item(id).currentValue === value) return;
		list().activate(id);
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	throw new Error(`could not cycle ${id} to ${value}`);
}

async function readJson(filePath: string) {
	try {
		return JSON.parse(await readFile(filePath, "utf8"));
	} catch {
		return undefined;
	}
}

test("panel edits the global layer first and shows each layer's own value", async () => {
	await withTempProject(async ({ cwd, globalPath }) => {
		await writeFile(
			globalPath,
			JSON.stringify({ compactToolUi: { renderShell: "self", bash: { tailPreview: "running", previewLines: 5 }, edit: { inlineDiffMaxLines: 0 } } }),
		);

		await openPanel(cwd, true);

		assert.equal(item("scope").currentValue, "global");
		assert.equal(item("tailPreview").currentValue, "running");
		assert.equal(item("previewLines").currentValue, "5");
		assert.equal(item("inlineDiffMaxLines").currentValue, "0");

		await choose("scope", "project");
		assert.equal(item("scope").currentValue, "project");
		// The project layer is empty, so every row shows the "inherit" option.
		assert.equal(item("tailPreview").currentValue, "inherit");
		assert.equal(item("previewLines").currentValue, "inherit");
		assert.deepEqual(item("tailPreview").values, ["inherit", "off", "running", "failed", "all"]);
	});
});

test("every row cycles through its values", async () => {
	await withTempProject(async ({ cwd, globalPath }) => {
		await writeFile(globalPath, JSON.stringify({ compactToolUi: { bash: { previewLines: 5 }, edit: { inlineDiffMaxLines: 64 } } }));

		const { optionsRef } = await openPanel(cwd, true);

		assert.deepEqual(item("scope").values, ["global", "project"]);
		assert.deepEqual(item("renderShell").values?.slice(0, 3), ["unset", "self", "default"]);
		assert.deepEqual(item("tailPreview").values, ["unset", "off", "running", "failed", "all"]);
		assert.deepEqual(item("previewLines").values, ["unset", "1", "2", "3", "5", "8"]);
		assert.deepEqual(item("inlineDiffMaxLines").values, ["unset", "never", "0", "16", "32", "64", "128"]);
		for (const row of list().items) {
			assert.ok(row.values && row.values.length > 0, `${row.id} should cycle through values`);
		}

		await choose("inlineDiffMaxLines", "never");
		await waitFor(async () => (await readJson(globalPath))?.compactToolUi?.edit?.inlineDiffMaxLines === -1);
		assert.equal(optionsRef.current.edit.inlineDiffMaxLines, -1);
	});
});

const UP = "[A";
const DOWN = "[B";
const LEFT = "[D";
const RIGHT = "[C";
const BACKSPACE = "";

/** Move the panel selection the way arrow keys do. */
function moveTo(id: string, panel: Panel) {
	const index = list().items.findIndex((candidate) => candidate.id === id);
	assert.ok(index >= 0, `expected a ${id} row`);
	for (let step = 0; step < index; step++) panel.handleInput(DOWN);
}

test("left and right step a cycle row without wrapping through the clear option", async () => {
	await withTempProject(async ({ cwd, globalPath }) => {
		await writeFile(globalPath, JSON.stringify({ compactToolUi: { bash: { tailPreview: "running" } } }));

		const { optionsRef, panel } = await openPanel(cwd, true);
		moveTo("tailPreview", panel() as Panel);

		// Running sits before the end of the ring, so one step back must land on "off", not "unset".
		panel()?.handleInput(LEFT);
		await waitFor(async () => (await readJson(globalPath))?.compactToolUi?.bash?.tailPreview === "off");
		assert.equal(item("tailPreview").currentValue, "off");

		panel()?.handleInput(RIGHT);
		await waitFor(async () => (await readJson(globalPath))?.compactToolUi?.bash?.tailPreview === "running");
		assert.equal(optionsRef.current.bash.tailPreview, "running");
	});
});

test("left and right switch the scope row", async () => {
	await withTempProject(async ({ cwd, globalPath }) => {
		await writeFile(globalPath, JSON.stringify({ compactToolUi: { renderShell: "self" } }));

		const { panel } = await openPanel(cwd, true);
		assert.equal(item("scope").currentValue, "global");

		panel()?.handleInput(RIGHT);
		assert.equal(item("scope").currentValue, "project");
		panel()?.handleInput(LEFT);
		assert.equal(item("scope").currentValue, "global");
	});
});

test("left and right also step the numeric row", async () => {
	await withTempProject(async ({ cwd, globalPath }) => {
		await writeFile(globalPath, JSON.stringify({ compactToolUi: { bash: { previewLines: 5 } } }));

		const { panel } = await openPanel(cwd, true);
		moveTo("previewLines", panel() as Panel);

		panel()?.handleInput(LEFT);
		await waitFor(async () => (await readJson(globalPath))?.compactToolUi?.bash?.previewLines === 3);
		assert.equal(item("previewLines").currentValue, "3");
	});
});

test("Tab switches layers and Backspace clears the selected row's key", async () => {
	await withTempProject(async ({ cwd, globalPath }) => {
		await writeFile(globalPath, JSON.stringify({ compactToolUi: { bash: { tailPreview: "running", previewLines: 5 } } }));
		await writeFile(projectSettingsPath(cwd), JSON.stringify({ compactToolUi: { bash: { tailPreview: "failed" } } }));

		const { optionsRef, panel } = await openPanel(cwd, true);
		moveTo("tailPreview", panel() as Panel);

		panel()?.handleInput("	");
		assert.equal(item("scope").currentValue, "project");
		assert.equal(item("tailPreview").currentValue, "failed");

		panel()?.handleInput(BACKSPACE);
		await waitFor(async () => {
			const saved = await readJson(projectSettingsPath(cwd));
			return saved !== undefined && saved.compactToolUi === undefined;
		});

		assert.equal(optionsRef.current.bash.tailPreview, "running");
		assert.equal(optionsRef.current.bash.previewLines, 5);
		assert.equal(item("tailPreview").currentValue, "inherit");
	});
});

test("the panel hints at the shortcuts it supports", async () => {
	await withTempProject(async ({ cwd, globalPath }) => {
		await writeFile(globalPath, JSON.stringify({ compactToolUi: { renderShell: "self" } }));

		const { panel } = await openPanel(cwd, true);
		const text = panel()?.render(160).join("\n") ?? "";
		assert.match(text, /Tab switches scope/);
		assert.match(text, /Backspace clears this layer/);
	});
});

test("editing the project layer writes only the project file", async () => {
	await withTempProject(async ({ cwd, globalPath }) => {
		const globalSettings = { compactToolUi: { bash: { tailPreview: "running", previewLines: 5 } } };
		await writeFile(globalPath, JSON.stringify(globalSettings));

		const { optionsRef } = await openPanel(cwd, true);
		await choose("scope", "project");
		await choose("tailPreview", "failed");
		await waitFor(async () => (await readJson(projectSettingsPath(cwd)))?.compactToolUi?.bash?.tailPreview === "failed");

		assert.equal(optionsRef.current.bash.tailPreview, "failed");
		assert.equal(optionsRef.current.bash.previewLines, 5);
		assert.deepEqual(await readJson(globalPath), globalSettings);
		assert.match(notifications.at(-1) ?? "", /Saved compact-tool-ui settings to project settings/);
	});
});

test("inheriting clears the project key and falls back to the global value", async () => {
	await withTempProject(async ({ cwd, globalPath }) => {
		await writeFile(globalPath, JSON.stringify({ compactToolUi: { bash: { tailPreview: "running" } } }));
		await writeFile(projectSettingsPath(cwd), JSON.stringify({ compactToolUi: { bash: { tailPreview: "failed" } } }));

		const { optionsRef } = await openPanel(cwd, true);
		await choose("scope", "project");
		assert.equal(item("tailPreview").currentValue, "failed");

		await choose("tailPreview", "inherit");
		await waitFor(async () => {
			const saved = await readJson(projectSettingsPath(cwd));
			return saved !== undefined && saved.compactToolUi === undefined;
		});

		assert.equal(optionsRef.current.bash.tailPreview, "running");
		assert.equal(item("tailPreview").currentValue, "inherit");
	});
});

test("the global layer can be reset to the built-in default", async () => {
	await withTempProject(async ({ cwd, globalPath }) => {
		await writeFile(globalPath, JSON.stringify({ compactToolUi: { bash: { previewLines: 8 } } }));

		const { optionsRef } = await openPanel(cwd, true);
		assert.equal(item("previewLines").currentValue, "8");

		await choose("previewLines", "unset");
		await waitFor(async () => {
			const saved = await readJson(globalPath);
			return saved !== undefined && saved.compactToolUi === undefined;
		});

		assert.equal(optionsRef.current.bash.previewLines, 2);
		assert.equal(item("previewLines").currentValue, "unset");
	});
});

test("untrusted folders lock the scope row to global and never write project settings", async () => {
	await withTempProject(async ({ cwd, globalPath }) => {
		await writeFile(globalPath, JSON.stringify({ compactToolUi: { bash: { previewLines: 5 } } }));
		await writeFile(projectSettingsPath(cwd), JSON.stringify({ compactToolUi: { bash: { previewLines: 8 } } }));

		const { optionsRef } = await openPanel(cwd, false);
		assert.equal(item("scope").currentValue, "global");
		assert.deepEqual(item("scope").values, ["global"]);
		assert.match(item("scope").description ?? "", /not trusted/);
		assert.equal(item("previewLines").currentValue, "5");

		await choose("previewLines", "8");
		await waitFor(async () => (await readJson(globalPath))?.compactToolUi?.bash?.previewLines === 8);

		assert.equal(optionsRef.current.bash.previewLines, 8);
		assert.deepEqual(await readJson(projectSettingsPath(cwd)), { compactToolUi: { bash: { previewLines: 8 } } });
	});
});

test("a failed write rolls the displayed value back", { skip: process.platform !== "win32" }, async () => {
	await withTempProject(async ({ cwd, globalPath }) => {
		await writeFile(globalPath, JSON.stringify({ compactToolUi: { bash: { previewLines: 5 } } }));
		// A read-only settings file is still readable, but the atomic rename over it fails.
		await chmod(globalPath, 0o444);

		const { optionsRef } = await openPanel(cwd, true);
		await choose("previewLines", "8");
		await waitFor(() => notifications.length > 0);

		assert.match(notifications[0] ?? "", /Failed to save compact-tool-ui settings/);
		assert.equal(optionsRef.current.bash.previewLines, 5);
		assert.equal(item("previewLines").currentValue, "5");
		assert.deepEqual(await readJson(globalPath), { compactToolUi: { bash: { previewLines: 5 } } });
		await chmod(globalPath, 0o666);
	});
});
