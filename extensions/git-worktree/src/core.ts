/**
 * git-worktree core — pure-ish helpers for creating worktrees and launching a
 * fresh Pi session inside a Windows Terminal (WT) tab rooted at that worktree.
 *
 * Kept free of any `ExtensionAPI` dependency so it can be unit-tested.
 */

import { exec, execFile } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import { promisify } from "node:util";
import { homedir } from "node:os";
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

/** Return a Git error message when `branch` is not a valid local branch name. */
export async function validateBranchName(cwd: string, branch: string): Promise<string | null> {
	const res = await runGit(["check-ref-format", "--branch", branch], cwd);
	if (res.code === 0) return null;
	return res.stderr.trim() || res.stdout.trim() || "invalid Git branch name";
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
 * The Pi home directory (`~/.pi` by default).
 *
 * Pi's config dir is `<piHome>/agent` and can be relocated with
 * `PI_CODING_AGENT_DIR`, so honour that variable and use its PARENT as the Pi
 * home — worktrees then live beside the config dir, not inside it.
 */
export function piHomeDir(): string {
	const configured = process.env.PI_CODING_AGENT_DIR?.trim();
	if (configured) {
		const agentDir = path.resolve(configured);
		const parent = path.dirname(agentDir);
		return parent === agentDir ? agentDir : parent;
	}
	return path.join(homedir(), ".pi");
}

/** `<piHome>/worktrees` — where every worktree this extension creates lands. */
export function worktreesRootDir(): string {
	return path.join(piHomeDir(), "worktrees");
}

/**
 * Resolve the worktree directory for a branch:
 * `<piHome>/worktrees/<repoNameSanitized>/<branchSanitized>`.
 *
 * Worktrees live OUTSIDE the repo so they never pollute the working tree (no
 * `.gitignore` entry needed). The repo name keeps same-named branches of
 * different repos from colliding on one path.
 */
export function worktreePath(repoRootDir: string, branch: string): string {
	const repoName = path.basename(path.resolve(repoRootDir));
	return path.join(
		worktreesRootDir(),
		sanitizeBranchForPath(repoName),
		sanitizeBranchForPath(branch),
	);
}

/** Collapse the home prefix to `~` for friendlier notices. */
export function displayPath(target: string, home = homedir()): string {
	const rel = path.relative(home, target);
	if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return target;
	return path.join("~", rel);
}

/** Information about a worktree reported by `git worktree list --porcelain`. */
export interface WorktreeInfo {
	path: string;
	branch: string;
	/** Git marked the entry as stale and safe for `git worktree prune`. */
	prunable: boolean;
	/** Git marked the entry as locked; pruning should not remove it. */
	locked: boolean;
}

/** List existing worktrees, including stale/locked metadata markers. */
export async function listWorktrees(cwd: string): Promise<WorktreeInfo[]> {
	const res = await runGit(["worktree", "list", "--porcelain"], cwd);
	if (res.code !== 0) return [];
	const out: WorktreeInfo[] = [];
	let current: Partial<WorktreeInfo> = {};
	const flush = () => {
		if (!current.path) return;
		out.push({
			path: current.path,
			branch: current.branch ?? "(detached)",
			prunable: current.prunable ?? false,
			locked: current.locked ?? false,
		});
		current = {};
	};

	for (const line of res.stdout.split(/\r?\n/)) {
		if (line.startsWith("worktree ")) {
			flush();
			current.path = decodeWorktreeLine(line);
		} else if (line.startsWith("branch ")) {
			const ref = line.slice("branch ".length).trim();
			current.branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
		} else if (line === "prunable" || line.startsWith("prunable ")) {
			current.prunable = true;
		} else if (line === "locked" || line.startsWith("locked ")) {
			current.locked = true;
		}
	}
	flush();
	return out;
}

/** Inspect whether a target path is free, a valid worktree root, or occupied. */
export async function inspectWorktreePath(
	target: string,
): Promise<"missing" | "worktree" | "occupied"> {
	try {
		await access(target);
	} catch {
		return "missing";
	}

	const root = await repoRoot(target);
	if (!root) return "occupied";
	return samePath(root, target) ? "worktree" : "occupied";
}

/** Remove stale worktree metadata reported by Git as prunable. */
export async function pruneWorktrees(cwd: string): Promise<GitResult> {
	return runGit(["worktree", "prune"], cwd);
}

function samePath(left: string, right: string): boolean {
	const normalizedLeft = path.normalize(path.resolve(left));
	const normalizedRight = path.normalize(path.resolve(right));
	return process.platform === "win32"
		? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
		: normalizedLeft === normalizedRight;
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
	// Worktrees now live outside the repo, so `git worktree add` may need the
	// whole path chain created first (git only creates the leaf directory).
	await mkdir(path.dirname(worktreeDir), { recursive: true });
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

/** Result of requesting a new Windows Terminal tab. */
export type WindowsTerminalLaunchResult =
	| { status: "requested" }
	| { status: "unavailable"; reason: string }
	| { status: "failed"; reason: string };

/**
 * Request a new Windows Terminal tab that opens a Bash shell rooted at
 * `startDir`, then starts a fresh Pi session there.
 *
 * `requested` means the launch command was accepted by the local command
 * launcher; this function cannot verify that the tab became visible or that Pi
 * finished starting inside it.
 *
 * Strategy:
 * - `wt.exe` is an App Execution Alias (0-byte reparse point) Node `spawn`
 *   cannot resolve directly; route through `cmd.exe /c start`.
 * - Open the user's Bash profile with `--startingDirectory`, then run the
 *   minimal `bash -c "exec pi"` command so the path is not re-quoted by `cmd`.
 */
export async function launchWindowsTerminalInDir(
	startDir: string,
): Promise<WindowsTerminalLaunchResult> {
	if (process.platform !== "win32") {
		return {
			status: "unavailable",
			reason: "automatic Windows Terminal launch is only supported on Windows",
		};
	}
	if (!wtExecutableCandidate()) {
		return {
			status: "unavailable",
			reason: "wt.exe is unavailable or the current process is not running inside Windows Terminal",
		};
	}

	// `--startingDirectory` must use the Windows form; Bash $PWD uses POSIX but
	// WT accepts a Windows path here (probe verified this behavior).
	const winDir = path.win32.normalize(startDir);
	const tabCmd = `bash -c "exec pi"`;
	const full = `start \"\" wt new-tab -p \"${findBashProfile() ?? DEFAULT_BASH_PROFILE}\" --startingDirectory \"${winDir}\" -- ${tabCmd}`;

	return await new Promise<WindowsTerminalLaunchResult>((resolve) => {
		const child = exec(full, { timeout: 15000 }, (err) => {
			if (err) {
				resolve({ status: "failed", reason: err.message || String(err) });
				return;
			}
			resolve({ status: "requested" });
		});
		child.unref?.();
	});
}

const BASH_PROFILES: WtProfile[] = [];

/** Subset of a Windows Terminal profile we care about. */
export interface WtProfile {
	name?: string;
	guid?: string;
	commandline?: string;
	/** WT dynamic-profile source, e.g. `Git` for the generated git-bash profile. */
	source?: string;
	hidden?: boolean;
}

// Bash profile GUID observed in this WT settings (stable on this machine);
// used as fallback when settings.json can't be read or has no bash profile.
const DEFAULT_BASH_PROFILE = "{2ece5bfe-50ed-5f3a-ab87-5cd4baafed2b}";

/** True when a profile looks like a Bash/Git-Bash profile. */
export function isBashProfile(p: WtProfile): boolean {
	const name = (p.name ?? "").toLowerCase();
	const cmd = (p.commandline ?? "").toLowerCase();
	return (
		name.includes("bash") ||
		p.source === "Git" ||
		cmd.includes("bash.exe")
	);
}

/** Leading executable of a WT profile commandline, when one is named. */
export function profileExecutable(commandline: string | undefined): string | null {
	if (!commandline) return null;
	// `"C:\Program Files\Git\bin\bash.exe" --login -i` or `C:\...\bash.exe -i`
	const m = /^\s*"([^"]+)"|^\s*([^\s"]+)/.exec(commandline);
	const raw = (m?.[1] ?? m?.[2] ?? "").trim();
	return raw || null;
}

