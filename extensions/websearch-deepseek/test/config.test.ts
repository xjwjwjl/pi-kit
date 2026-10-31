import assert from "node:assert/strict";
import test from "node:test";
import { missingApiKeyMessage, normalizeBaseUrl, resolveConfig } from "../config.ts";
import { withTempAgentDir, writeSettings } from "./helpers.ts";

test("normalizes base URLs", () => {
	assert.equal(normalizeBaseUrl(undefined), "https://api.deepseek.com");
	assert.equal(normalizeBaseUrl("https://api.deepseek.com/"), "https://api.deepseek.com");
	assert.equal(normalizeBaseUrl("https://api.deepseek.com/v1/"), "https://api.deepseek.com");
	assert.equal(
		normalizeBaseUrl("https://api.deepseek.com/proxy/"),
		"https://api.deepseek.com/proxy",
	);
	assert.throws(() => normalizeBaseUrl("ftp://api.deepseek.com"), /HTTP and HTTPS/);
	assert.throws(() => normalizeBaseUrl("not a url"), /Invalid/);
});

test("uses the environment API key as a fallback", async () => {
	await withTempAgentDir(async () => {
		process.env.DEEPSEEK_API_KEY = "env-key";
		const config = resolveConfig();
		assert.equal(config.apiKey, "env-key");
		assert.equal(config.apiKeySource, "environment");
	});
});

test("prefers the settings API key over the environment", async () => {
	await withTempAgentDir(async (agentDir) => {
		await writeSettings(agentDir, { apiKey: "settings-key", timeZone: "Asia/Shanghai" });
		process.env.DEEPSEEK_API_KEY = "env-key";
		const config = resolveConfig();
		assert.equal(config.apiKey, "settings-key");
		assert.equal(config.apiKeySource, "settings");
		assert.equal(config.timeZone, "Asia/Shanghai");
	});
});

test("reports the settings path in the missing-key message", () => {
	assert.match(
		missingApiKeyMessage("/home/user/.pi/agent/settings.json"),
		/\/home\/user\/\.pi\/agent\/settings\.json/,
	);
	assert.match(missingApiKeyMessage("/tmp/settings.json"), /DEEPSEEK_API_KEY/);
});
