import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SystemAdapterFactory } from "../adapters/registry.js";
import { hasRemoteOpsConfig, loadRemoteOpsConfig, remoteOpsConfigPath } from "../config/loader.js";
import { createRemoteOpsConfigTemplate } from "../config/template.js";
import { buildRemoteOpsAgentPrompt } from "../prompt/profile-catalog.js";
import { renderDoctorReport } from "../doctor/guides.js";
import { runRemoteDoctor } from "../doctor/doctor-service.js";
import { RemoteOpsConfigError } from "../config/schema.js";
import type { RemoteOpsConfig } from "../config/types.js";
import {
	RemoteOpsService,
	type OperationExecutionContext,
	type OperationResult,
	type RemoteExecRequest,
} from "../operations/service.js";
import { RemoteOpsError } from "./errors.js";

export class RemoteOpsExtensionRuntime {
	private config: RemoteOpsConfig | undefined;
	private configPath: string | undefined;
	private configPresent = false;
	private service: RemoteOpsService | undefined;
	private configError: string | undefined;
	private configApprovedForSession = false;

	async sessionStart(ctx: ExtensionContext): Promise<void> {
		this.config = undefined;
		this.configPath = undefined;
		this.configPresent = await hasRemoteOpsConfig(ctx.cwd);
		this.service = undefined;
		this.configError = undefined;
		this.configApprovedForSession = false;
		if (!this.configPresent) {
			ctx.ui.setStatus("remote-ops", undefined);
			return;
		}
		if (ctx.isProjectTrusted()) {
			const configPath = await remoteOpsConfigPath(ctx.cwd);
			await this.loadTrustedConfig(ctx).catch((error) => {
				if (ctx.hasUI) ctx.ui.notify(formatConfigError(configPath, error), "error");
			});
			return;
		}
		ctx.ui.setStatus("remote-ops", ctx.ui.theme.fg("warning", "remote-ops: config needs approval"));
	}

	sessionShutdown(ctx: ExtensionContext): void {
		ctx.ui.setStatus("remote-ops", undefined);
	}

	isConfigured(): boolean {
		return this.configPresent;
	}

	getAgentPrompt(userPrompt: string): string | undefined {
		if (this.config) return buildRemoteOpsAgentPrompt(this.config, userPrompt);
		if (this.configPresent && this.configError) {
			return "Remote Ops configuration is invalid. Do not attempt remote tools; ask the user to run /remote-status and fix .pi/remote-ops.json.";
		}
		if (this.configPresent) {
			return "Remote Ops configuration exists but has not been approved or loaded yet. Do not invent remote profiles.";
		}
		return undefined;
	}

	async remoteExec(
		request: RemoteExecRequest,
		ctx: ExtensionContext,
		onUpdate?: (message: string) => void,
	): Promise<OperationResult> {
		const service = await this.ensureService(ctx);
		return service.remoteExec(request, this.operationContext(ctx, onUpdate));
	}

