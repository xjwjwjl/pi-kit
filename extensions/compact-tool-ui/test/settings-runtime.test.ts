import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { once } from "node:events";
import fs from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";
import lockfile from "proper-lockfile";
// Deliberately bypass the package-root unit-test stub. These are Pi 1.3.0's real implementations.
import { FileSettingsStorage, SettingsManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/settings-manager.js";
import {
	globalSettingsPath,
	loadCompactToolUiSettings,
	projectSettingsPath,
	resolveCompactToolUiOptions,
	saveCompactToolUiSettings,
} from "../settings/compact-tool-ui.js";

type Fixture = { cwd: string; agentDir: string; globalPath: string; projectPath: string };

async function withSettingsFixture(run: (fixture: Fixture) => Promise<void>) {
	const root = await mkdtemp(path.join(tmpdir(), "compact-settings-runtime-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const cwd = path.join(root, "project");
	const agentDir = path.join(root, "agent");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		await mkdir(agentDir, { recursive: true });
		await mkdir(path.join(cwd, ".pi"), { recursive: true });
		const globalPath = path.join(agentDir, "settings.json");
		const projectPath = path.join(cwd, ".pi", "settings.json");
		assert.equal(globalSettingsPath(), globalPath);
		assert.equal(projectSettingsPath(cwd), projectPath);
		await run({ cwd, agentDir, globalPath, projectPath });
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(root, { recursive: true, force: true });
	}
}

async function within<T>(promise: Promise<T>, message: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), 7000); }),
		]);
	} finally {
		clearTimeout(timer);
	}
}

function signal() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

async function assertClean(fixture: Fixture) {
	assert.deepEqual(await readdir(fixture.agentDir), ["settings.json"], "global lock and temporary files must be removed");
	assert.deepEqual(await readdir(path.dirname(fixture.projectPath)),
		fs.existsSync(fixture.projectPath) ? ["settings.json"] : [], "project lock and temporary files must be removed");
}

// A separate isolate holds the real native lock; no mocked lock acquisition or timing-based sleep.
const nativeWriter = String.raw`
import assert from "node:assert/strict";
import { parentPort, workerData } from "node:worker_threads";
const { FileSettingsStorage } = await import(workerData.moduleUrl);
const storage = new FileSettingsStorage(workerData.cwd, workerData.agentDir);
storage.withLock("global", (current) => {
	parentPort.postMessage("held");
	const release = new Int32Array(workerData.release);
	Atomics.wait(release, 0, 0, 5000);
	assert.equal(Atomics.load(release, 0), 1, "parent did not release native writer");
	const root = JSON.parse(current);
	return JSON.stringify({
		...root,
		theme: "light",
		unknownKey: { native: true },
		compactToolUi: { ...root.compactToolUi, edit: { inlineDiffMaxLines: 128 } },
	});
});
`;

