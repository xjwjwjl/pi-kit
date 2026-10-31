import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { renderAuxiliaryActions } from "../src/auxiliary-actions.ts";

const { getThemeByName } = await import(new URL(
	"../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js",
	import.meta.url,
).href);

const tiers = [
	[49, "[附加说明 Ctrl+N] [跳过 Ctrl+S] Tab切换 Enter确认"],
	[35, "[附加说明] [跳过] Tab切换 Enter确认"],
	[27, "[附加说明] [跳过] Tab/Enter"],
	[21, "[附加说明] [跳过] Tab"],
	[17, "[说明] [跳过] Tab"],
	[13, "说明 跳过 Tab"],
	[9, "注 跳 Tab"],
	[5, "注 跳"],
];

function capture(width, focus) {
	const calls = [];
	const line = renderAuxiliaryActions(width, focus, (text, action, active) => {
		calls.push({ text, action, active });
		return text;
	});
	return { line, calls };
}

function assertActionText({ text, action }) {
	if (action === "note") assert.match(text, /说明|注/);
	else if (action === "skip") assert.match(text, /跳/);
	else assert.match(text, /Tab/);
}

test("fixed controls and help degrade together at exact column thresholds", () => {
	for (const [index, [width, expected]] of tiers.entries()) {
		assert.equal(visibleWidth(expected), width);
		for (const focus of [undefined, "note", "skip"]) {
			assert.equal(renderAuxiliaryActions(width, focus), expected);
			assert.equal(renderAuxiliaryActions(width + 0.9, focus), expected);
			if (index + 1 < tiers.length) {
				assert.equal(renderAuxiliaryActions(width - 1, focus), tiers[index + 1][1]);
			}
		}
	}
	assert.equal(renderAuxiliaryActions(80, undefined), tiers[0][1]);
	assert.equal(renderAuxiliaryActions(40, "skip"), tiers[1][1]);
	assert.equal(renderAuxiliaryActions(21, "note"), "[附加说明] [跳过] Tab");
});

test("normal-width control tokens own their shortcuts, while help is not an action", () => {
	const { calls } = capture(80, "skip");
	assert.deepEqual(calls, [
		{ text: "[附加说明 Ctrl+N]", action: "note", active: false },
		{ text: "[跳过 Ctrl+S]", action: "skip", active: true },
		{ text: "Tab切换 Enter确认", action: undefined, active: false },
	]);
});

test("invalid and sub-character widths render nothing without invoking styles", () => {
	for (const width of [-100, -0.5, 0, 0.9, 1, 1.9, NaN, Infinity, -Infinity]) {
		for (const focus of [undefined, "note", "skip"]) {
			assert.deepEqual(capture(width, focus), { line: "", calls: [] });
		}
	}
});

test("when only one action fits it shows the actual focus, including skip", () => {
	for (const width of [2, 2.9, 3, 3.9, 4, 4.9]) {
		assert.deepEqual(capture(width, "note"), {
			line: "注", calls: [{ text: "注", action: "note", active: true }],
		});
		assert.deepEqual(capture(width, "skip"), {
			line: "跳", calls: [{ text: "跳", action: "skip", active: true }],
		});
		assert.deepEqual(capture(width, undefined), {
			line: "注", calls: [{ text: "注", action: "note", active: false }],
		});
	}
});

test("all 1..200 columns fit one line and preserve original action identities", () => {
	for (let width = 1; width <= 200; width++) {
		for (const focus of [undefined, "note", "skip"]) {
			const { line, calls } = capture(width + 0.9, focus);
			assert.ok(visibleWidth(line) <= width, `width=${width}, focus=${focus}: ${line}`);
			assert.doesNotMatch(line, /[>\x00-\x1f\x7f-\x9f\u2028\u2029]/);
			assert.equal(line, renderAuxiliaryActions(width, focus));
			for (const call of calls) {
				assertActionText(call);
				assert.equal(call.active, call.action !== undefined && call.action === focus);
			}
			const active = calls.filter((call) => call.active).map((call) => call.action);
			assert.deepEqual(active, focus && width >= 2 ? [focus] : []);
			if (width >= 5) {
				assert.deepEqual(calls.filter((call) => call.action).map((call) => call.action), ["note", "skip"]);
			}
			if (width >= 9) {
				assert.equal(calls.at(-1).action, undefined);
				assert.equal(calls.at(-1).active, false);
			}
		}
	}
});

