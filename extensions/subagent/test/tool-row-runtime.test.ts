/** Exercise the real Pi tool shell, renderer sequencing, theme proxy and final-duration context. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { initTheme, ToolExecutionComponent, type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type TUI, visibleWidth } from "@earendil-works/pi-tui";
import subagentExtension, { type SubagentExtensionDependencies } from "../index.ts";
import type { RunOnceOptions } from "../src/runner.ts";
import type { RunOutcome } from "../src/outcome.ts";
import { createToolHtmlRenderer } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/export-html/tool-renderer.js";

const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "").trimEnd();
const plain = (component: ToolExecutionComponent, width = 122) => component.render(width).map(strip);

function fixture(args: Record<string, unknown> = { description: "检查权限边界", prompt: "PROMPT_SENTINEL", subagent_type: "CONFIG_SENTINEL" }, dependencies: SubagentExtensionDependencies = {}) {
	let tool!: ToolDefinition;
	let redraws = 0;
	subagentExtension({ registerTool: (registered: ToolDefinition) => { tool = registered; }, on: () => {},
		getAllTools: () => [], getMcpServers: () => [] } as unknown as ExtensionAPI, dependencies);
	const ui = { requestRender: () => { redraws++; } } as unknown as TUI;
	const component = new ToolExecutionComponent("agent", "agent-ui-test", args, { outputPad: 1 }, tool, ui, process.cwd());
	return { component, tool, redraws: () => redraws };
}

function returned(text = "REPORT_SENTINEL", details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text: `finished.\n\n${text}` }],
		details: { header: "finished.", status: "finished", tokens: 8400, toolUses: 7, ...details },
		isError: false, durationMs: 38_000 };
}

test("HTML export keeps the report when it snapshots the call before rendering the result", () => {
	initTheme("dark", false);
	const { tool } = fixture();
	const renderer = createToolHtmlRenderer({ getToolRenderers: () => tool, cwd: process.cwd(),
		theme: { fg: (_role: string, value: string) => value, bold: (value: string) => value } as never });
	const args = { description: "scan", prompt: "PROMPT_SENTINEL", subagent_type: "CONFIG_SENTINEL" };
	assert.match(renderer.renderCall("export-call", "agent", args) ?? "", /scan/);
	const data = returned();
	const result = renderer.renderResult("export-call", "agent", data.content, data.details, false);
	assert.ok(result?.expanded);
	assert.match(result.expanded, /REPORT_SENTINEL/);
	assert.match(result.expanded, /PROMPT_SENTINEL/);
	assert.ok(result.expanded.indexOf("REPORT_SENTINEL") < result.expanded.indexOf("CONFIG_SENTINEL"));
});

test("the real host renders a single final task row and report-first expanded details", () => {
	initTheme("dark", false);
	const { component } = fixture();
	assert.match(plain(component).join("\n"), /检查权限边界.*running/);
	component.markExecutionStarted();
	component.setArgsComplete();
	component.updateResult(returned(), false);
	const folded = plain(component).filter((line) => line.trim());
	assert.equal(folded.length, 1);
	assert.doesNotMatch(component.render(100).join("\n"), /\x1b\[(?:48;|4[0-7]m)/, "self shell must not paint a default tool background");
	assert.match(folded[0], /检查权限边界.*8\.4k tokens.*7 tool calls.*38s.*returned/);
	component.setExpanded(true);
	const expandedLines = plain(component);
	const expanded = expandedLines.join("\n");
	const reportTitle = expandedLines.findIndex((line) => line.trim() === "│ report");
	assert.equal(expandedLines[reportTitle + 1].trim(), "│ REPORT_SENTINEL");
	assert.ok(expanded.indexOf("REPORT_SENTINEL") < expanded.indexOf("CONFIG_SENTINEL"));
	assert.ok(expanded.indexOf("CONFIG_SENTINEL") < expanded.indexOf("PROMPT_SENTINEL"));
	assert.equal((expanded.match(/REPORT_SENTINEL/g) ?? []).length, 1);
	assert.doesNotMatch(expanded, /^.*│ finished\.$/m);
	component.setExpanded(false);
	assert.equal(plain(component).filter((line) => line.trim()).length, 1);
	assert.doesNotMatch(plain(component).join("\n"), /REPORT_SENTINEL|running/);
});

test("real host live partials are report-free, terminal-safe, and freeze into final history", () => {
	initTheme("dark", false);
	const { component } = fixture();
	const active = { id: "one", name: "read", target: "src/request.ts", status: "running" };
	const progress = { version: 2, elapsedMs: 24_000, phase: "running", toolUses: 4,
		tools: [active], slots: [active, null] };
	component.updateResult({ content: [], details: { progress }, isError: false }, true);
	assert.match(plain(component).join("\n"), /4 tool calls.*24s.*running/);
	assert.doesNotMatch(plain(component).join("\n"), /read · src\/request.ts/);
	component.setExpanded(true);
	for (const name of ["dark", "light"]) {
		initTheme(name, false);
		component.invalidate();
		for (let width = 1; width <= 120; width++) for (const line of component.render(width)) assert.ok(visibleWidth(line) <= width, `${name} ${width}`);
		assert.doesNotMatch(plain(component).join("\n"), /report|no output/);
		assert.match(plain(component).join("\n"), /activity/);
	}
	component.updateResult(returned("REPORT_SENTINEL", { progress: { ...progress,
		tools: [{ ...progress.tools[0], status: "done" }], slots: [{ ...active, status: "done" }, null] } }), false);
	const final = plain(component).join("\n");
	assert.ok(final.indexOf("REPORT_SENTINEL") < final.indexOf("activity"));
	assert.ok(final.indexOf("activity") < final.indexOf("CONFIG_SENTINEL"));
	assert.doesNotMatch(final, /running|↳/);
	component.setExpanded(false);
	assert.equal(component.render(122).length, 2);
	assert.doesNotMatch(plain(component).join("\n"), /read|src\/request.ts/);
});

test("real host surfaces queued, starting, cleanup and preparing on the single main row", () => {
	initTheme("dark", false);
	const { component } = fixture();
	for (const [phase, label] of [
		["queued", "queued"], ["starting", "starting"], ["cleanup", "cleaning up"], ["preparing", "preparing result"],
	] as const) for (const name of ["dark", "light"]) {
		initTheme(name, false);
		component.invalidate();
		component.updateResult({ content: [], isError: false, details: { progress: {
			version: 2, elapsedMs: 24_000, phase, toolUses: 3, tools: [], slots: [null, null],
		} } }, true);
		assert.equal(component.render(122).length, 2, `${name} ${phase}: one summary row plus the host spacer`);
		const summary = plain(component).find((line) => line.trim()) ?? "";
		assert.ok(summary.endsWith(label), `${name} ${phase}: ${summary}`);
		assert.doesNotMatch(summary, /running|returned/, `${name} ${phase}`);
		for (let width = 1; width <= 60; width++) for (const line of component.render(width)) {
			assert.ok(visibleWidth(line) <= width, `${name} ${phase} ${width}`);
		}
	}
	initTheme("dark", false);
	component.invalidate();
	component.updateResult(returned(), false);
	assert.match(plain(component).join("\n"), /returned$/m);
});

test("HTML export reconstructs bounded final activity without a live activity line", () => {
	initTheme("dark", false);
	const { tool } = fixture();
	const renderer = createToolHtmlRenderer({ getToolRenderers: () => tool, cwd: process.cwd(),
		theme: { fg: (_role: string, value: string) => value, bold: (value: string) => value } as never });
	renderer.renderCall("activity-export", "agent", { description: "scan", prompt: "PROMPT_SENTINEL" });
	const activity = { id: "one", name: "read", target: "src/a.ts", status: "done" };
	const data = returned("REPORT_SENTINEL", { progress: { version: 2, elapsedMs: 38_000, toolUses: 7,
		tools: [activity], slots: [activity, null] } });
	const result = renderer.renderResult("activity-export", "agent", data.content, data.details, false);
	assert.ok(result?.expanded);
	assert.ok(result.expanded.indexOf("REPORT_SENTINEL") < result.expanded.indexOf("activity"));
	assert.match(result.expanded, /src\/a.ts/);
	assert.doesNotMatch(result.collapsed ?? "", /src\/a.ts|↳/);
});

test("execute progress drives the real host until the unchanged foreground result arrives", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	initTheme("dark", false);
	let now = 0;
	let request!: RunOnceOptions;
	let finish!: (result: RunOutcome) => void;
	const args = { description: "probe", prompt: "TASK" };
	const { component, tool } = fixture(args, { progressNow: () => now, run: (options) => {
		request = options;
		return new Promise((resolve) => { finish = resolve; });
	} });
	const context = { cwd: process.cwd(), mode: "tui", hasUI: true, model: { id: "parent" },
		modelRegistry: { find: () => undefined }, isProjectTrusted: () => true, sessionManager: { buildContextEntries: () => [] } };
	const pending = tool.execute("e2e", args, undefined, (partial) => component.updateResult({ ...partial, isError: false }, true), context as never);
	await new Promise<void>((resolve) => setImmediate(resolve));
	request.onProgress?.({ type: "phase", phase: "running" });
	request.onProgress?.({ type: "tool-count", count: 2 });
	request.onProgress?.({ type: "tool-start", id: "one", name: "read", target: "src/a.ts" });
	request.onProgress?.({ type: "tool-start", id: "two", name: "bash" });
	now = 1000;
	t.mock.timers.tick(1000);
	assert.match(plain(component).join("\n"), /2 tool calls.*1s.*running/);
	assert.doesNotMatch(plain(component).join("\n"), /read|bash|activity/);
	component.setExpanded(true);
	assert.match(plain(component).join("\n"), /read[\s\S]*bash/);
	component.setExpanded(false);
	request.onProgress?.({ type: "tool-end", id: "one", isError: false });
	request.onProgress?.({ type: "tool-end", id: "two", isError: false });
	finish({ status: "finished", responseText: "FINAL_REPORT", usage: { tokens: 12, cost: 0 }, toolUses: 2 });
	const result = await pending;
	component.updateResult({ ...result, isError: false, durationMs: 1000 }, false);
	component.setExpanded(true);
	const final = plain(component).join("\n");
	assert.match(final, /12 tokens.*2 tool calls.*1s.*returned/);
	assert.match(final, /FINAL_REPORT/);
	assert.doesNotMatch(final, /running|tools active/);
	now = 10_000;
	t.mock.timers.tick(10_000);
	request.onProgress?.({ type: "tool-start", id: "late", name: "late" });
	assert.equal(plain(component).join("\n"), final);
});

test("real host tool updates stay collapsed until manual expansion and remain reachable after overflow", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	initTheme("dark", false);
	let now = 0;
	let request!: RunOnceOptions;
	let finish!: (result: RunOutcome) => void;
	const args = { description: "probe", prompt: "TASK" };
	const { component, tool } = fixture(args, { progressNow: () => now, run: (options) => {
		request = options;
		return new Promise((resolve) => { finish = resolve; });
	} });
	const context = { cwd: process.cwd(), mode: "tui", hasUI: true, model: { id: "parent" },
		modelRegistry: { find: () => undefined }, isProjectTrusted: () => true, sessionManager: { buildContextEntries: () => [] } };
	const pending = tool.execute("monitor", args, undefined, (partial) => component.updateResult({ ...partial, isError: false }, true), context as never);
	await new Promise<void>((resolve) => setImmediate(resolve));
	request.onProgress?.({ type: "phase", phase: "running" });
	request.onProgress?.({ type: "tool-count", count: 3 });
	request.onProgress?.({ type: "tool-start", id: "A", name: "read", target: "src/a.ts" });
	request.onProgress?.({ type: "tool-start", id: "B", name: "bash", target: "npm test" });
	request.onProgress?.({ type: "tool-start", id: "C", name: "write", target: "src/c.ts" });
	now = 750;
	t.mock.timers.tick(750);
	assert.equal(component.render(122).length, 2);
	assert.doesNotMatch(plain(component).join("\n"), /src\/|bash|\+1 active|activity/);
	component.setExpanded(true);
	const expanded = plain(component).join("\n");
	assert.match(expanded, /src\/a.ts/);
	assert.match(expanded, /npm test/);
	assert.match(expanded, /src\/c.ts/);
	component.setExpanded(false);
	request.onProgress?.({ type: "tool-end", id: "A", isError: false, durationMs: 120 });
	request.onProgress?.({ type: "tool-end", id: "C", isError: false, durationMs: 200 });
	request.onProgress?.({ type: "tool-end", id: "B", isError: false, durationMs: 500 });
	finish({ status: "finished", responseText: "FINAL_REPORT", usage: { tokens: 20, cost: 0 }, toolUses: 3 });
	const result = await pending;
	component.updateResult({ ...result, isError: false, durationMs: 750 }, false);
	assert.equal(component.render(122).length, 2);
	const final = plain(component).join("\n");
	assert.doesNotMatch(final, /src\/|bash|FINAL_REPORT/);
	component.setExpanded(true);
	assert.match(plain(component).join("\n"), /FINAL_REPORT/);
	assert.match(plain(component).join("\n"), /write.*done.*200ms/);
	component.setExpanded(false);
	now = 20_000;
	t.mock.timers.tick(20_000);
	request.onProgress?.({ type: "tool-start", id: "late", name: "late" });
	assert.equal(plain(component).join("\n"), final);
});

test("real host preserves raw height from the first frame through idle, active, final and late partial states", () => {
	initTheme("dark", false);
	const { component } = fixture();
	const widths = [1, 2, 3, 8, 16, 24, 26, 63, 64, 66, 95, 96, 97, 98, 119, 120, 121, 122, 160];
	const assertHeight = () => {
		for (const width of widths) {
			// One summary row plus the host-owned spacer, without reserved tool rows.
			assert.equal(component.render(width).length, 2, `${width}: including the host spacer`);
		}
	};
	assertHeight();
	component.markExecutionStarted();
	component.setArgsComplete();
	for (const snapshot of [
		{ tools: [], slots: [null, null] },
		{ tools: [{ id: "one", name: "read", target: "src/a.ts", status: "running" }], slots: [{ id: "one", name: "read", target: "src/a.ts", status: "running" }, null] },
		{ tools: [], slots: [{ id: "two", name: "bash", status: "running" }, { id: "three", name: "bash", status: "running" }] },
		{ tools: [], slots: [null, null] },
	]) {
		component.updateResult({ content: [], isError: false, details: { progress: {
			version: 2, elapsedMs: 20_000, phase: "running", toolUses: 10, ...snapshot,
		} } }, true);
		assertHeight();
	}
	component.updateResult(returned(), false);
	assertHeight();
	const final = plain(component).join("\n");
	component.updateResult({ content: [], isError: false, details: { progress: {
		version: 2, elapsedMs: 90_000, toolUses: 90, tools: [], slots: [null, null],
	} } }, true);
	assertHeight();
	assert.equal(plain(component).join("\n"), final);
	for (const theme of ["dark", "light"]) {
		initTheme(theme, false);
		component.invalidate();
		assertHeight();
		component.setExpanded(true);
		assert.match(plain(component).join("\n"), /REPORT_SENTINEL/);
		component.setExpanded(false);
		assertHeight();
	}
});

test("real host context-only errors retain the reason even when counters are present", () => {
	initTheme("dark", false);
	const { component } = fixture();
	component.updateResult({ content: [{ type: "text", text: "Error: provider timeout\n\nPARTIAL" }],
		details: { tokens: 100, toolUses: 2 }, isError: true, durationMs: 14_000 }, false);
	const shown = plain(component).join("\n");
	assert.match(shown, /failed/);
	assert.match(shown, /provider timeout/);
	assert.doesNotMatch(shown, /returned|PARTIAL/);
	component.setExpanded(true);
	assert.match(plain(component).join("\n"), /PARTIAL/);
});

test("real host redraws do not duplicate cards, regress state or start a redraw feedback loop", () => {
	initTheme("dark", false);
	const { component, redraws } = fixture();
	component.updateResult(returned(), false);
	const before = redraws();
	for (let index = 0; index < 20; index++) {
		component.invalidate();
		component.setExpanded(index % 2 === 0);
		assert.equal((plain(component).join("\n").match(/returned/g) ?? []).length, 1);
	}
	assert.equal(redraws(), before, "renderer updates must not recursively request another render");
});

test("real dark/light themes, warnings, padding and very narrow widths remain terminal-safe", () => {
	initTheme("dark", false);
	const { component } = fixture({ description: "中文😀任务".repeat(12), prompt: "x".repeat(100) + "PROMPT_END" });
	component.updateResult(returned("## 报告\n\n正文 **bold** 😀", {
		cleanupWarning: "工具仍可能收尾", truncated: true, fullOutputPath: "D:/temporary/report.txt",
	}), false);
	component.setExpanded(true);
	for (const name of ["dark", "light"]) {
		initTheme(name, false);
		component.invalidate();
		for (const width of [1, 2, 3, 4, 8, 12, 20, 40, 80, 120]) {
			for (const line of component.render(width)) {
				assert.ok(visibleWidth(line) <= width, `${name} ${width}: ${JSON.stringify(line)}`);
				assert.ok(!line.includes("\n"));
			}
		}
		const shown = plain(component).join("\n");
		assert.match(shown, /cleanup warning/);
		assert.match(shown, /report truncated.*ctrl\+o for path/);
		assert.match(shown, /D:\/temporary\/report\.txt/);
		assert.match(shown, /PROMPT_END/);
	}
});
