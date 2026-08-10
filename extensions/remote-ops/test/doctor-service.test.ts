import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runRemoteDoctor } from "../src/doctor/doctor-service.js";

const config = {
	version: 3 as const,
	profiles: {
		linux: {
			host: "pi-wsl",
			port: 9090,
			token: "secret",
			cwd: "/tmp",
			policy: "confirm-all" as const,
		},
	},
};

test("doctor gives setup steps without an existing project config", async () => {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "remote-ops-doctor-empty-"));
	const report = await runRemoteDoctor({ cwd });
	assert.equal(report.profile, undefined);
	assert.match(report.guide.join("\n"), /piexec/);
	assert.match(report.guide.join("\n"), /remote-ops\.json/);
});

test("doctor checks proxy connectivity (expected offline in test)", async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), "remote-ops-doctor-profile-"));

	const report = await runRemoteDoctor({
		cwd: root,
		profile: "linux",
		config,
	});
	const conn = report.checks.find((check) => check.name === "Proxy 连通性");
	assert.equal(conn?.status, "fail"); // no real proxy running
	assert.match(report.guide.join("\n"), /piexec/);
});
