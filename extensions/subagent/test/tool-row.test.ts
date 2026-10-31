import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { type RowTheme } from "../src/tool-format.ts";
import type { ProgressSnapshot } from "../src/progress.ts";
import { type ToolRowContext, plain, present, toolDuration, toolResult, toolRow } from "../src/tool-row.ts";

const theme: RowTheme = {
	fg: (_color, text) => text,
	bold: (text) => `\x1b[1m${text}\x1b[22m`,
};
const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd();
const readable = (lines: string[]): string => lines.map(strip).join("\n");
const unrail = (lines: string[]): string => readable(lines).replace(/^  │ ?/gm, "");
type Input = { content: Array<{ type: string; text?: string }>; details?: unknown };
const resultOf = (text = "answer", details: unknown = { status: "finished" }): Input => ({ content: [{ type: "text", text }], details });
const ctx = (overrides: Partial<ToolRowContext> = {}): ToolRowContext => ({ args: {}, state: {}, expanded: false, ...overrides });

function card(options: { args?: Record<string, unknown>; expanded?: boolean; durationMs?: number; isError?: boolean; outputPad?: number; detail?: string } = {}) {
	const context = ctx({ ...options, args: options.args ?? { description: "检查权限边界", prompt: "完整委派指令" } });
	const label = { label: "agent", detail: options.detail ?? String(context.args?.description ?? "") };
	const call = toolRow(context, theme, label);
	let result: ReturnType<typeof toolResult> | undefined;
	return {
		context, call,
		updateCall: () => toolRow(context, theme, label),
		setResult: (input: Input, isPartial = false) => {
			result = toolResult(input, { expanded: context.expanded, isPartial }, theme, context);
			return result;
		},
		render: (width = 120) => [...call.render(width), ...(result?.render(width) ?? [])],
	};
}

function resultOnly(input: Input, expanded = false, overrides: Partial<ToolRowContext> = {}, rowTheme = theme) {
	return toolResult(input, { expanded }, rowTheme, ctx({ ...overrides, expanded }));
}

function liveProgress(overrides: Partial<ProgressSnapshot> = {}): ProgressSnapshot {
	const tool = { id: "one", name: "read", target: "src/request.ts", status: "running" as const };
	return { version: 2, elapsedMs: 24_000, phase: "running", toolUses: 4,
		tools: [tool], slots: [tool, null], ...overrides };
}

test("live cards keep elapsed time, requested-call count and one collapsed summary", () => {
	const view = card({ durationMs: 99_000 });
	view.setResult(resultOf("", { progress: liveProgress(), tokens: 9000 }), true);
	const shown = readable(view.render());
	assert.match(shown, /4 tool calls.*24s.*running/);
	assert.doesNotMatch(shown, /read · src\/request\.ts/);
	assert.doesNotMatch(shown, /99s|tokens|report|no output/);
	assert.equal(view.render().length, 1);
});

test("the live status distinguishes queued, starting, cleaning, and preparing from running", () => {
	for (const [phase, label] of [["queued", "queued"], ["starting", "starting"], ["cleanup", "cleaning up"], ["preparing", "preparing result"]] as const) {
		const view = card();
		view.setResult(resultOf("", { progress: liveProgress({ phase, elapsedMs: 0, tools: [], slots: [null, null] }) }), true);
		const shown = readable(view.render());
		assert.match(shown, new RegExp(`0s.*${label}`), `${phase}: ${shown}`);
		assert.doesNotMatch(shown, /running/);
		assert.equal(view.render().length, 1);
	}
	const view = card();
	view.setResult(resultOf("", { progress: liveProgress() }), true);
	assert.match(readable(view.render()), /running/);
	assert.doesNotMatch(readable(view.render()), /\+6 active/);
	view.setResult(resultOf("", { progress: liveProgress({ tools: [{ id: "one", name: "read", status: "done" }], slots: [{ id: "one", name: "read", status: "done" }, null] }) }), true);
	assert.equal(view.render().length, 1);
	assert.doesNotMatch(readable(view.render()), /read/);
});

