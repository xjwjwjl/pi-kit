import assert from "node:assert/strict";
import fs from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import lockfile from "proper-lockfile";
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

function createContext(cwd: string, projectTrusted: boolean, onNotify?: (message: string) => void) {
	let panel: Panel | undefined;
	const ctx = {
		mode: "tui",
		hasUI: true,
		cwd,
		isProjectTrusted: () => projectTrusted,
		ui: {
			notify(message: string) {
				notifications.push(message);
				for (const observer of saveObservers) observer(message);
				onNotify?.(message);
			},
			custom(callback: (tui: unknown, theme: unknown, kb: unknown, done: () => void) => Panel) {
				panel = callback({ requestRender() {} }, theme, {}, () => {});
				return Promise.resolve(panel);
			},
		},
	};
	return { ctx, panel: () => panel };
}

/** Saves are awaited through notifications before checking disk, never by polling the rename target. */
async function assertAfterSave(predicate: () => boolean | Promise<boolean>) {
	assert.ok(await predicate(), `condition failed after save completion; notifications=${JSON.stringify(notifications)}`);
}

const saveObservers = new Set<(message: string) => void>();

async function nextSave(action: () => void) {
	const completed = eventQueue<string>();
	const observer = (message: string) => {
		if (/^(Saved compact-tool-ui|Failed to save compact-tool-ui)/.test(message)) completed.push(message);
	};
	saveObservers.add(observer);
	try {
		action();
		return await completed.next();
	} finally {
		saveObservers.delete(observer);
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

async function openPanel(cwd: string, projectTrusted: boolean, onNotify?: (message: string) => void) {
	const optionsRef: CompactToolUiOptionsRef = { current: effectiveCompactToolUiSettings({}) };
	const harness = createContext(cwd, projectTrusted, onNotify);
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
		if (id === "scope") list().activate(id);
		else if ((await nextSave(() => list().activate(id))).startsWith("Failed")) return;
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
			JSON.stringify({ compactToolUi: { renderShell: "self", bash: { tailPreview: "all", previewLines: 5 }, edit: { inlineDiffMaxLines: 0 } } }),
		);

		await openPanel(cwd, true);

		assert.deepEqual(list().items.map((row) => row.id), ["scope", "renderShell", "inlineDiffMaxLines"]);
		assert.equal(list().items.length, 3);
		assert.equal(item("scope").currentValue, "global");
		assert.equal(item("renderShell").currentValue, "self");
		assert.equal(item("inlineDiffMaxLines").currentValue, "0");

		await choose("scope", "project");
		assert.equal(item("scope").currentValue, "project");
		// The project layer is empty, so every row shows the "inherit" option.
		assert.equal(item("renderShell").currentValue, "inherit");
		assert.equal(item("inlineDiffMaxLines").currentValue, "inherit");
		assert.deepEqual(item("renderShell").values, ["inherit", "self", "default"]);
		assert.equal(notifications.length, 0);
		assert.deepEqual((await readJson(globalPath)).compactToolUi.bash, { tailPreview: "all", previewLines: 5 }, "opening and navigating must not migrate settings");
	});
});

test("every row cycles through its values", async () => {
	await withTempProject(async ({ cwd, globalPath }) => {
		await writeFile(globalPath, JSON.stringify({ compactToolUi: { edit: { inlineDiffMaxLines: 64 } } }));

		const { optionsRef } = await openPanel(cwd, true);

		assert.deepEqual(item("scope").values, ["global", "project"]);
		assert.deepEqual(item("renderShell").values?.slice(0, 3), ["unset", "self", "default"]);
		assert.deepEqual(item("inlineDiffMaxLines").values, ["unset", "never", "0", "16", "32", "64", "128"]);
		for (const row of list().items) {
			assert.ok(row.values && row.values.length > 0, `${row.id} should cycle through values`);
		}

		await choose("inlineDiffMaxLines", "never");
		await assertAfterSave(async () => (await readJson(globalPath))?.compactToolUi?.edit?.inlineDiffMaxLines === -1);
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
		await writeFile(globalPath, JSON.stringify({ compactToolUi: { renderShell: "default" } }));

		const { optionsRef, panel } = await openPanel(cwd, true);
		moveTo("renderShell", panel() as Panel);

		// A step back from default must land on self, not unset.
		await nextSave(() => panel()?.handleInput(LEFT));
		await assertAfterSave(async () => (await readJson(globalPath))?.compactToolUi?.renderShell === "self");
		assert.equal(item("renderShell").currentValue, "self");

		await nextSave(() => panel()?.handleInput(RIGHT));
		await assertAfterSave(async () => (await readJson(globalPath))?.compactToolUi?.renderShell === "default");
		assert.equal(optionsRef.current.renderShell, "default");
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
		await writeFile(globalPath, JSON.stringify({ compactToolUi: { edit: { inlineDiffMaxLines: 64 } } }));

		const { panel } = await openPanel(cwd, true);
		moveTo("inlineDiffMaxLines", panel() as Panel);

		await nextSave(() => panel()?.handleInput(LEFT));
		await assertAfterSave(async () => (await readJson(globalPath))?.compactToolUi?.edit?.inlineDiffMaxLines === 32);
		assert.equal(item("inlineDiffMaxLines").currentValue, "32");
	});
});

