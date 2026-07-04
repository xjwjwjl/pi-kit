import assert from "node:assert/strict";
import test from "node:test";
import { createBashToolDefinition, initTheme } from "@earendil-works/pi-coding-agent";
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
	assert.ok(tool, "tool should be registered");
	return tool;
}

function renderText(component: { render: (width: number) => string[] } | undefined, width = 200): string {
	return component ? component.render(width).join("\n") : "";
}

test("compact renderers expose configurable render shell", () => {
	let renderShell: "self" | "default" = "default";
	for (const register of [
		(pi: any, cwd: string) => registerCompactBash(pi, cwd, {}, () => renderShell),
		(pi: any, cwd: string) => registerCompactRead(pi, cwd, () => renderShell),
		(pi: any, cwd: string) => registerCompactWrite(pi, cwd, () => renderShell),
		(pi: any, cwd: string) => registerCompactEdit(pi, cwd, undefined, () => renderShell),
	]) {
		const tool = captureRegisteredTool(register);
		assert.equal(tool.renderShell, "default");
		renderShell = "self";
		assert.equal(tool.renderShell, "self");
		renderShell = "default";
	}
});

function toolContext(state: any, toolCallId: string, args: any, lastComponent: any, expanded = false) {
	return {
		expanded,
		state,
		toolCallId,
		args,
		lastComponent,
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		isError: false,
		invalidate() {},
		showImages: false,
		cwd: process.cwd(),
	};
}

test("compact bash settles state when a partial run finishes while expanded", () => {
	const tool = captureRegisteredTool(registerCompactBash);
	const args = { command: "echo hi" };
	const startedAt = Date.now() - 1500;
	const state: any = { compactStartedAt: startedAt, startedAt };
	const toolCallId = "bash-1";

	const originalSetInterval = global.setInterval;
	const originalClearInterval = global.clearInterval;
	global.setInterval = ((() => ({ fake: true })) as unknown) as typeof setInterval;
	global.clearInterval = ((() => undefined) as unknown) as typeof clearInterval;

	try {
		const call = tool.renderCall(args, theme, {
			expanded: false,
			state,
			toolCallId,
			args,
			lastComponent: undefined,
			executionStarted: true,
			isError: false,
			invalidate() {},
			showImages: false,
			cwd: process.cwd(),
		});

		tool.renderResult(
			{ content: [{ type: "text", text: "line 1" }], details: undefined },
			{ expanded: false, isPartial: true },
			theme,
			{
				expanded: false,
				state,
				toolCallId,
				args,
				lastComponent: call,
				executionStarted: true,
				isError: false,
				invalidate() {},
				showImages: false,
				cwd: process.cwd(),
			},
		);
		assert.ok(state.compactInterval, "partial render should create a refresh interval");

		tool.renderResult(
			{ content: [{ type: "text", text: "done" }], details: undefined },
			{ expanded: true, isPartial: false },
			theme,
			{
				expanded: true,
				state,
				toolCallId,
				args,
				lastComponent: undefined,
				executionStarted: true,
				isError: false,
				invalidate() {},
				showImages: false,
				cwd: process.cwd(),
			},
		);

		assert.equal(state.compactInterval, undefined);
		assert.equal(typeof state.compactEndedAt, "number");
		assert.equal(typeof state.endedAt, "number");
		assert.equal(state.compactStatus, "success");
		assert.equal(state.compactSummary, "1 output line");
		assert.match(renderText(state.compactCallText), /^Bash /);

		const reconstructed = tool.renderCall(args, theme, toolContext(state, toolCallId, args, undefined));
		assert.match(renderText(reconstructed), /^Bash /);
		assert.match(renderText(reconstructed), /1 output line/);
	} finally {
		global.setInterval = originalSetInterval;
		global.clearInterval = originalClearInterval;
	}
});

test("compact bash starts a refresh timer before the first partial output", () => {
	const tool = captureRegisteredTool(registerCompactBash);
	const args = { command: "npm test" };
	const startedAt = Date.now() - 1500;
	const state: any = { compactStartedAt: startedAt, startedAt };
	const toolCallId = "bash-no-output-refresh";
	const intervalCallbacks: Array<() => void> = [];
	const cleared: any[] = [];
	let invalidations = 0;

	const originalSetInterval = global.setInterval;
	const originalClearInterval = global.clearInterval;
	global.setInterval = ((((callback: () => void) => {
		intervalCallbacks.push(callback);
		return { id: intervalCallbacks.length } as any;
	}) as unknown) as typeof setInterval);
	global.clearInterval = ((((interval: any) => {
		cleared.push(interval);
	}) as unknown) as typeof clearInterval);

	try {
		const call = tool.renderCall(args, theme, {
			...toolContext(state, toolCallId, args, undefined),
			invalidate() {
				invalidations++;
			},
		});

		assert.equal(intervalCallbacks.length, 1);
		assert.ok(state.compactInterval);
		assert.match(renderText(call), /running|1\.[0-9]s/);

		intervalCallbacks[0]?.();
		assert.equal(invalidations, 1);
		assert.deepEqual(cleared, []);
	} finally {
		global.setInterval = originalSetInterval;
		global.clearInterval = originalClearInterval;
	}
});

