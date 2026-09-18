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
	displayPath,
	inspectWorktreePath,
	isBashProfile,
	isLinkedWorktree,
	listWorktrees,
	manualEnterCommand,
	piHomeDir,
	pickBashProfile,
	profileExecutable,
	pruneWorktrees,
	repoRoot,
	sanitizeBranchForPath,
	validateBranchName,
	worktreePath,
} from "../src/core.ts";

const execAsync = promisify(execFile);

// Keep test-created worktrees out of the real Pi home: point the config dir at a
// throwaway location (`piHomeDir` reads the variable at call time).
process.env.PI_CODING_AGENT_DIR = await mkdtemp(path.join(tmpdir(), "gwt-agent-"));

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

test("validateBranchName accepts valid names and rejects invalid names", async () => {
	const repo = await makeRepo();
	try {
		assert.equal(await validateBranchName(repo, "feature/foo"), null);
		const invalid = await validateBranchName(repo, "bad..name");
		assert.ok(invalid);
		assert.match(invalid, /invalid|not a valid/i);
	} finally {
		await rm(repo, { recursive: true, force: true });
	}
});

test("worktreePath lands under the Pi home, repo-scoped", () => {
	const p = worktreePath("D:/code/pi-kit", "feature/foo");
	assert.ok(p.startsWith(path.join(piHomeDir(), "worktrees")));
	// Repo name and sanitized branch are both part of the path.
	assert.ok(p.endsWith(path.join("pi-kit", "feature-foo")));
	// Must NOT live inside the repo anymore.
	assert.ok(!p.startsWith(path.resolve("D:/code/pi-kit")));
});

test("piHomeDir honours PI_CODING_AGENT_DIR's parent", () => {
	const prev = process.env.PI_CODING_AGENT_DIR;
	try {
		process.env.PI_CODING_AGENT_DIR = path.join("D:", "cfg", ".pi", "agent");
		assert.equal(piHomeDir(), path.resolve(path.join("D:", "cfg", ".pi")));
	} finally {
		if (prev === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = prev;
	}
});

test("displayPath collapses the home prefix", () => {
	const home = path.join("C:", "Users", "admin");
	assert.equal(displayPath(path.join(home, ".pi", "worktrees"), home), path.join("~", ".pi", "worktrees"));
	assert.equal(displayPath(path.join("D:", "other"), home), path.join("D:", "other"));
});

test("repoRoot returns null outside a repo", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "gwt-norepo-"));
	await rm(dir, { recursive: true, force: true });
	const root = await repoRoot(dir);
	assert.equal(root, null);
});

test("inspectWorktreePath distinguishes missing, occupied, and worktree roots", async () => {
	const repo = await makeRepo();
	const occupied = await mkdtemp(path.join(tmpdir(), "gwt-occupied-"));
	try {
		assert.equal(await inspectWorktreePath(repo), "worktree");
		assert.equal(await inspectWorktreePath(occupied), "occupied");
		assert.equal(await inspectWorktreePath(path.join(occupied, "missing")), "missing");
	} finally {
		await rm(repo, { recursive: true, force: true });
		await rm(occupied, { recursive: true, force: true });
	}
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

test("profileExecutable extracts the leading exe", () => {
	assert.equal(
		profileExecutable('"C:\\Program Files\\Git\\bin\\bash.exe" --login -i'),
		"C:\\Program Files\\Git\\bin\\bash.exe",
	);
	assert.equal(profileExecutable("C:\\scoop\\apps\\git\\current\\bin\\bash.exe"), "C:\\scoop\\apps\\git\\current\\bin\\bash.exe");
	assert.equal(profileExecutable(undefined), null);
});

test("pickBashProfile skips profiles whose exe is gone", () => {
	// Regression: a stale hidden profile left by an uninstalled scoop Git used to
	// win the pick, so every split/duplicate pane died with 0x80070002.
	const stale = {
		name: "Bash",
		guid: "{stale}",
		commandline: "C:\\Users\\admin\\scoop\\apps\\git\\current\\bin\\bash.exe",
		hidden: true,
	};
	const git = { name: "Bash", guid: "{git}", source: "Git" };
	const exists = (p: string) => !p.includes("scoop");

	assert.equal(pickBashProfile([stale, git], exists, "{default}"), "{git}");
	// Nothing viable → constant fallback, never the broken guid.
	assert.equal(pickBashProfile([stale], exists, "{default}"), "{default}");
	// A hand-rolled visible profile beats the constant when no Git profile exists.
	const custom = { name: "Bash", guid: "{custom}", commandline: '"C:\\Program Files\\Git\\bin\\bash.exe" -i' };
	assert.equal(pickBashProfile([stale, custom], exists, "{default}"), "{custom}");
});

test("isBashProfile matches on name, source, and commandline", () => {
	assert.equal(isBashProfile({ name: "Bash" }), true);
	assert.equal(isBashProfile({ source: "Git" }), true);
	assert.equal(isBashProfile({ commandline: "C:\\tools\\bash.exe" }), true);
	assert.equal(isBashProfile({ name: "PowerShell" }), false);
});

test("listWorktrees marks stale entries and prune removes metadata", async () => {
	const repo = await makeRepo();
	const branch = "stale";
	const wtDir = worktreePath(repo, branch);
	const created = await createWorktree({
		base: "main",
		branch,
		worktreeDir: wtDir,
		repoRootDir: repo,
	});
	assert.equal(created.code, 0, created.stderr);
	try {
		await rm(wtDir, { recursive: true, force: true });
		const stale = (await listWorktrees(repo)).find((worktree) => worktree.branch === branch);
		assert.ok(stale, "stale worktree remains in Git metadata");
		assert.equal(stale?.prunable, true);

		const pruned = await pruneWorktrees(repo);
		assert.equal(pruned.code, 0, pruned.stderr);
		assert.equal(
			(await listWorktrees(repo)).some((worktree) => worktree.branch === branch),
			false,
		);
	} finally {
		try {
			await pruneWorktrees(repo);
		} catch {
			/* ignore cleanup errors */
		}
		await rm(repo, { recursive: true, force: true });
	}
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