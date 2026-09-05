/**
 * git-worktree core — pure-ish helpers for creating worktrees and launching a
 * fresh Pi session inside a Windows Terminal (WT) tab rooted at that worktree.
 *
 * Kept free of any `ExtensionAPI` dependency so it can be unit-tested.
 */

import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);

/** Result of a git command run, normalised for easy assertions. */
export interface GitResult {
	code: number;
	stdout: string;
	stderr: string;
}

/** Thin async wrapper around git for testable command plumbing. */
export async function runGit(args: string[], cwd?: string): Promise<GitResult> {
	try {
		const { stdout, stderr } = await execFileAsync("git", args, {
			cwd: cwd ? path.resolve(cwd) : process.cwd(),
			windowsHide: true,
		});
		return { code: 0, stdout, stderr };
	} catch (err: unknown) {
		const code =
			typeof (err as { code?: unknown }).code === "number"
				? ((err as { code: number }).code as number)
				: 1;
		const stderr = String((err as { stderr?: unknown }).stderr ?? "");
		const stdout = String((err as { stdout?: unknown }).stdout ?? "");
		return { code, stdout, stderr };
	}
}

/** Return an individual line of output stripped of its newline. */
export function lines(text: string): string[] {
	return text
		.split(/\r?\n/)
		.filter((l) => l.length > 0);
}

/**
 * True when `dir` is inside a git repository (toplevel resolves). Returns the
 * absolute repo root, or null when not in a repo.
 */
export async function repoRoot(cwd: string): Promise<string | null> {
	const res = await runGit(["rev-parse", "--show-toplevel"], cwd);
	if (res.code !== 0) return null;
	const root = path.normalize(res.stdout.trim());
	if (!root) return null;
	return root;
}

/** Current branch name, or null when detached / unborn. */
export async function currentBranch(cwd: string): Promise<string | null> {
	const res = await runGit(["branch", "--show-current"], cwd);
	return res.code === 0 && res.stdout.trim() ? res.stdout.trim() : null;
}

/** True when the working tree has uncommitted changes (untracked excluded). */
export async function isWorkingTreeDirty(cwd: string): Promise<boolean> {
	const res = await runGit(["status", "--porcelain"], cwd);
	if (res.code !== 0) return true; // treat unknown as dirty to be safe
	// status --porcelain: X_Y path; "_" columns not needed, but we want to ignore
	// untracked-only lines (starts with "??") for the dirty check.
	return res.stdout.split(/\r?\n/).some((l) => l.length > 0 && !l.startsWith("??"));
}

/**
 * True when `dir` is already a linked worktree (its git-dir differs from the
 * common git-dir), rather than the main checkout.
 */