test("Tab switches layers and Backspace clears the selected row's key", async () => {
	await withTempProject(async ({ cwd, globalPath }) => {
		await writeFile(globalPath, JSON.stringify({ compactToolUi: { renderShell: "default", edit: { inlineDiffMaxLines: 32 } } }));
		await writeFile(projectSettingsPath(cwd), JSON.stringify({ compactToolUi: { renderShell: "self" } }));

		const { optionsRef, panel } = await openPanel(cwd, true);
		moveTo("renderShell", panel() as Panel);

		panel()?.handleInput("	");
		assert.equal(item("scope").currentValue, "project");
		assert.equal(item("renderShell").currentValue, "self");

		await nextSave(() => panel()?.handleInput(BACKSPACE));
		await assertAfterSave(async () => {
			const saved = await readJson(projectSettingsPath(cwd));
			return saved !== undefined && saved.compactToolUi === undefined;
		});

		assert.deepEqual(optionsRef.current, { renderShell: "default", edit: { inlineDiffMaxLines: 32 } });
		assert.equal(item("renderShell").currentValue, "inherit");
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
		const globalSettings = { compactToolUi: { renderShell: "default", edit: { inlineDiffMaxLines: 32 } } };
		await writeFile(globalPath, JSON.stringify(globalSettings));

		const { optionsRef } = await openPanel(cwd, true);
		await choose("scope", "project");
		await choose("renderShell", "self");
		await assertAfterSave(async () => (await readJson(projectSettingsPath(cwd)))?.compactToolUi?.renderShell === "self");

		assert.deepEqual(optionsRef.current, { renderShell: "self", edit: { inlineDiffMaxLines: 32 } });
		assert.deepEqual(await readJson(globalPath), globalSettings);
		assert.match(notifications.at(-1) ?? "", /Saved compact-tool-ui settings to project settings/);
	});
});

test("inheriting clears the project key and falls back to the global value", async () => {
	await withTempProject(async ({ cwd, globalPath }) => {
		await writeFile(globalPath, JSON.stringify({ compactToolUi: { edit: { inlineDiffMaxLines: 32 } } }));
		await writeFile(projectSettingsPath(cwd), JSON.stringify({ compactToolUi: { edit: { inlineDiffMaxLines: 128 } } }));

		const { optionsRef } = await openPanel(cwd, true);
		await choose("scope", "project");
		assert.equal(item("inlineDiffMaxLines").currentValue, "128");

		await choose("inlineDiffMaxLines", "inherit");
		await assertAfterSave(async () => {
			const saved = await readJson(projectSettingsPath(cwd));
			return saved !== undefined && saved.compactToolUi === undefined;
		});

		assert.equal(optionsRef.current.edit.inlineDiffMaxLines, 32);
		assert.equal(item("inlineDiffMaxLines").currentValue, "inherit");
	});
});

test("the global layer can be reset to the built-in default", async () => {
	await withTempProject(async ({ cwd, globalPath }) => {
		await writeFile(globalPath, JSON.stringify({ compactToolUi: { edit: { inlineDiffMaxLines: 128 } } }));

		const { optionsRef } = await openPanel(cwd, true);
		assert.equal(item("inlineDiffMaxLines").currentValue, "128");

		await choose("inlineDiffMaxLines", "unset");
		await assertAfterSave(async () => {
			const saved = await readJson(globalPath);
			return saved !== undefined && saved.compactToolUi === undefined;
		});

		assert.equal(optionsRef.current.edit.inlineDiffMaxLines, 64);
		assert.equal(item("inlineDiffMaxLines").currentValue, "unset");
	});
});

