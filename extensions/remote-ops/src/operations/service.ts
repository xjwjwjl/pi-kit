import type { AdapterFactory } from "../adapters/types.js";
import type { RemoteExecProfile } from "../config/types.js";
import { resolveTimeout } from "../config/resolver.js";
import { resolveRemotePath } from "../paths.js";
import { assessRemoteCommand, formatVerifiedCommand } from "../policy/command-policy.js";
import { RemoteOpsCancelledError, RemoteOpsError } from "../runtime/errors.js";
import { KeyedMutationQueue } from "../runtime/mutation-queue.js";
import { truncateCommandOutput } from "../runtime/truncate.js";
import { scanSensitiveContent } from "../runtime/secret-scanner.js";

export interface RemoteOpsUi {
	hasUI: boolean;
	confirm(title: string, message: string): Promise<boolean>;
}

export interface OperationExecutionContext {
	cwd: string;
	ui: RemoteOpsUi;
	signal?: AbortSignal;
	onUpdate?: (message: string) => void;
}

export interface RemoteExecRequest {
	profile: string;
	command: string;
	cwd?: string;
	timeout?: number;
}

export interface OperationResult {
	content: string;
	details: Record<string, unknown>;
}

export class RemoteOpsService {
	private readonly approvedHosts = new Set<string>();
	private readonly pendingHostApprovals = new Map<string, Promise<void>>();
	private readonly hostMutations = new KeyedMutationQueue();
	private readonly profiles: Record<string, RemoteExecProfile>;
	private readonly adapters: AdapterFactory;

	constructor(profiles: Record<string, RemoteExecProfile>, adapters: AdapterFactory) {
		this.profiles = profiles;
		this.adapters = adapters;
	}

	async approveProfile(name: string, context: OperationExecutionContext): Promise<void> {
		const profile = this.profiles[name];
		if (!profile) throw new RemoteOpsError(`Unknown profile "${name}"`, "PROFILE_UNKNOWN");
		await this.ensureHostApproved(profile.host, name, context.ui);
	}

	async remoteExec(request: RemoteExecRequest, context: OperationExecutionContext): Promise<OperationResult> {
		const profile = this.profiles[request.profile];
		if (!profile) throw new RemoteOpsError(`Unknown profile "${request.profile}"`, "PROFILE_UNKNOWN");

		const cwd = request.cwd ? resolveRemotePath(profile.cwd, request.cwd) : profile.cwd;
		const timeout = resolveTimeout(request.timeout, profile, 60);
		const assessment = assessRemoteCommand(request.command, profile.policy);

		if (assessment.risk === "block") {
			throw new RemoteOpsError(
				[
					`Blocked remote command for profile "${request.profile}": ${assessment.reasons.join("; ")}.`,
					"",
					"Run this Pi command to open the configured interactive shell:",
					`/remote-shell ${request.profile}`,
					"",
					"Then run this command in that remote shell:",
					request.command,
					"",
					"Do not retry this command through remote_exec.",
				].join("\n"),
				"COMMAND_BLOCKED",
			);
		}
		await this.ensureHostApproved(profile.host, request.profile, context.ui);

		const verified = assessment.command;
		if (!verified) {
			throw new RemoteOpsError("Remote command was not verified", "COMMAND_NOT_VERIFIED");
		}

		if (assessment.risk === "confirm") {
			await this.confirmOrThrow(
				context.ui,
				"remote-ops: confirm remote command",
				[
					`Host: ${profile.host}`,
					`Profile: ${request.profile}`,
					`Risk: ${assessment.reasons.join("; ")}`,
					"",
					`  ${formatVerifiedCommand(verified)}`,
				].join("\n"),
			);
		}

		const execute = async () => {
			const displayCommand = formatVerifiedCommand(verified);
			const riskBadge = assessment.risk === "confirm" ? "⚠ " : "";
			context.onUpdate?.(`→ ${profile.host}: $ ${riskBadge}${displayCommand}`);
			const adapter = this.adapters.create(profile.host, profile.port, profile.token);
			const started = Date.now();
			const result = await adapter.execute({
				cwd,
				command: verified,
				timeoutSeconds: timeout,
				signal: context.signal,
				onOutput: () => {
					const elapsed = ((Date.now() - started) / 1000).toFixed(1);
					context.onUpdate?.(`→ ${profile.host} (running ${elapsed}s)`);
				},
			});
			const elapsed = ((Date.now() - started) / 1000).toFixed(1);
			const output = truncateCommandOutput(result.output);
			const sensitive = scanSensitiveContent(output.text);
			const statusIcon = result.timedOut ? "⏱" : result.cancelled ? "✗" : result.exitCode === 0 ? "✓" : "✗";
			const statusText = result.timedOut
				? `timed out after ${elapsed}s`
				: result.cancelled
					? `cancelled after ${elapsed}s`
					: result.exitCode === 0
						? `${formatSize(output.text)} · ${elapsed}s`
						: `exit ${result.exitCode} · ${formatSize(output.text)} · ${elapsed}s`;
			return {
				content: [
					`── ${profile.host} (${request.profile})`,
					`$ ${displayCommand}`,
					"",
					output.text,
					"",
					`── ${statusIcon} ${statusText}`,
				].join("\n"),
				details: {
					profile: request.profile,
					host: profile.host,
					command: displayCommand,
					argv: { program: verified.executionPath, args: [...verified.args] },
					cwd,
					exitCode: result.exitCode,
					timedOut: result.timedOut,
					cancelled: result.cancelled,
					truncated: output.truncated,
					elapsed,
					omittedLines: output.omittedLines,
					omittedBytes: output.omittedBytes,
					sensitive: sensitive.hasSensitive ? sensitive.patterns : undefined,
					risk: assessment.risk,
					riskCode: assessment.code,
					riskReasons: assessment.reasons,
				},
			};
		};
		return assessment.risk === "auto" ? execute() : this.hostMutations.run(`host:${profile.host}`, execute);
	}

	private async ensureHostApproved(host: string, profileName: string, ui: RemoteOpsUi): Promise<void> {
		if (this.approvedHosts.has(host)) return;
		const pending = this.pendingHostApprovals.get(host);
		if (pending) return pending;

		const approval = this.confirmOrThrow(
			ui,
			"remote-ops: allow SSH host",
			[
				`Host: ${host}`,
				`Profile: ${profileName}`,
				"",
				"Allow this project to connect to the host for the current Pi session?",
			].join("\n"),
		).then(() => {
			this.approvedHosts.add(host);
		});
		this.pendingHostApprovals.set(host, approval);
		try {
			await approval;
		} finally {
			if (this.pendingHostApprovals.get(host) === approval) {
				this.pendingHostApprovals.delete(host);
			}
		}
	}

	private async confirmOrThrow(ui: RemoteOpsUi, title: string, message: string): Promise<void> {
		if (!ui.hasUI) throw new RemoteOpsError("Remote operation requires interactive user confirmation", "CONFIRMATION_REQUIRED");
		const allowed = await ui.confirm(title, message);
		if (!allowed) throw new RemoteOpsCancelledError("Operation cancelled by user");
	}
}

function formatSize(text: string): string {
	const bytes = Buffer.byteLength(text, "utf8");
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1048576) return `${Math.round(bytes / 1024)}KB`;
	return `${(bytes / 1048576).toFixed(1)}MB`;
}
