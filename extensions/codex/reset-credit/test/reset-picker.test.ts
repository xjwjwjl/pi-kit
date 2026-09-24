import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { ResetCreditPicker, type ResetPickerResult } from "../src/reset-picker.ts";
import type { ResetCredit } from "../src/types.ts";

const now = new Date("2026-09-16T00:00:00.000Z");
const credits: ResetCredit[] = [
	{ id: "credit-1", title: "First", expires_at: null },
	{ id: "credit-2", title: "Second", expires_at: null },
];

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

// Raw terminal input as delivered to components, not normalized key names.
const ENTER = "\r";
const ESCAPE = "\x1b";
const DOWN = "\x1b[B";

function createPicker() {
	const results: ResetPickerResult[] = [];
	const picker = new ResetCreditPicker(
		credits,
		now,
		theme,
		new KeybindingsManager(TUI_KEYBINDINGS),
		(result) => results.push(result),
	);
	return { picker, results };
}

test("raw enter moves from the credit list into the confirm stage", () => {
	const { picker, results } = createPicker();
	picker.handleInput(ENTER);
	assert.deepEqual(results, []);
});

test("raw enter in the confirm stage consumes the selected credit", () => {
	const { picker, results } = createPicker();
	picker.handleInput(ENTER);
	picker.handleInput(ENTER);
	assert.deepEqual(results, [{ creditId: "credit-1" }]);
});

test("raw escape in the confirm stage returns to the credit list without consuming", () => {
	const { picker, results } = createPicker();
	picker.handleInput(DOWN);
	picker.handleInput(ENTER);
	picker.handleInput(ESCAPE);
	assert.deepEqual(results, []);
	// The list reopens on the previously selected credit.
	picker.handleInput(ENTER);
	picker.handleInput(ENTER);
	assert.deepEqual(results, [{ creditId: "credit-2" }]);
});

test("raw escape in the credit list cancels the picker", () => {
	const { picker, results } = createPicker();
	picker.handleInput(ESCAPE);
	assert.deepEqual(results, [{ cancelled: true }]);
});

test("digit quick-select opens the confirm stage for that credit", () => {
	const { picker, results } = createPicker();
	picker.handleInput("2");
	picker.handleInput(ENTER);
	assert.deepEqual(results, [{ creditId: "credit-2" }]);
});

test("unrelated keys in the confirm stage do not consume anything", () => {
	const { picker, results } = createPicker();
	picker.handleInput(ENTER);
	picker.handleInput(DOWN);
	picker.handleInput("2");
	assert.deepEqual(results, []);
});