test("untrusted folders lock the scope row to global and never write project settings", async () => {
	await withTempProject(async ({ cwd, globalPath }) => {
		await writeFile(globalPath, JSON.stringify({ compactToolUi: { edit: { inlineDiffMaxLines: 32 } } }));
		await writeFile(projectSettingsPath(cwd), JSON.stringify({ compactToolUi: { edit: { inlineDiffMaxLines: 128 } } }));

		const { optionsRef, panel } = await openPanel(cwd, false);
		assert.equal(list().items.length, 3);
		assert.equal(item("scope").currentValue, "global");
		assert.deepEqual(item("scope").values, ["global"]);
		assert.match(item("scope").description ?? "", /not trusted/);
		assert.equal(item("inlineDiffMaxLines").currentValue, "32");
		panel()?.handleInput("\t");
		assert.equal(item("scope").currentValue, "global");

		await choose("inlineDiffMaxLines", "128");
		await assertAfterSave(async () => (await readJson(globalPath))?.compactToolUi?.edit?.inlineDiffMaxLines === 128);

		assert.equal(optionsRef.current.edit.inlineDiffMaxLines, 128);
		assert.deepEqual(await readJson(projectSettingsPath(cwd)), { compactToolUi: { edit: { inlineDiffMaxLines: 128 } } });
	});
});

/** Bounded event-driven waits: race regressions must not depend on disk speed or polling. */
function eventQueue<T>() {
	const values: T[] = [];
	const waiters: Array<(value: T) => void> = [];
	return {
		push(value: T) {
			const waiter = waiters.shift();
			if (waiter) waiter(value);
			else values.push(value);
		},
		async next(): Promise<T> {
			if (values.length > 0) return values.shift() as T;
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				return await new Promise<T>((resolve, reject) => {
					waiters.push(resolve);
					timer = setTimeout(() => reject(new Error("timed out waiting for settings save event")), 8000);
				});
			} finally {
				clearTimeout(timer);
			}
		},
	};
}

type SaveOperation = {
	target: string;
	payload: { compactToolUi?: { edit?: { inlineDiffMaxLines?: number }; renderShell?: string } };
	release(fail?: boolean): void;
};

/**
 * Gate acquisition, not the synchronous critical section: retries report ELOCKED until released.
 * Payloads are observed at the synchronous write hook after release, before a real rename (or an
 * injected failure). Arming after opening excludes initial reads from this save-only barrier.
 */
async function withSaveBarriers(
	targets: string[],
	fn: (saves: ReturnType<typeof eventQueue<SaveOperation>> & { arm(): void }) => Promise<void>,
) {
	const originalLock = lockfile.lockSync;
	const originalWrite = fs.writeFileSync;
	const saves = Object.assign(eventQueue<SaveOperation>(), { arm() { armed = true; } });
	let armed = false;
	let closing = false;
	let gate: { operation: SaveOperation; released: boolean; fail: boolean } | undefined;
	let active: typeof gate;
	lockfile.lockSync = (file, options) => {
		const target = String(file);
		if (!armed || closing || !targets.includes(target)) return originalLock(file, options);
		if (!gate) {
			const next = {
				operation: {
					target,
					payload: {},
					release(fail = false) { next.fail = fail; next.released = true; },
				},
				released: false,
				fail: false,
			};
			gate = next;
			saves.push(next.operation);
		}
		assert.equal(target, gate.operation.target, "panel saves must remain serial across scopes");
		if (!gate.released) throw Object.assign(new Error("test lock contention"), { code: "ELOCKED" });
		const release = originalLock(file, options);
		active = gate;
		gate = undefined;
		return release;
	};
	fs.writeFileSync = (file, data, options) => {
		if (active && String(file).startsWith(`${active.operation.target}.`)) {
			const operation = active;
			active = undefined;
			operation.operation.payload = JSON.parse(String(data));
			if (operation.fail) throw new Error("injected settings save failure");
		}
		return originalWrite(file, data, options);
	};
	syncBuiltinESMExports();
	try {
		await fn(saves);
	} finally {
		closing = true;
		await quiet();
		lockfile.lockSync = originalLock;
		fs.writeFileSync = originalWrite;
		syncBuiltinESMExports();
	}
}

