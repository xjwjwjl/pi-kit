import assert from "node:assert/strict";
import test from "node:test";
import { getLanguageFromPath, initTheme } from "@earendil-works/pi-coding-agent";
import { hyperlink, visibleWidth } from "@earendil-works/pi-tui";
import { ExpandedDetailRail } from "../components/expanded-detail-rail.js";
import { LineNumberedCodeBlock } from "../components/line-numbered-code-block.js";
import { ToolDetailFooter } from "../components/tool-detail-footer.js";
import { registerCompactBash } from "../renderers/bash.js";
import { registerCompactEdit } from "../renderers/edit.js";
import { registerCompactRead } from "../renderers/read.js";
import { registerCompactWrite } from "../renderers/write.js";

const theme = {
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

function captureRegisteredTool(register: (pi: any, cwd: string) => void) {
	let tool: any;
	register(
		{
			registerTool(definition: any) {
				tool = definition;
			},
		},
		process.cwd(),
	);
	assert.ok(tool);
	return tool;
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
	};
}

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

test("expanded bash formats supported command structure and keeps unsafe syntax raw", () => {
	const tool = captureRegisteredTool(registerCompactBash);
	const args = { command: "echo a && pwd || printf x; cat input |& grep foo | sort" };
	const state: any = {};
	const result = tool.renderResult(
		{ content: [{ type: "text", text: "ok" }], details: undefined },
		{ expanded: true, isPartial: false },
		theme,
		context(state, args),
	);
	const text = render(result, 120).join("\n");
	assert.match(text, /├─ command · 2 statements · 3 stages/);
	assert.match(text, /echo a &&/);
	assert.match(text, /  pwd \|\|/);
	assert.match(text, /cat input \|&/);
	assert.match(text, /  grep foo \|/);

	const unsafeArgs = { command: "if true; then echo yes; fi" };
	const unsafe = tool.renderResult(
		{ content: [{ type: "text", text: "ok" }], details: undefined },
		{ expanded: true, isPartial: false },
		theme,
		context({}, unsafeArgs),
	);
	assert.match(render(unsafe, 120).join("\n"), /if true; then echo yes; fi/);

	const partial = tool.renderResult(
		{ content: [{ type: "text", text: "ok" }], details: undefined },
		{ expanded: true, isPartial: false },
		theme,
		context({}, args, true, false),
	);
	assert.match(render(partial, 120).join("\n"), /echo a && pwd/);
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
