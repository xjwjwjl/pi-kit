import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { clearProjectConfigCache, findProjectConfigPath, resolveProjectConfigPathForWrite, validateProjectConfigData } from "./loader.js";
import { isRecord } from "../utils.js";

export type ProjectConfigDraft = {
	configPath: string;
	exists: boolean;
	rawText: string;
	rawValue: unknown;
	rawObject: Record<string, unknown> | undefined;
	parseError?: string;
};

function emptyConfigTemplate(): Record<string, unknown> {
	return { sources: [] };
}

function ensureAgentTools(root: Record<string, unknown>): Record<string, unknown> {
	if (!isRecord(root.agent_tools)) root.agent_tools = {};
	return root.agent_tools as Record<string, unknown>;
}

export function loadProjectConfigDraft(cwd: string): ProjectConfigDraft {
	const existingPath = findProjectConfigPath(cwd);
	const configPath = existingPath ?? resolveProjectConfigPathForWrite(cwd);

	if (!existingPath || !existsSync(configPath)) {
		const template = emptyConfigTemplate();
		return {
			configPath,
			exists: false,
			rawText: `${JSON.stringify(template, null, 2)}\n`,
			rawValue: template,
			rawObject: template,
		};
	}

	const rawText = readFileSync(configPath, "utf-8");
	let rawValue: unknown;
	try {
		rawValue = JSON.parse(rawText);
	} catch (error) {
		return {
			configPath,
			exists: true,
			rawText,
			rawValue: undefined,
			rawObject: undefined,
			parseError: error instanceof Error ? error.message : String(error),
		};
	}

	return {
		configPath,
		exists: true,
		rawText,
		rawValue,
		rawObject: isRecord(rawValue) ? rawValue : undefined,
		parseError: isRecord(rawValue) ? undefined : "SQL config must be a JSON object.",
	};
}

export function setProjectAgentToolsEnabled(cwd: string, enabled: boolean): void {
	const draft = loadProjectConfigDraft(cwd);
	if (draft.parseError || !draft.rawObject) {
		throw new Error(`Cannot update SQLKit agent tools state: ${draft.parseError ?? "config is not a JSON object"}`);
	}
	const root = draft.rawObject;
	ensureAgentTools(root).enabled = enabled;
	writeProjectConfigDocument(draft.configPath, root);
}

export function writeProjectConfigDocument(configPath: string, value: unknown): void {
	validateProjectConfigData(value, configPath);

	const dir = path.dirname(configPath);
	mkdirSync(dir, { recursive: true });

	// Preserve the existing file's permission bits, or default to 0600 for new
	// files. sqlkit.json may contain plaintext passwords, so world/group-read
	// must not be introduced by a rewrite. On Windows the mode is effectively
	// ignored (NTFS ACLs govern access), but this keeps Unix deployments safe.
	let desiredMode = 0o600;
	const hadExistingTarget = existsSync(configPath);
	if (hadExistingTarget) {
		try {
			desiredMode = statSync(configPath).mode & 0o777;
		} catch {
			// Fall back to 0600 if stat fails.
		}
	}

	const tempPath = path.join(dir, `.${path.basename(configPath)}.${process.pid}.${Date.now()}.tmp`);
	const backupPath = `${configPath}.bak.${process.pid}.${Date.now()}`;
	const text = `${JSON.stringify(value, null, 2)}\n`;
	writeFileSync(tempPath, text, { encoding: "utf-8", mode: desiredMode });

	try {
		if (hadExistingTarget) {
			renameSync(configPath, backupPath);
		}
		try {
			renameSync(tempPath, configPath);
			// rename preserves the temp file's mode, but umask may have
			// narrowed it on some platforms — reassert explicitly.
			try {
				chmodSync(configPath, desiredMode);
			} catch {
				// chmod failure is non-fatal (e.g. Windows).
			}
		} catch (error) {
			if (hadExistingTarget && existsSync(backupPath)) {
				renameSync(backupPath, configPath);
			}
			throw error;
		}
	} finally {
		if (existsSync(tempPath)) {
			rmSync(tempPath, { force: true });
		}
		if (existsSync(backupPath)) {
			rmSync(backupPath, { force: true });
		}
	}

	clearProjectConfigCache();
}
