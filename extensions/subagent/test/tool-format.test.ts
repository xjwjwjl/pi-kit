import { test } from "node:test";
import assert from "node:assert/strict";
import { formatTokens, singleLine } from "../src/tool-format.ts";

// These two token tests migrated from record-view.test.ts without changing their assertions.
test("token counts are compact enough for a column", () => {
	assert.equal(formatTokens(0), "0");
	assert.equal(formatTokens(850), "850");
	assert.equal(formatTokens(1_000), "1.0k");
	assert.equal(formatTokens(12_345), "12.3k");
	assert.equal(formatTokens(1_234_567), "1.2M");
});

test("a token count rounds before its unit is chosen", () => {
	// Rounding first moves the count to the next unit instead of printing `1000.0k`.
	assert.equal(formatTokens(999_949), "999.9k");
	assert.equal(formatTokens(999_950), "1.0M");
	assert.equal(formatTokens(999_999), "1.0M");
});

test("token formatting preserves the boundaries of each compact unit", () => {
	const cases: Array<[number, string]> = [
		[1, "1"],
		[999, "999"],
		[1_001, "1.0k"],
		[1_049, "1.0k"],
		[1_050, "1.1k"],
		[12_349, "12.3k"],
		[12_350, "12.4k"],
		[999_900, "999.9k"],
		[1_000_000, "1.0M"],
		[1_049_999, "1.0M"],
		[1_050_000, "1.1M"],
		[12_345_678, "12.3M"],
	];
	for (const [tokens, expected] of cases) assert.equal(formatTokens(tokens), expected, String(tokens));
});

test("singleLine preserves plain text, Unicode, and intentional spaces", () => {
	for (const text of ["", "foreground result.md", "  keep  spaces  ", "中文 😀 e\u0301", "**bold** and `code`"]) {
		assert.equal(singleLine(text), text);
	}
});

test("singleLine expands tabs, removes carriage returns, and flattens newlines without trimming", () => {
	assert.equal(singleLine("a\tb"), "a    b");
	assert.equal(singleLine("\t\t"), "        ");
	assert.equal(singleLine("before\rafter"), "beforeafter");
	assert.equal(singleLine("first\r\nsecond\nthird"), "first second third");
	assert.equal(singleLine("\n a\n\n b\n"), "  a   b ");
});

test("singleLine removes every other C0 control and DEL", () => {
	for (let code = 0; code < 32; code++) {
		if ([9, 10, 13].includes(code)) continue;
		assert.equal(singleLine(`before${String.fromCharCode(code)}after`), "beforeafter", `control ${code}`);
	}
	assert.equal(singleLine("before\x7fafter"), "beforeafter");
});

test("singleLine removes complete SGR, CSI, and single-character escape sequences", () => {
	for (const sequence of [
		"\x1b[31m", "\x1b[0m", "\x1b[1;44m", "\x1b[38;2;10;20;30m",
		"\x1b[?25l", "\x1b[2J", "\x1b[2 q", "\x1bD", "\x1bE", "\x1bM",
	]) {
		assert.equal(singleLine(`before${sequence}after`), "beforeafter", JSON.stringify(sequence));
	}
});

test("singleLine keeps hyperlink labels but removes OSC URLs and terminators", () => {
	for (const terminator of ["\x07", "\x1b\\"]) {
		const text = `before \x1b]8;;https://example.com/result${terminator}result.md\x1b]8;;${terminator} after`;
		assert.equal(singleLine(text), "before result.md after");
	}
});

test("singleLine consumes terminated OSC, DCS, APC, SOS, and PM payloads whole", () => {
	for (const introducer of ["]", "P", "_", "X", "^"]) {
		for (const terminator of ["\x07", "\x1b\\"]) {
			const sequence = `\x1b${introducer}private-payload;Gi=1;AAAA${terminator}`;
			assert.equal(singleLine(`before${sequence}after`), "beforeafter", JSON.stringify(sequence));
		}
	}
});

test("singleLine consumes unterminated string escapes only to the end of their line", () => {
	for (const introducer of ["]", "P", "_", "X", "^"]) {
		const sequence = `\x1b${introducer}private-payload;Gi=1;AAAA`;
		assert.equal(singleLine(sequence), "", JSON.stringify(sequence));
		assert.equal(singleLine(`before${sequence}\nafter`), "before after", JSON.stringify(sequence));
	}
});

test("singleLine is idempotent and leaves no raw escapes or controls", () => {
	for (const text of [
		"plain 中文 😀 e\u0301",
		"\tfirst\r\nsecond\x00\x7f",
		"\x1b[31mred\x1b[0m\x1b[?25l\nnext",
		"before\x1b]8;;https://example.com\x07result.md\x1b]8;;\x07after",
		"before\x1b_Gi=1;AAAA\nafter",
	]) {
		const cleaned = singleLine(text);
		assert.equal(singleLine(cleaned), cleaned);
		assert.doesNotMatch(cleaned, /[\u0000-\u001f\u007f]/);
	}
});