test("real FileSettingsStorage contention makes plugin reads and patches wait for fresh disk contents", { timeout: 20000 }, async (t) => {
	await withSettingsFixture(async (fixture) => {
		const { cwd, agentDir, globalPath } = fixture;
		const initial = {
			theme: "dark", originalUnknown: { preserved: [1, 2] },
			compactToolUi: { renderShell: "default", edit: { inlineDiffMaxLines: 16 }, future: true },
		};
		await writeFile(globalPath, JSON.stringify(initial));
		assert.equal((await loadCompactToolUiSettings("global", cwd)).edit?.inlineDiffMaxLines, 16);
		const release = new Int32Array(new SharedArrayBuffer(4));
		const worker = new Worker(new URL("data:text/javascript," + encodeURIComponent(nativeWriter)), {
			execArgv: [],
			workerData: {
				cwd, agentDir, release: release.buffer,
				moduleUrl: new URL("../node_modules/@earendil-works/pi-coding-agent/dist/core/settings-manager.js", import.meta.url).href,
			},
			env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
		});
		const workerErrors: Error[] = [];
		worker.on("error", (error) => workerErrors.push(error));
		const exited = new Promise<number>((resolve) => worker.once("exit", resolve));
		const pending: Promise<unknown>[] = [];
		try {
			const [message] = await within(once(worker, "message"), "native writer did not acquire its lock");
			assert.equal(message, "held");
			assert.equal(fs.existsSync(globalPath + ".lock"), true);
			const contended = signal();
			const originalLock = lockfile.lockSync;
			const operations = new AsyncLocalStorage<"read" | "save">();
			const collisions = new Set<string>();
			t.mock.method(lockfile, "lockSync", (...args: Parameters<typeof lockfile.lockSync>) => {
				try {
					return originalLock(...args);
				} catch (error) {
					if (args[0] === globalPath && (error as NodeJS.ErrnoException).code === "ELOCKED") {
						assert.equal(args[1]?.realpath, false);
						const operation = operations.getStore();
						assert.ok(operation, "contention must come from an identified plugin operation");
						collisions.add(operation);
						if (collisions.size === 2) contended.resolve();
					}
					throw error;
				}
			});
			let readSettled = false;
			let saveSettled = false;
			const reading = operations.run("read", () => loadCompactToolUiSettings("global", cwd));
			const saving = operations.run("save", () => saveCompactToolUiSettings("global", cwd, { renderShell: "self" }));
			// Register rejection handlers immediately, including on assertion/timeout cleanup paths.
			pending.push(reading.then(() => { readSettled = true; }, () => { readSettled = true; }));
			pending.push(saving.then(() => { saveSettled = true; }, () => { saveSettled = true; }));
			await within(contended.promise, "plugin read and save did not both encounter the native lock");
			assert.equal(readSettled, false);
			assert.equal(saveSettled, false);
			assert.deepEqual(JSON.parse(await readFile(globalPath, "utf8")), initial);
			Atomics.store(release, 0, 1);
			Atomics.notify(release, 0);
			const [loaded, committed, exitCode] = await within(Promise.all([reading, saving, exited]), "writers did not finish after release");
			assert.equal(exitCode, 0);
			assert.deepEqual(workerErrors, []);
			assert.equal(loaded.edit?.inlineDiffMaxLines, 128, "plugin reads must not use a pre-lock snapshot");
			assert.deepEqual(committed, { renderShell: "self", edit: { inlineDiffMaxLines: 128 } });
			assert.deepEqual(JSON.parse(await readFile(globalPath, "utf8")), {
				...initial, theme: "light", unknownKey: { native: true },
				compactToolUi: { renderShell: "self", edit: { inlineDiffMaxLines: 128 }, future: true },
			});
			await assertClean(fixture);
		} finally {
			Atomics.store(release, 0, 1);
			Atomics.notify(release, 0);
			try {
				// Let native withLock finish its finally/release before terminating the isolate.
				await within(exited, "native writer did not release its lock during cleanup");
			} finally {
				await worker.terminate();
				await Promise.allSettled(pending);
				t.mock.restoreAll();
			}
		}
	});
});