test("queued global edits keep their target after Tab and never create an unwritten project file", async () => {
	await withTempProject(async ({ cwd, globalPath }) => {
		const projectPath = projectSettingsPath(cwd);
		await writeFile(globalPath, JSON.stringify({ unrelated: { enabled: true }, compactToolUi: { edit: { inlineDiffMaxLines: 0 } } }));
		await withSaveBarriers([globalPath, projectPath], async (saves) => {
			const completed = eventQueue<string>();
			const { optionsRef, panel } = await openPanel(cwd, true, completed.push);
			saves.arm();
			list().activate("inlineDiffMaxLines"); // First write: 16.
			const first = await saves.next();
			assert.equal(first.target, globalPath);
			list().activate("inlineDiffMaxLines"); // Queued write: 32, still global.
			list().activate("renderShell"); // unset -> self -> default, also queued.
			list().activate("renderShell");
			panel()?.handleInput("\t");
			first.release();
			assert.match(await completed.next(), /Saved .* global settings/);
			assert.deepEqual(first.payload.compactToolUi, { edit: { inlineDiffMaxLines: 16 } });
			const second = await saves.next();
			assert.equal(second.target, globalPath);
			assert.deepEqual(optionsRef.current, { edit: { inlineDiffMaxLines: 16 }, renderShell: "self" }, "only the immutable committed snapshot may be applied");
			assert.equal(item("scope").currentValue, "project");
			assert.equal(item("inlineDiffMaxLines").currentValue, "inherit");
			assert.equal(item("renderShell").currentValue, "inherit");
			second.release();
			assert.match(await completed.next(), /Saved .* global settings/);
			assert.deepEqual(second.payload.compactToolUi, { edit: { inlineDiffMaxLines: 32 }, renderShell: "default" });
			assert.deepEqual(optionsRef.current, { edit: { inlineDiffMaxLines: 32 }, renderShell: "default" });
			assert.deepEqual(await readJson(globalPath), { unrelated: { enabled: true }, compactToolUi: { edit: { inlineDiffMaxLines: 32 }, renderShell: "default" } });
			await assert.rejects(readFile(projectPath), { code: "ENOENT" });
			panel()?.handleInput("\t");
			panel()?.handleInput("\t");
			assert.equal(notifications.length, 2, "scope-only navigation must not save");
		});
	});
});

test("coalesced edits in both scopes are saved serially and applied only after each commit", async () => {
	await withTempProject(async ({ cwd, globalPath }) => {
		const projectPath = projectSettingsPath(cwd);
		await writeFile(globalPath, JSON.stringify({ compactToolUi: { edit: { inlineDiffMaxLines: 0 }, renderShell: "self" } }));
		await writeFile(projectPath, JSON.stringify({ unrelatedProjectKey: true }));
		await withSaveBarriers([globalPath, projectPath], async (saves) => {
			const completed = eventQueue<string>();
			const { optionsRef, panel } = await openPanel(cwd, true, completed.push);
			saves.arm();
			list().activate("inlineDiffMaxLines");
			const first = await saves.next();
			list().activate("inlineDiffMaxLines");
			panel()?.handleInput("\t");
			list().activate("renderShell"); // inherit -> self -> default, coalesced.
			list().activate("renderShell");
			first.release();
			await completed.next();
			const global = await saves.next();
			assert.equal(global.target, globalPath);
			assert.equal(optionsRef.current.edit.inlineDiffMaxLines, 16);
			assert.equal(optionsRef.current.renderShell, "self");
			global.release();
			await completed.next();
			assert.equal(global.payload.compactToolUi?.edit?.inlineDiffMaxLines, 32);
			const project = await saves.next();
			assert.equal(project.target, projectPath);
			assert.equal(optionsRef.current.edit.inlineDiffMaxLines, 32);
			assert.equal(optionsRef.current.renderShell, "self", "project edits remain uncommitted while its save waits");
			assert.match(item("renderShell").description ?? "", /Effective: self \(source: global\).*pending save/);
			project.release();
			await completed.next();
			assert.equal(project.payload.compactToolUi?.renderShell, "default");
			assert.equal(optionsRef.current.renderShell, "default");
			assert.equal(item("renderShell").currentValue, "default");
			assert.match(item("renderShell").description ?? "", /Effective: default \(source: project\)/);
			assert.doesNotMatch(item("renderShell").description ?? "", /pending save/);
			assert.deepEqual(await readJson(projectPath), { unrelatedProjectKey: true, compactToolUi: { renderShell: "default" } });
			assert.equal((await readJson(globalPath)).compactToolUi.edit.inlineDiffMaxLines, 32);
			assert.equal(notifications.length, 3);
		});
	});
});

