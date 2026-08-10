import type { VerifiedCommand } from "./shell-parser.js";

// ── lookup tables ──

export const INDIRECT_EXECUTORS = new Set([
	"bash", "sh", "zsh", "dash", "env", "eval", "source", "exec", "xargs", "find",
	"python", "python2", "python3", "perl", "ruby", "node", "ssh", "sudo", "doas",
	"systemd-run", "nohup", "disown", "setsid",
]);

export const HOST_DESTRUCTIVE = new Map<string, string>([
	["shutdown", "host power action"],
	["reboot", "host power action"],
	["poweroff", "host power action"],
	["halt", "host power action"],
	["mkfs", "disk or filesystem modification"],
	["mkfs.ext4", "disk or filesystem modification"],
	["mkfs.xfs", "disk or filesystem modification"],
	["mkfs.btrfs", "disk or filesystem modification"],
	["dd", "disk or filesystem modification"],
	["wipefs", "disk or filesystem modification"],
	["useradd", "account modification"],
	["userdel", "account modification"],
	["usermod", "account modification"],
	["groupadd", "account modification"],
	["groupdel", "account modification"],
	["passwd", "account or password modification"],
	["chpasswd", "account or password modification"],
	["ufw", "firewall modification"],
	["iptables", "firewall modification"],
	["nft", "firewall modification"],
	["firewall-cmd", "firewall modification"],
	["route", "network routing modification"],
]);

export const READ_ONLY_COMMANDS = new Set([
	"pwd", "whoami", "id", "uname", "uptime", "df", "free", "ps", "pgrep", "ls", "stat", "file",
	"head", "tail", "grep", "rg", "cat", "sha256sum", "echo", "printf",
	"du", "wc", "pstree", "pidof", "which", "netstat", "lsof", "readlink", "realpath", "basename", "dirname",
]);

export const DISK_READ_ONLY = new Set(["lsblk", "blkid", "smartctl"]);

export const SYSTEMCTL_READ_ONLY = new Set(["status", "show", "is-active", "is-enabled"]);
export const SYSTEMCTL_GLOBAL_FLAGS = new Set([
	"--no-ask-password", "--no-pager", "--no-legend", "--full", "--quiet", "-q", "--plain", "--value",
	"--all", "--system", "--user", "--failed", "--recursive", "--reverse",
]);
export const SYSTEMCTL_CONFIRM = new Set([
	"start", "stop", "restart", "reload", "try-restart", "reload-or-restart", "enable", "disable",
	"mask", "unmask", "daemon-reload", "reset-failed", "revert",
]);

export const DOCKER_READ_ONLY = new Set(["ps", "version", "info"]);
export const DOCKER_COMPOSE_READ_ONLY = new Set(["ps", "logs", "config"]);
export const DOCKER_CONFIRM = new Set([
	"start", "stop", "restart", "kill", "pause", "unpause", "pull", "push",
	"create", "rm", "update", "rename", "cp",
]);
export const DOCKER_DESTRUCTIVE = new Set(["system", "volume", "network", "container"]);

export const WRITE_COMMANDS = new Set([
	"cp", "mv", "mkdir", "touch", "chmod", "chown", "ln", "install", "tee", "truncate", "sed",
	"mount", "umount", "kill", "pkill", "killall", "service", "curl", "wget",
]);

// ── command-specific argument parsers ──

export function systemctlSubcommand(args: readonly string[]): string | undefined {
	for (const arg of args) {
		if (SYSTEMCTL_GLOBAL_FLAGS.has(arg)) continue;
		return arg;
	}
	return undefined;
}

export function hasSystemctlTargetFlag(args: readonly string[]): boolean {
	return args.some((arg) =>
		arg === "--host" || arg === "-H" || arg.startsWith("--host=") ||
		arg === "--machine" || arg === "-M" || arg.startsWith("--machine=") ||
		arg === "--root" || arg.startsWith("--root=") ||
		arg === "--runtime-scope" || arg.startsWith("--runtime-scope="),
	);
}

export function hasDateSetFlag(args: readonly string[]): boolean {
	return args.some((arg) => arg === "-s" || arg === "--set" || arg.startsWith("--set="));
}

