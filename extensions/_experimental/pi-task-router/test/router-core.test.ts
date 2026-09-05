import assert from "node:assert/strict";
import test from "node:test";
import {
	STRICT_FLASH_FIRST_TURN_SYSTEM_PROMPT,
	STRICT_FLASH_FIRST_TURN_TOOLS,
	beginStrictFlashFirstTurn,
	classifyTask,
	completeStrictFlashFirstTurn,
	emptyRouterState,
	effectiveMode,
	guidanceFor,
	isDeepSeekV4,
	isDeepSeekV4Flash,
	isStrictFlashFirstTurnActive,
	isStrictFlashFirstTurnPending,
	modeSource,
	normalizeRouterState,
	parseRouterCommand,
	strictFlashFirstTurnTools,
	withoutOverride,
	withAutoMode,
	withOverride,
} from "../src/router-core.ts";

test("classifies maintenance work as inspect", () => {
	assert.equal(classifyTask("修复登录报错并排查回归原因"), "inspect");
	assert.equal(classifyTask("Review and refactor the broken migration"), "inspect");
});

test("classifies greenfield delivery work as act", () => {
	assert.equal(classifyTask("从零开发一个内部管理网站并部署"), "act");
	assert.equal(classifyTask("Build and implement a new CLI tool"), "act");
});

test("returns neutral for ties and unmatched prompts", () => {
	assert.equal(classifyTask("开发并修复"), "neutral");
	assert.equal(classifyTask("看看这个开源项目"), "neutral");
	assert.equal(classifyTask(""), "neutral");
});

test("recognizes DeepSeek V4 IDs independently of provider", () => {
	assert.equal(isDeepSeekV4({ provider: "deepseek", id: "deepseek-v4-pro" }), true);
	assert.equal(isDeepSeekV4({ provider: "gogate", id: "deepseek-v4-flash" }), true);
	assert.equal(isDeepSeekV4({ provider: "mydeepseek", id: "DEEPSEEK-V4-PRO" }), true);
	assert.equal(isDeepSeekV4({ provider: "gogate", id: "my-deepseek-v4-proxy" }), false);
	assert.equal(isDeepSeekV4({ provider: "sx", id: "gpt-5.6-terra" }), false);
	assert.equal(isDeepSeekV4(undefined), false);
	assert.equal(isDeepSeekV4Flash({ provider: "gogate", id: "deepseek-v4-flash" }), true);
	assert.equal(isDeepSeekV4Flash({ provider: "deepseek", id: "deepseek-v4-pro" }), false);
});

test("keeps the first automatic mode and lets manual mode override it", () => {
	const initial = withAutoMode({ version: 2 }, "修复缓存问题");
	assert.equal(initial.autoMode, "inspect");
	assert.equal(withAutoMode(initial, "开发一个新工具").autoMode, "inspect");

	const manual = withOverride(initial, "act");
	assert.equal(effectiveMode(manual), "act");
	assert.equal(modeSource(manual), "manual");

	const automatic = withoutOverride(manual);
	assert.equal(effectiveMode(automatic), "inspect");
	assert.equal(modeSource(automatic), "auto");
});

test("normalizes only known persisted fields and safely migrates old state", () => {
	assert.deepEqual(normalizeRouterState({ version: 999, autoMode: "act", overrideMode: "invalid" }), {
		version: 2,
		autoMode: "act",
		flashFirstTurnCompleted: true,
	});
	assert.deepEqual(normalizeRouterState({ version: 1, autoMode: "inspect" }), {
		version: 2,
		autoMode: "inspect",
		flashFirstTurnCompleted: true,
	});
	assert.deepEqual(normalizeRouterState(null), { version: 2 });
});

test("runs the strict Flash profile once and retains a safe restoration path", () => {
	const initial = emptyRouterState();
	assert.equal(isStrictFlashFirstTurnPending(initial), true);
	assert.deepEqual(strictFlashFirstTurnTools(["read", "bash", "edit", "write"]), ["bash", "edit"]);
	assert.equal(strictFlashFirstTurnTools(["read", "bash", "write"]), undefined);

	const active = beginStrictFlashFirstTurn(initial, ["read", "bash", "edit", "write"]);
	assert.equal(isStrictFlashFirstTurnPending(active), false);
	assert.equal(isStrictFlashFirstTurnActive(active), true);
	assert.deepEqual(active.flashFirstTurnRestoreTools, ["read", "bash", "edit", "write"]);
	assert.deepEqual(STRICT_FLASH_FIRST_TURN_TOOLS, ["bash", "edit"]);
	assert.equal(STRICT_FLASH_FIRST_TURN_SYSTEM_PROMPT, "You are a helpful software engineer assistant.");

	const completed = completeStrictFlashFirstTurn(active);
	assert.deepEqual(completed, { version: 2, flashFirstTurnCompleted: true });
	assert.equal(isStrictFlashFirstTurnPending(completed), false);
	assert.equal(isStrictFlashFirstTurnActive(completed), false);
});

test("parses supported router commands and keeps later prompt guidance advisory", () => {
	assert.deepEqual(parseRouterCommand(""), { kind: "status" });
	assert.deepEqual(parseRouterCommand("auto"), { kind: "auto" });
	assert.deepEqual(parseRouterCommand("inspect"), { kind: "set", mode: "inspect" });
	assert.deepEqual(parseRouterCommand("other"), { kind: "invalid", input: "other" });
	assert.match(guidanceFor("inspect")!, /advisory only/i);
	assert.match(guidanceFor("act")!, /advisory only/i);
	assert.equal(guidanceFor("neutral"), undefined);
});