test("same-process SettingsManager writes run only after the plugin releases its synchronous critical section", { timeout: 15000 }, async (t) => {
	await withSettingsFixture(async (fixture) => {
		const { cwd, agentDir, globalPath } = fixture;
		await writeFile(globalPath, JSON.stringify({ theme: "dark", unknown: true, compactToolUi: { edit: { inlineDiffMaxLines: 16 } } }));
		const native = SettingsManager.create(cwd, agentDir);
		assert.deepEqual(native.drainErrors(), []);
		native.setDefaultModel("native-before");
		await native.flush();
		const target = fs.realpathSync(globalPath);
		const originalRename = fs.renameSync;
		const queued = signal();
		const events: string[] = [];
		let lockedAtNativeEvent: boolean | undefined;
		try {
			t.mock.method(fs, "renameSync", (...args: Parameters<typeof fs.renameSync>) => {
				if (String(args[1]) === target && events.length === 0) {
					assert.equal(fs.existsSync(globalPath + ".lock"), true, "atomic replacement must be under the native lock");
					events.push("plugin-rename");
					queueMicrotask(() => {
						lockedAtNativeEvent = fs.existsSync(globalPath + ".lock");
						events.push("native-event");
						native.setTheme("light");
						queued.resolve();
					});
				}
				return originalRename(...args);
			});
			syncBuiltinESMExports();
			const committed = await within(Promise.all([
				saveCompactToolUiSettings("global", cwd, { renderShell: "self" }), queued.promise,
			]), "native event was not scheduled during the plugin write");
			await native.flush();
			assert.deepEqual(events, ["plugin-rename", "native-event"]);
			assert.equal(lockedAtNativeEvent, false, "yielding while holding the lock blocks native synchronous retries");
			assert.deepEqual(committed[0], { renderShell: "self", edit: { inlineDiffMaxLines: 16 } });
			assert.deepEqual(JSON.parse(await readFile(globalPath, "utf8")), {
				theme: "light", unknown: true, defaultModel: "native-before",
				compactToolUi: { renderShell: "self", edit: { inlineDiffMaxLines: 16 } },
			});
			// Reverse the order as well: the manager's stale in-memory plugin block must not overwrite a patch.
			native.setTheme("dark");
			await saveCompactToolUiSettings("global", cwd, { edit: { inlineDiffMaxLines: 96 } });
			await native.flush();
			assert.deepEqual(native.drainErrors(), [], "native lock/storage errors must not be swallowed by its write queue");
			assert.deepEqual(JSON.parse(await readFile(globalPath, "utf8")), {
				theme: "dark", unknown: true, defaultModel: "native-before",
				compactToolUi: { renderShell: "self", edit: { inlineDiffMaxLines: 96 } },
			});
			await assertClean(fixture);
		} finally {
			t.mock.restoreAll();
			syncBuiltinESMExports();
			await native.flush();
		}
	});
});

test("real SettingsManager and plugin agree on BOM-prefixed global/project layers without rewriting them", async () => {
	await withSettingsFixture(async (fixture) => {
		const { cwd, agentDir, globalPath, projectPath } = fixture;
		const global = { theme: "light", unknown: [1, 2], compactToolUi: { renderShell: "default", edit: { inlineDiffMaxLines: 64 } } };
		const project = { defaultModel: "project-model", compactToolUi: { edit: { inlineDiffMaxLines: 32 } } };
		const globalBytes = Buffer.from("\uFEFF" + JSON.stringify(global, null, 2) + "\r\n");
		const projectBytes = Buffer.from("\uFEFF" + JSON.stringify(project) + "\n");
		await writeFile(globalPath, globalBytes);
		await writeFile(projectPath, projectBytes);
		const native = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
		assert.deepEqual(native.getGlobalSettings(), global);
		assert.deepEqual(native.getProjectSettings(), project);
		assert.equal(native.getTheme(), "light");
		assert.equal(native.getDefaultModel(), "project-model");
		assert.deepEqual(native.drainErrors(), []);
		assert.deepEqual(await resolveCompactToolUiOptions(cwd, true), { renderShell: "default", edit: { inlineDiffMaxLines: 32 } });
		const untrusted = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
		assert.deepEqual(untrusted.getProjectSettings(), {});
		assert.deepEqual(untrusted.drainErrors(), []);
		assert.deepEqual(await resolveCompactToolUiOptions(cwd, false), { renderShell: "default", edit: { inlineDiffMaxLines: 64 } });
		assert.deepEqual(await readFile(globalPath), globalBytes);
		assert.deepEqual(await readFile(projectPath), projectBytes);
		await assertClean(fixture);
	});
});

