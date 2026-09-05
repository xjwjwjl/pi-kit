import { runOption, showLauncherPanel } from "../launcher/show";
import type { LauncherFeature, PanelOptionContext } from "../launcher/types";

/** Directory (relative to the workspace root) where worktrees live. */
export const WORKTREES_DIR = ".worktrees";

/**
 * Reserved contract for scheme-B worktree creation.
 *
 * Nothing in this phase executes git commands — this interface only defines
 * the seam where the real implementation will plug in later:
 *
 *   git worktree add <workspaceRoot>/.worktrees/<directoryName> <branch>
 */
export interface WorktreeCreateParams {
	/** Toplevel of the main checkout (the repo that owns .git/). */
	workspaceRoot: string;
	/** Branch the new worktree will check out. */
	branch: string;
	/** Optional start point (defaults to the current branch when omitted). */
	base?: string;
	/**
	 * Directory name under `.worktrees/`. Slashes in branch names should be
	 * flattened by the caller (e.g. feature/auth -> feat_auth).
	 */
	directoryName: string;
}

export interface WorktreeCreateResult {
	/** Absolute path of the created worktree. */
	path: string;
	branch: string;
}

/**
 * Placeholder implementation entry point.
 *
 * The future implementation belongs here and nowhere else: resolve the target
 * path under `<workspaceRoot>/.worktrees/`, validate it does not collide
 * with an existing worktree, then run `git worktree add` (plus
 * `--track`/`-b` handling) and return the created path. Also remind to add
 * `.worktrees/` to `.git/info/exclude`.
 */
export async function createWorktree(params: WorktreeCreateParams): Promise<WorktreeCreateResult> {
	void params;
	throw new Error(
		"Not implemented: worktree creation is intentionally deferred. " +
			"Implement git worktree add in src/features/worktree.ts.",
	);
}

/**
 * Worktree feature (phase 1: placeholder only).
 *
 * Declarative LauncherFeature: contributes the "Create worktree" option.
 * Selecting it opens a second, reused instance of the launcher panel that
 * previews the parameters the real implementation will collect — no git
 * command is executed yet. No global shortcut is declared at this phase
 * (the shortcuts field is intentionally omitted).
 */
export const worktreeFeature: LauncherFeature = {
	id: "worktree",
	description: "Manage git worktrees under .worktrees/",
	options: () => [
		{
			id: "worktree.create",
			label: "Create worktree",
			description: `Create a new worktree under ${WORKTREES_DIR}/ (coming soon)`,
			execute: runCreateWorktreePlaceholder,
		},
	],
};

async function runCreateWorktreePlaceholder(panelCtx: PanelOptionContext): Promise<void> {
	const { ctx, workspaceRoot } = panelCtx;
	if (!workspaceRoot) {
		ctx.ui.notify("Not inside a git workspace — cannot create a worktree.", "warning");
		return;
	}

	const notImplemented = async () => {
		ctx.ui.notify("Not implemented yet: worktree creation is planned for a later phase.", "info");
	};

	// Reuse the generic panel as a parameter-preview wizard placeholder. The
	// confirmed parameter option is executed through runOption(), the same
	// path the main launcher uses, so the interaction flow stays uniform.
	const selected = await showLauncherPanel(ctx, {
		title: "Create worktree",
		subtitle: `Target: <project>/${WORKTREES_DIR}/<name> · this flow is a placeholder`,
		options: [
			{
				id: "worktree.param.branch",
				label: "Branch",
				description: "Branch the new worktree will check out (required)",
				execute: notImplemented,
			},
			{
				id: "worktree.param.base",
				label: "Base",
				description: "Start point; defaults to the current branch",
				execute: notImplemented,
			},
			{
				id: "worktree.param.directory",
				label: "Directory name",
				description: `${WORKTREES_DIR}/<directory name>, slashes flattened`,
				execute: notImplemented,
			},
			{
				id: "worktree.back",
				label: "← Back",
				execute: () => {
					/* just close; nothing to do */
				},
			},
		],
	});
	if (selected) {
		await runOption(selected, panelCtx);
	}
}
