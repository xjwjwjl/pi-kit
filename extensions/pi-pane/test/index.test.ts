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
	getBackendCommand,
	getPaneArgumentCompletions,
	looksLikeWindowsPath,
	parsePaneArgs,
	posixifyPiArg,
	quotePosix,
	quotePowerShell,
	splitShellArgs,
	stripJsonComments,
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
	assert.equal(buildWindowsTerminalPaneArgs("right", "D:\\code\\x", [], "C:\\Git\\bin\\bash.exe")[1], "--vertical");
	assert.equal(buildWindowsTerminalPaneArgs("down", "D:\\code\\x", [], "C:\\Git\\bin\\bash.exe")[1], "--horizontal");
});

test("buildWindowsTerminalPaneArgs launches Git Bash instead of PowerShell", () => {
	const args = buildWindowsTerminalPaneArgs(
		"right",
		"D:\\code\\x",
		["--fork", "C:\\Users\\admin\\.pi\\session.jsonl"],
		"C:\\Git\\bin\\bash.exe",
	);

	assert.equal(args[4], "C:\\Git\\bin\\bash.exe");
	assert.equal(args[5], "-c");
	assert.match(args[6], /cd 'D:\/code\/x' && pi '--fork' 'C:\/Users\/admin\/\.pi\/session\.jsonl'/);
	assert.doesNotMatch(args[6], /;/);
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

test("stripJsonComments removes line and block comments", () => {
	assert.equal(
		stripJsonComments('{ "a": 1 // comment\n, "b": 2 /* block */ }'),
		'{ "a": 1 \n, "b": 2  }',
	);
	assert.equal(stripJsonComments('{"x":1}'), '{"x":1}');
});

test("stripJsonComments preserves :// URLs in string values", () => {
	assert.equal(
		stripJsonComments('{ "url": "https://example.com" // note\n}'),
		'{ "url": "https://example.com" \n}',
	);
});

test("getBackendCommand omits -w when WT_SESSION is set", () => {
	const wtArgs = getBackendCommand(
		"windows-terminal",
		{ direction: "right", mode: "fresh", startup: "normal", dryRun: false },
		"D:\\code\\x",
		[],
		{ WT_SESSION: "abc123" },
	).args;
	assert.equal(wtArgs[0], "split-pane");
	assert.ok(!wtArgs.includes("-w"));
});

test("getBackendCommand adds -w 0 when WT_SESSION is absent", () => {
	const wtArgs = getBackendCommand(
		"windows-terminal",
		{ direction: "right", mode: "fresh", startup: "normal", dryRun: false },
		"D:\\code\\x",
		[],
		{},
	).args;
	assert.equal(wtArgs[0], "-w");
	assert.equal(wtArgs[1], "0");
});

test("looksLikeWindowsPath detects drive-letter and UNC paths", () => {
	assert.equal(looksLikeWindowsPath("C:\\Users\\admin\\.pi\\session.jsonl"), true);
	assert.equal(looksLikeWindowsPath("D:/code/pi-kit"), true);
	assert.equal(looksLikeWindowsPath("\\\\server\\share\\dir"), true);
});

test("looksLikeWindowsPath ignores flags and non-path values", () => {
	assert.equal(looksLikeWindowsPath("--offline"), false);
	assert.equal(looksLikeWindowsPath("--fork"), false);
	assert.equal(looksLikeWindowsPath("gpt-4"), false);
	assert.equal(looksLikeWindowsPath("some\\nbackslash"), false); // backslashes but not absolute path
	assert.equal(looksLikeWindowsPath("use \\d+ regex"), false);
});

test("posixifyPiArg converts Windows paths but not flags", () => {
	assert.equal(posixifyPiArg("C:\\Users\\admin\\.pi\\session.jsonl"), "C:/Users/admin/.pi/session.jsonl");
	assert.equal(posixifyPiArg("--offline"), "--offline");
	assert.equal(posixifyPiArg("--prompt"), "--prompt");
	assert.equal(posixifyPiArg("deepseek/deepseek-v4-flash"), "deepseek/deepseek-v4-flash");
});

test("buildWindowsTerminalPaneArgs keeps backslashes in non-path pi args", () => {
	const args = buildWindowsTerminalPaneArgs(
		"right",
		"D:\\code\\x",
		["--fork", "C:\\Users\\admin\\.pi\\session.jsonl", "--prompt", "use \\d+ regex"],
		"C:\\Git\\bin\\bash.exe",
	);
	const bashCmd = args[args.indexOf("-c") + 1];
	// session file should be posixified
	assert.match(bashCmd, /C:\/Users\/admin\/\.pi\/session\.jsonl/);
	// backslash in --prompt value should be preserved
	assert.match(bashCmd, /use \\d\+ regex/);
});