export function isSafeDateArgs(args: readonly string[]): boolean {
	const readOnlyFlags = new Set(["-u", "--utc", "-R", "--rfc-email", "-I", "--help", "--version"]);
	for (let index = 0; index < args.length; index++) {
		const arg = args[index] ?? "";
		if (arg.startsWith("+") || readOnlyFlags.has(arg) || arg.startsWith("--iso-8601")) continue;
		if (arg === "-d" || arg === "--date") {
			if (index + 1 >= args.length) return false;
			index++;
			continue;
		}
		if (arg.startsWith("--date=")) continue;
		return false;
	}
	return true;
}

export function isSafeHostnameArgs(args: readonly string[]): boolean {
	const readOnlyFlags = new Set([
		"-s", "--short", "-f", "--fqdn", "-d", "--domain", "-i", "-I", "--ip-address",
		"--all-ip-addresses", "--all-fqdns", "--help", "--version",
	]);
	return args.length === 0 || args.every((arg) => readOnlyFlags.has(arg));
}

export function hasJournalMutation(args: readonly string[]): boolean {
	return args.some((arg) => /^(?:--vacuum-(?:size|time|files)(?:=|$)|--(?:rotate|flush|sync|relinquish-var|setup-keys)$)/.test(arg));
}

export function hasJournalFileOption(args: readonly string[]): boolean {
	return args.some((arg) =>
		arg === "--file" || arg === "-D" || arg === "--directory" || arg === "--root" ||
		arg.startsWith("--file=") || arg.startsWith("--directory=") || arg.startsWith("--root="),
	);
}

export function hasStreamingFlag(args: readonly string[]): boolean {
	return args.some((arg) => arg === "-f" || arg === "-F" || arg === "--follow" || arg === "--watch");
}

function hasLogLimitFlags(args: readonly string[]): boolean {
	for (let index = 0; index < args.length; index++) {
		const arg = args[index] ?? "";
		if (arg === "--tail" || arg === "-n" || arg === "--since" || arg === "--until") {
			if (args[index + 1] !== undefined) return true;
		}
		if (arg.startsWith("--tail=") || arg.startsWith("--since=") || arg.startsWith("--until=") || arg.startsWith("-n")) {
			return true;
		}
	}
	return false;
}

export function evaluateDocker(command: VerifiedCommand): { decision: RuleDecision; reason: string } {
	const args = [...command.args];
	const compose = command.executable === "docker-compose" || args[0] === "compose";
	const subcommand = compose && command.executable === "docker" ? args[1] : args[0];
	if (!subcommand) return { decision: "block", reason: "docker operation is missing a subcommand" };

	if (subcommand === "logs") {
		const subArgs = args.slice(compose && command.executable === "docker" ? 2 : 1);
		if (hasStreamingFlag(subArgs)) {
			return { decision: "block", reason: "streaming command is not allowed" };
		}
		if (!hasLogLimitFlags(subArgs)) {
			return { decision: "confirm", reason: "unbounded log output — add --tail or --since to limit" };
		}
		return { decision: "auto", reason: "container log inspection" };
	}
	if (subcommand === "stats") {
		const subArgs = args.slice(compose && command.executable === "docker" ? 2 : 1);
		if (!subArgs.includes("--no-stream")) return { decision: "block", reason: "streaming command is not allowed" };
		return { decision: "auto", reason: "docker read-only operation" };
	}
	if (compose ? DOCKER_COMPOSE_READ_ONLY.has(subcommand) : DOCKER_READ_ONLY.has(subcommand)) {
		return { decision: "auto", reason: "docker read-only operation" };
	}
	if (subcommand === "exec" || subcommand === "run" || subcommand === "build") {
		return { decision: "block", reason: "container command or image build execution is not allowed" };
	}
	if (DOCKER_DESTRUCTIVE.has(subcommand) && args.some((arg) => /(?:rm|prune|delete)/.test(arg))) {
		return { decision: "block", reason: "destructive container cleanup" };
	}
	if (DOCKER_CONFIRM.has(subcommand)) return { decision: "confirm", reason: "container state modification" };
	return { decision: "block", reason: "unknown docker operation" };
}

