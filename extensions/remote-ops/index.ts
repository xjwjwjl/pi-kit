import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { hasProjectRemoteOpsConfig, RemoteOpsExtensionRuntime } from "./src/runtime/extension-runtime.js";

const REMOTE_EXEC_SCHEMA = Type.Object({
	profile: Type.String({ description: "Exact profile name from the Remote Ops catalog; do not invent names" }),
	command: Type.String({ description: "Command to run on the remote server via rp-proxy" }),
	cwd: Type.Optional(
		Type.String({
			description:
				"Optional relative directory under the profile cwd. It selects where the command starts; it is not a filesystem access boundary.",
		}),
	),
	timeout: Type.Optional(Type.Integer({ minimum: 1, description: "Operation timeout in seconds" })),
});

export default function remoteOpsExtension(pi: ExtensionAPI): void {
	const runtime = new RemoteOpsExtensionRuntime();

	pi.on("project_trust", async (event, ctx) => {
		if (!(await hasProjectRemoteOpsConfig(event.cwd))) return { trusted: "undecided" };
		if (!ctx.hasUI) return { trusted: "undecided" };
		const approved = await ctx.ui.confirm(
			"remote-ops: trust project",
			[
				`This project contains .pi/remote-ops.json.`,
				"",
				"Remote Ops can use this configuration to contact remote proxy servers after further per-session confirmation.",
				"Trust project resources?",
			].join("\n"),
		);
		return approved ? { trusted: "yes", remember: false } : { trusted: "no", remember: false };
	});

	pi.on("session_start", async (_event, ctx) => {
		await runtime.sessionStart(ctx);
	});
	pi.on("session_shutdown", (_event, ctx) => {
		runtime.sessionShutdown(ctx);
	});

	pi.on("before_agent_start", (event) => {
		const remoteOpsPrompt = runtime.getAgentPrompt(event.prompt);
		if (!remoteOpsPrompt) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${remoteOpsPrompt}` };
	});

	pi.registerTool({
		name: "remote_exec",
		label: "Remote Exec",
		description:
			"Run a diagnostic or operational command on a configured remote server via rp-proxy. Use it for logs, processes, services, files, and system diagnostics. Strict read-only commands may run automatically; changing or uncertain commands require confirmation, while high-risk commands are blocked.",
		promptSnippet: "Run a guarded diagnostic or operational command on configured remote servers",
		promptGuidelines: [
			"Use remote_exec whenever the user asks to inspect or operate a configured remote server's logs, processes, services, or files.",
			"Use the exact profile name shown in the Remote Ops catalog; do not invent a profile name.",
			"When remote_exec blocks a command, surface the reason and the command to the user; do not retry around the block.",
		],
		parameters: REMOTE_EXEC_SCHEMA,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const result = await runtime.remoteExec(params, ctx, (message) => {
				onUpdate?.({ content: [{ type: "text", text: message }], details: {} });
			});
			pi.appendEntry("remote-ops-operation", { operation: "remote_exec", ...result.details });
			return { content: [{ type: "text", text: result.content }], details: result.details };
		},
	});

	pi.registerCommand("remote-init", {
		description: "Create a non-overwriting project .pi/remote-ops.json configuration skeleton",
		handler: async (_args, ctx) => {
			await runtime.initializeConfig(ctx);
		},
	});

	pi.registerCommand("remote-status", {
		description: "Show project remote-ops profiles",
		handler: async (_args, ctx) => {
			await runtime.status(ctx);
		},
	});

	pi.registerCommand("remote-doctor", {
		description: "Diagnose project configuration and proxy connectivity",
		handler: async (args, ctx) => {
			await runtime.doctor(args.trim() || undefined, ctx);
		},
	});
}
