/** Deterministic generated-input checks for terminal safety and full-content reachability. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { type ToolRowContext, toolResult, toolRow } from "../src/tool-row.ts";
import { singleLine } from "../src/tool-format.ts";

const theme = {
	fg: (_color: string, text: string) => `\x1b[2m${text}\x1b[39m`,
	bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
};
const strip = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, "");
const normalize = (text: string): string => text.replace(/\s/g, "");
const unrail = (lines: string[]): string => lines.map(strip).join("\n").replace(/^  │ ?/gm, "");
const context = (overrides: Partial<ToolRowContext> = {}): ToolRowContext => ({ args: {}, state: {}, expanded: false, ...overrides });

function rng(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let value = state;
		value = Math.imul(value ^ (value >>> 15), value | 1);
		value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
		return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
	};
}

const WORDS = ["scan", "the", "repo", "for", "callers", "and", "report", "back"];
const HAZARDS = ["\t", "\r", "\x1b[31m", "\x1b[0m", "\x07", "\x00", "\x1b]8;;https://example.invalid\x07label\x1b]8;;\x07", "\x1bPpayload\x1b\\"];
function cleanText(next: () => number, maxParts = 40): string {
	const parts: string[] = [];
	const count = Math.floor(next() * maxParts);
	for (let index = 0; index < count; index++) {
		const roll = next();
		if (roll < 0.1) parts.push("中文描述很长");
		else if (roll < 0.15) parts.push("😀");
		else if (roll < 0.2) parts.push("x".repeat(Math.floor(next() * 120)));
		else if (roll < 0.25) parts.push("\n");
		else parts.push(WORDS[Math.floor(next() * WORDS.length)] ?? "");
	}
	return parts.join(" ");
}
function dirtyText(next: () => number): string {
	const base = cleanText(next, 12);
	return `${base}${HAZARDS[Math.floor(next() * HAZARDS.length)]}${base}`;
}

const CASES = 160;
const PHASES = ["queued", "starting", "running", "cleanup", "preparing"] as const;

function generatedRows(seed: number): { width: number; lines: string[] } {
	const next = rng(seed);
	const text = seed % 3 === 0 ? dirtyText(next) : cleanText(next);
	const width = 1 + Math.floor(next() * 120);
	const expanded = next() < 0.5;
	const isPartial = seed % 4 === 0;
	const ctx = context({ args: { description: text, prompt: text, tools: [text] }, expanded, outputPad: seed % 4, isError: seed % 7 === 0 });
	const call = toolRow(ctx, theme, { label: "agent", detail: text });
	const result = toolResult({ content: [{ type: "text", text }], details: {
		status: seed % 7 === 0 ? "failed" : "finished", tokens: seed * 450, toolUses: seed % 9,
		progress: { version: 2, elapsedMs: seed * 1500, toolUses: seed % 9,
			phase: isPartial ? PHASES[seed % PHASES.length] : "preparing",
			tools: Array.from({ length: seed % 8 }, (_, i) => ({ id: String(i), name: text, target: text, status: isPartial ? "running" : "done" })),
			slots: [null, null],
		},
		...(seed % 11 === 0 ? { cleanupWarning: text, truncated: true, fullOutputPath: text } : {}),
	} }, { expanded, isPartial }, theme, ctx);
	return { width, lines: [...call.render(width), ...result.render(width)] };
}

test("no composed card overflows its width for CJK, emoji, controls, padding or resize", () => {
	for (let seed = 1; seed <= CASES; seed++) {
		const { width, lines } = generatedRows(seed);
		for (const line of lines) assert.ok(visibleWidth(line) <= width, `seed ${seed}: ${width} columns: ${JSON.stringify(line)}`);
	}
});

test("no generated row emits a full SGR reset", () => {
	for (let seed = 1; seed <= CASES; seed++) {
		for (const line of generatedRows(seed).lines) assert.ok(!line.includes("\x1b[0m"), `seed ${seed}: ${JSON.stringify(line)}`);
	}
});

test("source control characters and escape strings never reach a terminal row", () => {
	for (let seed = 1; seed <= CASES; seed++) {
		for (const line of generatedRows(seed).lines) {
			assert.doesNotMatch(strip(line), /[\u0000-\u001f\u007f]/, `seed ${seed}`);
			assert.doesNotMatch(strip(line), /\x1b/);
		}
	}
});

test("each render element is exactly one terminal line", () => {
	for (let seed = 1; seed <= CASES; seed++) {
		for (const line of generatedRows(seed).lines) assert.ok(!line.includes("\n"), `seed ${seed}: ${JSON.stringify(line)}`);
	}
});

test("plain expanded reports preserve all non-whitespace content", () => {
	for (let seed = 1; seed <= CASES; seed++) {
		const next = rng(seed);
		const text = cleanText(next);
		if (!text.trim()) continue;
		const width = 40 + Math.floor(next() * 80);
		const result = toolResult({ content: [{ type: "text", text }] }, { expanded: true }, theme, context());
		const lines = unrail(result.render(width)).split("\n");
		const start = lines.findIndex((line) => line.trim() === "report");
		assert.ok(start >= 0, `seed ${seed}: missing report section`);
		const shown = lines.slice(start + 1).filter((line) => line.trim() !== "╰─").join("\n");
		assert.equal(normalize(shown), normalize(text), `seed ${seed}`);
	}
});

test("Markdown emphasis keeps every word in an expanded report", () => {
	for (let seed = 1; seed <= CASES; seed++) {
		const next = rng(seed);
		const words = Array.from({ length: 12 }, () => WORDS[Math.floor(next() * WORDS.length)]);
		const text = words.map((word, index) => index % 3 === 0 ? `**${word}**` : index % 3 === 1 ? `_${word}_` : `\`${word}\``).join(" ");
		const result = toolResult({ content: [{ type: "text", text }] }, { expanded: true }, theme, context());
		const shown = normalize(unrail(result.render(40 + Math.floor(next() * 80))));
		assert.ok(shown.includes(words.join("")), `seed ${seed}: ${shown}`);
	}
});

test("configuration labels and the end of every long prompt remain reachable", () => {
	for (let seed = 1; seed <= CASES; seed++) {
		const next = rng(seed);
		const text = cleanText(next) + `TAIL_${seed}`;
		const key = `option_${seed}`;
		const ctx = context({ args: { description: "scan", prompt: text, [key]: text }, expanded: true });
		const call = toolRow(ctx, theme, { label: "agent", detail: "scan" });
		const shown = normalize(unrail(call.render(20 + Math.floor(next() * 60))));
		assert.ok(shown.includes(`${key}:`), `seed ${seed}: missing key`);
		assert.ok(shown.includes(normalize(text)), `seed ${seed}: content lost`);
		assert.ok(shown.includes(`TAIL_${seed}`));
	}
});

test("prompts stay available even if the headline also contains them", () => {
	for (let seed = 1; seed <= CASES; seed++) {
		const text = `PROMPT_${seed}`;
		const ctx = context({ args: { description: "scan", prompt: text }, expanded: true });
		const call = toolRow(ctx, theme, { label: "agent", detail: `scan ${text}` });
		assert.ok(normalize(unrail(call.render(80))).includes(`prompt${text}`));
	}
});

test("normal folded calls and results remain compact without leaking the prompt or report", () => {
	for (let seed = 1; seed <= CASES; seed++) {
		const width = 10 + seed;
		const ctx = context({ args: { description: "scan", prompt: "HIDDEN_PROMPT" } });
		const call = toolRow(ctx, theme, { label: "agent", detail: "scan" });
		const result = toolResult({ content: [{ type: "text", text: "HIDDEN_REPORT" }], details: { status: "finished", tokens: seed * 500 } }, { expanded: false }, theme, ctx);
		const lines = [...call.render(width), ...result.render(width)];
		assert.equal(lines.length, 1);
		assert.doesNotMatch(unrail(lines), /HIDDEN|prompt|report/);
		assert.deepEqual(result.render(width), []);
	}
});

test("malformed optional data does not throw", () => {
	for (const args of [undefined, null, {}, [], 1, "old", { prompt: "" }]) {
		for (const details of [undefined, null, {}, [], 1, "old", { tokens: NaN, toolUses: Infinity, status: {} }]) {
			for (const expanded of [false, true]) {
				const ctx = context({ args: args as Record<string, unknown>, expanded });
				const call = toolRow(ctx, theme, { label: "agent", detail: "" });
				const result = toolResult({ content: [], details }, { expanded }, theme, ctx);
				assert.doesNotThrow(() => [...call.render(40), ...result.render(40)]);
			}
		}
	}
});

test("unterminated OSC and DCS sequences are consumed rather than printed as payload", () => {
	for (const escape of ["\x1b]8;;BAD_LINK", "\x1bPPRIVATE_PAYLOAD", "\x1b_PRIVATE_PAYLOAD"]) {
		for (const width of [8, 24, 80]) {
			const text = `visible${escape}\nAFTER`;
			const component = toolResult({ content: [{ type: "text", text }] }, { expanded: true }, theme, context());
			const shown = normalize(unrail(component.render(width)));
			assert.ok(shown.includes("visibleAFTER"));
			assert.doesNotMatch(shown, /BAD_LINK|PRIVATE_PAYLOAD|\x1b/);
		}
	}
});

test("normalization is idempotent and never carries input ANSI into a measured value", () => {
	for (let seed = 1; seed <= CASES; seed++) {
		const text = dirtyText(rng(seed));
		const normalized = singleLine(text);
		assert.equal(singleLine(normalized), normalized);
		assert.doesNotMatch(normalized, /[\u0000-\u001f\u007f]/);
	}
});

test("sufficient width preserves the complete description", () => {
	for (let seed = 1; seed <= CASES; seed++) {
		const text = `TASK_${seed}_` + "x".repeat(seed % 40);
		const call = toolRow(context(), theme, { label: "agent", detail: text });
		assert.ok(unrail(call.render(visibleWidth(text) + 40)).includes(text));
	}
});


test("a live row always shows exactly one lifecycle label matching its phase", () => {
	const LABELS = { queued: "queued", starting: "starting", running: "running", cleanup: "cleaning up", preparing: "preparing result" } as const;
	for (const width of [24, 40, 80, 120]) for (const [phase, label] of Object.entries(LABELS)) {
		const component = toolResult({ content: [], details: { progress: {
			version: 2, elapsedMs: 5_000, phase, toolUses: 1, tools: [], slots: [null, null],
		} } }, { expanded: false, isPartial: true }, theme, context({ args: { description: "scan" } }));
		const line = strip(component.render(width)[0]);
		assert.ok(line.endsWith(label), `${phase}@${width}: ${line}`);
		assert.deepEqual(Object.values(LABELS).filter((candidate) => line.includes(candidate)), [label], `${phase}@${width}: ${line}`);
	}
});

test("actual report truncation is always disclosed even when optional statistics disappear", () => {
	for (const width of [24, 32, 50, 100]) {
		const result = toolResult({ content: [{ type: "text", text: "PREFIX" }], details: { status: "finished", tokens: 9000, truncated: true } }, { expanded: false }, theme, context());
		assert.match(unrail(result.render(width)), /report truncated/);
	}
});
