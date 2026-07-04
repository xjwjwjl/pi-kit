import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export type PaneDirection = "right" | "down";
export type PaneBackend = "tmux" | "windows-terminal";
export type PaneMode = "fork" | "fresh";
export type PaneStartup = "normal" | "fast";

export interface PaneOptions {
	direction: PaneDirection;
	mode: PaneMode;
	startup: PaneStartup;
	backend?: PaneBackend;
	dryRun: boolean;
}

export interface PaneParseResult {
	options?: PaneOptions;
	error?: string;
}

type PaneCompletionGroup = "direction" | "mode" | "startup" | "backend" | "dryRun";
type PaneCompletionItem = {
	value: string;
	label: string;
	description: string;
	group: PaneCompletionGroup;
};

const DIRECTIONS: PaneDirection[] = ["right", "down"];
const BACKENDS: PaneBackend[] = ["tmux", "windows-terminal"];
const MODES: PaneMode[] = ["fork", "fresh"];
const STARTUPS: PaneStartup[] = ["normal", "fast"];
export const FAST_PI_ARGS = ["--offline", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files"];

const PANE_COMPLETIONS: PaneCompletionItem[] = [
	{ value: "right", label: "right", description: "Open a pane to the right", group: "direction" },
	{ value: "down", label: "down", description: "Open a pane below", group: "direction" },
	{ value: "fresh", label: "fresh", description: "Start a new pi session", group: "mode" },
	{ value: "fork", label: "fork", description: "Fork the current session", group: "mode" },
	{ value: "fast", label: "fast", description: "Use clean fast startup args", group: "startup" },
	{ value: "normal", label: "normal", description: "Use normal pi startup", group: "startup" },
	{ value: "backend=windows-terminal", label: "backend=windows-terminal", description: "Force Windows Terminal", group: "backend" },
	{ value: "backend=tmux", label: "backend=tmux", description: "Force tmux", group: "backend" },
	{ value: "--dry-run", label: "--dry-run", description: "Print the pane command only", group: "dryRun" },
];

function isPaneDirection(value: string): value is PaneDirection {
	return (DIRECTIONS as string[]).includes(value);
}

function isPaneBackend(value: string): value is PaneBackend {
	return (BACKENDS as string[]).includes(value);
}

function isPaneMode(value: string): value is PaneMode {
	return (MODES as string[]).includes(value);
}

function isPaneStartup(value: string): value is PaneStartup {
	return (STARTUPS as string[]).includes(value);
}

function normalizeMode(value: string | undefined): PaneMode {
	if (!value) return "fresh";
	const normalized = value.toLowerCase();
	if (normalized === "new") return "fresh";
	return isPaneMode(normalized) ? normalized : "fresh";
}

function normalizeStartup(value: string | undefined): PaneStartup {
	if (!value) return "normal";
	const normalized = value.toLowerCase();
	if (normalized === "clean") return "fast";
	return isPaneStartup(normalized) ? normalized : "normal";
}

function normalizeBackend(value: string | undefined): PaneBackend | undefined {
	if (!value) return undefined;
	const normalized = value.toLowerCase();
	if (normalized === "wt" || normalized === "windows" || normalized === "windows_terminal") {
		return "windows-terminal";
	}
	return isPaneBackend(normalized) ? normalized : undefined;
}

function completionGroupForToken(rawToken: string): PaneCompletionGroup | undefined {
	const token = rawToken.toLowerCase();
	if (isPaneDirection(token)) return "direction";
	if (token === "new" || isPaneMode(token)) return "mode";
	if (token === "clean" || isPaneStartup(token)) return "startup";
	if (token.startsWith("backend=") && normalizeBackend(token.slice("backend=".length))) return "backend";
	if (token === "--dry-run" || token === "dry-run") return "dryRun";
	return undefined;
}

export function getPaneArgumentCompletions(prefix: string) {
	const hasTrailingSpace = /\s$/.test(prefix);
	const tokens = prefix
		.trim()
		.split(/\s+/)
		.filter(Boolean);
	const current = hasTrailingSpace ? "" : tokens.pop()?.toLowerCase() ?? "";
	const usedGroups = new Set<PaneCompletionGroup>();
	for (const token of tokens) {
		const group = completionGroupForToken(token);
		if (group) usedGroups.add(group);
	}

	const filtered = PANE_COMPLETIONS.filter((item) => !usedGroups.has(item.group) && item.value.startsWith(current));
	return filtered.length
		? filtered.map(({ value, label, description }) => ({ value, label, description }))
		: null;
}

export function parsePaneArgs(
	args: string,
	defaults: Partial<Pick<PaneOptions, "direction" | "mode" | "startup" | "backend">> = {},
): PaneParseResult {
	const options: PaneOptions = {
		direction: defaults.direction ?? "right",
		mode: defaults.mode ?? "fresh",
		startup: defaults.startup ?? "normal",
		backend: defaults.backend,
		dryRun: false,
	};
	const tokens = args
		.trim()
		.split(/\s+/)
		.filter(Boolean);

	for (const rawToken of tokens) {
		const token = rawToken.toLowerCase();

		if (isPaneDirection(token)) {
			options.direction = token;
			continue;
		}

		if (token === "new") {
			options.mode = "fresh";
			continue;
		}

		if (isPaneMode(token)) {
			options.mode = token;
			continue;
		}

		if (token === "clean") {
			options.startup = "fast";
			continue;
		}

		if (isPaneStartup(token)) {
			options.startup = token;
			continue;
		}

		if (token === "--dry-run" || token === "dry-run") {
			options.dryRun = true;
			continue;
		}

		if (token.startsWith("backend=")) {
			const backend = normalizeBackend(token.slice("backend=".length));
			if (!backend) return { error: `Unknown pane backend: ${rawToken.slice("backend=".length)}` };
			options.backend = backend;
			continue;
		}

		return { error: `Unknown pane argument: ${rawToken}` };
	}

	return { options };
}

export function toPosixPath(value: string): string {
	return value.replace(/\\/g, "/");
}

export function quotePosix(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function quotePowerShell(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

export function expandWindowsEnvVars(value: string, env: NodeJS.ProcessEnv = process.env): string {
	return value.replace(/%([^%]+)%/g, (_match, name: string) => env[name] ?? env[name.toUpperCase()] ?? "");
}

export function extractWindowsExecutable(commandline: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
	const expanded = expandWindowsEnvVars(commandline.trim(), env);
	const quoted = /^"([^"]+)"/.exec(expanded);
	if (quoted) return quoted[1];

	const exe = /^([^\s]+\.exe)(?=\s|$)/i.exec(expanded);
	if (exe) return exe[1];

	return undefined;
}

export function splitShellArgs(value: string): string[] {
	const args: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let escaped = false;
	let active = false;

	function pushCurrent() {
		if (!active) return;
		args.push(current);
		current = "";
		active = false;
	}

	for (let i = 0; i < value.length; i++) {
		const char = value[i];
		if (escaped) {
			current += char;
			active = true;
			escaped = false;
			continue;
		}

		if (char === "\\" && quote !== "'" && i + 1 < value.length && (/\s/.test(value[i + 1]) || value[i + 1] === '"' || value[i + 1] === "'")) {
			escaped = true;
			active = true;
			continue;
		}

		if (quote) {
			if (char === quote) {
				quote = undefined;
			} else {
				current += char;
			}
			active = true;
			continue;
		}

		if (char === "'" || char === '"') {
			quote = char;
			active = true;
			continue;
		}

		if (/\s/.test(char)) {
			pushCurrent();
			continue;
		}

		current += char;
		active = true;
	}

	if (escaped) current += "\\";
	pushCurrent();
	return args;
}

function getExtraPiArgs(env: NodeJS.ProcessEnv = process.env): string[] {
	return env.PI_PANE_PI_ARGS ? splitShellArgs(env.PI_PANE_PI_ARGS) : [];
}

export function buildPiArgs(
	ctx: ExtensionCommandContext,
	options: Pick<PaneOptions, "mode" | "startup">,
	env: NodeJS.ProcessEnv = process.env,
): string[] {
	const args = options.startup === "fast" ? [...FAST_PI_ARGS] : [];
	args.push(...getExtraPiArgs(env));
	if (options.mode === "fresh") return args;

	const sessionFile = ctx.sessionManager.getSessionFile();
	return sessionFile ? [...args, "--fork", sessionFile] : args;
}

export function buildTmuxPaneArgs(direction: PaneDirection, cwd: string, piArgs: string[]): string[] {
	const splitFlag = direction === "right" ? "-h" : "-v";
	const quotedCwd = quotePosix(toPosixPath(cwd));
	const piCommand = ["pi", ...piArgs.map((arg) => quotePosix(toPosixPath(arg)))].join(" ");
	const command = `cd ${quotedCwd} && ${piCommand}; exec "\${SHELL:-/bin/sh}"`;

	return ["split-window", splitFlag, command];
}

function getWindowsTerminalSettingsPaths(env: NodeJS.ProcessEnv = process.env): string[] {
	const paths: string[] = [];
	if (env.LOCALAPPDATA) {
		const packagesDir = join(env.LOCALAPPDATA, "Packages");
		try {
			for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
				if (entry.isDirectory() && entry.name.startsWith("Microsoft.WindowsTerminal")) {
					paths.push(join(packagesDir, entry.name, "LocalState", "settings.json"));
				}
			}
		} catch {
			// Best-effort profile discovery; fall back to known bash paths below.
		}

		paths.push(join(env.LOCALAPPDATA, "Microsoft", "Windows Terminal", "settings.json"));
	}

	return [...new Set(paths)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readWindowsTerminalGitBashFromSettings(env: NodeJS.ProcessEnv = process.env): string | undefined {
	for (const settingsPath of getWindowsTerminalSettingsPaths(env)) {
		if (!existsSync(settingsPath)) continue;

		try {
			const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as unknown;
			if (!isRecord(settings)) continue;

			const profiles = isRecord(settings.profiles) ? settings.profiles.list : undefined;
			if (!Array.isArray(profiles)) continue;

			const profileId = typeof env.WT_PROFILE_ID === "string" ? env.WT_PROFILE_ID : undefined;
			const defaultProfile = typeof settings.defaultProfile === "string" ? settings.defaultProfile : undefined;
			const profileCandidates = [
				profiles.find((profile) => isRecord(profile) && profile.guid === profileId),
				profiles.find((profile) => isRecord(profile) && profile.guid === defaultProfile),
			].filter(isRecord);

			const bashProfile =
				profileCandidates.find(
					(profile) =>
						typeof profile.commandline === "string" &&
						/(^|[\\/])bash\.exe(?:\s|$)/i.test(expandWindowsEnvVars(profile.commandline, env)),
				) ??
				profiles.find(
					(profile) =>
						isRecord(profile) &&
						typeof profile.commandline === "string" &&
						/(^|[\\/])bash\.exe(?:\s|$)/i.test(expandWindowsEnvVars(profile.commandline, env)),
				);

			if (!isRecord(bashProfile) || typeof bashProfile.commandline !== "string") continue;

			const executable = extractWindowsExecutable(bashProfile.commandline, env);
			if (executable) return executable;
		} catch {
			// Ignore malformed or JSONC settings and continue with fallback paths.
		}
	}

	return undefined;
}

let cachedWindowsTerminalBash: string | undefined;

export function resolveWindowsTerminalBash(env: NodeJS.ProcessEnv = process.env): string {
	if (env === process.env && cachedWindowsTerminalBash) return cachedWindowsTerminalBash;

	if (env.PI_PANE_SHELL) return expandWindowsEnvVars(env.PI_PANE_SHELL, env);

	const fromSettings = readWindowsTerminalGitBashFromSettings(env);
	if (fromSettings) {
		if (env === process.env) cachedWindowsTerminalBash = fromSettings;
		return fromSettings;
	}

	const candidates = [
		env.USERPROFILE ? join(env.USERPROFILE, "scoop", "apps", "git", "current", "bin", "bash.exe") : undefined,
		"C:\\Program Files\\Git\\bin\\bash.exe",
		"C:\\Program Files\\Git\\usr\\bin\\bash.exe",
	].filter((candidate): candidate is string => Boolean(candidate));

	for (const candidate of candidates) {
		if (existsSync(candidate)) {
			if (env === process.env) cachedWindowsTerminalBash = candidate;
			return candidate;
		}
	}

	if (env === process.env) cachedWindowsTerminalBash = "bash.exe";
	return "bash.exe";
}

export function buildWindowsTerminalPaneArgs(
	direction: PaneDirection,
	cwd: string,
	piArgs: string[],
	shellPath = resolveWindowsTerminalBash(),
): string[] {
	const splitFlag = direction === "right" ? "--vertical" : "--horizontal";
	const quotedCwd = quotePosix(toPosixPath(cwd));
	const piCommand = ["pi", ...piArgs.map((arg) => quotePosix(toPosixPath(arg)))].join(" ");
	const bashCommand = `cd ${quotedCwd} && ${piCommand} || true && exec bash -i`;

	return [
		"-w",
		"0",
		"split-pane",
		splitFlag,
		"--startingDirectory",
		cwd,
		shellPath,
		"-c",
		bashCommand,
	];
}

export function detectPaneBackend(env: NodeJS.ProcessEnv = process.env, platform = process.platform): PaneBackend | undefined {
	const configured = normalizeBackend(env.PI_PANE_BACKEND);
	if (configured) return configured;
	if (env.WT_SESSION || platform === "win32") return "windows-terminal";
	if (env.TMUX) return "tmux";
	return undefined;
}

function getBackendCommand(backend: PaneBackend, options: PaneOptions, cwd: string, piArgs: string[]) {
	if (backend === "tmux") {
		return { command: "tmux", args: buildTmuxPaneArgs(options.direction, cwd, piArgs) };
	}

	return { command: "wt", args: buildWindowsTerminalPaneArgs(options.direction, cwd, piArgs) };
}

function commandPreview(command: string, args: string[]): string {
	return [command, ...args].join(" ");
}

function paneBackendLabel(backend: PaneBackend): string {
	return backend === "windows-terminal" ? "Windows Terminal" : "tmux";
}

function paneModeLabel(options: Pick<PaneOptions, "mode" | "startup">): string {
	const mode = options.mode === "fork" ? "forked" : "fresh";
	return options.startup === "fast" ? `${mode}, fast` : mode;
}

function truncateNotice(value: string, maxLength = 220): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	if (normalized.length <= maxLength) return normalized;
	return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

async function openPane(pi: ExtensionAPI, ctx: ExtensionCommandContext, options: PaneOptions) {
	const backend = options.backend ?? detectPaneBackend();
	if (!backend) {
		ctx.ui.notify("No supported pane backend found. Run pi inside tmux or Windows Terminal, or set PI_PANE_BACKEND.", "error");
		return;
	}

	const piArgs = buildPiArgs(ctx, options);
	const { command, args } = getBackendCommand(backend, options, ctx.cwd, piArgs);
	const preview = commandPreview(command, args);

	if (options.dryRun) {
		console.log(`[pi-pane] ${preview}`);
		ctx.ui.notify(`Dry run: ${truncateNotice(preview)}`, "info");
		return;
	}

	const result = await pi.exec(command, args, { cwd: ctx.cwd, timeout: 5000 });
	if (result.code !== 0) {
		const details = (result.stderr || result.stdout || `exit code ${result.code}`).trim();
		ctx.ui.notify(`Failed to open ${options.direction} pane via ${paneBackendLabel(backend)}: ${truncateNotice(details)}`, "error");
		return;
	}

	ctx.ui.notify(`Opened ${options.direction} pane (${paneModeLabel(options)}) via ${paneBackendLabel(backend)}`, "info");
}

export default function piPaneExtension(pi: ExtensionAPI) {
	pi.registerCommand("pane", {
		description: "Open a new terminal pane running pi",
		getArgumentCompletions: getPaneArgumentCompletions,
		handler: async (args, ctx) => {
			const parsed = parsePaneArgs(args, {
				mode: normalizeMode(process.env.PI_PANE_MODE),
				startup: normalizeStartup(process.env.PI_PANE_STARTUP),
				backend: normalizeBackend(process.env.PI_PANE_BACKEND),
			});
			if (!parsed.options) {
				ctx.ui.notify(parsed.error ?? "Invalid pane arguments", "error");
				return;
			}

			await ctx.waitForIdle();
			await openPane(pi, ctx, parsed.options);
		},
	});
}