test("compact bash timer rebinds to the latest invalidate after rerender", () => {
	const tool = captureRegisteredTool(registerCompactBash);
	const args = { command: "npm test" };
	const startedAt = Date.now() - 1500;
	const state: any = { compactStartedAt: startedAt, startedAt };
	const toolCallId = "bash-refresh-rebind";
	const intervalCallbacks: Array<() => void> = [];
	const cleared: any[] = [];
	let firstInvalidations = 0;
	let secondInvalidations = 0;

	const originalSetInterval = global.setInterval;
	const originalClearInterval = global.clearInterval;
	global.setInterval = ((((callback: () => void) => {
		intervalCallbacks.push(callback);
		return { id: intervalCallbacks.length } as any;
	}) as unknown) as typeof setInterval);
	global.clearInterval = ((((interval: any) => {
		cleared.push(interval);
	}) as unknown) as typeof clearInterval);

	try {
		const firstCall = tool.renderCall(args, theme, {
			...toolContext(state, toolCallId, args, undefined),
			invalidate() {
				firstInvalidations++;
			},
		});
		tool.renderResult(
			{ content: [{ type: "text", text: "line 1\n" }], details: undefined },
			{ expanded: false, isPartial: true },
			theme,
			{
				...toolContext(state, toolCallId, args, firstCall),
				invalidate() {
					firstInvalidations++;
				},
			},
		);
		assert.equal(intervalCallbacks.length, 1);

		tool.renderCall(args, theme, {
			...toolContext(state, toolCallId, args, firstCall),
			invalidate() {
				secondInvalidations++;
			},
		});

		intervalCallbacks[0]?.();
		assert.equal(firstInvalidations, 0);
		assert.equal(secondInvalidations, 1);
		assert.ok(state.compactInterval);
		assert.deepEqual(cleared, []);
	} finally {
		global.setInterval = originalSetInterval;
		global.clearInterval = originalClearInterval;
	}
});

test("compact bash reuses the same refresh timer across remount-like state replacement", () => {
	const tool = captureRegisteredTool(registerCompactBash);
	const args = { command: "npm test" };
	const startedAt = Date.now() - 1500;
	const firstState: any = { compactStartedAt: startedAt, startedAt };
	const secondState: any = { compactStartedAt: startedAt, startedAt };
	const toolCallId = "bash-refresh-remount";
	const intervalCallbacks: Array<() => void> = [];
	const cleared: any[] = [];
	let firstInvalidations = 0;
	let secondInvalidations = 0;

	const originalSetInterval = global.setInterval;
	const originalClearInterval = global.clearInterval;
	global.setInterval = ((((callback: () => void) => {
		intervalCallbacks.push(callback);
		return { id: intervalCallbacks.length } as any;
	}) as unknown) as typeof setInterval);
	global.clearInterval = ((((interval: any) => {
		cleared.push(interval);
	}) as unknown) as typeof clearInterval);

	try {
		const firstCall = tool.renderCall(args, theme, {
			...toolContext(firstState, toolCallId, args, undefined),
			invalidate() {
				firstInvalidations++;
			},
		});
		tool.renderResult(
			{ content: [{ type: "text", text: "line 1\n" }], details: undefined },
			{ expanded: false, isPartial: true },
			theme,
			{
				...toolContext(firstState, toolCallId, args, firstCall),
				invalidate() {
					firstInvalidations++;
				},
			},
		);
		assert.equal(intervalCallbacks.length, 1);
		assert.ok(firstState.compactInterval);

		const remountedCall = tool.renderCall(args, theme, {
			...toolContext(secondState, toolCallId, args, undefined),
			invalidate() {
				secondInvalidations++;
			},
		});
		assert.equal(intervalCallbacks.length, 1);
		assert.ok(secondState.compactInterval);

		intervalCallbacks[0]?.();
		assert.equal(firstInvalidations, 0);
		assert.equal(secondInvalidations, 1);

		tool.renderResult(
			{ content: [{ type: "text", text: "done\n" }], details: undefined },
			{ expanded: false, isPartial: false },
			theme,
			{
				...toolContext(secondState, toolCallId, args, remountedCall),
				invalidate() {
					secondInvalidations++;
				},
			},
		);

		assert.equal(secondState.compactInterval, undefined);
		assert.equal(cleared.length, 1);
	} finally {
		global.setInterval = originalSetInterval;
		global.clearInterval = originalClearInterval;
	}
});

