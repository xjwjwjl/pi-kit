import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { RemoteOpsExtensionRuntime } from "../src/runtime/extension-runtime.js";

function commandContext(cwd: string, notices: string[]): ExtensionCommandContext {
	return {
		cwd,
		hasUI: true,
		isProjectTrusted: () => false,
		ui: {
			theme: { fg: (_color: string, text: string) => text },
			setStatus() {},
			notify(message: string) { notices.push(message); },
			confirm: async () => true,
		},
	} as unknown as ExtensionCommandContext;
}

test("remote-init creates a v3 template and never overwrites it", async () => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "remote-ops-init-"));
	const notices: string[] = [];
	const runtime = new RemoteOpsExtensionRuntime();
	const ctx = commandContext(cwd, notices);
	const configPath = path.join(cwd, ".pi", "remote-ops.json");

	await runtime.initializeConfig(ctx);
	const created = await readFile(configPath, "utf8");
	assert.match(created, /"version": 3/);
	assert.match(created, /"token"/);
	assert.match(created, /"port": 9090/);
	assert.match(notices[0] ?? "", /created/i);

	await runtime.initializeConfig(ctx);
	assert.equal(await readFile(configPath, "utf8"), created);
	assert.match(notices[1] ?? "", /already exists/i);
});
