/**
 * git-worktree — create a git worktree and optionally launch a fresh Pi session
 * inside a Windows Terminal tab rooted at that worktree.
 *
 * Commands:
 *   /worktree            Choose an existing worktree or create a new one.
 *   /worktree <branch>   Create a worktree on <branch>, then offer to open it in a new WT tab.
 *
 * With no arguments, `/worktree` shows existing worktrees plus a create option.
 *
 * Convention: `<piHome>/worktrees/<repo>/<branch>` — `piHome` is `~/.pi`
 * (or the parent of `PI_CODING_AGENT_DIR` when set); repo/branch path-unsafe
 * chars replaced with `-`. Worktrees stay outside the repo, so no
 * `.gitignore` entry is needed.
 */

import path from "node:path";
import { BorderedLoader, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createWorktree,
	deriveBranchName,
	displayPath,
	isLinkedWorktree,
	isWorkingTreeDirty,
	launchWindowsTerminalInDir,
	inspectWorktreePath,
	listWorktrees,
	manualEnterCommand,
	pruneWorktrees,
	repoRoot,
	resolveBase,
	type WindowsTerminalLaunchResult,
	validateBranchName,
	worktreePath,
} from "./src/core.ts";

export interface GitWorktreeExtensionDependencies {
	launchWindowsTerminalInDir?: typeof launchWindowsTerminalInDir;
}