export async function isLinkedWorktree(cwd: string): Promise<boolean> {
	const gitDir = await runGit(["rev-parse", "--absolute-git-dir"], cwd);
	// Use the *absolute* common dir: `--git-common-dir` returns a path relative
	// to cwd (e.g. `.git`), which would never equal the absolute git-dir and
	// wrongly flag the main checkout as a linked worktree.
	const common = await runGit(["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd);
	if (gitDir.code !== 0 || common.code !== 0) return false;
	const dir = path.normalize(gitDir.stdout.trim());
	const comm = path.normalize(common.stdout.trim());
	// A plain repo stores the common dir directly in .git (equal paths);
	// a linked worktree stores a .git file pointing to .git/worktrees/<name>.
	return dir !== comm;
}

/** Default base branch name for a new worktree. No base defaults to provided one. */
export async function resolveBase(cwd: string): Promise<string | null> {
	return currentBranch(cwd);
}

/**
 * Derive a default worktree branch name from the current branch. Handles common
 * cases so repeated use produces stable, distinct names.
 */
export function deriveBranchName(current: string): string {
	if (!current) return "worktree";
	// feature/foo -> feature/foo-worktree ; main -> main-worktree
	return `${current}-worktree`;
}

/** Path-unfriendly chars are replaced with `-` per the skill convention. */
export function sanitizeBranchForPath(branch: string): string {
	return branch.replace(/[/\\:@]/g, "-");
}

/**
 * Resolve the worktree directory for a branch:
 * `<repoRoot>/.worktrees/<branchSanitized>`.
 */
export function worktreePath(repoRootDir: string, branch: string): string {
	return path.join(repoRootDir, ".worktrees", sanitizeBranchForPath(branch));
}

/** List existing worktrees as `{ path, branch }`. */
export async function listWorktrees(cwd: string): Promise<Array<{ path: string; branch: string }>> {
	const res = await runGit(["worktree", "list", "--porcelain"], cwd);
	if (res.code !== 0) return [];
	const out: Array<{ path: string; branch: string }> = [];
	let current: { path?: string; branch?: string } = {};
	for (const line of res.stdout.split(/\r?\n/)) {
		if (line.startsWith("worktree ")) {
			if (current.path) out.push({ path: current.path, branch: current.branch ?? "(detached)" });
			current = { path: decodeWorktreeLine(line) };
		} else if (line.startsWith("branch ")) {
			const ref = line.slice("branch ".length).trim();
			current.branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
		} else if (line.startsWith("HEAD ")) {
			// ignore
		}
	}
	if (current.path) out.push({ path: current.path, branch: current.branch ?? "(detached)" });
	return out;
}

function decodeWorktreeLine(line: string): string {
	return line.slice("worktree ".length).trim();
}

/**
 * Create a worktree. `branch` is the new branch (unprefixed). If `branch`
 * already exists and isn't attached, reuse it; otherwise create with `-b`.
 */
export async function createWorktree(opts: {
	base: string;
	branch: string;
	worktreeDir: string;
	repoRootDir: string;
}): Promise<GitResult> {
	const { base, branch, worktreeDir, repoRootDir } = opts;
	// Check whether branch exists.
	const exists = await runGit(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], repoRootDir);
	if (exists.code === 0) {
		// Branch exists but not attached — attach it to the new worktree.
		return runGit(["worktree", "add", worktreeDir, branch], repoRootDir);
	}
	return runGit(["worktree", "add", worktreeDir, "-b", branch, base], repoRootDir);
}

/** The absolute Windows path to a shell command that launches `wt.exe`. */
export function wtExecutableCandidate(): string | null {
	if (process.env.WT_SESSION) {
		// We're inside Windows Terminal; `wt.exe` is an App Execution Alias that
		// only resolves via PATH through CreateProcess. Resolve via PATH search.
		const fromPath = findOnPath("wt.exe");
		if (fromPath) return fromPath;
		// Fallback: the standard alias location.
		const local = process.env.LOCALAPPDATA;
		if (local) {
			const c = path.join(local, "Microsoft", "WindowsApps", "wt.exe");
			return c;
		}
	}
	return null;
}

/** Minimal PATH search for an executable name (case-insensitive on Windows). */
function findOnPath(name: string): string | null {
	const pathext = (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";");
	const dirs = (process.env.PATH ?? "").split(path.delimiter);
	const lower = name.toLowerCase();
	for (const dir of dirs) {
		if (!dir) continue;
		const base = path.join(dir, name);
		// Try the bare name first, then with each PATHEXT.
		if (existsCaseInsensitive(base)) return base;
		for (const ext of pathext) {
			if (ext.toLowerCase() !== lower.slice(-ext.length)) {
				const cand = `${base}${ext}`;
				if (existsCaseInsensitive(cand)) return cand;
			}
		}
	}
	return null;
}

function existsCaseInsensitive(file: string): boolean {
	try {
		// fs.existsSync is enough for our purposes; this is best-effort.
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		return require("node:fs").existsSync(file);
	} catch {
		return false;
	}
}

/**
 * Launch a new Windows Terminal tab rooted at `startDir`, running a fresh Pi
 * session in that directory. Returns true if we successfully spawned the
 * command (we cannot verify the tab actually opened).
 *
 * Strategy: `wt.exe` is an App Execution Alias (0-byte reparse point) that
 * Node `spawn` cannot resolve directly. We route it through `cmd.exe /c start`
 * so Windows resolves the alias via the OS, and tell WT to open a new tab that
 * runs `cmd /k cd /d <dir> && pi` (keeping the tab open and entering the
 * worktree). Falling back to just printing the manual command is left to the
 * caller when this returns false.
 */
/**
 * Launch a new Windows Terminal tab that opens a Bash shell rooted at
 * `startDir`, then starts a fresh Pi session there. Returns true on success
 * (best-effort; we don't verify the tab actually opened).
 *
 * Strategy (all verified by marker probes on this machine):
 * - `wt.exe` is an App Execution Alias (0-byte reparse point) Node `spawn`
 *   cannot resolve; we run through cmd.exe with a bare `start "" wt` so the
 *   OS resolves the alias via PATH.
 * - We open a Bash profile (the user's expected shell) via `-p`, override its
 *   starting directory with `--startingDirectory`, and run a dialog shell that
 *   cds into the worktree and `exec`s pi so it stays in the tab.
 * - The tab command sits after `--` and is quoted so the outer `cmd start`
 *   does not interpret its `&&`.
 */
export async function launchWindowsTerminalInDir(startDir: string): Promise<boolean> {
	if (process.platform !== "win32") return false;
	if (!wtExecutableCandidate()) return false;

	// `--startingDirectory` must use the Windows form; bash $PWD uses posix but
	// WT accepts a Windows path here (probe wrote the correct dir).
	const winDir = path.win32.normalize(startDir);
	// Rely on `--startingDirectory` to place the Bash shell in the worktree, and
	// pass a MINIMAL tab command (`bash -c "exec pi"`) with only a single layer of
	// quotes. Verified on this machine: command chains, `cd ... && pi`, and any
	// command that re-quotes with embedded quotes get mangled by `cmd start` and
	// never execute; a short `bash -c "..."` (path kept OUT of the command) runs.
	const tabCmd = `bash -c "exec pi"`;
	const full = `start \"\" wt new-tab -p \"${findBashProfile() ?? DEFAULT_BASH_PROFILE}\" --startingDirectory \"${winDir}\" -- ${tabCmd}`;

	return await new Promise<boolean>((resolve) => {
		const child = exec(full, { timeout: 15000 }, (err) => resolve(!err));
		child.unref?.();
	});
}

const BASH_PROFILES: Array<{ name: string; guid: string; commandline?: string }> = [];

// Bash profile GUID observed in this WT settings (stable on this machine);
// used as fallback when settings.json can't be read or has no bash profile.
const DEFAULT_BASH_PROFILE = "{2ece5bfe-50ed-5f3a-ab87-5cd4baafed2b}";

/**
 * Resolve the WT Bash profile GUID from the current terminal's settings.json.
 * The profile list is cached per process; returns undefined when bash isn't
 * found so we fall back to the default profile.
 */
function findBashProfile(): string | undefined {
	// Cache so we only read settings once per process.
	if (BASH_PROFILES.length === 0) {
		try {
			const settings = readWtSettings();
			const list = settings?.profiles?.list ?? [];
			const profiles = list.filter((x: { name?: string; commandline?: string }) =>
				(x.name ?? "").toLowerCase().includes("bash") ||
				(x.commandline ?? "").toLowerCase().includes("git\\bash.exe") ||
				(x.commandline ?? "").toLowerCase().includes("/bash.exe"),
			);
			BASH_PROFILES.push(...profiles.map((x: { name?: string; guid?: string; commandline?: string }) => ({
				name: x.name ?? "",
				guid: x.guid ?? "",
				commandline: x.commandline,
			})));
		} catch {
			/* ignore; fall back to default */
		}
	}
	// Prefer one whose commandline explicitly points at git bash.
	const withGit = BASH_PROFILES.find((x) => (x.commandline ?? "").includes("bash.exe"));
	return withGit?.guid || DEFAULT_BASH_PROFILE;
}

function readWtSettings(): { profiles?: { list?: Array<{ name?: string; guid?: string; commandline?: string }> } } | null {
	const base =
		process.env.LOCALAPPDATA?.replace(/\\/g, "/") +
		"/Packages/Microsoft.WindowsTerminal_8wekyb3d8bbwe/LocalState/settings.json";
	if (!base) return null;
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const fs = require("node:fs") as typeof import("node:fs");
		return JSON.parse(fs.readFileSync(base, "utf8")) as never;
	} catch {
		return null;
	}
}

/**
 * Build the shell snippet a user can paste to enter the worktree dir manually.
 */
export function manualEnterCommand(worktreeDir: string): string {
	return `cd ${shellQuote(worktreeDir)} && pi`;
}

/** Single-quote a path for shell (windows-friendly). */
function shellQuote(p: string): string {
	return `"${p.replace(/"/g, '\\"')}"`;
}