test("failure rolls back to the actual persisted snapshot, discards newer same-scope edits and still saves the other scope", async () => {
	await withTempProject(async ({ cwd, globalPath }) => {
		const projectPath = projectSettingsPath(cwd);
		await writeFile(globalPath, JSON.stringify({ compactToolUi: { edit: { inlineDiffMaxLines: 0 }, renderShell: "default" } }));
		await withSaveBarriers([globalPath, projectPath], async (saves) => {
			const completed = eventQueue<string>();
			const { optionsRef, panel } = await openPanel(cwd, true, completed.push);
			saves.arm();
			list().activate("inlineDiffMaxLines"); // Persist 16 successfully, with 32 already queued.
			const first = await saves.next();
			list().activate("inlineDiffMaxLines");
			first.release();
			await completed.next();
			const failed = await saves.next();
			assert.equal(failed.target, globalPath);
			assert.equal(optionsRef.current.edit.inlineDiffMaxLines, 16);
			list().activate("inlineDiffMaxLines"); // 64 is discarded with this scope's failed edit.
			panel()?.handleInput("\t");
			list().activate("renderShell"); // Project's independent edit must survive.
			failed.release(true);
			assert.match(await completed.next(), /Failed to save .*injected settings save failure/);
			assert.equal(failed.payload.compactToolUi?.edit?.inlineDiffMaxLines, 32);
			const project = await saves.next();
			assert.equal(project.target, projectPath, "no retry of rolled-back global edits");
			assert.equal(item("renderShell").currentValue, "self", "another scope's pending rows must not roll back");
			assert.equal(optionsRef.current.edit.inlineDiffMaxLines, 16);
			assert.equal(optionsRef.current.renderShell, "default");
			panel()?.handleInput("\t");
			assert.equal(item("inlineDiffMaxLines").currentValue, "16", "the UI must roll back with disk");
			assert.equal((await readJson(globalPath)).compactToolUi.edit.inlineDiffMaxLines, 16);
			project.release();
			assert.match(await completed.next(), /Saved .* project settings/);
			assert.equal(project.payload.compactToolUi?.renderShell, "self");
			assert.equal(optionsRef.current.edit.inlineDiffMaxLines, 16);
			assert.equal(optionsRef.current.renderShell, "self");
			assert.deepEqual(await readJson(projectPath), { compactToolUi: { renderShell: "self" } });
			assert.equal(notifications.length, 3);
		});
	});
});

test("a stale panel patches only its edited field and refreshes untouched rows from the committed layer", async () => {
	await withTempProject(async ({ cwd, globalPath }) => {
		await writeFile(globalPath, JSON.stringify({ compactToolUi: { edit: { inlineDiffMaxLines: 32 } } }));
		await withSaveBarriers([globalPath], async (saves) => {
			const completed = eventQueue<string>();
			const { optionsRef } = await openPanel(cwd, true, completed.push);
			saves.arm();
			list().activate("renderShell");
			const saving = await saves.next();
			// Another host edits the disk while this panel waits for the same file lock.
			await writeFile(globalPath, JSON.stringify({
				otherHostKey: true,
				compactToolUi: {
					edit: { inlineDiffMaxLines: 128, unknownEditKey: "keep" },
					unknownKey: "keep",
					bash: { tailPreview: "all", unknownBashKey: "keep" },
				},
			}));
			assert.equal(item("inlineDiffMaxLines").currentValue, "32");
			assert.equal(optionsRef.current.edit.inlineDiffMaxLines, 32);
			assert.match(item("renderShell").description ?? "", /Effective: self \(source: built-in\).*pending save/);
			saving.release();
			assert.match(await completed.next(), /Saved .* global settings/);
			assert.equal(item("inlineDiffMaxLines").currentValue, "128", "untouched rows refresh from the actual committed layer");
			assert.equal(optionsRef.current.edit.inlineDiffMaxLines, 128);
			assert.match(item("inlineDiffMaxLines").description ?? "", /Effective: 128 \(source: global\)/);
			assert.doesNotMatch(item("renderShell").description ?? "", /pending save/);
			assert.deepEqual(await readJson(globalPath), {
				otherHostKey: true,
				compactToolUi: {
					renderShell: "self",
					edit: { inlineDiffMaxLines: 128, unknownEditKey: "keep" },
					unknownKey: "keep",
					bash: { unknownBashKey: "keep" },
				},
			});
		});
	});
});

