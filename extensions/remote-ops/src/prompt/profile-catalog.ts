import type { RemoteExecProfile, RemoteOpsConfig } from "../config/types.js";

const MAX_PROFILES_IN_PROMPT = 20;
const REMOTE_INTENT_PATTERN =
	/(?:\bremote\b|\bserver\b|\blinux\b|\bsystemctl\b|\bjournalctl\b|\bdocker\b|远程|远端|服务器|主机)/i;

interface ProfilePromptEntry {
	name: string;
	profile: RemoteExecProfile;
}

export function buildRemoteOpsAgentPrompt(config: RemoteOpsConfig, userPrompt: string): string {
	const entries = Object.entries(config.profiles).map(([name, profile]) => ({ name, profile }));
	const shown = entries.slice(0, MAX_PROFILES_IN_PROMPT);
	const lines = [
		"Remote Ops is available for this project via piexec.",
		"Use the exact profile names below; never invent a profile name.",
		"Use the remote_exec tool to run commands on configured remote servers.",
		"",
		"Configured profiles:",
	];

	if (shown.length === 0) {
		lines.push("- No profiles configured. Ask the user to edit .pi/remote-ops.json.");
	} else {
		for (const entry of shown) lines.push(formatProfile(entry));
		if (entries.length > shown.length) lines.push(`- ${entries.length - shown.length} additional profile(s) omitted.`);
	}

	lines.push(
		"",
		"Routing rules:",
		"- Remote Linux/server, logs, processes, services → use remote_exec.",
		"- A profile cwd is the default working directory, not a filesystem access boundary.",
		"- If no profile matches, ask the user which one to use.",
	);

	if (REMOTE_INTENT_PATTERN.test(userPrompt)) {
		lines.push(
			"",
			"REMOTE OPERATION INTENT DETECTED: call remote_exec now instead of suggesting manual steps.",
		);
	}

	return lines.join("\n");
}

function formatProfile(entry: ProfilePromptEntry): string {
	const p = entry.profile;
	const description = p.description ?? `run commands on ${p.host}`;
	const details = [`host ${p.host}:${p.port}`, `cwd ${p.cwd}`, `policy ${p.policy}`];
	return `- remote_exec(profile: "${entry.name}"): ${description}. [${details.join(", ")}]`;
}