export function isReadOnlyDiskCommand(command: VerifiedCommand): boolean {
	if (command.executable === "lsblk") return true;
	if (command.executable === "blkid") return isSafeBlkidArgs(command.args);
	if (command.executable === "smartctl") return isSafeSmartctlArgs(command.args);
	if (command.executable === "fdisk") return command.args.includes("-l") || command.args.includes("--list");
	if (command.executable === "parted") {
		const mutationTokens = new Set(["mklabel", "mkpart", "rm", "resizepart", "move", "name", "set", "toggle", "rescue", "disk_set", "disk_toggle"]);
		if (command.args.some((arg) => mutationTokens.has(arg))) return false;
		return command.args.includes("-l") || command.args.includes("--list") || command.args.includes("print");
	}
	if (command.executable === "hdparm") {
		return command.args.every((arg) => !arg.startsWith("-") || /^-[tTgiI]+$/.test(arg));
	}
	return false;
}

function isSafeBlkidArgs(args: readonly string[]): boolean {
	const flags = new Set(["-p", "--probe", "-i", "--info", "-o", "--output", "-s", "--match-token", "-u", "--match-usage"]);
	return args.every((arg) => !arg.startsWith("-") || flags.has(arg) || arg.startsWith("--output=") || arg.startsWith("--match-token=") || arg.startsWith("--match-usage="));
}

function isSafeSmartctlArgs(args: readonly string[]): boolean {
	const safeFlags = new Set(["-a", "--all", "-x", "--xall", "-H", "--health", "-i", "--info", "-g", "--get", "-c", "--capabilities"]);
	return args.every((arg) => !arg.startsWith("-") || safeFlags.has(arg));
}

export function hasNetworkMutation(args: readonly string[]): boolean {
	return args.some((arg) => ["add", "del", "delete", "change", "replace", "flush", "set"].includes(arg));
}

export function parseRmArgs(args: readonly string[]): { recursive: boolean; force: boolean; targets: string[] } {
	let recursive = false;
	let force = false;
	let endOfOptions = false;
	const targets: string[] = [];

	for (const arg of args) {
		if (endOfOptions) { targets.push(arg); continue; }
		if (arg === "--") { endOfOptions = true; continue; }
		if (arg === "--recursive") { recursive = true; continue; }
		if (arg === "--force") { force = true; continue; }
		if (arg.startsWith("--")) {
			if (arg.startsWith("--recursive=") || arg.startsWith("--force=")) {
				recursive ||= arg.startsWith("--recursive=");
				force ||= arg.startsWith("--force=");
				continue;
			}
			targets.push(arg);
			continue;
		}
		if (arg.startsWith("-") && arg !== "-") {
			recursive ||= arg.includes("r") || arg.includes("R");
			force ||= arg.includes("f");
			const attachedOperand = arg.match(/\/.+$/)?.[0];
			if (attachedOperand) targets.push(attachedOperand);
			continue;
		}
		targets.push(arg);
	}
	return { recursive, force, targets };
}

// ── operand extraction ──

export function isWriteLike(executable: string, command?: VerifiedCommand): boolean {
	if (executable === "ss") return Boolean(ssDiagnosticPath(command?.args ?? []));
	return executable === "rm" || WRITE_COMMANDS.has(executable);
}

export function writePathOperands(command: VerifiedCommand): readonly string[] {
	if (command.executable === "rm") return parseRmArgs(command.args).targets;
	if (["cp", "mv", "install"].includes(command.executable)) {
		return [...nonOptionOperands(command.args), ...targetDirectoryOperands(command.args)];
	}
	if (command.executable === "ss") {
		const path = ssDiagnosticPath(command.args);
		return path ? [path] : [];
	}
	if (command.executable === "curl" || command.executable === "wget") {
		const outputs: string[] = [];
		for (let index = 0; index < command.args.length; index++) {
			const arg = command.args[index] ?? "";
			if (arg === "-o" || arg === "--output" || arg === "-O" || arg === "--output-document") outputs.push(command.args[index + 1] ?? "");
			if (arg.startsWith("--output=") || arg.startsWith("--output-document=")) outputs.push(arg.slice(arg.indexOf("=") + 1));
		}
		return outputs;
	}
	return nonOptionOperands(command.args);
}

