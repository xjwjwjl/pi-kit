import { appendFileSync, writeFileSync } from "node:fs";

const [agentDir, donePath, mode] = process.argv.slice(2);
if (!agentDir || !donePath || !["failure", "success", "cancel"].includes(mode ?? "")) {
	process.exitCode = 2;
} else {
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const { default: codexUsage } = await import("../index.ts");
	const handlers = new Map<string, (event: unknown, ctx: unknown) => void | Promise<void>>();
	const statuses: Array<string | undefined> = [];
	let shutdownRequested = false;
	let watchdog: ReturnType<typeof setTimeout> | undefined;

	const ctx = {
		hasUI: false,
		model: { provider: "openai-codex", id: "test-model" },
		signal: undefined,
		ui: {
			setStatus(_key: string, status: string | undefined) {
				statuses.push(status);
				if ((mode === "failure" && status?.includes("quota unavailable")) || (mode === "success" && status?.includes("%"))) {
					writeFileSync(donePath, JSON.stringify(statuses), "utf-8");
					handlers.get("session_shutdown")?.({}, ctx);
					if (watchdog) clearTimeout(watchdog);
					setTimeout(() => process.exit(0), 0);
				}
				if (mode === "cancel" && status === "Codex·refreshing" && !shutdownRequested) {
					shutdownRequested = true;
					watchdog?.unref?.();
					setTimeout(() => handlers.get("session_shutdown")?.({}, ctx), 25);
				}
			},
			theme: { fg: (_color: string, text: string) => text },
		},
	};

	codexUsage({
		on(event: string, handler: (event: unknown, ctx: unknown) => void | Promise<void>) { handlers.set(event, handler); },
		events: { on() {} },
		registerCommand() {},
	} as never);

	const sessionStart = handlers.get("session_start");
	if (!sessionStart) process.exitCode = 3;
	else {
		const originalDateNow = Date.now;
		const now = originalDateNow();
		const refreshMs = 5 * 60 * 1000;
		const nextBoundary = (Math.floor(now / refreshMs) + 1) * refreshMs;
		Date.now = () => nextBoundary - 25;
		watchdog = setTimeout(() => {
			appendFileSync(donePath, "watchdog timeout\n", "utf-8");
			process.exit(4);
		}, mode === "cancel" ? 2_000 : 5_000);
		try {
			await sessionStart({}, ctx);
		} finally {
			Date.now = originalDateNow;
		}
	}
}
