import type { RemoteExecPolicy } from "../config/types.js";
import {
	parseVerifiedCommand,
	type VerifiedCommand,
	type VerificationFailure,
} from "./shell-parser.js";
import {
	DISK_READ_ONLY,
	DOCKER_READ_ONLY,
	DOCKER_COMPOSE_READ_ONLY,
	DOCKER_CONFIRM,
	DOCKER_DESTRUCTIVE,
	HOST_DESTRUCTIVE,
	INDIRECT_EXECUTORS,
	READ_ONLY_COMMANDS,
	SYSTEMCTL_READ_ONLY,
	WRITE_COMMANDS,
	evaluateDocker,
	hasDateSetFlag,
	hasJournalFileOption,
	hasJournalMutation,
	hasNetworkMutation,
	hasStreamingFlag,
	hasSystemctlTargetFlag,
	isReadOnlyDiskCommand,
	isSafeDateArgs,
	isSafeHostnameArgs,
	isWriteLike,
	parseRmArgs,
	readPathOperands,
	readsFromStdin,
	systemctlSubcommand,
	writePathOperands,
	type CommandRisk,
	type RuleDecision,
} from "./cmd-parsers.js";
import { containsProtectedPath, containsSensitivePath } from "./path-guard.js";

export type { CommandRisk } from "./cmd-parsers.js";

export interface CommandAssessment {
	risk: CommandRisk;
	reasons: string[];
	code: string;
	command?: VerifiedCommand;
}

interface CommandRule {
	code: string;
	matches(command: VerifiedCommand): boolean;
	evaluate(command: VerifiedCommand): { decision: RuleDecision; reason: string };
}

const COMMAND_RULES: CommandRule[] = [
	{
		code: "INDIRECT_EXECUTION",
		matches: (command) => INDIRECT_EXECUTORS.has(command.executable),
		evaluate: () => ({ decision: "block", reason: "indirect or nested command execution is not allowed" }),
	},
	{
		code: "HOST_DESTRUCTIVE",
		matches: (command) => HOST_DESTRUCTIVE.has(command.executable),
		evaluate: (command) => ({
			decision: "block",
			reason: HOST_DESTRUCTIVE.get(command.executable) ?? "high-risk host modification",
		}),
	},
	{
		code: "DATE",
		matches: (command) => command.executable === "date",
		evaluate: (command) => {
			if (hasDateSetFlag(command.args)) return { decision: "block", reason: "system time modification" };
			if (isSafeDateArgs(command.args)) return { decision: "auto", reason: "date read-only operation" };
			return { decision: "confirm", reason: "date arguments are not in the read-only subset" };
		},
	},
	{
		code: "RM",
		matches: (command) => command.executable === "rm",
		evaluate: (command) => {
			const parsed = parseRmArgs(command.args);
			if (parsed.recursive && parsed.force) return { decision: "block", reason: "recursive forced deletion" };
			return { decision: "confirm", reason: "filesystem deletion" };
		},
	},
	{
		code: "DISK_READ_ONLY",
		matches: (command) =>
			DISK_READ_ONLY.has(command.executable) ||
			command.executable === "fdisk" ||
			command.executable === "parted" ||
			command.executable === "hdparm",
		evaluate: (command) =>
			isReadOnlyDiskCommand(command)
				? { decision: "auto", reason: "disk inspection command" }
				: { decision: "block", reason: "disk or filesystem modification" },
	},
	{
		code: "SYSTEMCTL",
		matches: (command) => command.executable === "systemctl",
		evaluate: (command) => {
			if (hasSystemctlTargetFlag(command.args)) {
				return { decision: "block", reason: "systemctl remote or alternate-root target is not allowed" };
			}
			const subcommand = systemctlSubcommand(command.args);
			if (!subcommand) return { decision: "block", reason: "systemctl command is missing a subcommand" };
			if (["poweroff", "reboot", "halt", "suspend", "hibernate"].includes(subcommand)) {
				return { decision: "block", reason: "host power action" };
			}
			if (SYSTEMCTL_READ_ONLY.has(subcommand)) return { decision: "auto", reason: "systemctl read-only operation" };
			return { decision: "confirm", reason: "systemd service or unit modification" };
		},
	},
	{
		code: "JOURNALCTL",
		matches: (command) => command.executable === "journalctl",
		evaluate: (command) => {
			if (hasStreamingFlag(command.args)) return { decision: "block", reason: "streaming command is not allowed" };
			if (hasJournalFileOption(command.args)) return { decision: "confirm", reason: "journal command may read a file" };
			return hasJournalMutation(command.args)
				? { decision: "confirm", reason: "journal maintenance operation" }
				: { decision: "auto", reason: "journal inspection command" };
		},
	},
	{
		code: "DOCKER",
		matches: (command) => command.executable === "docker" || command.executable === "docker-compose",
		evaluate: (command) => evaluateDocker(command),
	},
	{
		code: "SS",
		matches: (command) => command.executable === "ss",
		evaluate: (command) => {
			if (command.args.some((arg) => arg === "-K" || arg === "--kill")) {
				return { decision: "block", reason: "socket termination" };
			}
			if (command.args.some((arg) =>
				arg === "-D" || arg.startsWith("-D/") || arg === "--diag" || arg.startsWith("--diag=") ||
				arg === "-F" || arg.startsWith("-F/") || arg === "--filter" || arg.startsWith("--filter="),
			)) {
				return { decision: "confirm", reason: "ss may write or load an external filter file" };
			}
			return { decision: "auto", reason: "socket inspection command" };
		},
	},
	{
		code: "IP",
		matches: (command) => command.executable === "ip",
		evaluate: (command) => {
			if (command.args.some((arg) => arg === "-b" || arg === "-batch" || arg === "--batch" || arg.startsWith("-b/"))) {
				return { decision: "block", reason: "ip batch execution is not allowed" };
			}
			if (command.args.includes("exec") || command.args.includes("monitor")) {
				return { decision: "block", reason: "nested or streaming network command is not allowed" };
			}
			if (hasNetworkMutation(command.args)) return { decision: "block", reason: "network configuration modification" };
			return { decision: "auto", reason: "network inspection command" };
		},
	},
	{
		code: "HOSTNAME",
		matches: (command) => command.executable === "hostname",
		evaluate: (command) =>
			isSafeHostnameArgs(command.args)
				? { decision: "auto", reason: "hostname inspection command" }
				: { decision: "confirm", reason: "hostname modification or non-read-only flags" },
	},
	{
		code: "INTERACTIVE_COMMAND",
		matches: (command) => command.executable === "less" || command.executable === "more",
		evaluate: () => ({ decision: "block", reason: "interactive pager is not allowed" }),
	},
	{
		code: "STREAMING_READ",
		matches: (command) => command.executable === "tail",
		evaluate: (command) =>
			hasStreamingFlag(command.args)
				? { decision: "block", reason: "streaming command is not allowed" }
				: { decision: "auto", reason: "read-only command allowlist" },
	},
	{
		code: "PROCESS_ENVIRONMENT",
		matches: (command) => command.executable === "ps" && command.args.some((arg) => /^[a-z]*e[a-z]*$/.test(arg) && arg.length <= 5),
		evaluate: () => ({ decision: "confirm", reason: "process environment may contain secrets" }),
	},
	{
		code: "STDIN_READ",
		matches: (command) => readsFromStdin(command),
		evaluate: () => ({ decision: "block", reason: "reading from stdin is not allowed" }),
	},
	{
		code: "READ_ONLY_COMMAND",
		matches: (command) => READ_ONLY_COMMANDS.has(command.executable),
		evaluate: () => ({ decision: "auto", reason: "read-only command allowlist" }),
	},
	{
		code: "WRITE_COMMAND",
		matches: (command) => WRITE_COMMANDS.has(command.executable),
		evaluate: () => ({ decision: "confirm", reason: "filesystem or process modification" }),
	},
];

