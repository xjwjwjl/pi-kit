/**
 * git-worktree — create a git worktree and optionally launch a fresh Pi session
 * inside a Windows Terminal tab rooted at that worktree.
 *
 * Commands:
 *   /worktree <branch>   Create a worktree on <branch>, then offer to open it in a new WT tab.
 *   /worktree --list     List existing worktrees of the current repo.
 *
 * A branch/worktree name is required: `/worktree` with no args is rejected.
 *
 * Convention: `<repoRoot>/.worktrees/<branch>`, branch path-unsafe
 * chars replaced with `-`. Mirrors the `git-worktree` skill so both stay in sync.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import {
	createWorktree,
	isLinkedWorktree,
	isWorkingTreeDirty,
	launchWindowsTerminalInDir,
	listWorktrees,
	manualEnterCommand,
	repoRoot,
	resolveBase,
	worktreePath,
} from "./src/core.ts";

export default function gitWorktreeExtension(pi: ExtensionAPI) {
	pi.registerCommand("worktree", {
		description:
			"Create a git worktree on a required branch name and optionally open a fresh Pi session inside it.\nUsage: /worktree <branch> — the branch/worktree name is required.\nList: /worktree --list",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			// The list subcommand uses a flag form (`--list` / `-l`) so a bare
			// branch named `list` is NOT captured as the list command —
			// `/worktree list` now creates a branch literally named `list`.
			if (trimmed === "--list" || trimmed === "-l") {
				await handleList(ctx);
				return;
			}
			if (!trimmed) {
				ctx.ui.notify(
					"git-worktree: missing branch/worktree name — /worktree <branch> (see --list)",
				"warning",
			);
				return;
			}
			await handleCreate(trimmed, ctx);
		},
	});

	async function handleList(
		ctx: ExtensionArgsContext,
	): Promise<void> {
		const root = await repoRoot(ctx.cwd);
		if (!root) {
			ctx.ui.notify("git-worktree: not inside a git repository", "error");
			return;
		}
		const wt = await listWorktrees(ctx.cwd);
		if (wt.length === 0) {
			ctx.ui.notify("git-worktree: no worktrees in this repository", "info");
			return;
		}
		const lines = wt.map((w) => `${w.path}  (${w.branch})`).join("\n");
		ctx.ui.notify(`git-worktree: ${wt.length} worktree(s):\n${lines}`, "info");
	}

	async function handleCreate(
		branchArg: string,
		ctx: ExtensionArgsContext,
	): Promise<void> {
		// 1. Verify we're in a repo.
		const root = await repoRoot(ctx.cwd);
		if (!root) {
			ctx.ui.notify("git-worktree: not inside a git repository — aborting", "error");
			return;
		}

		// 2. Warn/confirm when already inside a linked worktree.
		const alreadyLinked = await isLinkedWorktree(ctx.cwd);
		if (alreadyLinked) {
			const ok = await ctx.ui.confirm(
				"git-worktree",
				"You're inside a worktree. Creating one from inside it is unusual. Create here anyway?",
			);
			if (!ok) return;
		}

		// 3. Determine base and branch. A name is always supplied, so `branch`
		//    is never derived; the base is the current branch, or HEAD when on a
		//    detached HEAD.
		const base = (await resolveBase(root)) ?? "HEAD";
		let branch = branchArg;

		// 4. Record dirty state; it is surfaced in the preview dialog title rather
		//    than as a separate confirm, keeping the whole flow to ONE dialog
		//    (avoids focus-flash on chained dialogs). Selecting a Create option
		//    implicitly confirms proceeding despite uncommitted changes.
		const dirty = await isWorkingTreeDirty(root);

		// 5. Compute the worktree path.
		let wtDir = worktreePath(root, branch);
		let wantOpen = true;

		// 6. Preview loop before creating: let the user create (+ optionally open
		//    in WT), rename (re-derive branch + path), or cancel. Doing the
		//    open decision here (instead of a second post-create dialog) keeps
		//    the whole flow to a single dialog, avoiding focus-flash on chained
		//    dialogs.
		while (true) {
			const title = dirty
				? `git-worktree · Create worktree \`${branch}\` with uncommitted changes?`
				: `git-worktree · Create worktree \`${branch}\`?`;
			const choice = await ctx.ui.select(title, [
				"Create & open in WT",
				"Create only",
				"Rename",
				"Cancel",
			]);
			if (!choice || choice.startsWith("Cancel")) return;
			if (choice.startsWith("Create & open")) {
				wantOpen = true;
				break;
			}
			if (choice.startsWith("Create only")) {
				wantOpen = false;
				break;
			}

			// Rename: re-ask for the branch name, then re-preview with the new
			// branch and recomputed path.
			const newBranch = await ctx.ui.input(
				"git-worktree · Worktree branch name?",
				branch,
			);
			if (!newBranch || !newBranch.trim()) return;
			branch = newBranch.trim();
			wtDir = worktreePath(root, branch);
		}

		// 7. Create.
		const res = await createWorktree({
			base: base ?? branch,
			branch,
			worktreeDir: wtDir,
			repoRootDir: root,
		});
		if (res.code !== 0) {
			const reason = res.stderr.trim() || res.stdout.trim() || `git exit ${res.code}`;
			ctx.ui.notify(`git-worktree: failed to create worktree — ${reason}`, "error");
			return;
		}

		// 8. Success. Report and open (if requested) via non-blocking notify so no
		//    second dialog flashes the interface.
		const rel = path.relative(ctx.cwd, wtDir) || wtDir;
		ctx.ui.notify(`git-worktree: created worktree \`${rel}\` on branch \`${branch}\``, "info");

		if (wantOpen) {
			const launched = await launchWindowsTerminalInDir(wtDir);
			if (!launched) {
				ctx.ui.notify(
					`git-worktree: could not auto-open Windows Terminal. Run manually:\n${manualEnterCommand(wtDir)}`,
					"warning",
				);
			} else {
				ctx.ui.notify(
					`git-worktree: opened ${wtDir} in a new WT tab. A fresh Pi session will start there.`,
					"info",
				);
			}
		} else {
			ctx.ui.notify(
				`To work in it: ${manualEnterCommand(wtDir)}\n\nNote: the worktree branch is \`${branch}\`.`,
				"info",
			);
		}
	}
}

/** Minimal alias so command handlers type-check cleanly with ctx.ui. */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
type ExtensionArgsContext = ExtensionCommandContext;