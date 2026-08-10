import { access, stat } from "node:fs/promises";
import path from "node:path";
import type { RemoteOpsConfig } from "../config/types.js";
import { buildBootstrapGuide, buildProfileRepairGuide } from "./guides.js";

export type DoctorStatus = "pass" | "warn" | "fail";

export interface DoctorCheck {
	name: string;
	status: DoctorStatus;
	detail: string;
}

export interface DoctorReport {
	profile?: string;
	checks: DoctorCheck[];
	guide: string[];
}

export interface RemoteDoctorInput {
	cwd: string;
	profile?: string;
	config?: RemoteOpsConfig;
}

export async function runRemoteDoctor(input: RemoteDoctorInput): Promise<DoctorReport> {
	const configPath = path.join(input.cwd, ".pi", "remote-ops.json");
	const checks: DoctorCheck[] = [];

	checks.push(
		(await exists(configPath))
			? pass("项目配置", configPath)
			: fail("项目配置", `${configPath} 不存在；先执行 /remote-init`),
	);

	if (!input.profile) {
		return {
			checks,
			guide: buildBootstrapGuide({ configPath }),
		};
	}

	if (!input.config) {
		checks.push(fail("配置加载", "没有加载到合法的 remote-ops 配置；先修复 /remote-status 报告的问题"));
		return {
			profile: input.profile,
			checks,
			guide: buildBootstrapGuide({ configPath, profile: input.profile }),
		};
	}

	const profile = input.config.profiles[input.profile];
	if (!profile) {
		checks.push(fail("Profile", `profiles 中没有找到 "${input.profile}"`));
		return {
			profile: input.profile,
			checks,
			guide: buildBootstrapGuide({ configPath, profile: input.profile }),
		};
	}

	// Check proxy connectivity
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 5_000);
		const resp = await fetch(`http://${profile.host}:${profile.port}/health`, {
			headers: { Authorization: `Bearer ${profile.token}` },
			signal: controller.signal,
		});
		clearTimeout(timer);
		if (resp.ok) {
			const info = (await resp.json()) as { hostname?: string; pid?: number };
			checks.push(pass("Proxy 连通性", `piexec 在线 (${info.hostname ?? profile.host}, pid ${info.pid ?? "?"})`));
		} else {
			checks.push(fail("Proxy 认证", `HTTP ${resp.status}：token 是否匹配？`));
		}
	} catch (error: unknown) {
		const msg = error instanceof Error ? error.message : String(error);
		if (msg.includes("abort") || msg.includes("timeout")) {
			checks.push(fail("Proxy 连通性", `无法连接 ${profile.host}:${profile.port}（超时）`));
		} else {
			checks.push(fail("Proxy 连通性", `无法连接 ${profile.host}:${profile.port}：${msg.slice(0, 100)}`));
		}
	}

	return {
		profile: input.profile,
		checks,
		guide: buildProfileRepairGuide({
			configPath,
			profile: input.profile,
			host: profile.host,
			port: profile.port,
		}),
	};
}

function pass(name: string, detail: string): DoctorCheck {
	return { name, status: "pass", detail };
}

function fail(name: string, detail: string): DoctorCheck {
	return { name, status: "fail", detail };
}

async function exists(filePath: string): Promise<boolean> {
	try {
		await access(filePath);
		return true;
	} catch {
		return false;
	}
}