export default function gitWorktreeExtension(
	pi: ExtensionAPI,
	dependencies: GitWorktreeExtensionDependencies = {},
) {
	const launchWindowsTerminal =
		dependencies.launchWindowsTerminalInDir ?? launchWindowsTerminalInDir;

	pi.registerCommand("worktree", {
		description:
			"Choose an existing worktree or create one when no branch is provided.\nUsage: /worktree — choose or create a worktree\n       /worktree <branch> — create a new worktree",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (!trimmed) {
				await handleChooseWorktree(ctx);
				return;
			}
			await handleCreate(trimmed, ctx);
		},
	});

	async function handleChooseWorktree(
		ctx: ExtensionArgsContext,
	): Promise<void> {
		const root = await repoRoot(ctx.cwd);
		if (!root) {
			ctx.ui.notify("git-worktree: not inside a git repository", "error");
			return;
		}

		const worktrees = await listWorktrees(ctx.cwd);
		const liveWorktrees = worktrees.filter((worktree) => !worktree.prunable);
		const staleWorktrees = worktrees.filter((worktree) => worktree.prunable);
		const createChoice = "Create new worktree...";
		const pruneChoice = staleWorktrees.length > 0 ? "Prune stale worktrees..." : undefined;
		const choices = [
			...liveWorktrees.map((worktree) => worktreeLabel(worktree, root)),
			createChoice,
			...(pruneChoice ? [pruneChoice] : []),
		];
		const selected = await ctx.ui.select(
			"git-worktree · Open or create worktree",
			choices,
		);
		if (!selected) return;

		if (selected === createChoice) {
			const defaultBranch = deriveBranchName((await resolveBase(root)) ?? "");
			const branch = await promptBranch(ctx, root, defaultBranch);
			if (!branch) return;
			await handleCreate(branch, ctx);
			return;
		}
		if (selected === pruneChoice) {
			await pruneStaleWorktrees(ctx, staleWorktrees.length);
			return;
		}

		const selectedIndex = liveWorktrees.findIndex(
			(worktree) => worktreeLabel(worktree, root) === selected,
		);
		const worktree = liveWorktrees[selectedIndex];
		if (!worktree) return;

		await openWorktree(ctx, worktree);
	}

	async function openWorktree(
		ctx: ExtensionArgsContext,
		worktree: { path: string; branch: string },
	): Promise<void> {
		const outcome = await runWithSpinner(
			ctx,
			`Opening worktree \`${worktree.branch}\` in Windows Terminal...`,
			() => launchWindowsTerminal(worktree.path),
		);
		if ("error" in outcome) {
			ctx.ui.notify(
				`git-worktree: failed to open Windows Terminal — ${formatError(outcome.error)}`,
				"error",
			);
			return;
		}

		const launch = outcome.value;
		if (launch.status !== "requested") {
			ctx.ui.notify(
				`git-worktree: could not request Windows Terminal launch — ${launch.reason}\nRun manually:\n${manualEnterCommand(worktree.path)}`,
				"warning",
			);
		} else {
			ctx.ui.notify(
				`git-worktree: Windows Terminal launch requested for ${worktree.path}. A fresh Pi session should start there.`,
				"info",
			);
		}
	}

	async function pruneStaleWorktrees(
		ctx: ExtensionArgsContext,
		count: number,
	): Promise<void> {
		const confirmed = await ctx.ui.confirm(
			"git-worktree · Prune stale metadata",
			`Remove ${count} stale worktree entr${count === 1 ? "y" : "ies"} from Git?`,
		);
		if (!confirmed) return;

		const outcome = await runWithSpinner(
			ctx,
			`Pruning ${count} stale worktree entr${count === 1 ? "y" : "ies"}...`,
			() => pruneWorktrees(ctx.cwd),
		);
		if ("error" in outcome) {
			ctx.ui.notify(
				`git-worktree: failed to prune stale metadata — ${formatError(outcome.error)}`,
				"error",
			);
			return;
		}

		if (outcome.value.code !== 0) {
			const reason = outcome.value.stderr.trim() || outcome.value.stdout.trim() || `git exit ${outcome.value.code}`;
			ctx.ui.notify(`git-worktree: failed to prune stale metadata — ${reason}`, "error");
			return;
		}
		ctx.ui.notify(`git-worktree: pruned ${count} stale worktree entr${count === 1 ? "y" : "ies"}`, "info");
	}

	async function promptBranch(
		ctx: ExtensionArgsContext,
		cwd: string,
		current: string,
	): Promise<string | null> {
		let placeholder = current;
		while (true) {
			const branch = await ctx.ui.input(
				"git-worktree · Worktree branch name?",
				placeholder,
			);
			if (branch === undefined) return null;

			const trimmed = branch.trim() || placeholder.trim();
			if (!trimmed) return null;

			const error = await validateBranchName(cwd, trimmed);
			if (!error) return trimmed;

			ctx.ui.notify(
				`git-worktree: invalid branch name \`${trimmed}\` — ${error}`,
				"error",
			);
			placeholder = trimmed;
		}
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

		const branchError = await validateBranchName(root, branchArg);
		if (branchError) {
			ctx.ui.notify(
				`git-worktree: invalid branch name \`${branchArg}\` — ${branchError}`,
				"error",
			);
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

		// 4. Record dirty state; surface it in the preview dialog title rather
		//    than as a separate confirm to avoid focus-flash on chained dialogs.
		//    Selecting a Create option implicitly confirms proceeding despite
		//    uncommitted changes.
		const dirty = await isWorkingTreeDirty(root);

		// 5. Compute the worktree path.
		let wtDir = worktreePath(root, branch);
		let wantOpen = true;

		// 6. Preview loop before creating: let the user create (+ optionally open
		//    in WT), rename (re-derive branch + path), or cancel. Keeping the open
		//    decision here avoids a second post-create dialog and focus-flash.
		while (true) {
			const worktrees = await listWorktrees(root);
			const attached = worktrees.find((worktree) => worktree.branch === branch);
			if (attached) {
				if (attached.prunable) {
					const staleChoice = await ctx.ui.select(
						`git-worktree · Branch \`${branch}\` has stale metadata`,
						[
							`Prune stale: ${displayPath(attached.path)}`,
							"Choose another branch",
							"Cancel",
						],
					);
					if (!staleChoice || staleChoice.startsWith("Cancel")) return;
					if (staleChoice.startsWith("Prune stale")) {
						await pruneStaleWorktrees(ctx, 1);
						continue;
					}
				} else {
					const conflictChoice = await ctx.ui.select(
						`git-worktree · Branch \`${branch}\` is already attached`,
						[
							`Open existing: ${worktreeLabel(attached, root)}`,
							"Choose another branch",
							"Cancel",
						],
					);
					if (!conflictChoice || conflictChoice.startsWith("Cancel")) return;
					if (conflictChoice.startsWith("Open existing")) {
						await openWorktree(ctx, attached);
						return;
					}
				}

				const newBranch = await promptBranch(ctx, root, branch);
				if (!newBranch) return;
				branch = newBranch;
				wtDir = worktreePath(root, branch);
				continue;
			}

			const registeredAtTarget = worktrees.find((worktree) => samePath(worktree.path, wtDir));
			if (registeredAtTarget?.prunable) {
				const stalePathChoice = await ctx.ui.select(
					`git-worktree · Target path has stale metadata`,
					[
						`Prune stale: ${displayPath(registeredAtTarget.path)}`,
						"Choose another branch",
						"Cancel",
					],
				);
				if (!stalePathChoice || stalePathChoice.startsWith("Cancel")) return;
				if (stalePathChoice.startsWith("Prune stale")) {
					await pruneStaleWorktrees(ctx, 1);
					continue;
				}

				const newBranch = await promptBranch(ctx, root, branch);
				if (!newBranch) return;
				branch = newBranch;
				wtDir = worktreePath(root, branch);
				continue;
			}

			const pathState = await inspectWorktreePath(wtDir);
			if (pathState !== "missing") {
				const existing =
					pathState === "worktree"
						? worktrees.find((worktree) => !worktree.prunable && samePath(worktree.path, wtDir))
						: undefined;
				const pathChoice = await ctx.ui.select(
					existing
						? `git-worktree · Target path already contains a worktree`
						: `git-worktree · Target path already exists`,
					existing
						? [
								`Open existing: ${worktreeLabel(existing, root)}`,
								"Choose another branch",
								"Cancel",
						  ]
						: ["Choose another branch", "Cancel"],
				);
				if (!pathChoice || pathChoice.startsWith("Cancel")) return;
				if (existing && pathChoice.startsWith("Open existing")) {
					await openWorktree(ctx, existing);
					return;
				}
				if (!pathChoice.startsWith("Choose another")) return;

				const newBranch = await promptBranch(ctx, root, branch);
				if (!newBranch) return;
				branch = newBranch;
				wtDir = worktreePath(root, branch);
				continue;
			}

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
			const newBranch = await promptBranch(ctx, root, branch);
			if (!newBranch) return;
			branch = newBranch;
			wtDir = worktreePath(root, branch);
		}

		// 7. Create and, when requested, open the new worktree under one visible
		//    loader so the current session stays responsive throughout the flow.
		const outcome = await runWithSpinner(
			ctx,
			wantOpen
				? `Creating worktree \`${branch}\` and opening Windows Terminal...`
				: `Creating worktree \`${branch}\`...`,
			async () => {
				const res = await createWorktree({
					base: base ?? branch,
					branch,
					worktreeDir: wtDir,
					repoRootDir: root,
				});
				if (res.code !== 0 || !wantOpen) return { res, launch: null };
				return {
					res,
					launch: await launchWindowsTerminal(wtDir),
				};
			},
		);
		if ("error" in outcome) {
			ctx.ui.notify(
				`git-worktree: operation failed — ${formatError(outcome.error)}`,
				"error",
			);
			return;
		}

		const { res, launch } = outcome.value;
		if (res.code !== 0) {
			const reason = res.stderr.trim() || res.stdout.trim() || `git exit ${res.code}`;
			ctx.ui.notify(`git-worktree: failed to create worktree — ${reason}`, "error");
			return;
		}

		const createdMessage =
			`git-worktree: created worktree \`${displayPath(wtDir)}\` on branch \`${branch}\``;
		if (!wantOpen) {
			ctx.ui.notify(
				`${createdMessage}\nTo work in it: ${manualEnterCommand(wtDir)}`,
				"info",
			);
			return;
		}

		if (!launch || launch.status !== "requested") {
			const reason = launch ? `\nReason: ${launch.reason}` : "";
			ctx.ui.notify(
				`${createdMessage}\nWindows Terminal could not be opened automatically.${reason}\nRun manually:\n${manualEnterCommand(wtDir)}`,
				"warning",
			);
			return;
		}

		ctx.ui.notify(
			`${createdMessage}\nWindows Terminal launch requested; a fresh Pi session should start there.`,
			"info",
		);
	}
}