	async initializeConfig(ctx: ExtensionCommandContext): Promise<void> {
		const configPath = await remoteOpsConfigPath(ctx.cwd);
		if (await exists(configPath)) {
			ctx.ui.notify(`remote-ops: configuration already exists at ${configPath}; it was not overwritten`, "warning");
			return;
		}
		await mkdir(path.dirname(configPath), { recursive: true });
		try {
			await writeFile(configPath, createRemoteOpsConfigTemplate(), { encoding: "utf8", flag: "wx" });
		} catch (error: unknown) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") {
				ctx.ui.notify(`remote-ops: configuration already exists at ${configPath}; it was not overwritten`, "warning");
				return;
			}
			throw error;
		}
		this.configPresent = true;
		this.configApprovedForSession = true;
		await this.loadTrustedConfig(ctx);
		ctx.ui.notify(`remote-ops: created ${configPath}\nEdit profiles, then run /remote-status.`, "info");
	}

	async status(ctx: ExtensionCommandContext): Promise<void> {
		const configPath = await remoteOpsConfigPath(ctx.cwd);
		if (!(await exists(configPath))) {
			ctx.ui.notify(`remote-ops: no project configuration at ${configPath}`, "info");
			return;
		}
		if (!ctx.isProjectTrusted() && !this.configApprovedForSession) {
			ctx.ui.notify(`remote-ops: configuration needs approval before it can be read\n${configPath}`, "warning");
			return;
		}
		try {
			const service = await this.ensureService(ctx);
			void service;
		} catch (error) {
			ctx.ui.notify(formatConfigError(configPath, error), "error");
			return;
		}
		const config = this.config!;
		const entries = Object.entries(config.profiles);
		const lines = [`Configuration: ${this.configPath}`, `Profiles: ${entries.length}`];
		for (const [name, p] of entries) {
			lines.push(`- ${name}: ${p.host}:${p.port} → ${p.cwd} (${p.policy})`);
		}
		ctx.ui.notify(lines.join("\n"), "info");
	}

	async doctor(profile: string | undefined, ctx: ExtensionCommandContext): Promise<void> {
		let config: RemoteOpsConfig | undefined;
		if (profile) {
			try {
				await this.ensureService(ctx);
				config = this.config;
			} catch (error) {
				const configPath = await remoteOpsConfigPath(ctx.cwd);
				const bootstrap = await runRemoteDoctor({ cwd: ctx.cwd, profile });
				ctx.ui.notify(`${formatConfigError(configPath, error)}\n\n${renderDoctorReport(bootstrap)}`, "error");
				return;
			}
		}
		try {
			const report = await runRemoteDoctor({ cwd: ctx.cwd, profile, config });
			const hasFailure = report.checks.some((check) => check.status === "fail");
			ctx.ui.notify(renderDoctorReport(report), hasFailure ? "warning" : "info");
		} catch (error) {
			const configPath = await remoteOpsConfigPath(ctx.cwd);
			ctx.ui.notify(formatConfigError(configPath, error), "error");
		}
	}

	private async ensureService(ctx: ExtensionContext): Promise<RemoteOpsService> {
		if (this.service) return this.service;
		if (!(await hasRemoteOpsConfig(ctx.cwd))) {
			throw new RemoteOpsError(`No project configuration found at ${await remoteOpsConfigPath(ctx.cwd)}`, "CONFIG_NOT_FOUND");
		}
		if (!ctx.isProjectTrusted() && !this.configApprovedForSession) {
			if (!ctx.hasUI) {
				throw new RemoteOpsError("Remote operations require project configuration approval in an interactive session", "CONFIG_APPROVAL_REQUIRED");
			}
			const configPath = await remoteOpsConfigPath(ctx.cwd);
			const approved = await ctx.ui.confirm(
				"remote-ops: trust project configuration",
				[`Project configuration: ${configPath}`, "", "This configuration can name remote hosts.", "Approve reading it for this Pi session?"].join("\n"),
			);
			if (!approved) throw new RemoteOpsError("Project remote-ops configuration was not approved", "CONFIG_APPROVAL_DENIED");
			this.configApprovedForSession = true;
		}
		await this.loadTrustedConfig(ctx);
		if (!this.service) throw new RemoteOpsError(this.configError ?? "Unable to load remote-ops configuration", "CONFIG_ERROR");
		return this.service;
	}

	private async loadTrustedConfig(ctx: ExtensionContext): Promise<void> {
		const configPath = await remoteOpsConfigPath(ctx.cwd);
		try {
			const loaded = await loadRemoteOpsConfig(ctx.cwd);
			this.config = loaded.config;
			this.configPath = loaded.path;
			this.service = new RemoteOpsService(loaded.config.profiles, new SystemAdapterFactory());
			this.configError = undefined;
			const count = Object.keys(loaded.config.profiles).length;
			ctx.ui.setStatus("remote-ops", ctx.ui.theme.fg("accent", `remote-ops: ${count} profiles`));
		} catch (error) {
			this.config = undefined;
			this.service = undefined;
			this.configError = messageOf(error);
			ctx.ui.setStatus("remote-ops", ctx.ui.theme.fg("error", "remote-ops: config error; run /remote-status"));
			throw error;
		}
	}

	private operationContext(ctx: ExtensionContext, onUpdate?: (message: string) => void): OperationExecutionContext {
		return {
			cwd: ctx.cwd,
			signal: ctx.signal,
			onUpdate,
			ui: {
				hasUI: ctx.hasUI,
				confirm: (title, message) => ctx.ui.confirm(title, message),
			},
		};
	}
}

export async function hasProjectRemoteOpsConfig(cwd: string): Promise<boolean> {
	return exists(path.join(cwd, ".pi", "remote-ops.json"));
}

async function exists(filePath: string): Promise<boolean> {
	try {
		await access(filePath);
		return true;
	} catch {
		return false;
	}
}

function messageOf(error: unknown): string {
	if (error instanceof RemoteOpsConfigError || error instanceof Error) return error.message;
	return String(error);
}

function formatConfigError(configPath: string, error: unknown): string {
	return [
		"remote-ops 配置加载失败",
		`文件：${configPath}`,
		`原因：${messageOf(error)}`,
		"建议：检查 profiles 配置，然后执行 /reload。",
	].join("\n");
}
