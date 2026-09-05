import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { CommandCodeQuotaController } from "../src/quota-controller.ts";
import { getQuotaCachePaths } from "../src/quota-cache.ts";
import type { CommandCodeCredential } from "../src/usage-types.ts";
import type { CommandCodeQuotaResult } from "../src/quota-types.ts";

function context(statuses: Array<string | undefined>, provider = "commandcode") {
	return {
		hasUI: false,
		model: { provider, id: "test-model" },
		ui: {
			setStatus(_key: string, status: string | undefined) { statuses.push(status); },
			theme: { fg: (_color: string, text: string) => text },
		},
	} as never;
}

const credential: CommandCodeCredential = { access: "command-test-token" };
const success: CommandCodeQuotaResult = {
	status: "success",
	quota: { fiveHour: { used: 20, cap: 100, exceeded: false }, weekly: null },
};
const failure: CommandCodeQuotaResult = { status: "error", quota: null, error: "network failure" };

test("command result updates status immediately without another API request", async () => {
	const root = await mkdtemp(join(tmpdir(), "commandcode-quota-controller-"));
	const paths = getQuotaCachePaths(join(root, "agent"));
	let current: CommandCodeCredential | null = null;
	let requests = 0;
	const statuses: Array<string | undefined> = [];
	const controller = new CommandCodeQuotaController({
		cachePaths: paths,
		readCredential: () => current,
		fetchQuota: async () => { requests += 1; return success; },
	});
	try {
		controller.start(context(statuses));
		current = credential;
		await controller.applyCommandResult(credential, success, new Date("2026-09-01T00:00:00.000Z"));
		assert.equal(requests, 0);
		assert.equal(statuses.at(-1), "CommandCode·5h 80%");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("a newer command result wins concurrent cache writes", async () => {
	const root = await mkdtemp(join(tmpdir(), "commandcode-quota-controller-"));
	const paths = getQuotaCachePaths(join(root, "agent"));
	const older: CommandCodeQuotaResult = { status: "success", quota: { fiveHour: { used: 60, cap: 100, exceeded: false }, weekly: null } };
	const newer: CommandCodeQuotaResult = { status: "success", quota: { fiveHour: { used: 10, cap: 100, exceeded: false }, weekly: null } };
	const controller = new CommandCodeQuotaController({ cachePaths: paths, readCredential: () => null });
	try {
		await Promise.all([
			controller.applyCommandResult(credential, older, new Date("2026-09-01T00:00:00.000Z")),
			controller.applyCommandResult(credential, newer, new Date("2026-09-01T00:00:01.000Z")),
		]);
		const cache = JSON.parse(await readFile(paths.cacheFile, "utf-8")) as Record<string, { observedAt: number; result: CommandCodeQuotaResult }>;
		const entry = Object.values(cache)[0]!;
		assert.equal(entry.observedAt, Date.parse("2026-09-01T00:00:01.000Z"));
		assert.equal(entry.result.status, "success");
		assert.equal(entry.result.quota?.fiveHour?.used, 10);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("status is hidden for non-commandcode models and restored after switching back", async () => {
	const root = await mkdtemp(join(tmpdir(), "commandcode-quota-controller-"));
	const paths = getQuotaCachePaths(join(root, "agent"));
	let current: CommandCodeCredential | null = null;
	const statuses: Array<string | undefined> = [];
	const controller = new CommandCodeQuotaController({ cachePaths: paths, readCredential: () => current });
	try {
		const commandContext = context(statuses);
		controller.start(commandContext);
		current = credential;
		await controller.applyCommandResult(credential, success, new Date("2026-09-01T00:00:00.000Z"));
		assert.equal(statuses.at(-1), "CommandCode·5h 80%");

		controller.handleModelSelected(commandContext, { provider: "anthropic", id: "test-model" });
		assert.equal(statuses.at(-1), undefined);

		controller.handleModelSelected(context(statuses, "anthropic"), { provider: "commandcode", id: "test-model" });
		assert.equal(statuses.at(-1), "CommandCode·5h 80%");
	} finally {
		current = null;
		controller.stop(context(statuses));
		await rm(root, { recursive: true, force: true });
	}
});

test("command failure is unavailable and a later command success clears retry state", async () => {
	const root = await mkdtemp(join(tmpdir(), "commandcode-quota-controller-"));
	const paths = getQuotaCachePaths(join(root, "agent"));
	let current: CommandCodeCredential | null = null;
	const statuses: Array<string | undefined> = [];
	const controller = new CommandCodeQuotaController({ cachePaths: paths, readCredential: () => current });
	try {
		controller.start(context(statuses));
		current = credential;
		await controller.applyCommandResult(credential, failure, new Date("2026-09-01T00:00:00.000Z"));
		assert.equal(statuses.at(-1), "CommandCode·quota unavailable");
		await controller.applyCommandResult(credential, success, new Date("2026-09-01T00:00:01.000Z"));
		assert.equal(statuses.at(-1), "CommandCode·5h 80%");
		const cache = JSON.parse(await readFile(paths.cacheFile, "utf-8")) as Record<string, { retryCount: number; nextRetryAt?: number }>;
		const entry = Object.values(cache)[0]!;
		assert.equal(entry.retryCount, 0);
		assert.equal(entry.nextRetryAt, undefined);
	} finally {
		current = null;
		controller.stop(context(statuses));
		await rm(root, { recursive: true, force: true });
	}
});
