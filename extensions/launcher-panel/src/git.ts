import { statSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Detected Git workspace information.
 */
export interface GitWorkspaceInfo {
	/** Toplevel of the git working tree (the directory that contains `.git`). */
	root: string;
	/** Absolute path of the `.git` entry. */
	gitPath: string;
	/**
	 * True when `.git` is a *file* instead of a directory, which means
	 * `startDir` is inside a linked worktree rather than the main checkout.
	 */
	isLinkedWorktree: boolean;
}

/**
 * Walk up from `startDir` looking for a `.git` entry.
 *
 * Returns null when the directory is not inside a git working tree, which is
 * the condition under which the launcher panel must NOT auto-open.
 */
export function findGitWorkspace(startDir: string): GitWorkspaceInfo | null {
	let dir = startDir;
	for (;;) {
		const gitPath = join(dir, ".git");
		try {
			const stat = statSync(gitPath);
			if (stat.isDirectory() || stat.isFile()) {
				return { root: dir, gitPath, isLinkedWorktree: stat.isFile() };
			}
		} catch {
			// No .git here, keep walking up.
		}
		const parent = dirname(dir);
		if (parent === dir) return null; // reached filesystem root
		dir = parent;
	}
}
