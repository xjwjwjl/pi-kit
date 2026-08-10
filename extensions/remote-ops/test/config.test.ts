import assert from "node:assert/strict";
import test from "node:test";
import { RemoteOpsConfigError, parseRemoteOpsConfig } from "../src/config/schema.js";

const validConfig = {
	version: 3,
	profiles: {
		production: {
			host: "prod-api",
			port: 9090,
			token: "abc123",
			cwd: "/root",
			policy: "confirm-write" as const,
		},
	},
};

test("parses a valid project remote-ops config", () => {
	const config = parseRemoteOpsConfig(validConfig);
	assert.equal(config.profiles.production?.policy, "confirm-write");
	assert.equal(config.profiles.production?.port, 9090);
	assert.equal(config.profiles.production?.token, "abc123");
});

test("accepts an empty configuration", () => {
	const config = parseRemoteOpsConfig({ version: 3, profiles: {} });
	assert.deepEqual(config.profiles, {});
});

test("rejects unknown fields and invalid values", () => {
	assert.throws(
		() => parseRemoteOpsConfig({ ...validConfig, unexpected: true }),
		(error: unknown) => error instanceof RemoteOpsConfigError && /unknown field/.test(error.message),
	);
	assert.throws(
		() => parseRemoteOpsConfig({ version: 3, profiles: { bad: { host: "ok", port: 9090, token: "x", cwd: "relative", policy: "confirm-write" } } }),
		/absolute POSIX path/,
	);
});

test("rejects invalid port", () => {
	assert.throws(
		() => parseRemoteOpsConfig({ version: 3, profiles: { bad: { host: "ok", port: 99999, token: "x", cwd: "/tmp", policy: "confirm-all" } } }),
		/65535/,
	);
});
