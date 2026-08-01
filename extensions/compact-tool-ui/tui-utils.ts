import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Container, getCapabilities, hyperlink, Text } from "@earendil-works/pi-tui";

export {
	countLines,
	firstNonEmptyLine,
	formatDuration,
	imageBlocks,
	plural,
	shortPath,
	stripAnsi,
	textBlocks,
	trimTrailingEmptyLines,
} from "./core-utils.js";

export function emptyComponent() {
	return new Container();
}

export function setText(component: Text, content: string) {
	component.setText(content);
	return component;
}

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

function normalizeToolPath(value: string, stripAtPrefix: boolean): string {
	let normalized = value.replace(UNICODE_SPACES, " ");
	if (stripAtPrefix && normalized.startsWith("@")) normalized = normalized.slice(1);

	const home = homedir();
	if (normalized === "~") return home;
	if (normalized.startsWith("~/") || (process.platform === "win32" && normalized.startsWith("~\\"))) {
		return resolve(home, normalized.slice(2));
	}
	if (/^file:\/\//.test(normalized)) return fileURLToPath(normalized);
	return normalized;
}

/** Resolve links exactly as Pi's built-in file tools resolve their path arguments. */
export function resolveToolPathForLink(rawPath: string, cwd: string): string {
	const normalizedPath = normalizeToolPath(rawPath, true);
	const normalizedCwd = normalizeToolPath(cwd, false);
	return isAbsolute(normalizedPath) ? resolve(normalizedPath) : resolve(normalizedCwd, normalizedPath);
}

export function linkPath(styledText: string, rawPath: string, cwd: string): string {
	if (!getCapabilities().hyperlinks) return styledText;
	return hyperlink(styledText, pathToFileURL(resolveToolPathForLink(rawPath, cwd)).href);
}