function targetDirectoryOperands(args: readonly string[]): string[] {
	const paths: string[] = [];
	for (let index = 0; index < args.length; index++) {
		const arg = args[index] ?? "";
		if (arg === "-t" || arg === "--target-directory") {
			if (args[index + 1] !== undefined) paths.push(args[++index]!);
			continue;
		}
		if (arg.startsWith("-t") && arg.length > 2) paths.push(arg.slice(2));
		if (arg.startsWith("--target-directory=")) paths.push(arg.slice("--target-directory=".length));
	}
	return paths;
}

function ssDiagnosticPath(args: readonly string[]): string | undefined {
	for (let index = 0; index < args.length; index++) {
		const arg = args[index] ?? "";
		if (arg === "-D" || arg === "--diag") return args[index + 1];
		if (arg.startsWith("-D/")) return arg.slice(2);
		if (arg.startsWith("--diag=")) return arg.slice("--diag=".length);
	}
	return undefined;
}

export function readPathOperands(command: VerifiedCommand): readonly string[] {
	if (!["cat", "head", "tail", "grep", "rg", "file", "stat", "sha256sum", "ls"].includes(command.executable)) {
		return [];
	}
	if (command.executable === "grep" || command.executable === "rg") return grepFilePathOperands(command.args);
	return nonOptionOperands(command.args);
}

interface GrepOperands {
	/** Files specified via -f/--file (pattern files, read into the search). */
	patternFiles: string[];
	/** Files to search (target operands). */
	inputFiles: string[];
}

function parseGrepOperands(args: readonly string[]): GrepOperands {
	const patternFiles: string[] = [];
	const inputFiles: string[] = [];
	let endOfOptions = false;
	let patternDefined = false;
	for (let index = 0; index < args.length; index++) {
		const arg = args[index] ?? "";
		if (endOfOptions) { inputFiles.push(arg); continue; }
		if (arg === "--") { endOfOptions = true; continue; }
		if (arg === "-f" || arg === "--file") {
			patternDefined = true;
			const patternFile = args[index + 1];
			if (patternFile !== undefined) { patternFiles.push(patternFile); index++; }
			continue;
		}
		if (arg === "-e" || arg === "--regexp") {
			patternDefined = true;
			if (index + 1 < args.length) index++;
			continue;
		}
		if (arg.startsWith("--file=")) { patternDefined = true; patternFiles.push(arg.slice("--file=".length)); continue; }
		if (arg.startsWith("--regexp=")) { patternDefined = true; continue; }
		if (arg.startsWith("-f") && arg.length > 2) { patternDefined = true; patternFiles.push(arg.slice(2)); continue; }
		if (arg.startsWith("-e") && arg.length > 2) { patternDefined = true; continue; }
		if (arg.startsWith("-")) continue;
		if (!patternDefined) { patternDefined = true; continue; }
		inputFiles.push(arg);
	}
	return { patternFiles, inputFiles };
}

/** Returns all file operands (pattern files + search targets) for sensitive-path checks. */
function grepFilePathOperands(args: readonly string[]): string[] {
	const operands = parseGrepOperands(args);
	return [...operands.patternFiles, ...operands.inputFiles];
}

export function readsFromStdin(command: VerifiedCommand): boolean {
	const stdinCommands = new Set(["cat", "head", "tail", "grep", "rg", "sha256sum", "wc"]);
	if (!stdinCommands.has(command.executable)) return false;
	if (command.args.includes("-")) return true;
	if (command.executable === "grep" || command.executable === "rg") {
		return parseGrepOperands(command.args).inputFiles.length === 0;
	}
	return nonOptionOperands(command.args).length === 0;
}

export function nonOptionOperands(args: readonly string[]): string[] {
	const operands: string[] = [];
	let endOfOptions = false;
	for (const arg of args) {
		if (endOfOptions) { operands.push(arg); continue; }
		if (arg === "--") { endOfOptions = true; continue; }
		if (!arg.startsWith("-")) operands.push(arg);
	}
	return operands;
}

// ── re-exported types (consumed by command-policy.ts) ──

export type CommandRisk = "auto" | "confirm" | "block";
export type RuleDecision = Exclude<CommandRisk, "auto"> | "auto";
