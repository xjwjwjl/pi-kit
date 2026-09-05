import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
	createWorktree,
	deriveBranchName,
	isLinkedWorktree,
	listWorktrees,
	manualEnterCommand,
	repoRoot,
	sanitizeBranchForPath,
	worktreePath,
} from "../src/core.ts";

const execAsync = promisify(execFile);

/** Prepare a throwaway git repo on disk. */
async function makeRepo(): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), "gwt-test-"));
	// Init and commit so worktrees are possible.
	await execAsync("git", ["init", "-b", "main", dir], { windowsHide: true });
	await execAsync("git", ["-C", dir, "config", "user.email", "t@t"], { windowsHide: true });
	await execAsync("git", ["-C", dir, "config", "user.name", "t"], { windowsHide: true });
	await writeFile(path.join(dir, "a.txt"), "hello\n");
	await execAsync("git", ["-C", dir, "add", "."], { windowsHide: true });
	await execAsync("git", ["-C", dir, "commit", "-m", "init"], { windowsHide: true });
	return dir;
}

test("deriveBranchName appends -worktree and sanitizes", () => {
	assert.equal(deriveBranchName("main"), "main-worktree");
	assert.equal(deriveBranchName("feature/foo"), "feature/foo-worktree");
});

test("sanitizeBranchForPath replaces path-unsafe chars", () => {
	assert.equal(sanitizeBranchForPath("feature/foo"), "feature-foo");
	assert.equal(sanitizeBranchForPath("a:b@c"), "a-b-c");
});

test("worktreePath follows convention <repoRoot>/.worktrees/<branch>", () => {
	// Repo at /x/pi-kit -> .worktrees/<branch> under the repo root.
	const p = worktreePath("D:/code/pi-kit", "feature/foo");
	assert.ok(p.includes(".worktrees"));
	assert.ok(p.includes("feature-foo"));
	// Must NOT contain the repo name prefix (now repo-scoped).
	assert.ok(!p.includes("pi-kit-feature"));
});

test("repoRoot returns null outside a repo", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "gwt-norepo-"));
	await rm(dir, { recursive: true, force: true });
	const root = await repoRoot(dir);
	assert.equal(root, null);
});

test("isLinkedWorktree: false in main checkout, true inside a real worktree", async () => {
	const repo = await makeRepo();
	try {
		// Main checkout (.git is a directory) must NOT be flagged as a linked
		// worktree. Regression: an earlier implementation compared an absolute
		// git-dir against a relative git-common-dir, so even the main checkout
		// was misdetected as linked.
		assert.equal(await isLinkedWorktree(repo), false);

		// Inside an actual linked worktree it must be true.
		const branch = "linked-check";
		const wtDir = worktreePath(repo, branch);
		const res = await createWorktree({ base: "main", branch, worktreeDir: wtDir, repoRootDir: repo });
		assert.equal(res.code, 0, res.stderr);
		assert.equal(await isLinkedWorktree(wtDir), true);
	} finally {
		try {
			await execAsync("git", ["-C", repo, "worktree", "remove", "--force", worktreePath(repo, "linked-check")], { windowsHide: true });
		} catch {
			/* ignore */
		}
		await rm(repo, { recursive: true, force: true });
	}
});

test("listWorktrees returns the main checkout by default", async () => {
	const repo = await makeRepo();
	try {
		const wt = await listWorktrees(repo);
		assert.ok(wt.length >= 1);
		assert.equal(wt[0].branch, "main");
	} finally {
		await rm(repo, { recursive: true, force: true });
	}
});

test("manualEnterCommand wraps the dir in quotes", () => {
	const cmd = manualEnterCommand("C:/path with space");
	assert.ok(cmd.includes('"C:/path with space"'));
});

test("create + list round-trip across a real worktree", async () => {
	const repo = await makeRepo();
	const { createWorktree } = await import("../src/core.ts");
	const branch = "feat";
	const wtDir = worktreePath(repo, branch);
	try {
		const res = await createWorktree({
			base: "main",
			branch,
			worktreeDir: wtDir,
			repoRootDir: repo,
		});
		assert.equal(res.code, 0, res.stderr);
		const listed = await listWorktrees(repo);
		assert.ok(listed.some((w) => w.branch === branch), "worktree branch listed");
	} finally {
		// Clean up the linked worktree before deleting the repo.
		try {
			await execAsync("git", ["-C", repo, "worktree", "remove", "--force", wtDir], { windowsHide: true });
		} catch {
			/* ignore */
		}
		await rm(repo, { recursive: true, force: true });
	}
});

test("worktree creation fails gracefully when branch already attached", async () => {
	const repo = await makeRepo();
	const { createWorktree } = await import("../src/core.ts");
	const branch = "dup";
	const wtDir1 = worktreePath(repo, branch);
	const res1 = await createWorktree({ base: "main", branch, worktreeDir: wtDir1, repoRootDir: repo });
	assert.equal(res1.code, 0, res1.stderr);
	try {
		// Attempt to create a second worktree on the same branch — git refuses.
		const wtDir2 = worktreePath(repo, `${branch}-alt`);
		const res2 = await createWorktree({ base: "main", branch, worktreeDir: wtDir2, repoRootDir: repo });
		assert.notEqual(res2.code, 0, "should fail: branch already checked out elsewhere");
	} finally {
		try {
			await execAsync("git", ["-C", repo, "worktree", "remove", "--force", wtDir1], { windowsHide: true });
		} catch {
			/* ignore */
		}
		await rm(repo, { recursive: true, force: true });
	}
});