test("each lifecycle label keeps the identity and never falls back to running under narrow widths", () => {
	for (const [phase, label] of [
		["queued", "queued"], ["starting", "starting"], ["cleanup", "cleaning up"], ["preparing", "preparing result"],
	] as const) {
		for (const width of [visibleWidth(label) + 7, 40, 120]) {
			const view = card();
			view.setResult(resultOf("", { progress: liveProgress({ phase, elapsedMs: 30_000, toolUses: 2, tools: [], slots: [null, null] }) }), true);
			const lines = view.render(width).map(strip);
			assert.equal(lines.length, 1, `${phase}@${width}`);
			assert.ok(lines[0].startsWith("agent"), `${phase}@${width}: ${lines[0]}`);
			assert.ok(lines[0].endsWith(label), `${phase}@${width}: ${lines[0]}`);
			assert.doesNotMatch(lines[0], /running/, `${phase}@${width}`);
		}
	}
});

test("queued stays muted while starting, cleanup and preparing keep the active color", () => {
	const labels = { queued: "queued", starting: "starting", cleanup: "cleaning up", preparing: "preparing result" } as const;
	for (const [phase, statusText] of Object.entries(labels) as Array<[keyof typeof labels, string]>) {
		const roles: string[] = [];
		const probe: RowTheme = { fg: (role, text) => { if (text === statusText) roles.push(role); return text; }, bold: (text) => text };
		const context = ctx();
		toolResult({ content: [], details: { progress: liveProgress({ phase, elapsedMs: 30_000, toolUses: 2 }) } }, { expanded: false, isPartial: true }, probe, context);
		toolRow(context, probe, { label: "agent", detail: "TASK" }).render(120);
		assert.deepEqual(roles.slice(-1), [phase === "queued" ? "muted" : "accent"], phase);
	}
});

test("a call cancelled while queued reports stopped instead of queued, running or returned", () => {
	const view = card();
	view.setResult(resultOf("", { progress: liveProgress({ phase: "queued", elapsedMs: 0, toolUses: 0, tools: [], slots: [null, null] }) }), true);
	assert.match(readable(view.render()), /queued/);
	view.setResult(resultOf("", { status: "aborted", reason: "cancelled" }));
	const shown = readable(view.render());
	assert.match(shown, /stopped/);
	assert.match(shown, /↳ cancelled/);
	assert.doesNotMatch(shown, /queued|running|returned/);
});

test("running expansion has bounded activity before config and prompt, never an empty report", () => {
	const view = card({ expanded: true, args: { description: "scan", prompt: "PROMPT", model: "p/model" } });
	const tools = Array.from({ length: 8 }, (_, i) => ({ id: String(i), name: `TOOL_${i}`, status: "done" as const }));
	view.setResult(resultOf("PARTIAL_BODY", { progress: liveProgress({ tools, slots: [null, null] }) }), true);
	const shown = unrail(view.render());
	assert.doesNotMatch(shown, /report|no output|PARTIAL_BODY|TOOL_[012]/);
	assert.ok(shown.indexOf("activity") < shown.indexOf("config"));
	assert.ok(shown.indexOf("config") < shown.indexOf("prompt"));
	assert.equal((shown.slice(shown.indexOf("activity")).match(/TOOL_/g) ?? []).length, 5);
});

