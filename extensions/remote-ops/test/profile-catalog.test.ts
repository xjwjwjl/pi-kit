import assert from "node:assert/strict";
import test from "node:test";
import { buildRemoteOpsAgentPrompt } from "../src/prompt/profile-catalog.js";
import type { RemoteOpsConfig } from "../src/config/types.js";

const config: RemoteOpsConfig = {
	version: 3,
	profiles: {
		wsl: {
			description: "生产主机诊断",
			host: "pi-wsl",
			port: 9090,
			token: "secret",
			cwd: "/tmp",
			policy: "confirm-all",
		},
	},
};

test("builds a profile catalog with routing information", () => {
	const prompt = buildRemoteOpsAgentPrompt(config, "检查服务器的服务日志");
	assert.match(prompt, /remote_exec\(profile: "wsl"\): 生产主机诊断/);
	assert.match(prompt, /host pi-wsl:9090/);
	assert.match(prompt, /not a filesystem access boundary/);
	assert.match(prompt, /REMOTE OPERATION INTENT DETECTED/);
});

test("does not force routing for unrelated prompts", () => {
	const prompt = buildRemoteOpsAgentPrompt(config, "解释这个 TypeScript 函数");
	assert.doesNotMatch(prompt, /REMOTE OPERATION INTENT DETECTED/);
});
