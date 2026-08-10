import type { DoctorCheck, DoctorReport } from "./doctor-service.js";

export function renderDoctorReport(report: DoctorReport): string {
	const lines = [
		"Remote Ops Doctor",
		report.profile ? `Profile: ${report.profile}` : "Scope: project setup readiness",
		"",
		...report.checks.map(renderCheck),
	];
	if (report.guide.length > 0) {
		lines.push("", "配置指引", ...report.guide);
	}
	return lines.join("\n");
}

export function buildBootstrapGuide(input: { configPath: string; profile?: string }): string[] {
	const guide = [
		"1. 将 piexec 二进制拷到目标服务器并启动：",
		"   # 在目标 Linux 服务器上",
		"   ./piexec --token=<token> --port=9090 &",
		"",
		`2. 编辑 ${input.configPath}，配置 profile：`,
		"   /remote-init   # 生成模板",
		"   然后修改 host / port / token / cwd / policy",
		"",
		"3. 回到 Pi 验证：",
		"   /reload",
	];
	if (input.profile) {
		guide.push(`   /remote-doctor ${input.profile}`);
	}
	return guide;
}

export function buildProfileRepairGuide(input: {
	configPath: string;
	profile: string;
	host: string;
	port: number;
}): string[] {
	return [
		`1. 确认 piexec 在 ${input.host}:${input.port} 上正在运行。`,
		`2. 在目标服务器上检查：curl -H "Authorization: Bearer <token>" http://localhost:${input.port}/health`,
		`3. 确认 ${input.configPath} 中 profile "${input.profile}" 的 host/port/token 正确。`,
	];
}

function renderCheck(check: DoctorCheck): string {
	const tag = check.status === "pass" ? "PASS" : check.status === "warn" ? "WARN" : "FAIL";
	return `[${tag}] ${check.name}: ${check.detail}`;
}