test("a completed batch replays new same-scope input without applying it before its own commit", async () => {
	await withTempProject(async ({ cwd, globalPath }) => {
		await writeFile(globalPath, JSON.stringify({ compactToolUi: { renderShell: "self", edit: { inlineDiffMaxLines: 0 } } }));
		await withSaveBarriers([globalPath], async (saves) => {
			const completed = eventQueue<string>();
			const { optionsRef } = await openPanel(cwd, true, completed.push);
			saves.arm();
			list().activate("inlineDiffMaxLines"); // Captured immutable batch: 16.
			const first = await saves.next();
			list().activate("inlineDiffMaxLines"); // New input: 32.
			list().activate("renderShell"); // New input: default.
			assert.equal(optionsRef.current.edit.inlineDiffMaxLines, 0);
			assert.match(item("inlineDiffMaxLines").description ?? "", /Effective: 0 \(source: global\).*pending save/);
			first.release();
			await completed.next();
			const second = await saves.next();
			assert.equal(first.payload.compactToolUi?.edit?.inlineDiffMaxLines, 16);
			assert.equal(first.payload.compactToolUi?.renderShell, "self");
			assert.equal(item("inlineDiffMaxLines").currentValue, "32");
			assert.equal(item("renderShell").currentValue, "default");
			assert.match(item("inlineDiffMaxLines").description ?? "", /Effective: 16 \(source: global\).*pending save/);
			assert.match(item("renderShell").description ?? "", /Effective: self \(source: global\).*pending save/);
			assert.deepEqual(optionsRef.current, { renderShell: "self", edit: { inlineDiffMaxLines: 16 } });
			second.release();
			await completed.next();
			assert.deepEqual(second.payload.compactToolUi, { renderShell: "default", edit: { inlineDiffMaxLines: 32 } });
			assert.deepEqual(optionsRef.current, { renderShell: "default", edit: { inlineDiffMaxLines: 32 } });
			assert.doesNotMatch(item("inlineDiffMaxLines").description ?? "", /pending save/);
		});
	});
});

test("a queued clear survives an earlier commit and restores inheritance only after its own commit", async () => {
	await withTempProject(async ({ cwd, globalPath }) => {
		const projectPath = projectSettingsPath(cwd);
		await writeFile(globalPath, JSON.stringify({ compactToolUi: { renderShell: "default", edit: { inlineDiffMaxLines: 32 } } }));
		await writeFile(projectPath, JSON.stringify({ compactToolUi: { renderShell: "self", edit: { inlineDiffMaxLines: 128 } } }));
		await withSaveBarriers([projectPath], async (saves) => {
			const completed = eventQueue<string>();
			const { optionsRef } = await openPanel(cwd, true, completed.push);
			await choose("scope", "project");
			saves.arm();
			list().activate("inlineDiffMaxLines"); // 128 -> inherit, captured in the first batch.
			const first = await saves.next();
			list().activate("renderShell"); // self -> default -> inherit, queued clear.
			list().activate("renderShell");
			assert.deepEqual(optionsRef.current, { renderShell: "self", edit: { inlineDiffMaxLines: 128 } });
			first.release();
			await completed.next();
			const second = await saves.next();
			assert.deepEqual(first.payload.compactToolUi, { renderShell: "self" });
			assert.equal(item("renderShell").currentValue, "inherit", "a queued removal must not be overwritten by the preceding commit");
			assert.equal(item("inlineDiffMaxLines").currentValue, "inherit");
			assert.deepEqual(optionsRef.current, { renderShell: "self", edit: { inlineDiffMaxLines: 32 } });
			assert.match(item("renderShell").description ?? "", /Effective: self \(source: project\).*pending save/);
			second.release();
			await completed.next();
			assert.equal(second.payload.compactToolUi, undefined);
			assert.deepEqual(await readJson(projectPath), {});
			assert.deepEqual(optionsRef.current, { renderShell: "default", edit: { inlineDiffMaxLines: 32 } });
			assert.match(item("renderShell").description ?? "", /Effective: default \(source: global\)/);
			assert.doesNotMatch(item("renderShell").description ?? "", /pending save/);
		});
	});
});