test("compact bash reconstructs failed state from persisted summary", () => {
	const tool = captureRegisteredTool(registerCompactBash);
	const args = { command: "pnpm test" };
	const startedAt = Date.now() - 1500;
	const state: any = { compactStartedAt: startedAt, startedAt };
	const toolCallId = "bash-failed-reconstruct";

	tool.renderResult(
		{ content: [{ type: "text", text: "boom\nCommand exited with code 2\n" }], details: undefined },
		{ expanded: true, isPartial: false },
		theme,
		{ ...toolContext(state, toolCallId, args, undefined, true), isError: true },
	);

	assert.equal(state.compactStatus, "failed");
	assert.equal(state.compactSummary, "exit 2");

	const reconstructed = tool.renderCall(args, theme, toolContext(state, toolCallId, args, undefined));
	const text = renderText(reconstructed);
	assert.match(text, /^Bash /);
	assert.match(text, /exit 2/);
	assert.match(text, /1\.[0-9]s/);
});

test("compact bash classifies test failures in the collapsed header", () => {
	const tool = captureRegisteredTool(registerCompactBash);
	const args = { command: "pnpm test" };
	const state: any = { compactStartedAt: Date.now() - 1500 };
	const toolCallId = "bash-test-failure";

	const call = tool.renderCall(args, theme, toolContext(state, toolCallId, args, undefined));
	tool.renderResult(
		{ content: [{ type: "text", text: "FAIL src/app.test.ts\nTests: 1 failed, 3 passed\nCommand exited with code 1\n" }], details: undefined },
		{ expanded: false, isPartial: false },
		theme,
		{ ...toolContext(state, toolCallId, args, call), isError: true },
	);

	const text = renderText(state.compactCallText);
	assert.match(text, /^Bash /);
	assert.match(text, /test failed · exit 1/);
});

test("compact bash classifies tsc failures in the collapsed header", () => {
	const tool = captureRegisteredTool(registerCompactBash);
	const args = { command: "pnpm tsc --noEmit" };
	const state: any = { compactStartedAt: Date.now() - 1500 };
	const toolCallId = "bash-tsc-failure";

	const call = tool.renderCall(args, theme, toolContext(state, toolCallId, args, undefined));
	tool.renderResult(
		{
			content: [
				{
					type: "text",
					text: "src/app.ts:42:13 - error TS2322: Type 'string' is not assignable to type 'number'.\nCommand exited with code 2\n",
				},
			],
			details: undefined,
		},
		{ expanded: false, isPartial: false },
		theme,
		{ ...toolContext(state, toolCallId, args, call), isError: true },
	);

	const text = renderText(state.compactCallText);
	assert.match(text, /^Bash /);
	assert.match(text, /tsc errors · exit 2/);
});

test("compact bash shows success output summary before duration when enabled", () => {
	const tool = captureRegisteredTool((pi, cwd) => registerCompactBash(pi, cwd, { successfulOutputSummary: true }));
	const args = { command: "printf 'alpha\\nbeta\\n'" };
	const state: any = { compactStartedAt: Date.now() - 1500 };
	const toolCallId = "bash-success-summary-on";

	const call = tool.renderCall(args, theme, toolContext(state, toolCallId, args, undefined));
	tool.renderResult(
		{ content: [{ type: "text", text: "alpha\nbeta\n" }], details: undefined },
		{ expanded: false, isPartial: false },
		theme,
		toolContext(state, toolCallId, args, call),
	);

	const text = renderText(state.compactCallText);
	assert.match(text, /^Bash /);
	assert.match(text, /2 output lines · 1\.[0-9]s/);
});

test("compact bash includes timeout metadata when provided", () => {
	const tool = captureRegisteredTool(registerCompactBash);
	const args = { command: "sleep 10", timeout: 30 };
	const state: any = { compactStartedAt: Date.now() - 1500 };
	const toolCallId = "bash-timeout-metadata";

	const rendered = tool.renderCall(args, theme, toolContext(state, toolCallId, args, undefined));
	const text = renderText(rendered);

	assert.match(text, /^Bash sleep 10/);
	assert.match(text, /timeout 30s/);
	assert.match(text, /running/);
	assert.match(text, /1\.[0-9]s/);
});

test("compact bash hides success output summary when disabled", () => {
	const tool = captureRegisteredTool((pi, cwd) => registerCompactBash(pi, cwd, { successfulOutputSummary: false }));
	const args = { command: "printf 'alpha\\nbeta\\n'" };
	const state: any = {};
	const toolCallId = "bash-success-summary-off";

	const call = tool.renderCall(args, theme, toolContext(state, toolCallId, args, undefined));
	tool.renderResult(
		{ content: [{ type: "text", text: "alpha\nbeta\n" }], details: undefined },
		{ expanded: false, isPartial: false },
		theme,
		toolContext(state, toolCallId, args, call),
	);

	const text = renderText(state.compactCallText);
	assert.match(text, /^Bash /);
	assert.doesNotMatch(text, /output lines/);
});