test("final results freeze history behind report and full-report path and reject late partials", () => {
	const view = card({ expanded: true });
	const progress = liveProgress();
	view.setResult(resultOf("REPORT_BODY", { status: "finished", progress, fullOutputPath: "D:/full.txt", toolUses: 4 }));
	const shown = unrail(view.render());
	assert.ok(shown.indexOf("REPORT_BODY") < shown.indexOf("full report"));
	assert.ok(shown.indexOf("full report") < shown.indexOf("activity"));
	assert.ok(shown.indexOf("activity") < shown.indexOf("prompt"));
	assert.match(shown, /read · src\/request.ts · unfinished/);
	assert.doesNotMatch(shown, /running|↳/);
	view.setResult(resultOf("", { progress: liveProgress({ elapsedMs: 80_000 }) }), true);
	assert.equal(unrail(view.render()), shown);
});

test("live and frozen activity remain safe at every terminal width without losing expanded targets", () => {
	const target = "中文😀".repeat(12) + "TARGET_END";
	for (const isPartial of [true, false]) {
		const view = card({ expanded: true });
		view.setResult(resultOf("BODY", { status: "finished", progress: liveProgress({ tools: [
			{ id: "one", name: "read\x1b[31m", target: target + "\x00", status: "running" },
		] }) }), isPartial);
		for (let width = 1; width <= 120; width++) for (const line of view.render(width)) {
			assert.ok(visibleWidth(line) <= width, `${width}: ${JSON.stringify(line)}`);
			assert.doesNotMatch(strip(line), /[\u0000-\u001f\u007f]/);
		}
		assert.ok(unrail(view.render(32)).replace(/\s/g, "").includes(target));
	}
});

test("durations use compact units", () => {
	for (const [ms, expected] of [[4_000, "4s"], [59_000, "59s"], [60_000, "1m"], [90_000, "1m 30s"], [3_600_000, "1h"], [3_661_000, "1h 1m"]] as const) {
		assert.equal(toolDuration(ms), expected);
	}
});

test("present and plain tolerate partial text and sanitize inline controls", () => {
	assert.equal(present(undefined, "", "one", "two"), "one  two");
	assert.equal(present(undefined, undefined), "");
	assert.equal(plain("a\t\x1b[31mb\x1b[0m\nc\x00"), "a    b c");
});