test("BOM-prefixed layers open without rewriting their files and initialize the effective options", async () => {
	await withTempProject(async ({ cwd, globalPath }) => {
		const globalRaw = '\uFEFF{"compactToolUi":{"renderShell":"default","edit":{"inlineDiffMaxLines":32}}}';
		const projectRaw = '\uFEFF{"compactToolUi":{"edit":{"inlineDiffMaxLines":128}}}';
		await writeFile(globalPath, globalRaw);
		await writeFile(projectSettingsPath(cwd), projectRaw);
		const { optionsRef, panel } = await openPanel(cwd, true);
		assert.deepEqual(optionsRef.current, { renderShell: "default", edit: { inlineDiffMaxLines: 128 } });
		assert.equal(item("inlineDiffMaxLines").currentValue, "32");
		assert.match(item("inlineDiffMaxLines").description ?? "", /Effective: 128 \(source: project\).*overridden by project/);
		panel()?.handleInput("\t");
		assert.equal(item("renderShell").currentValue, "inherit");
		assert.match(item("renderShell").description ?? "", /Effective: default \(source: global\)/);
		assert.equal(notifications.length, 0);
		assert.equal(await readFile(globalPath, "utf8"), globalRaw);
		assert.equal(await readFile(projectSettingsPath(cwd), "utf8"), projectRaw);
	});
});

for (const brokenScope of ["global", "project"] as const) {
	test(`an invalid ${brokenScope} layer is read-only while the other layer remains editable`, async () => {
		await withTempProject(async ({ cwd, globalPath }) => {
			const projectPath = projectSettingsPath(cwd);
			const brokenPath = brokenScope === "global" ? globalPath : projectPath;
			const healthyPath = brokenScope === "global" ? projectPath : globalPath;
			const brokenRaw = brokenScope === "global" ? '{"compactToolUi":' : "[]";
			await writeFile(brokenPath, brokenRaw);
			await writeFile(healthyPath, JSON.stringify({ compactToolUi: { renderShell: "self", edit: { inlineDiffMaxLines: 32 } } }));
			const { optionsRef, panel } = await openPanel(cwd, true);
			assert.equal(notifications.length, 1);
			assert.ok(notifications[0]?.includes(brokenPath), "the load error names the actual failed path");
			assert.match(notifications[0] ?? "", new RegExp(`Failed to load compact-tool-ui ${brokenScope} settings`));
			assert.match(notifications[0] ?? "", brokenScope === "global" ? /JSON|position|Expected/ : /JSON object/);
			assert.deepEqual(optionsRef.current, { renderShell: "self", edit: { inlineDiffMaxLines: 32 } });
			if (brokenScope === "project") panel()?.handleInput("\t");
			for (const id of ["renderShell", "inlineDiffMaxLines"]) {
				assert.equal(item(id).values, undefined);
				assert.equal(item(id).currentValue, "unavailable");
				assert.ok(item(id).description?.includes(brokenPath));
				assert.match(item(id).description ?? "", /Fix the file and reopen/);
				list().activate(id); // Native Enter/Space activation has no values to cycle.
			}
			moveTo("renderShell", panel() as Panel);
			for (const key of ["\r", LEFT, RIGHT, BACKSPACE, "\x1b[3~"]) panel()?.handleInput(key);
			// Also exercise the callback's guard independently of SettingsList's values check.
			(list() as unknown as { onChange(id: string, value: string): void }).onChange("renderShell", "default");
			assert.equal(item("renderShell").currentValue, "unavailable");
			assert.equal(notifications.length, 1, "disabled edits must never enqueue saves");
			assert.equal(await readFile(brokenPath, "utf8"), brokenRaw);
			panel()?.handleInput("\t");
			assert.equal(item("renderShell").currentValue, "self");
			assert.match(await nextSave(() => list().activate("renderShell")), /Saved/);
			assert.equal((await readJson(healthyPath)).compactToolUi.renderShell, "default");
			assert.equal(optionsRef.current.renderShell, "default");
			assert.equal(await readFile(brokenPath, "utf8"), brokenRaw);
			await writeFile(brokenPath, "{}");
			panel()?.handleInput("\t");
			assert.equal(item("renderShell").values, undefined, "repairing disk does not silently reactivate the open panel");
			await openPanel(cwd, true);
			if (brokenScope === "project") await choose("scope", "project");
			assert.ok(item("renderShell").values, "reopening activates the repaired layer");
			assert.match(await nextSave(() => list().activate("renderShell")), /Saved/);
			assert.equal((await readJson(brokenPath)).compactToolUi.renderShell, "self");
		});
	});
}

