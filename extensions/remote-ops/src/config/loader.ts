import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { parseRemoteOpsConfig, RemoteOpsConfigError } from "./schema.js";
import type { RemoteOpsConfig } from "./types.js";

export const REMOTE_OPS_CONFIG_RELATIVE_PATH = path.join(".pi", "remote-ops.json");

export interface LoadedRemoteOpsConfig {
	path: string;
	config: RemoteOpsConfig;
}

export async function remoteOpsConfigPath(cwd: string): Promise<string> {
	return path.join(cwd, REMOTE_OPS_CONFIG_RELATIVE_PATH);
}

export async function hasRemoteOpsConfig(cwd: string): Promise<boolean> {
	try {
		await access(await remoteOpsConfigPath(cwd));
		return true;
	} catch {
		return false;
	}
}

export async function loadRemoteOpsConfig(cwd: string): Promise<LoadedRemoteOpsConfig> {
	const configPath = await remoteOpsConfigPath(cwd);
	let text: string;
	try {
		text = await readFile(configPath, "utf8");
	} catch (error: unknown) {
		throw new RemoteOpsConfigError(`Unable to read ${configPath}: ${messageOf(error)}`);
	}

	let raw: unknown;
	try {
		raw = JSON.parse(stripJsonComments(text));
	} catch (error: unknown) {
		throw new RemoteOpsConfigError(`Invalid JSON in ${configPath}: ${messageOf(error)}`);
	}
	try {
		return { path: configPath, config: parseRemoteOpsConfig(raw) };
	} catch (error: unknown) {
		throw new RemoteOpsConfigError(`Invalid configuration in ${configPath}: ${messageOf(error)}`);
	}
}

function stripJsonComments(text: string): string {
	const out: string[] = [];
	let inString = false;
	let escape = false;
	let inLineComment = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (inLineComment) {
			if (ch === "\n") {
				inLineComment = false;
				out.push(ch);
			}
			continue;
		}
		if (inString) {
			if (escape) {
				escape = false;
			} else if (ch === "\\") {
				escape = true;
			} else if (ch === '"') {
				inString = false;
			}
			out.push(ch);
		} else if (ch === '"') {
			inString = true;
			out.push(ch);
		} else if (ch === "/" && text[i + 1] === "/") {
			inLineComment = true;
			i++;
		} else {
			out.push(ch);
		}
	}
	return out.join("");
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