test("running keeps the task prominent without pretending to know stages or elapsed time", () => {
	const view = card({ durationMs: 45_000 });
	const shown = readable(view.render());
	assert.match(shown, /^agent  检查权限边界/);
	assert.match(shown, /running/);
	assert.doesNotMatch(shown, /45s|排队|初始化|收尾|read |tokens|returned/);
	assert.equal(view.render().length, 1);
	assert.match(view.render()[0], /\x1b\[1m检查权限边界/);
});

test("half-streamed arguments never display undefined or throw", () => {
	for (const args of [undefined, {}, { description: "partial" }]) {
		const context = ctx({ args, expanded: true });
		const lines = toolRow(context, theme, { label: "agent", detail: present(args?.description as string | undefined) }).render(50);
		assert.doesNotMatch(readable(lines), /undefined|NaN/);
	}
});

test("the label is still the registered tool name", () => {
	const call = toolRow(ctx(), theme, { label: "agent", detail: "scan" });
	assert.match(readable(call.render(80)), /^agent  scan/);
});

test("call and result share one final summary instead of adjacent summary rows", () => {
	const view = card({ durationMs: 38_000 });
	const result = view.setResult(resultOf("Blocked: needs input", { status: "finished", tokens: 8400, toolUses: 7 }));
	assert.deepEqual(result.render(120), []);
	assert.equal(view.render().length, 1);
	assert.match(readable(view.render()), /8\.4k tokens.*7 tool calls.*38s.*returned/);
	assert.doesNotMatch(readable(view.render()), /Done|成功|已完成|running|Blocked/);
	assert.equal(view.updateCall(), view.call);
	assert.match(readable(view.render()), /returned/);
});

test("result-only consumers still get a complete card", () => {
	const result = resultOnly(resultOf("REPORT_SENTINEL"), true);
	assert.match(readable(result.render(80)), /agent.*returned/);
	assert.match(readable(result.render(80)), /REPORT_SENTINEL/);
});

test("result-before-call ordering neither loses the report nor duplicates the card", () => {
	const context = ctx({ args: { description: "scan", prompt: "TASK_SENTINEL" }, expanded: true });
	const result = toolResult(resultOf("REPORT_SENTINEL"), { expanded: true }, theme, context);
	assert.match(readable(result.render(80)), /REPORT_SENTINEL/);
	const call = toolRow(context, theme, { label: "agent", detail: "scan" });
	const combined = readable([...call.render(80), ...result.render(80)]);
	assert.equal((combined.match(/REPORT_SENTINEL/g) ?? []).length, 1);
	assert.equal((combined.match(/^agent /gm) ?? []).length, 1);
});

test("independent calls never share state", () => {
	const first = card();
	const second = card();
	first.setResult(resultOf("first"));
	assert.match(readable(first.render()), /returned/);
	assert.match(readable(second.render()), /running/);
});

test("narrow viewports keep a single row and prioritize status", () => {
	const view = card({ args: { description: "检查", prompt: "hidden task" } });
	view.setResult(resultOf());
	const lines = view.render(16).map(strip);
	assert.equal(lines.length, 1);
	assert.match(lines[0], /^agent.*returned/);
	assert.ok(lines.slice(1).every((line) => !line.trim()));
});

test("optional statistics yield to description and status and return after resize", () => {
	const view = card({ durationMs: 38_000 });
	view.setResult(resultOf("answer", { status: "finished", tokens: 8400, toolUses: 7 }));
	assert.match(readable(view.render(120)), /8\.4k tokens.*7 tool calls/);
	const narrow = readable(view.render(32));
	assert.match(narrow, /returned/);
	assert.doesNotMatch(narrow, /tokens|7 tool calls/);
	assert.match(readable(view.render(120)), /8\.4k tokens.*7 tool calls/);
});

test("long descriptions are visibly clipped but fully reachable when expanded", () => {
	const description = "很长的任务描述".repeat(15) + "DESCRIPTION_END";
	const view = card({ args: { description, prompt: "task" } });
	assert.match(readable(view.render(40)), /…/);
	view.context.expanded = true;
	view.updateCall();
	assert.match(unrail(view.render(40)).replace(/\s/g, ""), /DESCRIPTION_END/);
});

test("a multiline description stays inline when collapsed and keeps its original lines in detail", () => {
	const view = card({ args: { description: "first\nsecond", prompt: "task" } });
	assert.match(readable(view.render()), /first second/);
	view.context.expanded = true;
	view.updateCall();
	assert.match(unrail(view.render()), /description\nfirst\nsecond/);
});

test("expanded output puts the report before configuration and the complete prompt", () => {
	const view = card({ expanded: true, args: { description: "review", prompt: "PROMPT_SENTINEL", subagent_type: "CONFIG_SENTINEL" } });
	view.setResult(resultOf("REPORT_SENTINEL"));
	const shown = readable(view.render());
	assert.ok(shown.indexOf("REPORT_SENTINEL") < shown.indexOf("CONFIG_SENTINEL"));
	assert.ok(shown.indexOf("CONFIG_SENTINEL") < shown.indexOf("PROMPT_SENTINEL"));
	assert.match(shown, /│.*report/);
	assert.match(shown, /╰─/);
	assert.equal((shown.match(/REPORT_SENTINEL/g) ?? []).length, 1);
});

test("prompt is never hidden merely because it also appears in the headline", () => {
	const context = ctx({ args: { description: "Re-read config", prompt: "read" }, expanded: true });
	const call = toolRow(context, theme, { label: "agent", detail: "Re-read config" });
	assert.match(unrail(call.render(100)), /prompt\nread/);
});

test("expanded config shows the resolved agent alongside call overrides", () => {
	const view = card({ expanded: true, args: { description: "scan", prompt: "task", model: "p/requested", thinking: "high" } });
	view.setResult(resultOf("REPORT", { status: "finished", agent: {
		name: "reviewer", source: "project", model: "p/resolved", thinking: "medium", tools: "read, grep",
	} }));
	const shown = unrail(view.render());
	assert.match(shown, /agent: reviewer \[project\]/);
	assert.match(shown, /model: p\/resolved/);
	assert.match(shown, /thinking: medium/);
	assert.match(shown, /tools: read, grep/);
	assert.match(shown, /model override: p\/requested/);
	assert.match(shown, /thinking override: high/);
});

test("configuration names overrides and additive tools without claiming an effective loadout", () => {
	const view = card({ expanded: true, args: { description: "scan", prompt: "task", model: "p/requested", thinking: "high", tools: [], inherit_context: false } });
	const shown = unrail(view.render());
	assert.match(shown, /model override: p\/requested/);
	assert.match(shown, /thinking override: high/);
	assert.match(shown, /additional tools: \[\]/);
	assert.match(shown, /Adds to base tools; not a permission boundary\./);
	assert.match(shown, /inherit_context: false/);
	assert.doesNotMatch(shown, /实际模型|只读权限|有效工具|没有工具/);
});

test("tool-call counts distinguish singular and plural", () => {
	for (const count of [1, 3]) {
		const component = resultOnly(resultOf("", { status: "finished", toolUses: count }));
		const shown = readable(component.render(100));
		assert.match(shown, new RegExp(`${count} tool ${count === 1 ? "call" : "calls"}\\b`));
		if (count === 1) assert.doesNotMatch(shown, /1 tool calls/);
	}
});

test("all fixed UI copy is English across running, return, failure and stop states", () => {
	const args = { description: "scan ".repeat(40), prompt: "task", model: "provider/model", thinking: "high", tools: [] };
	const view = card({ args, expanded: true });
	assert.doesNotMatch(readable(view.render()), /\p{Script=Han}/u);
	for (const details of [
		{ status: "finished" }, { status: "failed" },
		{ status: "aborted", reason: "cancelled" }, { status: "aborted", reason: "turn_limit" },
		{ status: "aborted", reason: "sdk_abort" }, { status: "aborted" },
		{ status: "finished", cleanupWarning: "" }, { status: "finished", truncated: true },
		{ status: "finished", truncated: true, fullOutputPath: "D:/report.txt" },
	]) {
		view.setResult(resultOf("", details));
		assert.doesNotMatch(readable(view.render()), /\p{Script=Han}/u);
	}
});

test("task, prompt, report and original diagnostics retain their source language", () => {
	const view = card({ expanded: true, args: { description: "检查权限", prompt: "仅阅读中文指令" } });
	view.setResult(resultOf("报告内容保持中文", { status: "failed", errorSummary: "原始错误保持中文", cleanupWarning: "原始清理信息保持中文" }));
	const shown = unrail(view.render());
	for (const original of ["检查权限", "仅阅读中文指令", "报告内容保持中文", "原始错误保持中文", "原始清理信息保持中文"]) {
		assert.ok(shown.includes(original), original);
	}
});

test("unknown JSON arguments remain available and keep their labels", () => {
	const view = card({ expanded: true, args: { description: "scan", prompt: "task", extra: { nested: ["one", "two"] } } });
	const shown = unrail(view.render());
	assert.match(shown, /extra: \{/);
	assert.match(shown, /"nested"/);
	assert.match(shown, /"two"/);
});

test("the prompt keeps leading and internal blank lines plus its final long token", () => {
	const prompt = "\nfirst\n\nsecond\n" + "x".repeat(200) + "PROMPT_END";
	const view = card({ expanded: true, args: { description: "scan", prompt } });
	const shown = unrail(view.render(32));
	assert.match(shown, /prompt\n\nfirst\n\nsecond/);
	assert.match(shown.replace(/\s/g, ""), /PROMPT_END/);
});

test("an empty prompt still has a named section", () => {
	const view = card({ expanded: true, args: { description: "scan", prompt: "" } });
	assert.match(readable(view.render()), /prompt/);
});

test("Markdown headings, emphasis, tables and line breaks are rendered rather than printed raw", () => {
	const component = resultOnly(resultOf("## Heading\n\n**bold**\n\n| Key | Value |\n| --- | --- |\n| alpha | beta |\n\nfirst\n\nsecond"), true);
	const shown = unrail(component.render(80));
	assert.match(shown, /Heading/);
	assert.match(shown, /bold/);
	assert.match(shown, /alpha/);
	assert.match(shown, /beta/);
	assert.match(shown, /first\n\nsecond/);
	assert.doesNotMatch(shown, /## Heading|\*\*bold\*\*|\| --- \|/);
});

test("only the exact declared machine header is removed", () => {
	const exact = resultOnly(resultOf("finished.\n\nREPORT", { header: "finished.", status: "finished" }), true);
	assert.doesNotMatch(readable(exact.render(80)), /^  │ finished\.$/m);
	const similar = resultOnly(resultOf("finished. but this is report text\nREPORT", { header: "finished.", status: "finished" }), true);
	assert.match(readable(similar.render(100)), /finished\. but this is report text/);
	const missingMetadata = resultOnly(resultOf("finished.\nREPORT", {}), true);
	assert.match(readable(missingMetadata.render(80)), /finished\./);
});

test("header removal drops only the protocol separator and preserves report whitespace", () => {
	for (const [input, expected] of [
		["finished.\n\nfirst\n\nsecond", "report\nfirst\n\nsecond"],
		["finished.\nfirst\n\nsecond", "report\nfirst\n\nsecond"],
		["finished.\n\n\nfirst\n\nsecond", "report\n\nfirst\n\nsecond"],
		["\nfirst\n\nsecond", "report\n\nfirst\n\nsecond"],
	]) {
		const component = resultOnly(resultOf(input, { header: "finished.", status: "finished" }), true);
		assert.ok(unrail(component.render(100)).includes(expected), JSON.stringify(input));
	}
});

test("an empty successful result is visibly returned without inventing success or failure", () => {
	const view = card({ expanded: true });
	view.setResult(resultOf(""));
	const shown = readable(view.render());
	assert.match(shown, /returned/);
	assert.match(shown, /\(no output\)/);
	assert.doesNotMatch(shown, /failed|验收通过|已完成/);
});

test("a host context error keeps its reason visible even with nonzero statistics", () => {
	const view = card({ isError: true, durationMs: 14_000 });
	view.setResult(resultOf("Error: model timeout\n\npartial report", { tokens: 100, toolUses: 4 }));
	const shown = readable(view.render());
	assert.match(shown, /failed/);
	assert.match(shown, /model timeout/);
	assert.doesNotMatch(shown, /returned|Returned|partial report/);
	assert.equal(view.render().length, 2);
});

test("structured error summaries take precedence over an incomplete body prefix", () => {
	const view = card({ isError: true });
	view.setResult(resultOf("E", { status: "failed", errorSummary: "Model initialization failed", tokens: 800 }));
	assert.match(readable(view.render()), /Model initialization failed/);
});

test("empty failures fall back to an explicit missing-diagnostic notice", () => {
	const component = resultOnly(resultOf("", {}), false, { isError: true });
	assert.match(readable(component.render(80)), /failed/);
	assert.match(readable(component.render(80)), /no error details/);
});

test("legacy result flags and metadata aliases are ignored", () => {
	const obsoleteFlag = resultOnly({ ...resultOf("ordinary result"), isError: true } as Input);
	assert.match(readable(obsoleteFlag.render(80)), /returned/);
	assert.doesNotMatch(readable(obsoleteFlag.render(80)), /failed/);
	const component = resultOnly(resultOf("current diagnostic", { status: "failed", error: "LEGACY_ERROR_ALIAS" }));
	const shown = readable(component.render(80));
	assert.match(shown, /failed/);
	assert.match(shown, /current diagnostic/);
	assert.doesNotMatch(shown, /LEGACY_ERROR_ALIAS/);
});

for (const [reason, status, diagnostic] of [
	["cancelled", "stopped", "↳ cancelled"],
	["turn_limit", "stopped", "↳ turn limit reached"],
	["sdk_abort", "stopped", "↳ session aborted"],
] as const) {
	test(`${reason} is distinct from a returned result even though the host marks it as an error`, () => {
		const view = card({ isError: true, expanded: true });
		view.setResult(resultOf("PARTIAL_REPORT", { status: "aborted", reason }));
		const shown = readable(view.render());
		assert.match(shown, new RegExp(status));
		assert.match(shown, new RegExp(diagnostic));
		assert.match(shown, /PARTIAL_REPORT/);
		assert.doesNotMatch(shown, /failed|returned/);
	});
}

test("turn-limit aborts include the configured limit", () => {
	const view = card();
	view.setResult(resultOf("PARTIAL", { status: "aborted", reason: "turn_limit", turnLimit: 3 }));
	const shown = readable(view.render());
	assert.match(shown, /stopped/);
	assert.match(shown, /turn limit reached \(max_turns=3\)/);
});

test("cleanup warnings remain visible on normal returns without hiding the report", () => {
	const view = card({ expanded: true });
	view.setResult(resultOf("REPORT", { status: "finished", cleanupWarning: "A tool may still be unwinding" }));
	const shown = readable(view.render());
	assert.match(shown, /returned \(warning\)/);
	assert.match(shown, /cleanup warning: A tool may still be unwinding/);
	assert.match(shown, /REPORT/);
	assert.ok(shown.indexOf("cleanup warning") < shown.indexOf("report"));
});

test("cleanup-warning report text is not interpreted as current cleanup metadata", () => {
	const component = resultOnly(resultOf("Cleanup warning: tool is still unwinding\n\nREPORT", { status: "finished" }), true);
	const shown = readable(component.render(100));
	assert.match(shown, /Cleanup warning: tool is still unwinding/);
	assert.match(shown, /REPORT/);
	assert.doesNotMatch(shown, /! cleanup warning:/);
});

test("undefined fields from partial arguments are not printed as configuration", () => {
	const view = card({ expanded: true, args: { description: "scan", prompt: undefined, model: undefined } });
	assert.doesNotMatch(readable(view.render()), /undefined|model|prompt/);
});

test("truncation stays visible when folded and the complete path is available after expansion", () => {
	const view = card();
	view.setResult(resultOf("PREFIX", { status: "finished", truncated: true, fullOutputPath: "D:/not-read-by-renderer/report.txt" }));
	assert.match(readable(view.render()), /report truncated.*ctrl\+o for path/);
	assert.doesNotMatch(readable(view.render()), /PREFIX|D:\//);
	view.context.expanded = true;
	view.updateCall();
	const shown = unrail(view.render());
	assert.match(shown, /PREFIX/);
	assert.match(shown, /D:\/not-read-by-renderer\/report\.txt/);
	assert.match(shown, /Use read to view the full report\./);
	assert.match(shown, /Expanding does not load the file\./);
});

test("truncation without a path never advertises a made-up file", () => {
	const component = resultOnly(resultOf("PREFIX", { status: "finished", truncated: true }), true);
	assert.match(readable(component.render(80)), /full report path unavailable/);
});

test("all final metrics stay reachable when the narrow header omits them", () => {
	const view = card({ expanded: true, durationMs: 38_000 });
	view.setResult(resultOf("body", { status: "finished", tokens: 8400, toolUses: 7 }));
	const shown = unrail(view.render(24)).replace(/\s/g, "");
	assert.match(shown, /38s·8\.4ktokens·7toolcalls/);
});

test("missing metadata and malformed optional values never invent durations or counts", () => {
	for (const details of [undefined, null, [], "old", {}, { status: "finished" }, { tokens: NaN, toolUses: Infinity }, { tokens: -1, toolUses: "many" }]) {
		const shown = readable(resultOnly(resultOf("REPORT", details), true).render(80));
		assert.match(shown, /returned/);
		assert.match(shown, /REPORT/);
		assert.doesNotMatch(shown, /NaN|Infinity|undefined|tokens|tool calls|\d+s\b/);
	}
});

test("final call counts use current result metadata while partial counts use progress snapshots", () => {
	const progress = liveProgress({ toolUses: 9 });
	const final = resultOnly(resultOf("REPORT", { status: "finished", progress }));
	assert.doesNotMatch(readable(final.render(100)), /tool calls/);
	const partial = toolResult({ content: [], details: { progress } }, { expanded: false, isPartial: true }, theme, ctx());
	assert.match(readable(partial.render(100)), /9 tool calls/);
});

test("sub-second durations and unknown values do not clutter the summary", () => {
	const component = resultOnly(resultOf("", { tokens: 0, toolUses: 0 }), false, { durationMs: 100 });
	assert.doesNotMatch(readable(component.render(80)), /tokens|tool calls|0s/);
});

test("partial results do not pretend to have a final duration", () => {
	const view = card({ durationMs: 99_000 });
	view.setResult(resultOf("partial", { tokens: 20 }), true);
	assert.match(readable(view.render()), /running/);
	assert.doesNotMatch(readable(view.render()), /99s|returned/);
	view.setResult(resultOf("final"));
	assert.match(readable(view.render()), /returned/);
});

test("the card and result slot are reused and updated content does not remain cached", () => {
	const view = card({ expanded: true });
	const first = view.setResult(resultOf("FIRST_BODY"));
	assert.match(readable(view.render()), /FIRST_BODY/);
	const second = view.setResult(resultOf("SECOND_BODY"));
	assert.equal(first, second);
	assert.equal(view.updateCall(), view.call);
	assert.match(readable(view.render()), /SECOND_BODY/);
	assert.doesNotMatch(readable(view.render()), /FIRST_BODY/);
});

test("theme changes and invalidation rebuild report styles without retaining the old palette", () => {
	let color = "31";
	const mutableTheme: RowTheme = { fg: (_role, text) => `\x1b[${color}m${text}\x1b[39m`, bold: (text) => text };
	const context = ctx({ expanded: true });
	const component = toolResult(resultOf("**REPORT**"), { expanded: true }, mutableTheme, context);
	assert.match(component.render(80).join("\n"), /\x1b\[31m/);
	color = "34";
	component.invalidate();
	const updated = component.render(80).join("\n");
	assert.match(updated, /\x1b\[34m/);
	assert.doesNotMatch(updated, /\x1b\[31m/);
});

test("rendering creates no timers or self-driven redraw loop", (t) => {
	t.mock.method(globalThis, "setInterval", () => { throw new Error("unexpected interval"); });
	t.mock.method(globalThis, "setTimeout", () => { throw new Error("unexpected timeout"); });
	const view = card({ expanded: true });
	view.setResult(resultOf("body"));
	assert.doesNotThrow(() => view.render(80));
	assert.doesNotThrow(() => view.updateCall());
});

test("self-rendered cards honor host padding without overflowing tiny widths", () => {
	const view = card({ expanded: true, outputPad: 2 });
	view.setResult(resultOf("报告正文"));
	assert.ok(view.render(80).every((line) => line.startsWith("  ")));
	for (const width of [0, 1, 2, 3, 4, 7, 8, 12, 24, 80]) {
		for (const line of view.render(width)) assert.ok(visibleWidth(line) <= width, `${width}: ${JSON.stringify(line)}`);
	}
});