test("both invalid layers report their own path and reason", async () => {
	await withTempProject(async ({ cwd, globalPath }) => {
		await writeFile(globalPath, "[]");
		await writeFile(projectSettingsPath(cwd), "null");
		const { optionsRef, panel } = await openPanel(cwd, true);
		assert.equal(notifications.length, 2);
		assert.ok(notifications[0]?.includes(globalPath));
		assert.ok(notifications[1]?.includes(projectSettingsPath(cwd)));
		assert.ok(notifications.every((message) => message.includes("JSON object")));
		assert.deepEqual(optionsRef.current, effectiveCompactToolUiSettings({}));
		assert.equal(item("renderShell").values, undefined);
		panel()?.handleInput("\t");
		assert.equal(item("renderShell").values, undefined);
	});
});

test("descriptions distinguish built-in defaults, inheritance and project precedence", async () => {
	await withTempProject(async ({ cwd }) => {
		const { optionsRef, panel } = await openPanel(cwd, true);
		assert.equal(item("renderShell").currentValue, "unset");
		assert.match(item("renderShell").description ?? "", /Effective: self \(source: built-in\)/);
		assert.match(item("inlineDiffMaxLines").description ?? "", /Effective: 64 \(source: built-in\)/);
		await choose("renderShell", "default");
		assert.match(item("renderShell").description ?? "", /Effective: default \(source: global\)/);
		panel()?.handleInput("\t");
		assert.equal(item("renderShell").currentValue, "inherit");
		assert.match(item("renderShell").description ?? "", /Effective: default \(source: global\)/);
		await choose("renderShell", "self");
		assert.equal(optionsRef.current.renderShell, "self");
		assert.match(item("renderShell").description ?? "", /Effective: self \(source: project\)/);
		panel()?.handleInput("\t");
		assert.equal(item("renderShell").currentValue, "default", "editing rows retain raw layer values");
		assert.match(item("renderShell").description ?? "", /Effective: self \(source: project\).*overridden by project/);
		panel()?.handleInput("\t");
		await choose("renderShell", "inherit");
		assert.equal(item("renderShell").currentValue, "inherit");
		assert.equal(optionsRef.current.renderShell, "default");
		assert.match(item("renderShell").description ?? "", /Effective: default \(source: global\)/);
	});
});

test("a failed write rolls the displayed value back", { skip: process.platform !== "win32" }, async () => {
	await withTempProject(async ({ cwd, globalPath }) => {
		await writeFile(globalPath, JSON.stringify({ compactToolUi: { edit: { inlineDiffMaxLines: 32 } } }));
		// A read-only settings file is still readable, but the atomic rename over it fails.
		await chmod(globalPath, 0o444);

		const { optionsRef } = await openPanel(cwd, true);
		await choose("inlineDiffMaxLines", "64");
		await assertAfterSave(() => notifications.length > 0);

		assert.match(notifications[0] ?? "", /Failed to save compact-tool-ui settings/);
		assert.equal(optionsRef.current.edit.inlineDiffMaxLines, 32);
		assert.equal(item("inlineDiffMaxLines").currentValue, "32");
		assert.deepEqual(await readJson(globalPath), { compactToolUi: { edit: { inlineDiffMaxLines: 32 } } });
		await chmod(globalPath, 0o666);
	});
});