// ── public API ──

export function assessRemoteCommand(command: string, policy: RemoteExecPolicy): CommandAssessment {
	const parsed = parseVerifiedCommand(command);
	if (!parsed.ok) return assessmentFromFailure(parsed);
	return assessVerifiedCommand(parsed.command, policy);
}

export function assessVerifiedCommand(command: VerifiedCommand, policy: RemoteExecPolicy): CommandAssessment {
	const rule = COMMAND_RULES.find((candidate) => candidate.matches(command));
	const base = rule
		? { ...rule.evaluate(command), code: rule.code }
		: { decision: "block" as const, reason: "command is not in the command rule table", code: "UNKNOWN_COMMAND" };

	if (base.decision === "block") {
		return { risk: "block", reasons: [base.reason], code: base.code, command };
	}

	if (isWriteLike(command.executable, command) && containsProtectedPath(writePathOperands(command))) {
		return {
			risk: "block",
			reasons: ["writes a protected system path"],
			code: "PROTECTED_WRITE_PATH",
			command,
		};
	}

	const sensitivePath = containsSensitivePath(readPathOperands(command));
	if (sensitivePath && base.decision === "auto") {
		return applyPolicy(
			{ decision: "confirm", reason: `may read sensitive path: ${sensitivePath}`, code: "SENSITIVE_READ" },
			command,
			policy,
		);
	}

	return applyPolicy(base, command, policy);
}

export function formatVerifiedCommand(command: VerifiedCommand): string {
	return [command.executionPath, ...command.args].map(shellQuote).join(" ");
}

// ── internal ──

function applyPolicy(
	base: { decision: RuleDecision; reason: string; code: string },
	command: VerifiedCommand,
	policy: RemoteExecPolicy,
): CommandAssessment {
	if (base.decision === "auto" && policy === "confirm-all") {
		return { risk: "confirm", reasons: ["policy requires confirmation", base.reason], code: "POLICY_CONFIRM_ALL", command };
	}
	if (base.decision === "confirm" && policy === "read-only") {
		return { risk: "block", reasons: ["command is not allowed by read-only policy", base.reason], code: "POLICY_READ_ONLY", command };
	}
	return { risk: base.decision, reasons: [base.reason], code: base.code, command };
}

function assessmentFromFailure(failure: VerificationFailure): CommandAssessment {
	return { risk: "block", reasons: [failure.reason], code: failure.code };
}

function shellQuote(value: string): string {
	if (/^[A-Za-z0-9_./:+@%=-]+$/.test(value)) return value;
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}
