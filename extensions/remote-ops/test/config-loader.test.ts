import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadRemoteOpsConfig } from "../src/config/loader.js";

test("config loader includes the absolute file path in validation errors", async () => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "remote-ops-config-error-"));
	await mkdir(path.join(cwd, ".pi"));
	await writeFile(
		path.join(cwd, ".pi", "remote-ops.json"),
		JSON.stringify({
			version: 3,
			profiles: { test: { host: "ok", port: 9090, token: "x", cwd: "not-absolute", policy: "confirm-all" } },
		}),
	);

	await assert.rejects(
		() => loadRemoteOpsConfig(cwd),
		(error: unknown) =>
			error instanceof Error &&
			error.message.includes(path.join(cwd, ".pi", "remote-ops.json")) &&
			error.message.includes("absolute POSIX path"),
	);
});
