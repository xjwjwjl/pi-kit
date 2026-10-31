import assert from "node:assert/strict";
import test from "node:test";
import { getLanguageFromPath, initTheme } from "@earendil-works/pi-coding-agent";
import { hyperlink, Text, visibleWidth } from "@earendil-works/pi-tui";
import { ExpandedDetailRail } from "../components/expanded-detail-rail.js";
import { LineNumberedCodeBlock } from "../components/line-numbered-code-block.js";
import { ToolDetailFooter } from "../components/tool-detail-footer.js";
import { registerCompactBash } from "../renderers/bash.js";
import { registerCompactEdit } from "../renderers/edit.js";
import { registerCompactRead } from "../renderers/read.js";
import { registerCompactWrite } from "../renderers/write.js";
import { registerCompactToolRenderer } from "../renderers/render-shell.js";
import { highlightCodeCalls } from "./stubs/pi-coding-agent.js";
import { captureRegisteredRenderer as captureRegisteredTool } from "./renderer-fixture.js";

const theme = {
	bg(_token: string, text: string) { return text; },
	fg(_token: string, text: string) {
		return text;
	},
	bold(text: string) {
		return text;
	},
} as any;

await initTheme();

function render(component: { render: (width: number) => string[] }, width: number): string[] {
	return component.render(width);
}

function context(state: any, args: any, expanded = true, argsComplete = true) {
	return {
		expanded,
		state,
		toolCallId: "expanded-test",
		args,
		lastComponent: undefined,
		executionStarted: true,
		argsComplete,
		isPartial: false,
		isError: false,
		invalidate() {},
		showImages: false,
		cwd: process.cwd(),
		outputPad: 0,
	};
}

test("shared renderer framing preserves raw state, lastComponent, and exact self-mode slots", () => {
	let resolver: any;
	let mode: "self" | "default" = "self";
	const state: any = { untouched: true };
	const rawCall = new Text("raw header");
	const rawResult = new Text("raw body\nsecond body line");
	const seenCalls: any[] = [];
	const seenResults: any[] = [];
	let invalidations = 0;
	(rawCall as any).invalidate = () => { invalidations++; };
	(rawResult as any).invalidate = () => { invalidations++; };
	registerCompactToolRenderer({ registerToolRenderer(value: any) { resolver = value; } } as any, "fixture", () => ({
		renderCall(_args, _theme, context) {
			assert.equal(context.state, state, "wrapper must preserve shared mutable tool state");
			seenCalls.push(context.lastComponent);
			context.state.callObserved = true;
			return rawCall;
		},
		renderResult(_result, _options, _theme, context) {
			assert.equal(context.state, state);
			assert.equal(context.state.callObserved, true);
			seenResults.push(context.lastComponent);
			return rawResult;
		},
	}), () => mode);
	const renderer = resolver("fixture", () => undefined);
	const args = {};
	const ctx: any = { ...context(state, args), outputPad: 2 };
	const call = renderer.renderCall(args, theme, ctx);
	const result = renderer.renderResult({ content: [], details: undefined }, { expanded: true, isPartial: false }, theme, ctx);
	assert.deepEqual(call.render(40), rawCall.render(36).map((line) => `  ${line}  `));
	assert.deepEqual(result.render(40), rawResult.render(36).map((line) => `  ${line}  `));
	assert.notEqual(call, rawCall);
	assert.notEqual(result, rawResult);
	renderer.renderCall(args, theme, { ...ctx, lastComponent: call });
	renderer.renderResult({ content: [], details: undefined }, { expanded: true, isPartial: false }, theme, { ...ctx, lastComponent: result });
	assert.deepEqual(seenCalls, [undefined, rawCall]);
	assert.deepEqual(seenResults, [undefined, rawResult]);
	const alreadyRaw = new Text("raw external component");
	renderer.renderCall(args, theme, { ...ctx, lastComponent: alreadyRaw });
	assert.equal(seenCalls.at(-1), alreadyRaw, "foreign components pass through untouched");
	call.invalidate();
	assert.equal(invalidations, 2, "framing invalidation reaches both raw slots");
	mode = "default";
	const framed = [...call.render(40), ...result.render(40)];
	assert.deepEqual(framed, [
		" ".repeat(40),
		"  raw header".padEnd(40),
		"  raw body".padEnd(40),
		"  second body line".padEnd(40),
		" ".repeat(40),
	]);
	assert.equal(call.render(40).length, 2, "call owns only the top margin and header");
	assert.equal(result.render(40).length, 3, "result owns body and the sole bottom margin");
	mode = "self";
	assert.deepEqual(call.render(40), rawCall.render(36).map((line) => `  ${line}  `));
	assert.deepEqual(result.render(40), rawResult.render(36).map((line) => `  ${line}  `));
});