test("compact bash does not show success output summary for empty output", () => {
	const tool = captureRegisteredTool((pi, cwd) => registerCompactBash(pi, cwd, { successfulOutputSummary: true }));
	const args = { command: "true" };
	const state: any = {};
	const toolCallId = "bash-success-summary-empty";

	const call = tool.renderCall(args, theme, toolContext(state, toolCallId, args, undefined));
	tool.renderResult(
		{ content: [{ type: "text", text: "(no output)" }], details: undefined },
		{ expanded: false, isPartial: false },
		theme,
		toolContext(state, toolCallId, args, call),
	);

	const text = renderText(state.compactCallText);
	assert.match(text, /^Bash /);
	assert.doesNotMatch(text, /output line/);
});

test("compact bash shows running tail preview when enabled", () => {
	const tool = captureRegisteredTool((pi, cwd) => registerCompactBash(pi, cwd, { runningTailPreview: true, previewLines: 2 }));
	const args = { command: "npm test" };
	const state: any = {};
	const toolCallId = "bash-running-preview-on";

	const call = tool.renderCall(args, theme, toolContext(state, toolCallId, args, undefined));
	const result = tool.renderResult(
		{ content: [{ type: "text", text: "a\nb\nc\n" }], details: undefined },
		{ expanded: false, isPartial: true },
		theme,
		toolContext(state, toolCallId, args, call),
	);

	assert.match(renderText(state.compactCallText), /3 lines so far/);
	assert.equal(renderText(result), "  │ b\n  │ c\n  ╰─");
	assert.doesNotMatch(renderText(result), /^a/m);
});

test("compact bash shows semantic summaries for search output", () => {
	const tool = captureRegisteredTool(registerCompactBash);
	const args = { command: "rg -n alpha src" };
	const state: any = {};
	const toolCallId = "bash-search-summary";

	const call = tool.renderCall(args, theme, toolContext(state, toolCallId, args, undefined));
	tool.renderResult(
		{ content: [{ type: "text", text: "src/a.ts:1:alpha\nsrc/b.ts:2:alpha\n" }], details: undefined },
		{ expanded: false, isPartial: false },
		theme,
		toolContext(state, toolCallId, args, call),
	);

	const text = renderText(state.compactCallText);
	assert.match(text, /^Bash rg \/alpha\/ in src/);
	assert.match(text, /2 matches · 2 files/);
});

test("compact bash keeps long rg summaries on one line at common widths", () => {
	const tool = captureRegisteredTool(registerCompactBash);
	const args = {
		command: "rg \"settledTailPreview|settled tail|Bash settled|successfulTailPreview|success tail\" -n . --glob '!node_modules'",
	};
	const state: any = { compactStartedAt: Date.now() - 1500 };
	const toolCallId = "bash-long-search-summary";
	const matches = ["a", "b", "c", "d", "e", "f"]
		.flatMap((file) => [1, 2, 3].map((line) => `src/${file}.ts:${line}:alpha`))
		.join("\n");

	const call = tool.renderCall(args, theme, toolContext(state, toolCallId, args, undefined));
	tool.renderResult(
		{ content: [{ type: "text", text: "line 1\nline 2\nline 3\n" }], details: undefined },
		{ expanded: false, isPartial: true },
		theme,
		toolContext(state, toolCallId, args, call),
	);
	for (const width of [75, 80, 85]) {
		const text = renderText(state.compactCallText, width);
		assert.equal(text.split("\n").length, 1);
		assert.match(text, /3 lines so far/);
	}

	tool.renderResult(
		{ content: [{ type: "text", text: `${matches}\n` }], details: undefined },
		{ expanded: false, isPartial: false },
		theme,
		toolContext(state, toolCallId, args, call),
	);
	for (const width of [75, 80, 85]) {
		const text = renderText(state.compactCallText, width);
		assert.equal(text.split("\n").length, 1);
		assert.match(text, /18 matches · 6 files/);
	}
});

test("compact bash prioritizes result metadata on narrow widths", () => {
	const tool = captureRegisteredTool(registerCompactBash);
	const args = { command: "python3 - <<'PY'\nprint('hi')\nPY" };
	const state: any = { compactStartedAt: Date.now() - 1500 };
	const toolCallId = "bash-narrow-metadata-priority";

	const call = tool.renderCall(args, theme, toolContext(state, toolCallId, args, undefined));
	tool.renderResult(
		{ content: [{ type: "text", text: "ok\n" }], details: undefined },
		{ expanded: false, isPartial: false },
		theme,
		toolContext(state, toolCallId, args, call),
	);

	const narrow = renderText(state.compactCallText, 35);
	assert.equal(narrow.split("\n").length, 1);
	assert.match(narrow, /1 output line/);
	assert.match(narrow, /1\.[0-9]s/);
	assert.doesNotMatch(narrow, /3 lines ·/);
});