for (const code of ["EPERM", "EACCES", "EBUSY"]) {
	test(`permanent ${code} replacement failures are bounded, preserve original bytes and clean locks/temp files`, { timeout: 15000 }, async (t) => {
		await withSettingsFixture(async (fixture) => {
			const { cwd, globalPath } = fixture;
			const originalBytes = Buffer.from('\uFEFF{ "theme": "dark", "unknown": [1, 2] }\r\n');
			await writeFile(globalPath, originalBytes);
			const target = fs.realpathSync(globalPath);
			const originalRename = fs.renameSync;
			const originalWrite = fs.writeFileSync;
			let attempts = 0;
			let directWrites = 0;
			const tempPaths: string[] = [];
			try {
				t.mock.method(fs, "renameSync", (...args: Parameters<typeof fs.renameSync>) => {
					if (String(args[1]) !== target) return originalRename(...args);
					attempts++;
					tempPaths.push(String(args[0]));
					assert.equal(fs.existsSync(globalPath + ".lock"), true);
					assert.equal(fs.existsSync(args[0]), true);
					assert.deepEqual(fs.readFileSync(globalPath), originalBytes);
					throw Object.assign(new Error("injected temporary-file replacement failure"), { code });
				});
				t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof fs.writeFileSync>) => {
					if (String(args[0]) === target) directWrites++;
					return originalWrite(...args);
				});
				syncBuiltinESMExports();
				await assert.rejects(saveCompactToolUiSettings("global", cwd, { renderShell: "self" }), { code });
				assert.equal(attempts, 4, "Windows errors must stop after the bounded retries");
				assert.equal(directWrites, 0, "never fall back to truncating the original file");
				assert.deepEqual(await readFile(globalPath), originalBytes);
				for (const tempPath of tempPaths) assert.equal(fs.existsSync(tempPath), false);
				await assertClean(fixture);
				// A fresh native writer must still acquire the released lock after failure.
				const native = SettingsManager.create(cwd, fixture.agentDir);
				native.setTheme("light");
				await native.flush();
				assert.deepEqual(native.drainErrors(), []);
				assert.equal(JSON.parse(await readFile(globalPath, "utf8")).theme, "light");
				await assertClean(fixture);
			} finally {
				t.mock.restoreAll();
				syncBuiltinESMExports();
			}
		});
	});
}

test("Windows replacement retries release the native lock and reread every intervening native commit", { timeout: 15000 }, async (t) => {
	await withSettingsFixture(async (fixture) => {
		const { cwd, agentDir, globalPath } = fixture;
		await writeFile(globalPath, JSON.stringify({ theme: "dark", originalUnknown: true, compactToolUi: { edit: { inlineDiffMaxLines: 16 } } }));
		const native = new FileSettingsStorage(cwd, agentDir);
		const target = fs.realpathSync(globalPath);
		const originalRename = fs.renameSync;
		const attemptedLines: number[] = [];
		const lockedAtNativeEvents: boolean[] = [];
		const nativeErrors: unknown[] = [];
		try {
			t.mock.method(fs, "renameSync", (...args: Parameters<typeof fs.renameSync>) => {
				if (String(args[1]) !== target) return originalRename(...args);
				assert.equal(fs.existsSync(globalPath + ".lock"), true);
				attemptedLines.push(JSON.parse(fs.readFileSync(args[0], "utf8")).compactToolUi.edit.inlineDiffMaxLines);
				const revision = attemptedLines.length;
				if (revision > 2) return originalRename(...args);
				queueMicrotask(() => {
					lockedAtNativeEvents.push(fs.existsSync(globalPath + ".lock"));
					try {
						native.withLock("global", (current) => {
							const root = JSON.parse(current!);
							return JSON.stringify({ ...root, theme: "native-" + revision, nativeRevision: revision,
								compactToolUi: { ...root.compactToolUi, future: revision, edit: { inlineDiffMaxLines: revision * 32 + 32 } } });
						});
					} catch (error) {
						nativeErrors.push(error);
					}
				});
				throw Object.assign(new Error("injected transient Windows rename error"), { code: revision === 1 ? "EPERM" : "EBUSY" });
			});
			syncBuiltinESMExports();
			const committed = await saveCompactToolUiSettings("global", cwd, { renderShell: "self" });
			assert.deepEqual(nativeErrors, []);
			assert.deepEqual(lockedAtNativeEvents, [false, false]);
			assert.deepEqual(attemptedLines, [16, 64, 96], "each retry must patch a fresh root, not reuse its failed snapshot");
			assert.deepEqual(committed, { renderShell: "self", edit: { inlineDiffMaxLines: 96 } });
			assert.deepEqual(JSON.parse(await readFile(globalPath, "utf8")), {
				theme: "native-2", originalUnknown: true, nativeRevision: 2,
				compactToolUi: { renderShell: "self", future: 2, edit: { inlineDiffMaxLines: 96 } },
			});
			await assertClean(fixture);
		} finally {
			t.mock.restoreAll();
			syncBuiltinESMExports();
		}
	});
});
