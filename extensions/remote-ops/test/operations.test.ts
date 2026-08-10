import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AdapterFactory, RemoteAdapter, RemoteExecInput, RemoteExecResult } from "../src/adapters/types.js";
import type { RemoteExecProfile } from "../src/config/types.js";
import { RemoteOpsService, type RemoteOpsUi } from "../src/operations/service.js";

const profiles: Record<string, RemoteExecProfile> = {
	production: { host: "prod-api", port: 9090, token: "secret", cwd: "/root", policy: "confirm-write" },
};

class FakeAdapter implements RemoteAdapter {
	lastCommand: RemoteExecInput | undefined;

	async execute(input: RemoteExecInput): Promise<RemoteExecResult> {
		this.lastCommand = input;
		return { exitCode: 0, output: "service active\n", timedOut: false, cancelled: false };
	}
}

class FakeFactory implements AdapterFactory {
	readonly adapter: FakeAdapter;

	constructor(adapter: FakeAdapter) {
		this.adapter = adapter;
	}

	create(): RemoteAdapter {
		return this.adapter;
	}
}

function approvedUi(): { ui: RemoteOpsUi; calls: Array<{ title: string; message: string }> } {
	const calls: Array<{ title: string; message: string }> = [];
	return {
		ui: { hasUI: true, async confirm(title, message) { calls.push({ title, message }); return true; } },
		calls,
	};
}

test("blocked remote_exec commands surface the profile and command", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "remote-ops-blocked-"));
	const service = new RemoteOpsService(profiles, new FakeFactory(new FakeAdapter()));
	const { ui } = approvedUi();

	await assert.rejects(
		() => service.remoteExec({ profile: "production", command: "rm -rf /tmp/jiti" }, { cwd: root, ui }),
		(error: unknown) => {
			const message = error instanceof Error ? error.message : "";
			assert.match(message, /Blocked remote command for profile "production"/);
			assert.match(message, /rm -rf \/tmp\/jiti/);
			return true;
		},
	);
});

test("remote_exec auto-runs read-only and confirms modifications", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "remote-ops-exec-"));
	const adapter = new FakeAdapter();
	const service = new RemoteOpsService(profiles, new FakeFactory(adapter));
	const { ui, calls } = approvedUi();

	const auto = await service.remoteExec({ profile: "production", command: "systemctl status app.service" }, { cwd: root, ui });
	assert.equal(auto.details.risk, "auto");
	assert.deepEqual(adapter.lastCommand?.command, {
		executable: "systemctl",
		executionPath: "systemctl",
		args: ["status", "app.service"],
	});
	assert.equal(calls.length, 1);

	const changed = await service.remoteExec({ profile: "production", command: "systemctl restart app.service" }, { cwd: root, ui });
	assert.equal(changed.details.risk, "confirm");
	assert.equal(calls.length, 2);
});
