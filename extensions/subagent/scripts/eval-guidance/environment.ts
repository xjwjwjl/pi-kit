import { posix, win32 } from "node:path";
import {
	createLsToolDefinition,
	createReadToolDefinition,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	truncateHead,
	type LsToolInput,
	type ReadToolInput,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export interface FixtureAccess {
	tool: "read" | "ls";
	path: string;
	allowed: boolean;
	/** Normalized fixture-relative key, so equivalent spellings compare equal. */
	key?: string;
	/** Recorded after at least one agent call in this case; descriptive, not a quality score. */
	afterDelegation?: boolean;
}

function fail(code: string, message: string): never {
	throw Object.assign(new Error(`${code}: ${message}`), { code });
}

function slashes(path: string): string {
	return path.replace(/\\/g, "/");
}

function isAbsolute(path: string): boolean {
	return posix.isAbsolute(path) || win32.isAbsolute(path) || /^[a-z]:/i.test(path);
}

/** Portable fixture names: no traversal, drive/ADS syntax, devices, or Windows aliases. */
function relativeKey(path: string, file = false): string {
	if (!path || isAbsolute(path) || path.startsWith("~")) fail("EINVAL", `Invalid fixture path: ${path}`);
	const normalized = slashes(path);
	const parts = normalized.split("/");
	if (parts.includes("..")) fail("EACCES", `Path traversal is not allowed: ${path}`);
	for (const part of parts) {
		if (!part || part === ".") continue;
		if (
			/[<>:"|?*\x00-\x1f\x7f]/.test(part) ||
			/[. ]$/.test(part) ||
			/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
		) fail("EINVAL", `Invalid fixture path component: ${part}`);
	}
	const key = parts.filter((part) => part && part !== ".").join("/");
	if (file && (!key || normalized.endsWith("/"))) fail("EINVAL", `Expected a file path: ${path}`);
	return key;
}

function positiveInteger(value: number | undefined, name: string, fallback: number): number {
	if (value === undefined) return fallback;
	if (!Number.isSafeInteger(value) || value < 1) fail("EINVAL", `${name} must be a positive safe integer`);
	return value;
}

function textResult(text: string, details: unknown = undefined) {
	return { content: [{ type: "text" as const, text }], structuredContent: text, details };
}

/**
 * A closed, case-sensitive virtual filesystem. cwd is only a lexical boundary, never opened.
 * Audit paths preserve the caller's spelling (ls's omitted path is "."). Each execute emits
 * exactly one audit entry, including failures; allowed describes path validity, not existence.
 * Both executes are deliberately replaced: SDK read's path probing bypasses operations, and
 * a local ls implementation keeps cross-platform path and sorting semantics independent of
 * SDK path expansion and the execution context's cwd. No SDK execute is called.
 */
export function createReadOnlyTools(
	cwd: string,
	files: ReadonlyMap<string, string>,
	onAccess?: (entry: FixtureAccess) => void,
): ToolDefinition[] {
	const windows = /^[a-z]:[\\/]/i.test(cwd) || /^[/\\]{2}[^/\\]/.test(cwd);
	const pathApi = windows ? win32 : posix;
	if (!pathApi.isAbsolute(cwd) || /[\x00-\x1f\x7f]/.test(cwd)) fail("EINVAL", "cwd must be an absolute path");
	const root = slashes(pathApi.normalize(cwd)).replace(/\/$/, "");
	const compare = (path: string) => windows ? path.toLowerCase() : path;

	const snapshot = new Map<string, string>();
	const directories = new Set<string>([""]);
	for (const [path, text] of files) {
		if (typeof path !== "string" || typeof text !== "string") fail("EINVAL", "Fixture keys and values must be strings");
		const key = relativeKey(path, true);
		if (snapshot.has(key)) fail("EINVAL", `Normalized fixture path collision: ${path}`);
		snapshot.set(key, text);
		const parts = key.split("/");
		for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join("/"));
	}
	for (const key of snapshot.keys()) {
		if (directories.has(key)) fail("EINVAL", `Fixture file/directory conflict: ${key}`);
	}

	function resolveInput(input: unknown): string {
		if (typeof input !== "string") fail("EINVAL", "path must be a string");
		const path = slashes(input);
		// Reject traversal before normalization, even when it would end inside the root.
		if (path.split("/").includes("..")) fail("EACCES", `Path traversal is not allowed: ${input}`);
		if (!isAbsolute(path)) return relativeKey(path);
		if (!windows && (path.startsWith("//") || /^[a-z]:/i.test(path))) {
			fail("EACCES", `Path is outside the fixture: ${input}`);
		}
		const normalized = slashes(pathApi.normalize(path)).replace(/\/$/, "");
		const sameRoot = compare(normalized) === compare(root);
		if (!sameRoot && !compare(normalized).startsWith(`${compare(root)}/`)) {
			fail("EACCES", `Path is outside the fixture: ${input}`);
		}
		return sameRoot ? "" : relativeKey(normalized.slice(root.length + 1));
	}

	function access(tool: FixtureAccess["tool"], input: unknown): string {
		let key: string;
		try {
			key = resolveInput(input);
		} catch (error) {
			onAccess?.({ tool, path: String(input), allowed: false });
			throw error;
		}
		onAccess?.({ tool, path: String(input), allowed: true, key });
		return key;
	}

	function assertExists(key: string): void {
		if (snapshot.has(key) || directories.has(key)) return;
		const parts = key.split("/");
		for (let i = 1; i < parts.length; i++) {
			if (snapshot.has(parts.slice(0, i).join("/"))) fail("ENOTDIR", `Not a directory: ${parts.slice(0, i).join("/")}`);
		}
		fail("ENOENT", `No such fixture path: ${key}`);
	}

	const children = new Map<string, string[]>();
	for (const key of [...snapshot.keys(), ...directories]) {
		if (!key) continue;
		const slash = key.lastIndexOf("/");
		const parent = key.slice(0, Math.max(0, slash));
		const entry = key.slice(slash + 1) + (directories.has(key) ? "/" : "");
		const entries = children.get(parent) ?? [];
		entries.push(entry);
		children.set(parent, entries);
	}
	for (const entries of children.values()) {
		// Locale-independent, case-insensitive lexical order with a case-sensitive tie break.
		entries.sort((a, b) => {
			const lowerA = a.toLowerCase();
			const lowerB = b.toLowerCase();
			return lowerA < lowerB ? -1 : lowerA > lowerB ? 1 : a < b ? -1 : a > b ? 1 : 0;
		});
	}

	const readDefinition = createReadToolDefinition(cwd);
	const lsDefinition = createLsToolDefinition(cwd);
	return [
		{
			name: "read",
			label: "read",
			parameters: readDefinition.parameters,
			outputSchema: readDefinition.outputSchema,
			constrainedSampling: readDefinition.constrainedSampling,
			promptSnippet: "Read fixture text",
			description: `评测夹具中的纯文本read。Only reads the immutable in-memory fixture, not host files or images. Paths are case-sensitive and confined to the fixture root; traversal is forbidden. offset/limit are positive integers, offset is 1-based. Empty text has one empty line; a trailing newline starts an empty final line. File text is capped at ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024} KiB, plus a short continuation notice. This is not the full native read implementation.`,
			async execute(_id, params, signal) {
				const { path, offset, limit } = (params ?? {}) as ReadToolInput;
				const key = access("read", path);
				if (signal?.aborted) fail("ABORT_ERR", "Operation aborted");
				const start = positiveInteger(offset, "offset", 1) - 1;
				const count = positiveInteger(limit, "limit", Number.MAX_SAFE_INTEGER);
				assertExists(key);
				if (directories.has(key)) fail("EISDIR", `Cannot read a directory: ${path}`);
				const lines = snapshot.get(key)!.split("\n");
				if (start >= lines.length) fail("ERANGE", `Offset ${start + 1} is beyond end of file (${lines.length} lines total)`);
				const selected = lines.slice(start, Math.min(lines.length, start + count)).join("\n");
				const truncation = truncateHead(selected);
				if (truncation.firstLineExceedsLimit) {
					return textResult(`[Line ${start + 1} exceeds the ${DEFAULT_MAX_BYTES / 1024} KiB fixture read limit; no partial line returned.]`, { truncation });
				}
				let output = truncation.content;
				const next = start + (truncation.truncated ? truncation.outputLines : Math.min(count, lines.length - start));
				if (next < lines.length) output += `\n\n[Showing lines ${start + 1}-${next} of ${lines.length}. Use offset=${next + 1} to continue.]`;
				return textResult(output, truncation.truncated ? { truncation } : undefined);
			},
		},
		{
			name: "ls",
			label: "ls",
			parameters: lsDefinition.parameters,
			promptSnippet: "List fixture directory contents",
			description: `List the in-memory fixture's immediate directory entries (default: fixture root). Includes dotfiles and '/' suffixes for directories. Case-insensitive lexical sorting uses a case-sensitive tie break, independent of locale. limit must be a positive integer (default: 500); entry text is capped at ${DEFAULT_MAX_BYTES / 1024} KiB plus a short notice. No host filesystem, symlinks, or native path expansion. Paths are case-sensitive; traversal and external absolute paths are forbidden.`,
			outputSchema: Type.String(),
			async execute(_id, params, signal) {
				const { path, limit } = (params ?? {}) as LsToolInput;
				const key = access("ls", path === undefined ? "." : path);
				if (signal?.aborted) fail("ABORT_ERR", "Operation aborted");
				const count = positiveInteger(limit, "limit", 500);
				assertExists(key);
				if (!directories.has(key)) fail("ENOTDIR", `Not a directory: ${path}`);
				const entries = children.get(key) ?? [];
				if (!entries.length) return textResult("(empty directory)");
				const truncation = truncateHead(entries.slice(0, count).join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
				const notices: string[] = [];
				const details: { entryLimitReached?: number; truncation?: typeof truncation } = {};
				if (entries.length > count) {
					notices.push(`${count} entries limit reached. Use a larger limit for more.`);
					details.entryLimitReached = count;
				}
				if (truncation.truncated) {
					notices.push(`${DEFAULT_MAX_BYTES / 1024} KiB fixture listing limit reached.`);
					details.truncation = truncation;
				}
				const output = truncation.content + (notices.length ? `\n\n[${notices.join(" ")}]` : "");
				return textResult(output, notices.length ? details : undefined);
			},
		},
	];
}
