import assert from "node:assert/strict";
import test from "node:test";
import { chartTypeGuidance, detectChartType } from "../src/core/chart-types.js";
import { isPiDrawRequest } from "../src/core/prompts.js";
import { buildDrawRequestPrompt } from "../src/core/request.js";

test("detects explicit chart types from Chinese and English prompts", () => {
	assert.equal(detectChartType("画一个用户登录流程图"), "flowchart");
	assert.equal(detectChartType("生成 OAuth sequence diagram"), "sequence");
	assert.equal(detectChartType("设计一个电商系统 ER 图"), "er");
	assert.equal(detectChartType("整理服务状态图"), "state");
});

test("returns specific visual guidance for a detected chart type", () => {
	const guidance = chartTypeGuidance("请画一个接口调用时序图");

	assert.match(guidance, /时序图视觉规范/);
	assert.match(guidance, /生命线/);
	assert.match(guidance, /消息/);
});

test("returns chart type selection guidance when no type is explicit", () => {
	const guidance = chartTypeGuidance("梳理这段业务逻辑");

	assert.match(guidance, /图表类型选择指导/);
	assert.match(guidance, /流程图 \(flowchart\)/);
	assert.match(guidance, /信息图 \(infographic\)/);
});

test("draw request prompt includes matching chart type guidance", () => {
	const prompt = buildDrawRequestPrompt("画一个用户登录流程图");

	assert.match(prompt, /流程图视觉规范/);
	assert.match(prompt, /开始\/结束用 ellipse/);
	assert.match(prompt, /用户需求：画一个用户登录流程图/);
});

test("draw request prompt can force Excalidraw mode", () => {
	const prompt = buildDrawRequestPrompt("把这段 Mermaid 画成可编辑图", { mode: "excalidraw" });

	assert.match(prompt, /渲染模式：Excalidraw/);
	assert.match(prompt, /调用 pi_draw_save_scene 保存/);
	assert.match(prompt, /不要调用 pi_draw_save_mermaid_scene/);
});

test("draw request prompt can force Mermaid mode", () => {
	const prompt = buildDrawRequestPrompt("画一个登录流程图", { mode: "mermaid" });

	assert.match(prompt, /渲染模式：Mermaid/);
	assert.match(prompt, /调用 pi_draw_save_mermaid_scene 保存/);
	assert.match(prompt, /不要转换成 ExcalidrawElementSkeleton/);
	assert.doesNotMatch(prompt, /流程图视觉规范/);
});

test("Mermaid definitions are treated as pi-draw requests", () => {
	assert.equal(isPiDrawRequest("```mermaid\ngraph TD\n  A --> B\n```"), true);
	assert.equal(isPiDrawRequest("sequenceDiagram\n  Alice->>Bob: hello"), true);
	assert.equal(isPiDrawRequest("please use pi_draw_save_mermaid_scene"), true);
});
