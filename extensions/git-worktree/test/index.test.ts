import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";
import gitWorktreeExtension from "../index.ts";
import {
	createWorktree,
	listWorktrees,
	pruneWorktrees,
	type WindowsTerminalLaunchResult,
	worktreePath,
} from "../src/core.ts";

const execAsync = promisify(execFile);

type Command = {
	handler: (args: string, ctx: TestContext) => Promise<void>;
};

type Launcher = (worktreePath: string) => Promise<WindowsTerminalLaunchResult>;

type HarnessOptions = {
	confirm?: TestContext["ui"]["confirm"];
	input?: TestContext["ui"]["input"];
	launch?: Launcher;
};

type TestContext = {
	cwd: string;
	mode: "print";
	hasUI: true;
	ui: {
		select: (title: string, options: string[]) => Promise<string | undefined>;
		confirm: (title: string, message: string) => Promise<boolean>;
		input: (title: string, placeholder?: string) => Promise<string | undefined>;
		notify: (message: string, type?: string) => void;
	};
};

async function makeRepo(): Promise<string> {
	const dir = await mkdtemp(path.join(tmpdir(), "gwt-ui-test-"));
	await execAsync("git", ["init", "-b", "main", dir], { windowsHide: true });
	await execAsync("git", ["-C", dir, "config", "user.email", "t@t"], { windowsHide: true });
	await execAsync("git", ["-C", dir, "config", "user.name", "t"], { windowsHide: true });
	await writeFile(path.join(dir, "a.txt"), "hello\n");
	await execAsync("git", ["-C", dir, "add", "."], { windowsHide: true });
	await execAsync("git", ["-C", dir, "commit", "-m", "init"], { windowsHide: true });
	return dir;
}

function createHarness(
	repo: string,
	select: TestContext["ui"]["select"],
	options: HarnessOptions = {},
): {
	command: Command;
	ctx: TestContext;
	notifications: Array<{ message: string; type?: string }>;
} {
	const commands = new Map<string, Command>();
	const notifications: Array<{ message: string; type?: string }> = [];
	const ctx: TestContext = {
		cwd: repo,
		mode: "print",
		hasUI: true,
		ui: {
			select,
			confirm: options.confirm ?? (async () => false),
			input: options.input ?? (async () => undefined),
			notify: (message, type) => notifications.push({ message, type }),
		},
	};

	gitWorktreeExtension(
		{
			registerCommand(name: string, command: Command) {
				commands.set(name, command);
			},
		} as never,
		{
			launchWindowsTerminalInDir:
				options.launch ??
				(async () => ({ status: "unavailable", reason: "test launcher not configured" })),
		},
	);

	const command = commands.get("worktree");
	assert.ok(command, "worktree command should be registered");
	return { command, ctx, notifications };
}