test("default presentation applies native-like background, outputPad, and margins without duplicate padding", () => {
	let mode: "self" | "default" = "default";
	const renderer = captureRegisteredTool((pi, cwd) => registerCompactRead(pi, cwd, () => mode));
	const colors: Record<string, string> = { toolPendingBg: "\x1b[43m", toolErrorBg: "\x1b[41m", toolSuccessBg: "\x1b[42m" };
	const activeTheme = { ...theme, colors: {}, bg(token: string, line: string) { return `${colors[token]}${line}\x1b[0m`; } };
	const args = { path: "src/a.ts" };
	const ctx: any = { ...context({}, args, false), isPartial: true, outputPad: 2 };
	const call = renderer.renderCall(args, activeTheme, ctx);
	assert.equal(call.render(40).length, 3, "before a result the call owns both vertical margins");
	assert.ok(call.render(40).every((line: string) => line.startsWith(colors.toolPendingBg!)));
	for (const [isPartial, isError, token] of [[true, false, "toolPendingBg"], [false, false, "toolSuccessBg"], [false, true, "toolErrorBg"]] as const) {
		const result = renderer.renderResult({ content: [{ type: "text", text: "some output" }], details: undefined },
			{ expanded: false, isPartial }, activeTheme, { ...ctx, isError, outputPad: 2 });
		const lines: string[] = [...call.render(40), ...result.render(40)];
		assert.equal(lines.length, 3, "empty collapsed result contributes only the bottom margin");
		assert.ok(lines.every((line) => line.startsWith(colors[token]!)));
		assert.ok(lines.every((line) => visibleWidth(line) === 40));
		assert.match(lines[1]!, /\x1b\[\d+m  Read /);
	}
	const result = renderer.renderResult({ content: [{ type: "text", text: "expanded body" }], details: undefined },
		{ expanded: true, isPartial: false }, activeTheme, { ...ctx, expanded: true, outputPad: 0 });
	assert.match(call.render(40)[1], /\x1b\[42mRead /, "outputPad=0 is not replaced by a default");
	const lines: string[] = [...call.render(40), ...result.render(40)];
	assert.equal(lines.filter((line) => visibleWidth(line.replace(/\x1b\[[0-9;]*m/g, "").trim()) === 0).length, 2);
	mode = "self";
	renderer.renderResult({ content: [{ type: "text", text: "expanded body" }], details: undefined },
		{ expanded: true, isPartial: false }, activeTheme, { ...ctx, expanded: true, outputPad: 2 });
	assert.match(call.render(40)[0], /^  Read /, "self mode honours outputPad without a Box");
	assert.match(result.render(40).join("\n"), /expanded body/);
	assert.ok([...call.render(40), ...result.render(40)].every((line: string) => !line.includes("\x1b[42m")));
	assert.ok([...call.render(40), ...result.render(40)].every((line: string) => line.startsWith("  ") || line.trim() === ""), "self mode insets both slots");
});

test("self presentation insets both slots by outputPad without a Box, background or margins", () => {
	const renderer = captureRegisteredTool((pi, cwd) => registerCompactRead(pi, cwd, () => "self"));
	const args = { path: "src/a.ts" };
	const ctx: any = { ...context({}, args, false), isPartial: false, outputPad: 2 };
	const call = renderer.renderCall(args, theme, ctx);
	const result = renderer.renderResult({ content: [{ type: "text", text: "expanded body" }], details: undefined },
		{ expanded: true, isPartial: false }, theme, { ...ctx, expanded: true });
	for (const lines of [call.render(40), result.render(40)]) {
		assert.ok(lines.length > 0);
		for (const line of lines) {
			assert.ok(visibleWidth(line) <= 40, "the inset must reduce the content width");
			assert.ok(line.startsWith("  "), `expected an outputPad inset: ${JSON.stringify(line)}`);
		}
	}
	assert.equal(call.render(40).length, 1, "self mode adds no vertical margins");
	const zero = renderer.renderCall(args, theme, { ...ctx, outputPad: 0 });
	assert.ok(zero.render(40)[0]!.startsWith("Read "), "outputPad=0 removes the inset");
});

test("read/write highlight caches follow colors replacement on a stable theme proxy", () => {
	for (const register of [registerCompactRead, registerCompactWrite]) {
		const tool = captureRegisteredTool(register);
		const args = { path: "src/cache.ts", content: "export const value = 1;" };
		const state: any = {};
		const activeTheme = { ...theme, colors: { toolOutput: "old" } };
		const ctx = context(state, args);
		const value = { content: [{ type: "text", text: args.content }], details: undefined };
		const start = highlightCodeCalls.length;
		const first = tool.renderResult(value, { expanded: true, isPartial: false }, activeTheme, ctx);
		const cached = state.expandedHighlightCache.lines;
		tool.renderResult(value, { expanded: true, isPartial: false }, activeTheme, { ...ctx, lastComponent: first });
		assert.equal(highlightCodeCalls.length, start + 1);
		assert.equal(state.expandedHighlightCache.lines, cached);
		activeTheme.colors = { toolOutput: "new" };
		tool.renderResult(value, { expanded: true, isPartial: false }, activeTheme, { ...ctx, lastComponent: first });
		assert.equal(highlightCodeCalls.length, start + 2, "stable theme identity cannot retain old highlighted colors");
		assert.notEqual(state.expandedHighlightCache.lines, cached);
	}
});

test("expanded Bash displays tabs without terminal-width escapes", () => {
	const tool = captureRegisteredTool(registerCompactBash);
	const args = { command: "printf\t'with tabs'\n\tprintf second" };
	const result = tool.renderResult({ content: [{ type: "text", text: "output\twith tabs" }], details: undefined },
		{ expanded: true, isPartial: false }, theme, context({}, args));
	for (const width of [24, 48, 80]) {
		const lines = render(result, width);
		assert.ok(lines.every((line) => !line.includes("\t")), "display must not emit raw terminal tabs");
		assert.ok(lines.every((line) => visibleWidth(line) <= width));
	}
});

test("expanded detail rail and code block stay within narrow widths", () => {
	const rail = new ExpandedDetailRail(theme, [
		{
			label: "content",
			metadata: "TypeScript",
			content: new LineNumberedCodeBlock(["const value = aVeryLongIdentifierThatMustWrapSafely;"], theme),
		},
	]);

	for (const width of [48, 64, 80, 120]) {
		assert.ok(render(rail, width).every((line) => visibleWidth(line) <= width), `rail overflow at ${width}`);
	}

	const narrow = render(new LineNumberedCodeBlock(["alpha"], theme), 48).join("\n");
	assert.doesNotMatch(narrow, /\s+alpha$/);
	const wide = render(new LineNumberedCodeBlock(["alpha"], theme), 80).join("\n");
	assert.match(wide, /1 alpha/);
});

test("expanded bash keeps command text raw", () => {
	const tool = captureRegisteredTool(registerCompactBash);
	const command = "echo a && pwd || printf x; cat input |& grep foo | sort";
	const args = { command };
	const result = tool.renderResult(
		{ content: [{ type: "text", text: "ok" }], details: undefined },
		{ expanded: true, isPartial: false },
		theme,
		context({}, args),
	);
	const text = render(result, 120).join("\n");
	assert.match(text, /├─ command/);
	assert.ok(text.includes(command));
	assert.doesNotMatch(text, /statements|stages/);
	for (const width of [48, 64, 80, 120]) {
		assert.ok(render(result, width).every((line) => visibleWidth(line) <= width), `command overflow at ${width}`);
	}

	const partial = tool.renderResult(
		{ content: [{ type: "text", text: "ok" }], details: undefined },
		{ expanded: true, isPartial: false },
		theme,
		context({}, args, true, false),
	);
	assert.ok(render(partial, 120).join("\n").includes(command));
});

test("expanded streaming bash labels the visible tail against the total output", () => {
	const tool = captureRegisteredTool(registerCompactBash);
	const args = { command: "npm test" };
	const output = `${Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join("\n")}\n`;
	const result = tool.renderResult(
		{ content: [{ type: "text", text: output }], details: undefined },
		{ expanded: true, isPartial: true },
		theme,
		context({}, args),
	);
	const text = render(result, 120).join("\n");
	assert.match(text, /├─ output · tail 28\/40 lines · streaming/);
	assert.match(text, /\bline 13\b/);
	assert.doesNotMatch(text, /\bline 12\b/);
	assert.doesNotMatch(text, /╰─ streaming/);
	assert.equal(render(result, 120).filter((line) => /^  │ line \d+$/.test(line)).length, 28);
});

test("expanded Bash retains all settled output after a capped stream, including failures", () => {
	const tool = captureRegisteredTool(registerCompactBash);
	const output = Array.from({ length: 80 }, (_, index) => `diagnostic-${index + 1}`).join("\n");
	for (const isError of [false, true]) {
		const args = Object.freeze({ command: "fixture-only command" });
		const ctx = { ...context({}, args), isError };
		const value = Object.freeze({ content: Object.freeze([Object.freeze({ type: "text", text: output })]), details: undefined });
		const snapshot = JSON.stringify(value);
		const streaming = tool.renderResult(value, { expanded: true, isPartial: true }, theme, { ...ctx, isError: false });
		assert.equal(render(streaming, 120).filter((line) => /^  │ diagnostic-\d+$/.test(line)).length, 28);
		const settled = tool.renderResult(value, { expanded: true, isPartial: false }, theme, { ...ctx, lastComponent: streaming });
		const lines = render(settled, 120);
		assert.equal(lines.filter((line) => /^  │ diagnostic-\d+$/.test(line)).length, 80);
		assert.match(lines.join("\n"), /├─ output · 80 lines/);
		assert.doesNotMatch(lines.join("\n"), /streaming|tail 28/);
		assert.equal(JSON.stringify(value), snapshot);
		assert.equal(ctx.expanded, true, "settling must not rewrite expansion state");
	}
});

test("expanded footer closes truncated OSC 8 links", () => {
	const footer = new ToolDetailFooter();
	footer.setText(`full output: ${hyperlink("C:/very-long-output.txt", "file:///C:/very-long-output.txt")}`);
	const text = footer.render(24)[0] ?? "";
	const openCount = (text.match(/\x1b]8;;[^\x1b]/g) ?? []).length;
	const closeCount = (text.match(/\x1b]8;;\x1b\\/g) ?? []).length;
	assert.equal(openCount, closeCount);
});

test("expanded write renders content and attempted content after errors", () => {
	const tool = captureRegisteredTool(registerCompactWrite);
	const args = { path: "src/generated.ts", content: "const value = 1;\nexport { value };" };
	const state: any = {};
	const call = tool.renderCall(args, theme, context(state, args));
	assert.match(render(call, 120).join("\n"), /^Write /);

	const success = tool.renderResult(
		{ content: [{ type: "text", text: "Successfully wrote 33 bytes" }], details: undefined },
		{ expanded: true, isPartial: false },
		theme,
		{ ...context(state, args), lastComponent: call },
	);
	const successText = render(success, 120).join("\n");
	assert.match(successText, /├─ content · ts/);
	assert.match(successText, /1 const value = 1/);
	assert.match(successText, /2 export/);
	assert.equal(state.builtInRendererState, undefined);

	const failureState: any = {};
	const failure = tool.renderResult(
		{ content: [{ type: "text", text: "EACCES: permission denied" }], details: undefined },
		{ expanded: true, isPartial: false },
		theme,
		{ ...context(failureState, args), isError: true },
	);
	const failureText = render(failure, 120).join("\n");
	assert.match(render(failureState.expandedCallHeader, 120).join("\n"), /permission denied/);
	assert.ok(failureText.indexOf("├─ error") < failureText.indexOf("├─ content"));
	assert.match(failureText, /permission denied/);
	assert.match(failureText, /const value/);
});

test("expanded edit renders complete diff and raw errors on the detail rail", () => {
	const tool = captureRegisteredTool(registerCompactEdit);
	const args = { path: "src/router.ts", edits: [{ oldText: "timeout: 5000", newText: "timeout: 10000" }] };
	const state: any = {};
	const call = tool.renderCall(args, theme, context(state, args));
	const success = tool.renderResult(
		{
			content: [{ type: "text", text: "Successfully replaced 1 block(s)." }],
			details: { diff: " 42 const timeout = 5000\n-43 old\n+43 new", firstChangedLine: 43 },
		},
		{ expanded: true, isPartial: false },
		theme,
		{ ...context(state, args), lastComponent: call },
	);
	const successText = render(success, 120).join("\n");
	assert.match(successText, /├─ diff · 1 hunks/);
	assert.match(successText, /-43 old/);
	assert.match(successText, /\+43 new/);

	const failure = tool.renderResult(
		{ content: [{ type: "text", text: "Could not find the exact text in src/router.ts." }], details: undefined },
		{ expanded: true, isPartial: false },
		theme,
		{ ...context({}, args), isError: true },
	);
	assert.match(render(failure, 120).join("\n"), /├─ error/);
	assert.match(render(failure, 120).join("\n"), /Could not find the exact text/);
});

test("expanded read reuses the highlighted body cache", () => {
	const tool = captureRegisteredTool(registerCompactRead);
	const args = { path: "src/router.ts" };
	const state: any = {};
	const first = tool.renderResult(
		{ content: [{ type: "text", text: "export function route() {}" }], details: undefined },
		{ expanded: true, isPartial: false },
		theme,
		context(state, args),
	);
	const cachedLines = state.expandedHighlightCache?.lines;
	assert.ok(cachedLines);
	const second = tool.renderResult(
		{ content: [{ type: "text", text: "export function route() {}" }], details: undefined },
		{ expanded: true, isPartial: false },
		theme,
		context(state, args),
	);
	assert.equal(state.expandedHighlightCache?.lines, cachedLines);
	assert.equal(render(first, 120).join("\n"), render(second, 120).join("\n"));
});

test("expanded read separates continuation metadata from content", () => {
	const tool = captureRegisteredTool(registerCompactRead);
	const args = { path: "src/router.ts", offset: 80, limit: 2 };
	const result = tool.renderResult(
		{
			content: [{ type: "text", text: "export function route() {}\nreturn route;\n\n[3 more lines in file. Use offset=82 to continue.]" }],
			details: undefined,
		},
		{ expanded: true, isPartial: false },
		theme,
		context({}, args),
	);

	const text = render(result, 120).join("\n");
	assert.match(text, /├─ content · ts/);
	assert.match(text, /80 export function route/);
	assert.doesNotMatch(text, /3 more lines in file/);
	assert.match(text, /3 more lines · next offset=82 · collapse/);
	assert.equal(getLanguageFromPath(args.path), "ts");
});

test("expanded bash keeps full settled diagnostics and truncation footer", () => {
	const tool = captureRegisteredTool(registerCompactBash);
	const args = { command: "pnpm test" };
	const result = tool.renderResult(
		{
			content: [{ type: "text", text: "FAIL src/foo.test.ts\nExpected: 1\nReceived: 2\nCommand exited with code 1" }],
			details: { truncation: { truncated: true, truncatedBy: "bytes", outputLines: 3, totalLines: 100, maxBytes: 512 }, fullOutputPath: "/tmp/pi-output.txt" },
		},
		{ expanded: true, isPartial: false },
		 theme,
		{ ...context({}, args), isError: true },
	);

	const text = render(result, 120).join("\n");
	assert.match(text, /├─ output · 3 lines/);
	assert.match(text, /FAIL src\/foo\.test\.ts/);
	assert.match(text, /truncated · 3\/100 lines · 512 B cap · full output: \/tmp\/pi-output\.txt · collapse/);
});
