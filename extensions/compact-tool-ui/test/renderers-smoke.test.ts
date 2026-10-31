import assert from "node:assert/strict";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { registerCompactBash } from "../renderers/bash.js";
import { registerCompactEdit } from "../renderers/edit.js";
import { registerCompactRead } from "../renderers/read.js";
import { registerCompactWrite } from "../renderers/write.js";
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

function renderText(component: { render: (width: number) => string[] } | undefined, width = 200): string {
	return component ? component.render(width).join("\n") : "";
}

test("compact renderers keep the host shell fixed while existing parts hot-switch their layout", () => {
	let renderShell: "self" | "default" = "default";
	for (const register of [
		(pi: any, cwd: string) => registerCompactBash(pi, cwd, () => renderShell),
		(pi: any, cwd: string) => registerCompactRead(pi, cwd, () => renderShell),
		(pi: any, cwd: string) => registerCompactWrite(pi, cwd, () => renderShell),
		(pi: any, cwd: string) => registerCompactEdit(pi, cwd, undefined, () => renderShell),
	]) {
		const tool = captureRegisteredTool(register);
		assert.equal(tool.renderShell, "self");
		assert.equal(Object.getOwnPropertyDescriptor(tool, "renderShell")?.get, undefined);
		const args = { command: "echo hi", path: "src/a.ts", content: "hello" };
		const state = {};
		const call = tool.renderCall(args, theme, { ...toolContext(state, "hot-shell", args, undefined), executionStarted: false });
		const framed = call.render(80);
		assert.equal(framed[0], " ".repeat(80));
		assert.equal(framed.at(-1), " ".repeat(80));
		renderShell = "self";
		assert.equal(tool.renderShell, "self");
		const plain = call.render(80);
		assert.equal(plain.length, 1);
		assert.match(plain[0], /^(Bash|Read|Write|Edit) /);
		renderShell = "default";
		assert.deepEqual(call.render(80), framed, "existing call reacts without renderer remount");
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
		isPartial: true,
		isError: false,
		invalidate() {},
		showImages: false,
		cwd: process.cwd(),
	};
}

function withFakeIntervals(run: (timers: { callbacks: Array<() => void>; handles: any[]; cleared: any[] }) => void) {
	const originalSetInterval = global.setInterval;
	const originalClearInterval = global.clearInterval;
	const timers = { callbacks: [] as Array<() => void>, handles: [] as any[], cleared: [] as any[] };
	global.setInterval = ((callback: () => void) => {
		const handle = { id: timers.callbacks.length };
		timers.callbacks.push(callback);
		timers.handles.push(handle);
		return handle;
	}) as unknown as typeof setInterval;
	global.clearInterval = ((handle: any) => { timers.cleared.push(handle); }) as unknown as typeof clearInterval;
	try { run(timers); } finally {
		global.setInterval = originalSetInterval;
		global.clearInterval = originalClearInterval;
	}
}

test("Bash pending, final, and replayed rows never start timers merely because executionStarted is true", () => {
	withFakeIntervals(({ callbacks }) => {
		const tool = captureRegisteredTool(registerCompactBash);
		const args = { command: "echo replay" };
		for (const [name, overrides] of [
			["pending", { executionStarted: false, isPartial: true }],
			["final", { executionStarted: true, isPartial: false }],
			["replay", { executionStarted: false, isPartial: false }],
		] as const) {
			const state = {};
			const context = { ...toolContext(state, name, args, undefined), ...overrides };
			const call = tool.renderCall(args, theme, context);
			assert.equal(callbacks.length, 0, `${name} call must not start a timer`);
			if (name !== "pending") {
				tool.renderResult({ content: [{ type: "text", text: "replayed" }], details: undefined },
					{ expanded: false, isPartial: false }, theme, { ...context, lastComponent: undefined });
				assert.doesNotMatch(renderText(call), /\b\d+(?:\.\d+)?(?:ms|s)\b/);
				assert.equal(callbacks.length, 0);
			}
		}
	});
});

test("Bash final native duration wins over observed live elapsed and rerender cannot restart its timer", () => {
	withFakeIntervals(({ callbacks, handles, cleared }) => {
		const tool = captureRegisteredTool(registerCompactBash);
		const args = { command: "echo timed" };
		const state = { compactStartedAt: Date.now() - 9800 };
		const context = toolContext(state, "native-duration", args, undefined);
		const call = tool.renderCall(args, theme, context);
		assert.equal(callbacks.length, 1);
		tool.renderResult({ content: [{ type: "text", text: "timed" }], details: undefined },
			{ expanded: false, isPartial: false }, theme, { ...context, durationMs: 2400 });
		assert.match(renderText(call), /2\.4s/);
		assert.doesNotMatch(renderText(call), /9\.[0-9]s/);
		assert.deepEqual(cleared, handles);
		// Pi retains executionStarted=true for settled calls, including after expansion/remount.
		for (const expanded of [false, true, false]) {
			tool.renderCall(args, theme, { ...context, expanded, isPartial: false, lastComponent: call, durationMs: 2400 });
		}
		assert.equal(callbacks.length, 1, "settled rerenders cannot restart elapsed timers");
		assert.deepEqual(cleared, handles);
	});
});

test("Bash falls back to observed live elapsed without an execution wrapper or fabricated replay timing", () => {
	withFakeIntervals(({ callbacks, handles, cleared }) => {
		const originalNow = Date.now;
		let now = 100_000;
		Date.now = () => now;
		try {
			const tool = captureRegisteredTool(registerCompactBash);
			const args = { command: "echo observed" };
			const state = {};
			const context = toolContext(state, "observed-live-duration", args, undefined);
			const call = tool.renderCall(args, theme, context);
			assert.equal(callbacks.length, 1);
			now += 3400;
			tool.renderResult({ content: [{ type: "text", text: "observed" }], details: undefined },
				{ expanded: false, isPartial: false }, theme, context);
			assert.match(renderText(call), /3\.4s/);
			assert.deepEqual(cleared, handles);
			now += 60_000;
			const replay = tool.renderCall(args, theme, { ...context, executionStarted: true, isPartial: false, lastComponent: call });
			assert.match(renderText(replay), /3\.4s/, "settled live duration does not keep increasing");
			assert.equal(callbacks.length, 1);
		} finally { Date.now = originalNow; }
	});
});

test("Bash errors stop live timers even if the result is still marked partial", () => {
	withFakeIntervals(({ callbacks, handles, cleared }) => {
		const tool = captureRegisteredTool(registerCompactBash);
		const args = { command: "false" };
		const state = {};
		const context = toolContext(state, "partial-error-stop", args, undefined);
		const call = tool.renderCall(args, theme, context);
		assert.equal(callbacks.length, 1);
		tool.renderResult({ content: [{ type: "text", text: "failure details" }], details: undefined },
			{ expanded: false, isPartial: true }, theme, { ...context, isError: true });
		assert.deepEqual(cleared, handles);
		assert.match(renderText(call), /failed/);
	});
});

test("Bash session_shutdown clears all active rendered timers idempotently", () => {
	withFakeIntervals(({ callbacks, handles, cleared }) => {
		const handlers = new Map<string, any[]>();
		const tool = captureRegisteredTool(registerCompactBash, handlers);
		let invalidations = 0;
		for (const toolCallId of ["shutdown-a", "shutdown-b"]) {
			const args = { command: "sleep 10" };
			tool.renderCall(args, theme, { ...toolContext({}, toolCallId, args, undefined), invalidate() { invalidations++; } });
		}
		assert.equal(callbacks.length, 2);
		assert.equal(handlers.get("session_shutdown")?.length, 1);
		for (const shutdown of handlers.get("session_shutdown")!) shutdown();
		assert.deepEqual(cleared, handles);
		callbacks.forEach((callback) => callback());
		assert.equal(invalidations, 0, "late callbacks cannot invalidate disposed rows");
		for (const shutdown of handlers.get("session_shutdown")!) shutdown();
		assert.deepEqual(cleared, handles, "shutdown does not clear stale handles again");
	});
});

test("Bash collapsed results are always empty across pending, streaming, success and error updates", () => {
	withFakeIntervals(({ handles, cleared }) => {
		const tool = captureRegisteredTool(registerCompactBash);
		for (const isError of [false, true]) {
			const args = Object.freeze({ command: "fixture-only command" });
			const state: any = {};
			const ctx = toolContext(state, `empty-lifecycle-${isError}`, args, undefined);
			const call = tool.renderCall(args, theme, { ...ctx, executionStarted: false });
			assert.equal(call.render(80).length, 1);
			for (const [isPartial, text] of [
				[true, ""], [true, "short"], [true, "x".repeat(20_000)],
				[true, Array.from({ length: 100 }, (_, index) => `line ${index}`).join("\n")],
				[false, `diagnostic\n${isError ? "Command exited with code 7" : "complete"}`],
			] as const) {
				const content = Object.freeze([Object.freeze({ type: "text", text })]);
				const value = Object.freeze({ content, details: undefined });
				const before = JSON.stringify(value);
				const result = tool.renderResult(value, { expanded: false, isPartial }, theme,
					{ ...ctx, isPartial, isError: !isPartial && isError });
				for (const width of [24, 48, 80, 120]) {
					assert.deepEqual(result.render(width), [], `${width}: partial=${isPartial}, error=${isError}`);
					assert.equal(call.render(width).length, 1);
				}
				assert.equal(JSON.stringify(value), before, "collapsed rendering cannot mutate output");
			}
			assert.equal(state.compactStatus, isError ? "failed" : "success");
			assert.match(renderText(call), isError ? /exit 7/ : /diagnostic/);
		}
		assert.deepEqual(cleared, handles, "both final outcomes stop their live timer");
	});
});

test("Bash successful and partial output retains status-like stdout verbatim", () => {
	const tool = captureRegisteredTool(registerCompactBash);
	for (const line of ["Command exited with code 7", "Command was aborted", "Command timed out after 3 seconds"]) {
		for (const [isPartial, isError] of [[false, false], [true, false], [true, true]]) {
			const args = { command: "printf stdout" };
			const result = tool.renderResult({ content: [{ type: "text", text: `ordinary output\n${line}\n` }], details: undefined },
				{ expanded: true, isPartial }, theme,
				{ ...toolContext({}, `stdout-${line}-${isPartial}-${isError}`, args, undefined, true), isPartial, isError });
			assert.ok(renderText(result).includes(line), `stdout was lost: ${line}, partial=${isPartial}, error=${isError}`);
		}
	}
});

test("compact bash settles state when a partial run finishes while expanded", () => {
	const tool = captureRegisteredTool(registerCompactBash);
	const args = { command: "echo hi" };
	const startedAt = Date.now() - 1500;
	const state: any = { compactStartedAt: startedAt, startedAt };
	const toolCallId = "bash-1";

	const originalSetInterval = global.setInterval;
	const originalClearInterval = global.clearInterval;
	const intervals: any[] = [];
	const cleared: any[] = [];
	global.setInterval = ((() => { const interval = { fake: true }; intervals.push(interval); return interval; }) as unknown) as typeof setInterval;
	global.clearInterval = (((interval: any) => { cleared.push(interval); }) as unknown) as typeof clearInterval;

	try {
		const call = tool.renderCall(args, theme, {
			expanded: false,
			state,
			toolCallId,
			args,
			lastComponent: undefined,
			executionStarted: true,
			isPartial: true,
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
		assert.equal(intervals.length, 1, "partial render should create a refresh interval");
		assert.deepEqual(cleared, []);

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

		assert.deepEqual(cleared, intervals, "final render should stop the live timer");
		assert.equal(typeof state.compactEndedAt, "number");
		assert.equal(typeof state.compactDurationMs, "number");
		assert.equal(state.compactStatus, "success");
		assert.equal(state.compactSummary, "done");
		assert.match(renderText(state.compactCallText), /^Bash /);

		const reconstructed = tool.renderCall(args, theme, toolContext(state, toolCallId, args, undefined));
		assert.match(renderText(reconstructed), /^Bash /);
		assert.match(renderText(reconstructed), /done/);
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
		assert.equal(intervalCallbacks.length, 1, "rerender must not allocate a second timer");
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
		assert.deepEqual(cleared, []);

		const remountedCall = tool.renderCall(args, theme, {
			...toolContext(secondState, toolCallId, args, undefined),
			invalidate() {
				secondInvalidations++;
			},
		});
		assert.equal(intervalCallbacks.length, 1);
		assert.deepEqual(cleared, []);

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

		assert.equal(cleared.length, 1);
		assert.equal(typeof secondState.compactDurationMs, "number");
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

test("compact bash collapses failures to the header by default", () => {
	const tool = captureRegisteredTool(registerCompactBash);
	const args = { command: "pnpm test" };
	const state: any = { compactStartedAt: Date.now() - 1500 };
	const toolCallId = "bash-failure-collapsed";

	const call = tool.renderCall(args, theme, toolContext(state, toolCallId, args, undefined));
	const result = tool.renderResult(
		{ content: [{ type: "text", text: "FAIL src/app.test.ts\nTests: 1 failed, 3 passed\nCommand exited with code 1\n" }], details: undefined },
		{ expanded: false, isPartial: false },
		theme,
		{ ...toolContext(state, toolCallId, args, call), isError: true },
	);

	assert.match(renderText(state.compactCallText), /test failed · exit 1/);
	assert.equal(renderText(result), "");
});

test("compact bash keeps failed diagnostics out of the collapsed result", () => {
	const tool = captureRegisteredTool(registerCompactBash);
	const args = { command: "pnpm test" };
	const state: any = { compactStartedAt: Date.now() - 1500 };
	const toolCallId = "bash-failure-preview";

	const call = tool.renderCall(args, theme, toolContext(state, toolCallId, args, undefined));
	const result = tool.renderResult(
		{ content: [{ type: "text", text: "line-1\nline-2\nline-3\nCommand exited with code 1\n" }], details: undefined },
		{ expanded: false, isPartial: false },
		theme,
		{ ...toolContext(state, toolCallId, args, call), isError: true },
	);

	assert.match(renderText(state.compactCallText), /exit 1/);
	assert.deepEqual(result.render(80), []);
});

test("compact bash keeps multiline success output out of the collapsed result", () => {
	const tool = captureRegisteredTool(registerCompactBash);
	const args = { command: "printf 'alpha\\nbeta\\ngamma\\n'" };
	const state: any = {};
	const toolCallId = "bash-failed-mode-success";

	const call = tool.renderCall(args, theme, toolContext(state, toolCallId, args, undefined));
	const result = tool.renderResult(
		{ content: [{ type: "text", text: "alpha\nbeta\ngamma\n" }], details: undefined },
		{ expanded: false, isPartial: false },
		theme,
		toolContext(state, toolCallId, args, call),
	);

	assert.equal(renderText(result), "");
});

test("compact bash shows success output summary before duration", () => {
	const tool = captureRegisteredTool(registerCompactBash);
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
	assert.match(text, /alpha · 1 more line · 1\.[0-9]s/);
});

test("compact bash drops sub-second durations from settled rows", () => {
	const tool = captureRegisteredTool(registerCompactBash);
	const args = { command: "echo hi" };
	const toolCallId = "bash-fast-duration";
	const state: any = {};

	const call = tool.renderCall(args, theme, toolContext(state, toolCallId, args, undefined));
	state.compactStartedAt = Date.now() - 120;
	tool.renderResult(
		{ content: [{ type: "text", text: "hi\n" }], details: undefined },
		{ expanded: false, isPartial: false },
		theme,
		toolContext(state, toolCallId, args, call),
	);

	const text = renderText(state.compactCallText);
	assert.equal(text, "Bash echo hi · hi");
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

test("compact bash flags truncated output in the collapsed summary", () => {
	const tool = captureRegisteredTool(registerCompactBash);
	const args = { command: "npm test" };
	const state: any = { compactStartedAt: Date.now() - 2400 };
	const toolCallId = "bash-truncated-summary";
	const output = `${Array.from({ length: 50 }, (_, index) => `line${index}`).join("\n")}\n`;

	const call = tool.renderCall(args, theme, toolContext(state, toolCallId, args, undefined));
	tool.renderResult(
		{ content: [{ type: "text", text: output }], details: { truncation: { truncated: true, truncatedBy: "lines", outputLines: 50, totalLines: 500, maxLines: 50 } } },
		{ expanded: false, isPartial: false },
		theme,
		toolContext(state, toolCallId, args, call),
	);

	const text = renderText(state.compactCallText);
	assert.match(text, /^Bash npm test/);
	assert.match(text, /50L · truncated · 2\.[0-9]s/);
});

test("compact bash leaves the summary unmarked when output was not truncated", () => {
	const tool = captureRegisteredTool(registerCompactBash);
	const args = { command: "npm test" };
	const state: any = { compactStartedAt: Date.now() - 2400 };
	const toolCallId = "bash-untruncated-summary";
	const output = `${Array.from({ length: 50 }, (_, index) => `line${index}`).join("\n")}\n`;

	const call = tool.renderCall(args, theme, toolContext(state, toolCallId, args, undefined));
	tool.renderResult(
		{ content: [{ type: "text", text: output }], details: { truncation: { truncated: false, truncatedBy: null, outputLines: 50, totalLines: 50 } } },
		{ expanded: false, isPartial: false },
		theme,
		toolContext(state, toolCallId, args, call),
	);

	const text = renderText(state.compactCallText);
	assert.match(text, /50L · 2\.[0-9]s/);
	assert.doesNotMatch(text, /truncated/);
});

test("compact bash marks truncation even when the summary has no count", () => {
	const tool = captureRegisteredTool(registerCompactBash);
	const args = { command: "true" };
	const state: any = { compactStartedAt: Date.now() - 2400 };
	const toolCallId = "bash-truncated-no-output";

	const call = tool.renderCall(args, theme, toolContext(state, toolCallId, args, undefined));
	tool.renderResult(
		{ content: [{ type: "text", text: "" }], details: { truncation: { truncated: true, truncatedBy: "lines", outputLines: 0, totalLines: 500 } } },
		{ expanded: false, isPartial: false },
		theme,
		toolContext(state, toolCallId, args, call),
	);

	const text = renderText(state.compactCallText);
	assert.match(text, /^Bash true · truncated/);
});

test("compact bash spends the reclaimed metadata width on the command", () => {
	const tool = captureRegisteredTool(registerCompactBash);
	const args = { command: "git diff -- web/src/view/alarm/components/AlarmTable.vue" };
	const state: any = { compactStartedAt: Date.now() - 2400 };
	const toolCallId = "bash-compact-count-width";
	const output = `${Array.from({ length: 50 }, (_, index) => `+line${index}`).join("\n")}\n`;

	const call = tool.renderCall(args, theme, toolContext(state, toolCallId, args, undefined));
	tool.renderResult(
		{ content: [{ type: "text", text: output }], details: undefined },
		{ expanded: false, isPartial: false },
		theme,
		toolContext(state, toolCallId, args, call),
	);

	const text = renderText(state.compactCallText, 88);
	assert.equal(text.split("\n").length, 1);
	assert.match(text, /AlarmTable\.vue · 50L · 2\.[0-9]s/);
});

test("compact bash drops timeout metadata once the run settles", () => {
	const tool = captureRegisteredTool(registerCompactBash);
	const args = { command: "sleep 1", timeout: 30 };
	const state: any = { compactStartedAt: Date.now() - 1500 };
	const toolCallId = "bash-timeout-settled";

	const call = tool.renderCall(args, theme, toolContext(state, toolCallId, args, undefined));
	tool.renderResult(
		{ content: [{ type: "text", text: "done\n" }], details: undefined },
		{ expanded: false, isPartial: false },
		theme,
		toolContext(state, toolCallId, args, call),
	);

	const text = renderText(state.compactCallText);
	assert.match(text, /^Bash /);
	assert.doesNotMatch(text, /timeout 30s/);
});

test("compact bash keeps timeout metadata for a settled timeout failure", () => {
	const tool = captureRegisteredTool(registerCompactBash);
	const args = { command: "sleep 40", timeout: 30 };
	const state: any = { compactStartedAt: Date.now() - 3000 };
	const toolCallId = "bash-timeout-failure";

	const call = tool.renderCall(args, theme, toolContext(state, toolCallId, args, undefined));
	tool.renderResult(
		{ content: [{ type: "text", text: "timed out\n" }], details: undefined },
		{ expanded: false, isPartial: false },
		theme,
		{ ...toolContext(state, toolCallId, args, call), isError: true },
	);

	const text = renderText(state.compactCallText);
	assert.match(text, /^Bash /);
	// The configured timeout is gone, but the outcome itself still reports the cut-off.
	assert.match(text, /timeout/);
	assert.doesNotMatch(text, /timeout 30s/);
});

test("compact bash does not show success output summary for empty output", () => {
	const tool = captureRegisteredTool(registerCompactBash);
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
	assert.doesNotMatch(text, /more line|\d+L|truncated/);
});

test("compact bash reports streaming line counts without a collapsed output body", () => {
	const tool = captureRegisteredTool(registerCompactBash);
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

	assert.match(renderText(state.compactCallText), /3L so far/);
	assert.deepEqual(result.render(80), []);
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
		assert.match(text, /3L so far/);
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
	assert.match(narrow, /ok/);
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
	assert.match(text, /ok/);
	assert.doesNotMatch(text, /print\('hi'\)/);
});

test("compact bash keeps settled multiline output available only through expansion", () => {
	const tool = captureRegisteredTool(registerCompactBash);
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

	assert.deepEqual(result.render(80), []);
	const expanded = tool.renderResult(
		{ content: [{ type: "text", text: "alpha\nbeta\ngamma\n" }], details: undefined },
		{ expanded: true, isPartial: false }, theme, toolContext(state, toolCallId, args, result, true),
	);
	assert.match(renderText(expanded), /alpha[\s\S]*beta[\s\S]*gamma/);
});

test("compact bash has an empty collapsed success result", () => {
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

test("compact bash has an empty collapsed streaming result", () => {
	const tool = captureRegisteredTool(registerCompactBash);
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

	assert.match(renderText(state.compactCallText), /3L so far/);
	assert.equal(renderText(result), "");
});

test("expanded bash renders a command rail and streaming output tail", () => {
	const tool = captureRegisteredTool(registerCompactBash);
	const args = { command: "npm test" };
	const state: any = {};
	const toolCallId = "bash-running-expanded";

	const call = tool.renderCall(args, theme, toolContext(state, toolCallId, args, undefined, true));
	const result = tool.renderResult(
		{ content: [{ type: "text" as const, text: "a\nb\nc\n" }], details: undefined },
		{ expanded: true, isPartial: true },
		theme,
		toolContext(state, toolCallId, args, call, true),
	);

	assert.match(renderText(call), /^Bash npm test/);
	assert.match(renderText(result), /├─ command/);
	assert.match(renderText(result), /npm test/);
	assert.match(renderText(result), /├─ output · 3 lines · streaming/);
	assert.match(renderText(result), /╰─ collapse/);
});

test("expanded bash owns its header instead of invoking the built-in renderer", () => {
	const tool = captureRegisteredTool(registerCompactBash);
	const args = { command: "npm test" };
	const state: any = {};
	const toolCallId = "bash-call-isolation";

	const compactCall = tool.renderCall(args, theme, toolContext(state, toolCallId, args, undefined));
	const expandedCall = tool.renderCall(args, theme, toolContext(state, toolCallId, args, compactCall, true));
	assert.ok(expandedCall);
	assert.ok(state.expandedCallHeader);
	assert.equal(state.builtInRendererState, undefined);
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
	assert.match(text, /2L · 11 B/);
	assert.doesNotMatch(text, /alpha/);
	assert.doesNotMatch(text, /beta/);
});

test("compact write reports the content size in compact line units", () => {
	const tool = captureRegisteredTool(registerCompactWrite);
	const args = { path: "src/generated.ts", content: `${Array.from({ length: 214 }, () => "x").join("\n")}\n` };
	const state: any = {};
	const toolCallId = "write-line-unit";

	const call = tool.renderCall(args, theme, toolContext(state, toolCallId, args, undefined));
	tool.renderResult(
		{ content: [{ type: "text", text: "Successfully wrote to src/generated.ts" }], details: undefined },
		{ expanded: false, isPartial: false },
		theme,
		toolContext(state, toolCallId, args, call),
	);

	const text = renderText(state.compactCallText);
	assert.match(text, /^Write src\/generated\.ts/);
	assert.match(text, /214L · 428 B/);
	assert.doesNotMatch(text, /214 lines/);
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
		assert.match(text, /2L · 11 B/);
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

test("expanded read and write use the structured rail", () => {
	const readTool = captureRegisteredTool(registerCompactRead);
	const readState: any = {};
	const readArgs = { path: "src/index.ts" };
	const readResult = readTool.renderResult(
		{ content: [{ type: "text", text: "alpha\nbeta" }], details: undefined },
		{ expanded: true, isPartial: false },
		theme,
		toolContext(readState, "read-result-isolation", readArgs, undefined, true),
	);
	assert.match(renderText(readResult), /├─ content/);
	assert.match(renderText(readResult), /alpha/);
	assert.equal(readState.builtInRendererState, undefined);

	const writeTool = captureRegisteredTool(registerCompactWrite);
	const writeState: any = {};
	const writeArgs = { path: "src/generated.ts", content: "alpha\nbeta" };
	const writeResult = writeTool.renderResult(
		{ content: [{ type: "text", text: "alpha\nbeta" }], details: undefined },
		{ expanded: true, isPartial: false },
		theme,
		toolContext(writeState, "write-result-isolation", writeArgs, undefined, true),
	);
	assert.match(renderText(writeResult), /├─ content/);
	assert.match(renderText(writeResult), /alpha/);
	assert.equal(writeState.builtInRendererState, undefined);
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

test("compact edit hides the diff when the inline preview maximum is never", () => {
	const tool = captureRegisteredTool((pi, cwd) => registerCompactEdit(pi, cwd, { inlineDiffMaxLines: -1 }));
	const args = { path: "src/session.ts", edits: [{ oldText: "old", newText: "new" }] };
	const state: any = {};
	const toolCallId = "edit-never-diff";
	const diff = Array.from({ length: 3 }, (_, i) => `+${i + 1} added`).join("\n");

	const call = tool.renderCall(args, theme, toolContext(state, toolCallId, args, undefined));
	const result = tool.renderResult(
		{ content: [{ type: "text", text: "Successfully replaced 1 block(s) in src/session.ts." }], details: { diff } },
		{ expanded: false, isPartial: false },
		theme,
		toolContext(state, toolCallId, args, call),
	);

	assert.match(renderText(state.compactCallText), /\+3 -0/);
	assert.equal(renderText(result), "");
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

test("compact read keeps failed rows to a single error line", () => {
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
	assert.equal(renderText(result), "");
});

test("compact write keeps failed rows to a single error line", () => {
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
	assert.equal(renderText(result), "");
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

test("compact read surfaces a user limit that stopped before EOF", () => {
	const tool = captureRegisteredTool(registerCompactRead);
	const args = { path: "src/large.ts", offset: 1, limit: 100 };
	const state: any = {};
	const toolCallId = "read-limit-remainder";

	const call = tool.renderCall(args, theme, toolContext(state, toolCallId, args, undefined));
	tool.renderResult(
		{ content: [{ type: "text", text: "alpha\nbeta\n\n[4900 more lines in file. Use offset=101 to continue.]" }], details: undefined },
		{ expanded: false, isPartial: false },
		theme,
		toolContext(state, toolCallId, args, call),
	);

	const text = renderText(state.compactCallText);
	assert.match(text, /^Read src\/large\.ts:1-100/);
	assert.match(text, /4900L more/);
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
	assert.match(text, /50\/100L/);
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
	assert.match(text, /2L/);
});