/** Only path-shaped executables can be existence-checked; bare names come from PATH. */
function isPathShaped(exe: string): boolean {
	return /[\\/]/.test(exe) || /^[A-Za-z]:/.test(exe);
}

/**
 * Pick the WT profile to launch Bash in.
 *
 * Broken profiles are skipped: a profile whose `commandline` names a path that
 * no longer exists kills every pane that re-runs it (`split`/`duplicate pane`
 * fails with 0x80070002 — a stale profile left behind by an uninstalled/
 * relocated Git is the usual culprit). Visible profiles win over hidden ones,
 * and WT's generated `source: "Git"` profile wins over hand-rolled entries.
 */
export function pickBashProfile(
	profiles: WtProfile[],
	exists: (p: string) => boolean,
	defaultGuid: string,
): string {
	const viable = profiles.filter(isBashProfile).filter((p) => {
		const exe = profileExecutable(p.commandline);
		return !exe || !isPathShaped(exe) || exists(exe);
	});
	const pick =
		viable.find((p) => !p.hidden && p.source === "Git") ??
		viable.find((p) => !p.hidden) ??
		viable.find((p) => p.guid === defaultGuid) ??
		viable[0];
	return pick?.guid || defaultGuid;
}

/**
 * Resolve the WT Bash profile GUID from the current terminal's settings.json.
 * The profile list is cached per process; falls back to the default profile
 * when settings can't be read or contain no usable bash profile.
 */
function findBashProfile(): string | undefined {
	// Cache so we only read settings once per process.
	if (BASH_PROFILES.length === 0) {
		try {
			const settings = readWtSettings();
			const list = settings?.profiles?.list ?? [];
			BASH_PROFILES.push(...list.filter(isBashProfile));
		} catch {
			/* ignore; fall back to default */
		}
	}
	return pickBashProfile(BASH_PROFILES, pathExists, DEFAULT_BASH_PROFILE);
}

function pathExists(p: string): boolean {
	try {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		return (require("node:fs") as typeof import("node:fs")).existsSync(p);
	} catch {
		return false;
	}
}

function readWtSettings(): { profiles?: { list?: WtProfile[] } } | null {
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