test("ANSI callbacks preserve raw display and width across every tier and focus", () => {
	for (let width = 1; width <= 200; width++) {
		for (const focus of [undefined, "note", "skip"]) {
			const line = renderAuxiliaryActions(width, focus, (text, action, active) => {
				const color = action === undefined ? 90 : 37;
				return `\x1b[${color}m${active ? "\x1b[44m" : ""}${text}\x1b[0m`;
			});
			const plain = renderAuxiliaryActions(width, focus);
			assert.equal(stripTerminalSequences(line), plain);
			assert.equal(visibleWidth(line), visibleWidth(plain));
			assert.ok(visibleWidth(line) <= width);
			assert.doesNotMatch(line, /[\r\n\u2028\u2029]/);
		}
	}
});

test("dark and light Pi themes apply selectedBg only to the focused control", () => {
	for (const name of ["dark", "light"]) {
		const theme = getThemeByName(name);
		assert.ok(theme);
		const background = theme.getBgAnsi("selectedBg");
		assert.ok(background);
		for (const width of [80, 40, 26, 20, 16, 12, 8, 5, 4, 3, 2, 1]) {
			for (const focus of [undefined, "note", "skip"]) {
				const styledControls = [];
				const line = renderAuxiliaryActions(width, focus, (text, action, active) => {
					if (!active) return theme.fg(action === undefined ? "dim" : "muted", text);
					const styled = theme.bg("selectedBg", theme.fg("text", text));
					styledControls.push({ text, action, styled });
					return styled;
				});
				const expectedCount = focus && width >= 2 ? 1 : 0;
				assert.equal(styledControls.length, expectedCount);
				assert.equal(line.split(background).length - 1, expectedCount);
				for (const control of styledControls) {
					assert.equal(control.action, focus);
					assertActionText(control);
					assert.ok(line.includes(control.styled));
				}
				assert.equal(stripTerminalSequences(line), renderAuxiliaryActions(width, focus));
				assert.ok(visibleWidth(line) <= width);
			}
		}
	}
});

test("single-question flows render a note-only row and degrade at exact thresholds", () => {
	const noteOnly = [
		[35, "[附加说明 Ctrl+N] Tab切换 Enter确认"],
		[28, "[附加说明] Tab切换 Enter确认"],
		[20, "[附加说明] Tab/Enter"],
		[14, "[附加说明] Tab"],
		[10, "[说明] Tab"],
		[8, "说明 Tab"],
		[6, "注 Tab"],
		[2, "注"],
	];
	for (const [index, [width, expected]] of noteOnly.entries()) {
		assert.equal(visibleWidth(expected), width);
		for (const focus of [undefined, "note"]) {
			assert.equal(renderAuxiliaryActions(width, focus, undefined, { skippable: false }), expected);
			if (index + 1 < noteOnly.length) {
				assert.equal(renderAuxiliaryActions(width - 1, focus, undefined, { skippable: false }), noteOnly[index + 1][1]);
			}
		}
	}
	assert.equal(renderAuxiliaryActions(80, "note", undefined, { skippable: false }), noteOnly[0][1]);
});

test("a note-only row never renders Skip, even when a stale skip focus is passed in", () => {
	for (let width = 1; width <= 120; width++) {
		for (const focus of [undefined, "note", "skip"]) {
			const calls = [];
			const line = renderAuxiliaryActions(width, focus, (text, action, active) => {
				calls.push({ text, action, active });
				return text;
			}, { skippable: false });
			assert.doesNotMatch(line, /跳过|跳/);
			assert.ok(!calls.some((call) => call.action === "skip"), `width=${width}: skip must not be offered`);
			assert.ok(calls.filter((call) => call.active).every((call) => call.action === "note"));
		}
	}
});