test("compact bash shows semantic empty summaries before duration", () => {
	const tool = captureRegisteredTool(registerCompactBash);
	const args = { command: "rg missing src" };
	const state: any = { compactStartedAt: Date.now() - 1200 };
	const toolCallId = "bash-empty-search-summary";

	const call = tool.renderCall(args, theme, toolContext(state, toolCallId, args, undefined));
	tool.renderResult(
		{ content: [{ type: "text", text: "" }], details: undefined },
		{ expanded: false, isPartial: false },
		theme,
		toolContext(state, toolCallId, args, call),
	);

	const text = renderText(state.compactCallText);
	assert.match(text, /^Bash rg \/missing\/ in src/);
	assert.match(text, /no matches · 1\.[0-9]s/);
});

test("compact bash summarizes multiline python heredoc commands", () => {
	const tool = captureRegisteredTool(registerCompactBash);
	const args = { command: "python3 - <<'PY'\nprint('hi')\nPY" };
	const state: any = {};
	const toolCallId = "bash-python-heredoc-summary";

	const call = tool.renderCall(args, theme, toolContext(state, toolCallId, args, undefined));
	tool.renderResult(
		{ content: [{ type: "text", text: "ok\n" }], details: undefined },
		{ expanded: false, isPartial: false },
		theme,
		toolContext(state, toolCallId, args, call),
	);

	const text = renderText(state.compactCallText);
	assert.match(text, /^Bash python3 heredoc/);
	assert.match(text, /3 lines/);
	assert.match(text, /1 output line/);
	assert.doesNotMatch(text, /print\('hi'\)/);
});

test("compact bash keeps tail preview after success when enabled", () => {
	const tool = captureRegisteredTool((pi, cwd) => registerCompactBash(pi, cwd, { successfulTailPreview: true, previewLines: 2 }));
	const args = { command: "printf 'alpha\\nbeta\\ngamma\\n'" };
	const state: any = {};
	const toolCallId = "bash-settled-preview";

	const call = tool.renderCall(args, theme, toolContext(state, toolCallId, args, undefined));
	const result = tool.renderResult(
		{ content: [{ type: "text", text: "alpha\nbeta\ngamma\n" }], details: undefined },
		{ expanded: false, isPartial: false },
		theme,
		toolContext(state, toolCallId, args, call),
	);

	const text = renderText(result);
	assert.doesNotMatch(text, /alpha/);
	assert.match(text, /beta/);
	assert.match(text, /gamma/);
});

test("compact bash hides tail preview after success by default", () => {
	const tool = captureRegisteredTool(registerCompactBash);
	const args = { command: "printf 'alpha\\nbeta\\n'" };
	const state: any = {};
	const toolCallId = "bash-settled-preview-off";

	const call = tool.renderCall(args, theme, toolContext(state, toolCallId, args, undefined));
	const result = tool.renderResult(
		{ content: [{ type: "text", text: "alpha\nbeta\n" }], details: undefined },
		{ expanded: false, isPartial: false },
		theme,
		toolContext(state, toolCallId, args, call),
	);

	assert.equal(renderText(result), "");
});

test("compact bash hides running tail preview when disabled", () => {
	const tool = captureRegisteredTool((pi, cwd) => registerCompactBash(pi, cwd, { runningTailPreview: false }));
	const args = { command: "npm test" };
	const state: any = {};
	const toolCallId = "bash-running-preview-off";

	const call = tool.renderCall(args, theme, toolContext(state, toolCallId, args, undefined));
	const result = tool.renderResult(
		{ content: [{ type: "text", text: "a\nb\nc\n" }], details: undefined },
		{ expanded: false, isPartial: true },
		theme,
		toolContext(state, toolCallId, args, call),
	);

	assert.match(renderText(state.compactCallText), /3 lines so far/);
	assert.equal(renderText(result), "");
});

test("compact bash defers expanded running output to the built-in renderer", () => {
	const tool = captureRegisteredTool((pi, cwd) => registerCompactBash(pi, cwd, { runningTailPreview: true, previewLines: 2 }));
	const original = createBashToolDefinition(process.cwd());
	assert.ok(original.renderResult, "built-in bash renderer should expose renderResult");

	const args = { command: "npm test" };
	const result = { content: [{ type: "text" as const, text: "a\nb\nc\n" }], details: undefined };
	const wrappedState: any = {};
	const originalState: any = {};
	const toolCallId = "bash-running-expanded";

	const wrappedCall = tool.renderCall(args, theme, toolContext(wrappedState, toolCallId, args, undefined));
	const wrappedRendered = tool.renderResult(
		result,
		{ expanded: true, isPartial: true },
		theme,
		toolContext(wrappedState, toolCallId, args, wrappedCall, true),
	);
	const originalRendered = original.renderResult(
		result,
		{ expanded: true, isPartial: true },
		theme,
		toolContext(originalState, toolCallId, args, undefined, true),
	);

	assert.equal(renderText(wrappedRendered), renderText(originalRendered));
});

