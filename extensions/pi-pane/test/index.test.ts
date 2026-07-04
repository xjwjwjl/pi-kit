import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	FAST_PI_ARGS,
	buildPiArgs,
	buildTmuxPaneArgs,
	buildWindowsTerminalPaneArgs,
	detectPaneBackend,
	expandWindowsEnvVars,
	extractWindowsExecutable,
	getPaneArgumentCompletions,
	parsePaneArgs,
	quotePosix,
	quotePowerShell,
	splitShellArgs,
} from "../index.ts";

test("parsePaneArgs defaults to right fresh", () => {
	assert.deepEqual(parsePaneArgs("").options, {
		direction: "right",
		mode: "fresh",
		startup: "normal",
		backend: undefined,
		dryRun: false,
	});
});

test("parsePaneArgs accepts right and down", () => {
	assert.equal(parsePaneArgs("right").options?.direction, "right");
	assert.equal(parsePaneArgs("down").options?.direction, "down");
});

test("parsePaneArgs accepts fresh and backend", () => {
	assert.deepEqual(parsePaneArgs("down fresh backend=tmux --dry-run").options, {
		direction: "down",
		mode: "fresh",
		startup: "normal",
		backend: "tmux",
		dryRun: true,
	});
});

test("parsePaneArgs accepts fast startup", () => {
	assert.deepEqual(parsePaneArgs("down fast fork").options, {
		direction: "down",
		mode: "fork",
		startup: "fast",
		backend: undefined,
		dryRun: false,
	});
});

test("parsePaneArgs rejects unknown tokens", () => {
	assert.match(parsePaneArgs("left").error ?? "", /Unknown pane argument/);
});

test("getPaneArgumentCompletions suggests available argument groups", () => {
	assert.deepEqual(
		getPaneArgumentCompletions(""),
		[
			{ value: "right", label: "right", description: "Open a pane to the right" },
			{ value: "down", label: "down", description: "Open a pane below" },
			{ value: "fresh", label: "fresh", description: "Start a new pi session" },
			{ value: "fork", label: "fork", description: "Fork the current session" },
			{ value: "fast", label: "fast", description: "Use clean fast startup args" },
			{ value: "normal", label: "normal", description: "Use normal pi startup" },
			{ value: "backend=windows-terminal", label: "backend=windows-terminal", description: "Force Windows Terminal" },
			{ value: "backend=tmux", label: "backend=tmux", description: "Force tmux" },
			{ value: "--dry-run", label: "--dry-run", description: "Print the pane command only" },
		],
	);
});

test("getPaneArgumentCompletions avoids repeating completed argument groups", () => {
	const afterDirection = getPaneArgumentCompletions("right ")?.map((item) => item.value);
	assert.ok(afterDirection);
	assert.equal(afterDirection.includes("right"), false);
	assert.equal(afterDirection.includes("down"), false);
	assert.equal(afterDirection.includes("fast"), true);
	assert.equal(afterDirection.includes("fork"), true);

	assert.deepEqual(getPaneArgumentCompletions("right f")?.map((item) => item.value), ["fresh", "fork", "fast"]);
	assert.deepEqual(getPaneArgumentCompletions("right fast backend=w")?.map((item) => item.value), ["backend=windows-terminal"]);
});

test("quotes shell values", () => {
	assert.equal(quotePosix("a'b"), "'a'\\''b'");
	assert.equal(quotePowerShell("a'b"), "'a''b'");
});

test("extractWindowsExecutable reads Windows Terminal commandline values", () => {
	assert.equal(
		extractWindowsExecutable('"%USERPROFILE%\\scoop\\apps\\git\\current\\bin\\bash.exe" --login', {
			USERPROFILE: "C:\\Users\\admin",
		}),
		"C:\\Users\\admin\\scoop\\apps\\git\\current\\bin\\bash.exe",
	);
	assert.equal(expandWindowsEnvVars("%USERPROFILE%\\x", { USERPROFILE: "C:\\Users\\admin" }), "C:\\Users\\admin\\x");
});

test("buildTmuxPaneArgs maps right and down to tmux split flags", () => {
	assert.equal(buildTmuxPaneArgs("right", "D:\\code\\x", [])[1], "-h");
	assert.equal(buildTmuxPaneArgs("down", "D:\\code\\x", [])[1], "-v");
});

test("buildWindowsTerminalPaneArgs maps right and down to Windows Terminal split flags", () => {
	assert.equal(buildWindowsTerminalPaneArgs("right", "D:\\code\\x", [], "C:\\Git\\bin\\bash.exe")[3], "--vertical");
	assert.equal(buildWindowsTerminalPaneArgs("down", "D:\\code\\x", [], "C:\\Git\\bin\\bash.exe")[3], "--horizontal");
});

test("buildWindowsTerminalPaneArgs launches Git Bash instead of PowerShell", () => {
	const args = buildWindowsTerminalPaneArgs(
		"right",
		"D:\\code\\x",
		["--fork", "C:\\Users\\admin\\.pi\\session.jsonl"],
		"C:\\Git\\bin\\bash.exe",
	);

	assert.equal(args[6], "C:\\Git\\bin\\bash.exe");
	assert.equal(args[7], "-c");
	assert.match(args[8], /cd 'D:\/code\/x' && pi '--fork' 'C:\/Users\/admin\/\.pi\/session\.jsonl'/);
	assert.doesNotMatch(args[8], /;/);
	assert.doesNotMatch(args.join(" "), /powershell/i);
});

test("splitShellArgs handles quoted extra pi args", () => {
	assert.deepEqual(splitShellArgs('--offline --model "deepseek/deepseek-v4-flash" --session-dir C:\\Users\\admin\\.pi --name fast\\ pane'), [
		"--offline",
		"--model",
		"deepseek/deepseek-v4-flash",
		"--session-dir",
		"C:\\Users\\admin\\.pi",
		"--name",
		"fast pane",
	]);
});

test("buildPiArgs combines fast startup, env args, and explicit fork", () => {
	const ctx = {
		sessionManager: {
			getSessionFile: () => "C:\\Users\\admin\\.pi\\session.jsonl",
		},
	} as ExtensionCommandContext;

	assert.deepEqual(
		buildPiArgs(ctx, { mode: "fork", startup: "fast" }, { PI_PANE_PI_ARGS: "--no-session" }),
		[...FAST_PI_ARGS, "--no-session", "--fork", "C:\\Users\\admin\\.pi\\session.jsonl"],
	);
});

test("detectPaneBackend respects explicit backend first", () => {
	assert.equal(detectPaneBackend({ PI_PANE_BACKEND: "tmux", WT_SESSION: "1" }, "win32"), "tmux");
});

test("detectPaneBackend prefers Windows Terminal before tmux", () => {
	assert.equal(detectPaneBackend({ TMUX: "/tmp/tmux", WT_SESSION: "1" }, "win32"), "windows-terminal");
});
