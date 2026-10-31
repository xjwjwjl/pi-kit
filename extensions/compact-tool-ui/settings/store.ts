import { readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import lockfile from "proper-lockfile";

type SettingsFile = Record<string, unknown>;
let tmpSeq = 0;

function errorCode(error: unknown): string | undefined {
	return (error as NodeJS.ErrnoException | undefined)?.code;
}

function readSettingsFileSync(filePath: string): SettingsFile {
	let raw: string;
	try {
		raw = readFileSync(filePath, "utf8");
	} catch (error) {
		if (errorCode(error) === "ENOENT") return {};
		throw error;
	}
	// Match Pi's BOM/empty-file handling, but never replace a malformed root with an empty one.
	if (!raw) return {};
	const parsed: unknown = JSON.parse(raw.replace(/^\uFEFF/, ""));
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("Settings file must contain a JSON object");
	}
	return parsed as SettingsFile;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function withSettingsLock<T>(filePath: string, operation: () => T): Promise<T> {
	for (let attempt = 0; ; attempt++) {
		let release: () => void;
		try {
			// Same lock path/protocol as Pi FileSettingsStorage, including not-yet-created files.
			release = lockfile.lockSync(filePath, { realpath: false });
		} catch (error) {
			if (errorCode(error) !== "ELOCKED" || attempt >= 49) throw error;
			await wait(20);
			continue;
		}
		try {
			// Never yield while holding this lock: Pi's same-process writers acquire it synchronously.
			return operation();
		} finally {
			release();
		}
	}
}

function writeSettingsFileSync(filePath: string, settings: SettingsFile) {
	let target = filePath;
	let mode = 0o600;
	try {
		// Keep an existing file symlink and its permissions, rather than replacing the link itself.
		target = realpathSync(filePath);
		mode = statSync(target).mode;
	} catch (error) {
		if (errorCode(error) !== "ENOENT") throw error;
	}
	const tmpPath = `${target}.${process.pid}.${Date.now()}.${tmpSeq++}.tmp`;
	try {
		writeFileSync(tmpPath, `${JSON.stringify(settings, null, 2)}\n`, { encoding: "utf8", mode });
		renameSync(tmpPath, target);
	} finally {
		// A failed atomic replacement must leave the original intact; never truncate it as fallback.
		rmSync(tmpPath, { force: true });
	}
}

export async function readSettingsFile(filePath: string): Promise<SettingsFile> {
	try {
		return await withSettingsLock(filePath, () => readSettingsFileSync(filePath));
	} catch (error) {
		// Reads must not create an agent/project directory merely to lock a missing file.
		if (errorCode(error) === "ENOENT") return {};
		throw error;
	}
}

/** The callback runs on the latest disk contents inside the same critical section as the write. */
export async function updateSettingsFile<T>(filePath: string, update: (settings: SettingsFile) => T): Promise<T> {
	await mkdir(path.dirname(filePath), { recursive: true });
	for (let attempt = 0; ; attempt++) {
		try {
			return await withSettingsLock(filePath, () => {
				const root = readSettingsFileSync(filePath);
				const result = update(root);
				writeSettingsFileSync(filePath, root);
				return result;
			});
		} catch (error) {
			if (!["EPERM", "EACCES", "EBUSY"].includes(errorCode(error) ?? "") || attempt >= 3) throw error;
			// Retry Windows scanner/indexer locks without holding our lock across the async delay.
			await wait(20 * (attempt + 1));
		}
	}
}