async function withPiHome<T>(run: (home: string) => Promise<T>): Promise<T> {
	const home = await mkdtemp(path.join(tmpdir(), "gwt-ui-home-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	const agentDir = path.join(home, "agent");
	await mkdir(agentDir, { recursive: true });
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		return await run(home);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		await rm(home, { recursive: true, force: true });
	}
}

async function removeWorktree(repo: string, worktree: string): Promise<void> {
	try {
		await execAsync("git", ["-C", repo, "worktree", "remove", "--force", worktree], { windowsHide: true });
	} catch {
		/* ignore cleanup errors */
	}
}

test("/worktree cancels cleanly from the chooser", async () => {
	const repo = await makeRepo();
	try {
		const selectCalls: string[] = [];
		const harness = createHarness(repo, async (title) => {
			selectCalls.push(title);
			return undefined;
		});

		await harness.command.handler("", harness.ctx);

		assert.deepEqual(selectCalls, ["git-worktree · Open or create worktree"]);
		assert.deepEqual(harness.notifications, []);
	} finally {
		await rm(repo, { recursive: true, force: true });
	}
});

test("/worktree rejects an invalid branch before showing the create preview", async () => {
	const repo = await makeRepo();
	try {
		const harness = createHarness(repo, async () => {
			throw new Error("chooser should not run for a direct invalid branch");
		});

		await harness.command.handler("bad..name", harness.ctx);

		assert.equal(harness.notifications.length, 1);
		assert.equal(harness.notifications[0]!.type, "error");
		assert.match(harness.notifications[0]!.message, /invalid branch name/);
	} finally {
		await rm(repo, { recursive: true, force: true });
	}
});

test("/worktree lets the user choose another branch when the target is attached", async () => {
	await withPiHome(async () => {
		const repo = await makeRepo();
		const taken = "taken";
		const takenPath = worktreePath(repo, taken);
		const existing = await createWorktree({
			base: "main",
			branch: taken,
			worktreeDir: takenPath,
			repoRootDir: repo,
		});
		assert.equal(existing.code, 0, existing.stderr);

		const next = "feature/new";
		const harness = createHarness(
			repo,
			async (title) => {
				if (title.includes("already attached")) return "Choose another branch";
				assert.match(title, /Create worktree/);
				return "Create only";
			},
			{ input: async () => next },
		);

		try {
			await harness.command.handler(taken, harness.ctx);
			assert.ok((await listWorktrees(repo)).some((worktree) => worktree.branch === next));
			assert.equal(harness.notifications.length, 1);
		} finally {
			await removeWorktree(repo, takenPath);
			await removeWorktree(repo, worktreePath(repo, next));
			await rm(repo, { recursive: true, force: true });
		}
	});
});

test("/worktree offers stale metadata pruning from the chooser", async () => {
	await withPiHome(async () => {
		const repo = await makeRepo();
		const branch = "stale-ui";
		const stalePath = worktreePath(repo, branch);
		const created = await createWorktree({
			base: "main",
			branch,
			worktreeDir: stalePath,
			repoRootDir: repo,
		});
		assert.equal(created.code, 0, created.stderr);
		await rm(stalePath, { recursive: true, force: true });

		const harness = createHarness(
			repo,
			async (_title, options) => {
				const choice = options.find((option) => option.startsWith("Prune stale worktrees"));
				assert.ok(choice, "stale prune action should be listed");
				return choice;
			},
			{ confirm: async () => true },
		);

		try {
			await harness.command.handler("", harness.ctx);
			assert.equal((await listWorktrees(repo)).some((worktree) => worktree.branch === branch), false);
			assert.match(harness.notifications[0]?.message ?? "", /pruned/);
		} finally {
			await pruneWorktrees(repo);
			await rm(repo, { recursive: true, force: true });
		}
	});
});

test("/worktree creates from the chooser with the default branch", async () => {
	await withPiHome(async () => {
		const repo = await makeRepo();
		const branch = "main-worktree";
		const harness = createHarness(
			repo,
			async (title, options) => {
				if (title === "git-worktree · Open or create worktree") {
					const choice = options.find((option) => option === "Create new worktree...");
					assert.ok(choice);
					return choice;
				}
				assert.match(title, /Create worktree/);
				return "Create only";
			},
			{ input: async () => "" },
		);

		try {
			await harness.command.handler("", harness.ctx);
			const listed = await listWorktrees(repo);
			assert.ok(listed.some((worktree) => worktree.branch === branch));
			assert.equal(harness.notifications.length, 1);
			assert.match(harness.notifications[0]!.message, /To work in it/);
		} finally {
			await removeWorktree(repo, worktreePath(repo, branch));
			await rm(repo, { recursive: true, force: true });
		}
	});
});

test("/worktree reports a Windows Terminal launch failure with a manual command", async () => {
	await withPiHome(async () => {
		const repo = await makeRepo();
		const branch = "feature/failure";
		const worktree = worktreePath(repo, branch);
		const created = await createWorktree({
			base: "main",
			branch,
			worktreeDir: worktree,
			repoRootDir: repo,
		});
		assert.equal(created.code, 0, created.stderr);

		const harness = createHarness(
			repo,
			async (_title, options) => {
				const choice = options.find((option) => option.includes(`(${branch})`));
				assert.ok(choice);
				return choice;
			},
			{ launch: async () => ({ status: "failed", reason: "test launch failure" }) },
		);

		try {
			await harness.command.handler("", harness.ctx);
			assert.equal(harness.notifications[0]?.type, "warning");
			assert.match(harness.notifications[0]?.message ?? "", /test launch failure/);
			assert.match(harness.notifications[0]?.message ?? "", /Run manually/);
		} finally {
			await removeWorktree(repo, worktree);
			await rm(repo, { recursive: true, force: true });
		}
	});
});

test("/worktree opens the selected existing worktree", async () => {
	await withPiHome(async () => {
		const repo = await makeRepo();
		const branch = "feature/ui";
		const worktree = worktreePath(repo, branch);
		const created = await createWorktree({
			base: "main",
			branch,
			worktreeDir: worktree,
			repoRootDir: repo,
		});
		assert.equal(created.code, 0, created.stderr);

		const launched: string[] = [];
		const harness = createHarness(
			repo,
			async (title, options) => {
				assert.equal(title, "git-worktree · Open or create worktree");
				const choice = options.find((option) => option.includes(`(${branch})`));
				assert.ok(choice, "existing worktree should be listed");
				return choice;
			},
			{
				launch: async (selectedPath) => {
					launched.push(selectedPath);
					return { status: "requested" };
				},
			},
		);

		try {
			await harness.command.handler("", harness.ctx);
			assert.equal(path.normalize(launched[0] ?? ""), path.normalize(worktree));
			assert.match(harness.notifications[0]?.message ?? "", /launch requested/);
		} finally {
			await removeWorktree(repo, worktree);
			await rm(repo, { recursive: true, force: true });
		}
	});
});