test("expanded bash call does not pass compact call component to the built-in renderer", () => {
	const tool = captureRegisteredTool(registerCompactBash);
	const args = { command: "npm test" };
	const state: any = {};
	const toolCallId = "bash-call-isolation";

	const compactCall = tool.renderCall(args, theme, toolContext(state, toolCallId, args, undefined));
	assert.doesNotThrow(() => tool.renderCall(args, theme, toolContext(state, toolCallId, args, compactCall, true)));
	assert.equal(state.builtInRendererState.renderCallCount, 1);
});

test("compact write shows content size in the call header without inlining content", () => {
	const tool = captureRegisteredTool(registerCompactWrite);
	const args = { path: "src/generated.ts", content: "alpha\nbeta\n" };
	const state: any = {};
	const toolCallId = "write-call-summary";

	const call = tool.renderCall(args, theme, toolContext(state, toolCallId, args, undefined));
	const text = renderText(call);

	assert.match(text, /^Write /);
	assert.match(text, /src\/generated\.ts/);
	assert.match(text, /2 lines · 11 B/);
	assert.doesNotMatch(text, /alpha/);
	assert.doesNotMatch(text, /beta/);
});

test("compact read/write/edit rows prioritize metadata on narrow widths", () => {
	{
		const tool = captureRegisteredTool(registerCompactRead);
		const args = { path: "src/deeply/nested/generated/component/with-long-name.ts" };
		const state: any = {};
		const toolCallId = "read-narrow-row";
		const call = tool.renderCall(args, theme, toolContext(state, toolCallId, args, undefined));
		tool.renderResult(
			{ content: [{ type: "text", text: "alpha\nbeta\n" }], details: undefined },
			{ expanded: false, isPartial: false },
			theme,
			toolContext(state, toolCallId, args, call),
		);

		const text = renderText(state.compactCallText, 34);
		assert.equal(text.split("\n").length, 1);
		assert.match(text, /^Read /);
		assert.doesNotMatch(text, /2 lines/);
	}

	{
		const tool = captureRegisteredTool(registerCompactWrite);
		const args = { path: "src/deeply/nested/generated/component/with-long-name.ts", content: "alpha\nbeta\n" };
		const state: any = {};
		const toolCallId = "write-narrow-row";
		const call = tool.renderCall(args, theme, toolContext(state, toolCallId, args, undefined));
		const text = renderText(call, 38);

		assert.equal(text.split("\n").length, 1);
		assert.match(text, /^Write /);
		assert.match(text, /2 lines · 11 B/);
	}

	{
		const tool = captureRegisteredTool(registerCompactEdit);
		const args = { path: "src/deeply/nested/generated/component/with-long-name.ts", edits: [{ oldText: "timeout: 5000", newText: "timeout: 10000" }] };
		const state: any = {};
		const toolCallId = "edit-narrow-row";
		const call = tool.renderCall(args, theme, toolContext(state, toolCallId, args, undefined));
		tool.renderResult(
			{
				content: [{ type: "text", text: "Successfully replaced 1 block(s)." }],
				details: { diff: "-42 timeout: 5000\n+42 timeout: 10000", firstChangedLine: 42 },
			},
			{ expanded: false, isPartial: false },
			theme,
			toolContext(state, toolCallId, args, call),
		);

		const text = renderText(state.compactCallText, 36);
		assert.equal(text.split("\n").length, 1);
		assert.match(text, /^Edit /);
		assert.match(text, /\+1 -1/);
	}
});

test("expanded read/write results do not pass compact result components to built-in renderers", () => {
	const result = { content: [{ type: "text", text: "alpha\nbeta" }], details: undefined };

	for (const [label, register, args] of [
		["read", registerCompactRead, { path: "src/index.ts" }],
		["write", registerCompactWrite, { path: "src/generated.ts", content: "alpha\nbeta" }],
	] as const) {
		const tool = captureRegisteredTool(register);
		const state: any = {};
		const toolCallId = `${label}-result-isolation`;
		const compactResult = tool.renderResult(result, { expanded: false, isPartial: false }, theme, toolContext(state, toolCallId, args, undefined));

		assert.doesNotThrow(() => {
			tool.renderResult(result, { expanded: true, isPartial: false }, theme, toolContext(state, toolCallId, args, compactResult, true));
		});
		assert.equal(state.builtInRendererState.renderResultCount, 1);
	}
});

test("compact edit shows small diffs inline", () => {
	const tool = captureRegisteredTool(registerCompactEdit);
	const args = { path: "src/config.ts", edits: [{ oldText: "timeout: 5000", newText: "timeout: 10000" }] };
	const state: any = {};
	const toolCallId = "edit-small-diff";

	const call = tool.renderCall(args, theme, toolContext(state, toolCallId, args, undefined));
	const result = tool.renderResult(
		{
			content: [{ type: "text", text: "Successfully replaced 1 block(s) in src/config.ts." }],
			details: { diff: "-42 timeout: 5000\n+42 timeout: 10000", firstChangedLine: 42 },
		},
		{ expanded: false, isPartial: false },
		theme,
		toolContext(state, toolCallId, args, call),
	);

	const header = renderText(state.compactCallText);
	assert.match(header, /^Edit /);
	assert.doesNotMatch(header, /1 replacement/);
	assert.match(header, /\+1 -1/);
	assert.match(renderText(result), /  │ -42 timeout: 5000\n  │ \+42 timeout: 10000\n  ╰─$/);
});

