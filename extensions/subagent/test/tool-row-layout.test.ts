/** Default cards remain compact; reports and tool records require explicit expansion. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { ProgressSnapshot, ToolActivity } from "../src/progress.ts";
import { toolResult, toolRow } from "../src/tool-row.ts";

const theme = { fg: (_color: string, value: string) => value, bold: (value: string) => `\x1b[1m${value}\x1b[22m` };
const strip = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");
function progress(overrides: Partial<ProgressSnapshot> = {}): ProgressSnapshot {
	return { version: 2, elapsedMs: 20_000, toolUses: 10, phase: "running", tools: [], slots: [null, null], ...overrides };
}
const tool = (id: string, status: ToolActivity["status"] = "running", extra: Partial<ToolActivity> = {}): ToolActivity => ({ id, name: "bash", status, ...extra });
function fixture(description = "TASK", outputPad = 0) {
	const state = {};
	const args = { description, prompt: "PROMPT", model: "provider/model" };
	let expanded = false;
	let call: ReturnType<typeof toolRow>;
	let result: ReturnType<typeof toolResult> | undefined;
	const updateCall = () => {
		const context = { state, args, expanded, outputPad, lastComponent: call };
		call = toolRow(context, theme, { label: "agent", detail: args.description });
	};
	updateCall();
	return {
		update: (details: unknown, isPartial = true) => {
			updateCall();
			const context = { state, args, expanded, outputPad, lastComponent: result };
			result = toolResult({ content: [{ type: "text", text: "REPORT_BODY" }], details }, { expanded, isPartial }, theme, context);
		},
		expand: (value: boolean) => { expanded = value; updateCall(); },
		description: (value: string) => { args.description = value; updateCall(); },
		render: (width: number) => [...call.render(width), ...(result?.render(width) ?? [])].map(strip),
	};
}
const A = tool("A", "running", { name: "read", target: "src/index.ts" });
const B = tool("B", "running", { target: "npm test" });
const STATES: ProgressSnapshot[] = [
	progress({ phase: "queued", elapsedMs: 0, toolUses: 0 }),
	progress({ phase: "starting", elapsedMs: 1000, toolUses: 0 }), progress(),
	progress({ slots: [A, null] }), progress({ slots: [A, B] }),
	progress({ slots: [A, B] }),
	progress({ slots: [{ ...A, status: "done", durationMs: 120 }, B] }),
	progress({ phase: "cleanup", slots: [{ ...A, status: "done", durationMs: 120 }, { ...B, status: "unfinished" }] }),
	progress({ phase: "preparing", slots: [{ ...A, status: "done", durationMs: 120 }, { ...B, status: "unfinished" }] }),
];

test("normal collapsed cards remain exactly one row through every tool state and final result", () => {
	for (let width = 1; width <= 160; width++) {
		const f = fixture();
		assert.equal(f.render(width).length, 1);
		for (const snapshot of STATES) {
			f.update({ progress: snapshot });
			const lines = f.render(width);
			assert.equal(lines.length, 1, `${width}: ${snapshot.phase}`);
			assert.ok(visibleWidth(lines[0]) <= width);
			assert.doesNotMatch(lines[0], /read|bash|src\/|npm test|\+\d+ active|REPORT_BODY/);
		}
		f.update({ status: "finished", progress: STATES.at(-1), tokens: 8400, toolUses: 10 }, false);
		const final = f.render(width);
		assert.equal(final.length, 1);
		f.update({ progress: STATES[4] });
		assert.deepEqual(f.render(width), final);
	}
});

test("tool-only updates do not change the collapsed text when summary statistics are unchanged", () => {
	const f = fixture();
	f.update({ progress: progress() });
	const before = f.render(120);
	for (const snapshot of STATES.slice(3).filter((snapshot) => snapshot.phase === "running")) {
		f.update({ progress: snapshot });
		assert.deepEqual(f.render(120), before);
	}
});

test("tool records, public messages and raw output never automatically expand the default card", () => {
	const f = fixture();
	for (const snapshot of [progress(), ...STATES]) {
		f.update({ progress: snapshot, message: "MODEL_SECRET", stdout: "OUTPUT_SECRET" });
		assert.equal(f.render(120).length, 1);
		assert.doesNotMatch(f.render(120).join("\n"), /MODEL_SECRET|OUTPUT_SECRET|REPORT_BODY|thinking|activity|read|bash/);
	}
});

test("manual expansion retains report-first details and pinned records outside recent history", () => {
	const f = fixture();
	const recent = Array.from({ length: 5 }, (_, i) => tool(`recent-${i}`, "done", { name: `TOOL_${i}` }));
	f.update({ status: "finished", progress: progress({ tools: recent, slots: [{ ...A, status: "done", durationMs: 120 }, B] }) }, false);
	assert.equal(f.render(120).length, 1);
	f.expand(true);
	const expanded = f.render(40).join("\n").replace(/^  │ ?/gm, "").replace(/\s/g, "");
	for (const value of ["src/index.ts", "npmtest", "TOOL_0", "TOOL_4", "PROMPT"]) assert.ok(expanded.includes(value), value);
	assert.match(expanded, /unfinished/);
	assert.ok(expanded.indexOf("REPORT_BODY") < expanded.indexOf("activity"));
	f.expand(false);
	assert.equal(f.render(120).length, 1);
	assert.doesNotMatch(f.render(120)[0], /REPORT_BODY|activity|read|bash/);
});

test("running details are manual and do not invent a report before final output", () => {
	const f = fixture();
	f.update({ progress: STATES[4] });
	f.expand(true);
	const expanded = f.render(80).join("\n");
	assert.match(expanded, /activity/);
	assert.match(expanded, /src\/index.ts/);
	assert.match(expanded, /npm test/);
	assert.doesNotMatch(expanded, /REPORT_BODY|no output/);
	f.expand(false);
	assert.equal(f.render(80).length, 1);
});

test("older progress snapshots are ignored instead of reconstructing activity", () => {
	const f = fixture();
	f.update({ status: "finished", progress: { ...progress(), version: 1, slots: undefined, tools: [A, B] } }, false);
	assert.equal(f.render(120).length, 1);
	f.expand(true);
	const expanded = f.render(120).join("\n");
	assert.doesNotMatch(expanded, /activity|src\/index\.ts|npm test/);
	assert.match(expanded, /REPORT_BODY/);
	f.expand(false);
	assert.equal(f.render(120).length, 1);
	assert.doesNotMatch(f.render(120)[0], /tokens|tool calls|\d+s\b/);
});

test("resize and streaming descriptions keep one row while full task details remain reachable", () => {
	const f = fixture();
	f.update({ progress: STATES[4] });
	const wide = f.render(120);
	assert.equal(f.render(16).length, 1);
	assert.deepEqual(f.render(120), wide);
	f.description("中文任务😀".repeat(15) + "DESCRIPTION_END");
	assert.equal(f.render(120).length, 1);
	f.expand(true);
	const expanded = f.render(32).join("\n").replace(/^  │ ?/gm, "").replace(/\s/g, "");
	assert.match(expanded, /DESCRIPTION_END/);
	assert.match(expanded, /src\/index.ts/);
	f.expand(false);
	assert.equal(f.render(32).length, 1);
});

test("compact summaries drop optional metrics before crowding out the task and status", () => {
	const f = fixture();
	f.update({ status: "finished", progress: progress({ elapsedMs: 38_000 }), tokens: 8400, toolUses: 10 }, false);
	assert.match(f.render(120)[0], /TASK.*8\.4k tokens · 10 tool calls · 38s · returned/);
	assert.match(f.render(16)[0], /returned/);
	assert.doesNotMatch(f.render(16)[0], /tokens|tool calls/);
	f.expand(true);
	assert.match(f.render(32).join("\n").replace(/^  │ ?/gm, "").replace(/\s/g, ""), /38s·8\.4ktokens·10toolcalls/);
});

test("narrow summaries remove tokens, then calls, then duration while retaining the rightmost status", () => {
	const f = fixture();
	f.update({ status: "finished", progress: progress({ elapsedMs: 38_000 }), tokens: 8400, toolUses: 10 }, false);
	assert.match(f.render(80)[0], /8\.4k tokens · 10 tool calls · 38s · returned$/);
	assert.match(f.render(45)[0], /10 tool calls · 38s · returned$/);
	assert.doesNotMatch(f.render(45)[0], /tokens/);
	assert.match(f.render(30)[0], /38s · returned$/);
	assert.doesNotMatch(f.render(30)[0], /tokens|tool calls/);
	assert.match(f.render(20)[0], /returned$/);
	assert.doesNotMatch(f.render(20)[0], /tokens|tool calls|38s/);
});

test("every lifecycle phase keeps its own rightmost label without overflowing any width", () => {
	for (const [phase, label] of [
		["queued", "queued"], ["starting", "starting"], ["cleanup", "cleaning up"], ["preparing", "preparing result"],
	] as const) {
		for (let width = 1; width <= 160; width++) {
			const f = fixture();
			f.update({ progress: progress({ phase, elapsedMs: 30_000, toolUses: 2 }) });
			const lines = f.render(width);
			assert.equal(lines.length, 1, `${phase}@${width}`);
			assert.ok(lines[0].trim().length > 0, `${phase}@${width}: blank row`);
			assert.ok(visibleWidth(lines[0]) <= width, `${phase}@${width}`);
		}
		const f = fixture();
		f.update({ progress: progress({ phase, elapsedMs: 30_000, toolUses: 2 }) });
		const wide = f.render(120)[0];
		assert.ok(wide.endsWith(label), `${phase}: ${wide}`);
		assert.match(wide, /2 tool calls · 30s · /);
		assert.doesNotMatch(wide, /running|returned|tokens/);
	}
});

test("rightmost status retains its own color and position as statistics grow", () => {
	const colored = { fg: (role: string, text: string) => `\x1b[${role === "accent" ? 34 : role === "error" ? 31 : 2}m${text}\x1b[39m`, bold: (text: string) => text };
	const context = { state: {}, args: { description: "TASK" }, expanded: false };
	const call = toolRow(context, colored, { label: "agent", detail: "TASK" });
	for (const [toolUses, elapsedMs] of [[6, 15_000], [10, 20_000], [1000, 80_000]]) {
		toolResult({ content: [], details: { progress: progress({ toolUses, elapsedMs }) } }, { expanded: false, isPartial: true }, colored, context);
		const line = call.render(100)[0];
		assert.ok(line.endsWith("\x1b[34mrunning\x1b[39m"));
		const plain = strip(line);
		assert.equal(visibleWidth(plain.slice(0, plain.lastIndexOf("running"))), 93);
	}
	toolResult({ content: [], details: { status: "failed", progress: progress() } }, { expanded: false, isPartial: false }, colored, context);
	assert.ok(call.render(100)[0].endsWith("\x1b[31mfailed\x1b[39m"));
});

test("stop reasons remain visible in addition to the single summary row", () => {
	for (const width of [64, 120]) for (const [status, reason, expected] of [
		["failed", undefined, "timeout"], ["aborted", "cancelled", "cancelled"],
		["aborted", "turn_limit", "turn limit reached"], ["aborted", "sdk_abort", "session aborted"],
	] as const) {
		const f = fixture();
		f.update({ status, reason, errorSummary: "timeout", progress: progress(), tokens: 8400, toolUses: 10 }, false);
		const lines = f.render(width);
		assert.equal(lines.length, 2);
		assert.ok(lines.at(-1)?.includes(expected));
		assert.doesNotMatch(lines.join("\n"), /REPORT_BODY|npm test/);
	}
});