type SpinnerOutcome<T> =
	| { value: T }
	| { error: unknown };

async function runWithSpinner<T>(
	ctx: ExtensionArgsContext,
	message: string,
	task: () => Promise<T>,
): Promise<SpinnerOutcome<T>> {
	const run = async (): Promise<SpinnerOutcome<T>> => {
		try {
			return { value: await task() };
		} catch (error) {
			return { error };
		}
	};

	if (ctx.mode !== "tui") return run();

	return await ctx.ui.custom<SpinnerOutcome<T>>((tui, theme, _keybindings, done) => {
		const loader = new BorderedLoader(tui, theme, message, { cancellable: false });
		void task().then(
			(value) => done({ value }),
			(error) => done({ error }),
		);
		return loader;
	});
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function worktreeLabel(
	worktree: { path: string; branch: string; locked?: boolean },
	currentRoot: string,
): string {
	const markers = [
		samePath(worktree.path, currentRoot) ? "[current]" : "",
		worktree.locked ? "[locked]" : "",
	].filter(Boolean);
	const suffix = markers.length > 0 ? `  ${markers.join(" ")}` : "";
	return `${displayPath(worktree.path)}  (${worktree.branch})${suffix}`;
}

function samePath(left: string, right: string): boolean {
	const normalizedLeft = path.normalize(path.resolve(left));
	const normalizedRight = path.normalize(path.resolve(right));
	return process.platform === "win32"
		? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
		: normalizedLeft === normalizedRight;
}

/** Minimal alias so command handlers type-check cleanly with ctx.ui. */
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
type ExtensionArgsContext = ExtensionCommandContext;