test("compact edit hides large diffs when collapsed", () => {
	const tool = captureRegisteredTool(registerCompactEdit);
	const args = { path: "src/session.ts", edits: Array.from({ length: 6 }, (_, i) => ({ oldText: `old ${i}`, newText: `new ${i}` })) };
	const state: any = {};
	const toolCallId = "edit-large-diff";
	const diff = [...Array.from({ length: 93 }, (_, i) => `+${i + 1} added`), ...Array.from({ length: 41 }, (_, i) => `-${i + 1} removed`)].join("\n");

	const call = tool.renderCall(args, theme, toolContext(state, toolCallId, args, undefined));
	const result = tool.renderResult(
		{ content: [{ type: "text", text: "Successfully replaced 6 block(s) in src/session.ts." }], details: { diff } },
		{ expanded: false, isPartial: false },
		theme,
		toolContext(state, toolCallId, args, call),
	);

	const header = renderText(state.compactCallText);
	assert.match(header, /^Edit /);
	assert.doesNotMatch(header, /6 replacements/);
	assert.match(header, /\+93 -41/);
	assert.equal(renderText(result), "");
});

test("compact edit shows configured large diffs inline when the max lines is 0", () => {
	const tool = captureRegisteredTool((pi, cwd) => registerCompactEdit(pi, cwd, { inlineDiffMaxLines: 0 }));
	const args = { path: "src/session.ts", edits: [{ oldText: "old", newText: "new" }] };
	const state: any = {};
	const toolCallId = "edit-unlimited-diff";
	const diff = Array.from({ length: 70 }, (_, i) => `+${i + 1} added`).join("\n");

	const call = tool.renderCall(args, theme, toolContext(state, toolCallId, args, undefined));
	const result = tool.renderResult(
		{ content: [{ type: "text", text: "Successfully replaced 1 block(s) in src/session.ts." }], details: { diff } },
		{ expanded: false, isPartial: false },
		theme,
		toolContext(state, toolCallId, args, call),
	);

	assert.match(renderText(state.compactCallText), /\+70 -0/);
	assert.match(renderText(result), /  │ \+70 added\n  ╰─$/);
});

test("compact edit shows missing text errors in the header without a hint", () => {
	const tool = captureRegisteredTool(registerCompactEdit);
	const args = { path: "src/session.ts", edits: [{ oldText: "missing", newText: "replacement" }] };
	const state: any = {};
	const toolCallId = "edit-error";

	const call = tool.renderCall(args, theme, toolContext(state, toolCallId, args, undefined));
	const result = tool.renderResult(
		{ content: [{ type: "text", text: "Could not find the exact text in src/session.ts. The old text must match exactly including all whitespace and newlines." }], details: undefined },
		{ expanded: false, isPartial: false },
		theme,
		{ ...toolContext(state, toolCallId, args, call), isError: true },
	);

	const header = renderText(state.compactCallText);
	assert.match(header, /^Edit /);
	assert.match(header, /oldText not found/);
	assert.equal(renderText(result), "");
});

test("compact edit hides hints for all collapsed edit errors", () => {
	const tool = captureRegisteredTool(registerCompactEdit);
	const args = { path: "src/session.ts", edits: [{ oldText: "duplicate", newText: "replacement" }] };
	const state: any = {};
	const toolCallId = "edit-duplicate-error";

	const call = tool.renderCall(args, theme, toolContext(state, toolCallId, args, undefined));
	const result = tool.renderResult(
		{ content: [{ type: "text", text: "Found 3 occurrences of the text in src/session.ts. The text must be unique." }], details: undefined },
		{ expanded: false, isPartial: false },
		theme,
		{ ...toolContext(state, toolCallId, args, call), isError: true },
	);

	const header = renderText(state.compactCallText);
	assert.match(header, /^Edit /);
	assert.match(header, /oldText not unique/);
	assert.equal(renderText(result), "");
});

test("compact read normalizes file errors with actionable hints", () => {
	const tool = captureRegisteredTool(registerCompactRead);
	const args = { path: "src/missing.ts" };
	const state: any = {};
	const toolCallId = "read-error";

	const call = tool.renderCall(args, theme, toolContext(state, toolCallId, args, undefined));
	const result = tool.renderResult(
		{ content: [{ type: "text", text: "ENOENT: no such file or directory, open 'src/missing.ts'" }], details: undefined },
		{ expanded: false, isPartial: false },
		theme,
		{ ...toolContext(state, toolCallId, args, call), isError: true },
	);

	const header = renderText(state.compactCallText);
	assert.match(header, /^Read /);
	assert.match(header, /path not found/);
	assert.match(renderText(result), /╰─ check file path/);
});

