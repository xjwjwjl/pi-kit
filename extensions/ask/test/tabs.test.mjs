import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { renderTabBar } from "../src/tabs.ts";

const { getThemeByName } = await import(new URL(
	"../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js",
	import.meta.url,
).href);

test("ordinary widths use native padded tabs and arrows, with no implicit Submit", () => {
	assert.equal(renderTabBar(["□ Scope", "■ Priority", "✓ Submit"], 1, 80), " ←  □ Scope   ■ Priority   ✓ Submit  →");
	assert.equal(renderTabBar(["Scope"], 0, 80), " ←  Scope  →");
	assert.equal(renderTabBar(["Scope", "Submit"], 1, 80), " ←  Scope   Submit  →");
	assert.equal(renderTabBar(["A", "B"], 0, 12), " ←  A   B  →");
});

test("indices are floored and clamped, with nonfinite indices defaulting to zero", () => {
	for (const [index, expected] of [[-10, 0], [0.9, 0], [1.9, 1], [99, 2], [NaN, 0], [Infinity, 0], [-Infinity, 0]]) {
		const active = [];
		assert.equal(renderTabBar(["A", "B", "Submit"], index, 80, (text, selected, originalIndex) => {
			if (selected) active.push(originalIndex);
			return text;
		}), " ←  A   B   Submit  →");
		assert.deepEqual(active, [expected]);
	}
});

test("empty input and invalid widths are safe", () => {
	assert.equal(renderTabBar([], 0, 80), "");
	for (const width of [-10, -0.5, 0, 0.9, NaN, Infinity, -Infinity]) {
		assert.equal(renderTabBar(["Scope", "Submit"], 1, width), "");
	}
	assert.equal(renderTabBar(["Scope", "Submit"], 1, 1.9), "…");
	assert.equal(renderTabBar(["Scope", "Submit"], 1, 2.9), "S…");
	assert.equal(renderTabBar([""], 0, 2), "");
	assert.equal(renderTabBar(["A"], 0, 1), "A");
	assert.equal(renderTabBar(["范围"], 0, 2), "…");
});

test("overflow prioritizes the actual active tab, position and offscreen navigation", () => {
	const labels = ["A very long scope label", "Risk", "Submit"];
	assert.equal(renderTabBar(labels, 1, 20), " ←  Risk  2/3 →");
	assert.equal(renderTabBar(labels, 2, 20), " ←  Submit  3/3");
	assert.equal(renderTabBar(labels, 0, 20), " A very long…  1/3 →");
	assert.equal(renderTabBar(labels, 2, 12), " Submit  3/3");
	assert.equal(renderTabBar(labels, 2, 8), " Submit ");
	assert.equal(renderTabBar(labels, 2, 5), " Su… ");
	assert.equal(renderTabBar(labels, 2, 3), "Su…");
});

test("labels are sanitized before measuring or styling", () => {
	const labels = ["\x1b[31mScope\x1b[0m\nline\tend\x00\x07", "\x1b]8;;https://example.com\x07Risk\x1b]8;;\x1b\\", "\x9b32mSubmit\x9b0m"];
	assert.equal(renderTabBar(labels, 2, 100), " ←  Scope line end   Risk   Submit  →");
	assert.equal(renderTabBar(["a\r\nb\u2028c\u2029d\u202ee\x1b[2J"], 0, 100), " ←  a  b c de  →");
	const calls = [];
	const line = renderTabBar([
		"\x9d8;;https://example.com\x9cScope\x9d8;;\x9c",
		"\x1b_payload\x1b\\\x9fhidden\x9cRisk",
		"\u061c\u200e\u200f\u202aSubmit\u202c\u2066\u2069",
	], 2, 100, (text, active, index) => {
		calls.push([text, active, index]);
		return text;
	});
	assert.equal(line, " ←  Scope   Risk   Submit  →");
	assert.deepEqual(calls, [[" Scope ", false, 0], [" Risk ", false, 1], [" Submit ", true, 2]]);
});

test("ANSI styles receive sanitized padded tokens and preserve the width budget", () => {
	const calls = [];
	// Existing two-argument callbacks remain supported.
	const style = (text, active) => {
		calls.push([text, active]);
		return `\x1b[${active ? 32 : 90}m${text}\x1b[0m`;
	};
	const line = renderTabBar(["Scope", "Submit"], 1, 80, style);
	assert.deepEqual(calls, [[" Scope ", false], [" Submit ", true]]);
	assert.equal(stripTerminalSequences(line), " ←  Scope   Submit  →");
	for (let width = 1; width <= 40; width++) {
		const styled = renderTabBar(["A very long scope", "Submit"], 1, width, style);
		assert.ok(visibleWidth(styled) <= width);
		assert.equal(stripTerminalSequences(styled), renderTabBar(["A very long scope", "Submit"], 1, width));
	}
});

test("Pi themes highlight exactly the active padded tab without textual brackets", () => {
	for (const name of ["dark", "light"]) {
		const theme = getThemeByName(name);
		assert.ok(theme);
		const labels = ["□ Scope", "■ Priority", "✓ Submit"];
		for (let current = 0; current < labels.length; current++) {
			const style = (text, active, index) => active
				? theme.bg("selectedBg", theme.fg("text", text))
				: theme.fg(index === 1 ? "success" : "muted", text);
			const line = renderTabBar(labels, current, 80, style);
			assert.equal(line, " ← " + labels.map((label, index) => style(` ${label} `, index === current, index)).join(" ") + " →");
			const background = theme.getBgAnsi("selectedBg");
			assert.ok(background);
			assert.equal(line.split(background).length - 1, 1);
			assert.ok(line.includes(theme.bg("selectedBg", theme.fg("text", ` ${labels[current]} `))));
			assert.equal(stripTerminalSequences(line), " ←  □ Scope   ■ Priority   ✓ Submit  →");
		}
	}
});

test("all widths and current indices fit without wrapping, including Unicode and huge labels", () => {
	const cases = [
		["Scope", "Risk", "Submit"],
		["范围选择", "风险评估", "提交"],
		["👩‍💻 work", "🇨🇳", "e\u0301 notes", "Submit"],
		["", "", "Submit"],
		["界".repeat(20000), "x".repeat(20000), "Submit"],
		["\x1b[31mCJK范围\x1b[0m\n\t", "\x1b]0;title\x07Risk", "Submit"],
	];
	for (const labels of cases) {
		for (let index = 0; index < labels.length; index++) {
			for (let width = 1; width <= 200; width++) {
				const line = renderTabBar(labels, index, width + 0.9);
				assert.ok(visibleWidth(line) <= width, `index=${index}, width=${width}: ${line}`);
				assert.doesNotMatch(line, /[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/);
			}
		}
	}
});

test("compact styling keeps the original index and never marks a different tab active", () => {
	for (let current = 0; current < 6; current++) {
		const labels = Array.from({ length: 6 }, (_, index) => `${String.fromCharCode(65 + index).repeat(100)}`);
		for (let width = 1; width <= 30; width++) {
			const calls = [];
			renderTabBar(labels, current, width, (text, active, index) => {
				calls.push([text, active, index]);
				return text;
			});
			assert.equal(calls.length, 1);
			const [[text, active, index]] = calls;
			assert.equal(active, true);
			assert.equal(index, current);
			assert.ok(text.trim() === "…" || text.trim().startsWith(labels[current][0]));
			if (width >= 2) assert.ok(text.trim().startsWith(labels[current][0]));
		}
	}
});
