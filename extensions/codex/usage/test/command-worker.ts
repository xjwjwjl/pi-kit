import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCacheEntry, getQuotaCachePaths, savePersistentCache } from "../src/quota-cache.ts";
import type { CodexCredential, UsageResult } from "../src/types.ts";

const [agentDir, donePath, mode] = process.argv.slice(2);
if (!agentDir || !donePath || !["success", "cached-success", "retry-reset", "failure"].includes(mode ?? "")) {
	process.exitCode = 2;
} else {
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const credential: CodexCredential = { access: "test-access-token", expires: Date.now() + 60 * 60 * 1000 };
	const success: UsageResult = {
		status: "success",
		usage: {
			email: "user@example.com",
			plan_type: "pro",
			allowed: true,
			rate_limit: { allowed: true, primary_window: { used_percent: 24, limit_window_seconds: 18_000, reset_after_seconds: 18_000 } },
		},
	};
	const cachedSuccess: UsageResult = {
		status: "success",
		usage: {
			email: "old@example.com",
			plan_type: "pro",
			allowed: true,
			rate_limit: { allowed: true, primary_window: { used_percent: 72, limit_window_seconds: 18_000, reset_after_seconds: 18_000 } },
		},
	};
	const failure: UsageResult = { status: "error", usage: null, error: "curl exit 22" };
	const { default: codexUsage } = await import("../index.ts");
	const handlers = new Map<string, (event: unknown, ctx: unknown) => void | Promise<void>>();
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const notifications: string[] = [];
	const statuses: Array<string | undefined> = [];
	const ctx = {
		hasUI: false,
		model: { provider: "openai-codex", id: "test-model" },
		signal: undefined,
		ui: {
			notify(message: string) { notifications.push(message); },
			setStatus(_key: string, status: string | undefined) { statuses.push(status); },
			theme: { fg: (_color: string, text: string) => text },
		},
	};
	codexUsage({
		on(event: string, handler: (event: unknown, c: unknown) => void | Promise<void>) { handlers.set(event, handler); },
		events: { on() {} },
		registerCommand(name: string, definition: { handler: (args: string, c: unknown) => Promise<void> }) { commands.set(name, definition); },
	} as never);

	const agentAuth = join(agentDir, "auth.json");
	writeFileSync(agentAuth, "{}", "utf-8");
	await handlers.get("session_start")?.({}, ctx);
	const paths = getQuotaCachePaths(agentDir);
	if (mode === "cached-success") savePersistentCache(credential, createCacheEntry(undefined, cachedSuccess, Date.now()), paths);
	if (mode === "retry-reset") savePersistentCache(credential, createCacheEntry(undefined, failure, Date.now()), paths);
	writeFileSync(agentAuth, JSON.stringify({ "openai-codex": { type: "oauth", access: credential.access, expires: credential.expires } }), "utf-8");
	process.env.CODEX_USAGE_FAKE_CURL_MODE = mode === "failure" ? "failure" : "success";

	const command = commands.get("codex-usage");
	if (!command) {
		process.exitCode = 3;
	} else {
		await command.handler("", ctx);
		let cache: unknown;
		try { cache = JSON.parse(readFileSync(paths.cacheFile, "utf-8")); } catch { cache = null; }
		writeFileSync(donePath, JSON.stringify({ notifications, statuses, cache }), "utf-8");
		handlers.get("session_shutdown")?.({}, ctx);
	}
}