test("compact write normalizes file errors with actionable hints", () => {
	const tool = captureRegisteredTool(registerCompactWrite);
	const args = { path: "src/secret.ts", content: "alpha" };
	const state: any = {};
	const toolCallId = "write-error";

	const call = tool.renderCall(args, theme, toolContext(state, toolCallId, args, undefined));
	const result = tool.renderResult(
		{ content: [{ type: "text", text: "EACCES: permission denied, open 'src/secret.ts'" }], details: undefined },
		{ expanded: false, isPartial: false },
		theme,
		{ ...toolContext(state, toolCallId, args, call), isError: true },
	);

	const header = renderText(state.compactCallText);
	assert.match(header, /^Write /);
	assert.match(header, /permission denied/);
	assert.match(renderText(result), /╰─ check file permissions/);
});

test("compact read stays successful after finishing while expanded", () => {
	const tool = captureRegisteredTool(registerCompactRead);
	const args = { path: "src/index.ts" };
	const state: any = {};
	const toolCallId = "read-1";

	const call = tool.renderCall(args, theme, {
		expanded: false,
		state,
		toolCallId,
		args,
		lastComponent: undefined,
		executionStarted: true,
		isError: false,
		invalidate() {},
		showImages: false,
		cwd: process.cwd(),
	});

	tool.renderResult(
		{ content: [{ type: "text", text: "alpha\nbeta" }], details: undefined },
		{ expanded: true, isPartial: false },
		theme,
		{
			expanded: true,
			state,
			toolCallId,
			args,
			lastComponent: undefined,
			executionStarted: true,
			isError: false,
			invalidate() {},
			showImages: false,
			cwd: process.cwd(),
		},
	);

	const collapsed = tool.renderCall(args, theme, {
		expanded: false,
		state,
		toolCallId,
		args,
		lastComponent: call,
		executionStarted: true,
		isError: false,
		invalidate() {},
		showImages: false,
		cwd: process.cwd(),
	});

	const text = renderText(collapsed);
	assert.match(text, /^Read /);
	assert.doesNotMatch(text, /2 lines/);
});

test("compact read keeps truncation metadata but suppresses ordinary line counts", () => {
	const tool = captureRegisteredTool(registerCompactRead);
	const args = { path: "src/large.ts" };
	const state: any = {};
	const toolCallId = "read-truncated";

	const call = tool.renderCall(args, theme, toolContext(state, toolCallId, args, undefined));
	tool.renderResult(
		{
			content: [{ type: "text", text: "alpha\nbeta\n" }],
			details: { truncation: { truncated: true, outputLines: 50, totalLines: 100 } },
		},
		{ expanded: false, isPartial: false },
		theme,
		toolContext(state, toolCallId, args, call),
	);

	const text = renderText(state.compactCallText);
	assert.match(text, /^Read /);
	assert.match(text, /truncated/);
	assert.doesNotMatch(text, /50 of 100 lines/);
});

test("compact read shows single image mime without a redundant image label", () => {
	const tool = captureRegisteredTool(registerCompactRead);
	const args = { path: "assets/logo.png" };
	const state: any = {};
	const toolCallId = "read-image";

	const call = tool.renderCall(args, theme, toolContext(state, toolCallId, args, undefined));
	tool.renderResult(
		{ content: [{ type: "image", mimeType: "image/png" }], details: undefined },
		{ expanded: false, isPartial: false },
		theme,
		toolContext(state, toolCallId, args, call),
	);

	const text = renderText(state.compactCallText);
	assert.match(text, /^Read assets\/logo\.png · image\/png$/);
	assert.doesNotMatch(text, /image · image\/png/);
});

test("compact write stays successful after finishing while expanded", () => {
	const tool = captureRegisteredTool(registerCompactWrite);
	const args = { path: "src/generated.ts", content: "alpha\nbeta" };
	const state: any = {};
	const toolCallId = "write-1";

	const call = tool.renderCall(args, theme, {
		expanded: false,
		state,
		toolCallId,
		args,
		lastComponent: undefined,
		executionStarted: true,
		isError: false,
		invalidate() {},
		showImages: false,
		cwd: process.cwd(),
	});

	tool.renderResult(
		{ content: [{ type: "text", text: "Wrote 2 lines" }], details: undefined },
		{ expanded: true, isPartial: false },
		theme,
		{
			expanded: true,
			state,
			toolCallId,
			args,
			lastComponent: undefined,
			executionStarted: true,
			isError: false,
			invalidate() {},
			showImages: false,
			cwd: process.cwd(),
		},
	);

	const collapsed = tool.renderCall(args, theme, {
		expanded: false,
		state,
		toolCallId,
		args,
		lastComponent: call,
		executionStarted: true,
		isError: false,
		invalidate() {},
		showImages: false,
		cwd: process.cwd(),
	});

	const text = renderText(collapsed);
	assert.match(text, /^Write /);
	assert.match(text, /2 lines/);
});
