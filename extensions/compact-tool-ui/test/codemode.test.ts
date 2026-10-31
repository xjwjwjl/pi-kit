import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { registerCompactCodemode } from "../renderers/codemode.js";
import { highlightCodeCalls } from "./stubs/pi-coding-agent.js";

const theme = {
	bg(_token: string, text: string) { return text; },
	fg(_token: string, text: string) { return text; },
	bold(text: string) { return text; },
} as any;

type Component = { render(width: number): string[]; invalidate?(): void };
type Child = {
	id: string;
	name: string;
	args: string;
	status: "running" | "ok" | "error" | "cancelled";
	durationMs?: number;
	error?: string;
	cost?: number;
};

function captureRenderer(source?: "self" | "default" | (() => "self" | "default")) {
	const resolvers: Array<(name: string, next: () => any) => any> = [];
	registerCompactCodemode({
		registerToolRenderer(resolver: (name: string, next: () => any) => any) { resolvers.push(resolver); },
		registerTool() { assert.fail("renderer must not re-register a tool"); },
		on() { assert.fail("renderer must not collect nested execution events"); },
	} as any, source);
	assert.equal(resolvers.length, 1);
	const resolve = resolvers[0]!;
	const renderer = resolve("codemode", () => { assert.fail("Codemode must own its renderer"); });
	assert.ok(renderer);
	return { resolve, renderer };
}

let sequence = 0;
function fixture(args: any = { code: 'text("secret-script-body");' }) {
	const { renderer } = captureRenderer();
	const context: any = {
		args, state: {}, toolCallId: `codemode-test-${++sequence}`, cwd: process.cwd(),
		executionStarted: true, argsComplete: true, expanded: false, isPartial: false,
		isError: false, showImages: false, durationMs: undefined, outputPad: 0,
		lastComponent: undefined, invalidate() {},
	};
	let call: Component | undefined;
	let result: Component | undefined;
	return {
		renderer, context,
		call(overrides: Record<string, any> = {}, activeTheme = theme) {
			Object.assign(context, overrides);
			call = renderer.renderCall(context.args, activeTheme, { ...context, lastComponent: call });
			return call;
		},
		result(value: any, overrides: Record<string, any> = {}, activeTheme = theme) {
			Object.assign(context, overrides);
			result = renderer.renderResult(value, { expanded: context.expanded, isPartial: context.isPartial }, activeTheme,
				{ ...context, lastComponent: result });
			return result;
		},
		remountCall(activeTheme = theme) {
			call = renderer.renderCall(context.args, activeTheme, { ...context, lastComponent: undefined });
			return call;
		},
	};
}

function text(component: Component | undefined, width = 300): string {
	return component?.render(width).join("\n") ?? "";
}
function child(name: string, status: Child["status"] = "ok", args = "{}", extra: Partial<Child> = {}): Child {
	return { id: `child-${++sequence}`, name, args, status, ...extra };
}
function nativeResult(calls: Child[] = [], output = "secret-output-body", seconds = 1.2, failed = false) {
	return {
		content: [
			{ type: "text", text: `Script ${failed ? "failed" : "completed"}\nWall time ${seconds} seconds\nOutput:\n` },
			{ type: "text", text: output },
		],
		details: { calls },
	};
}
function assertSingleLine(component: Component | undefined, width: number) {
	const lines = component?.render(width) ?? [];
	assert.equal(lines.length, 1, `collapsed call must be one line at width ${width}`);
	assert.ok(visibleWidth(lines[0]!) <= width, `collapsed call exceeds width ${width}`);
}
function assertCount(value: string, name: string, count: number) {
	assert.match(value, new RegExp(`(?:${name}\\s*(?:[×x:]\\s*)?${count}|${count}\\s*(?:[×x]\\s*)?${name})`, "i"));
}
const SUCCESS = /\bdone\b|\bsuccess(?:ful)?\b|\bcompleted\b|✓/i;
const FAILURE = /\bfailed\b|\berror\b|✗/i;
const ZERO_CALLS = /\b0\s+(?:tool\s+)?calls?\b|\bno\s+(?:tool\s+)?calls?\b/i;

// Check only public renderer behavior, not implementation-specific state slots or punctuation.
test("Codemode is a renderer-only resolver and delegates every other tool unchanged", () => {
	const { resolve, renderer } = captureRenderer();
	assert.deepEqual(Object.keys(renderer).sort(), ["renderCall", "renderResult", "renderShell"]);
	assert.equal(Object.getOwnPropertyDescriptor(renderer, "renderShell")?.get, undefined);
	assert.equal(renderer.renderShell, "self");
	for (const name of ["read", "bash", "codemode-other", "mcp__server__tool"]) {
		const downstream = { sentinel: name };
		let count = 0;
		assert.equal(resolve(name, () => { count++; return downstream; }), downstream);
		assert.equal(count, 1);
	}
	assert.equal(resolve("unregistered", () => undefined), undefined);
});

test("Codemode fixes the host shell but hot-switches existing call and result layout across expansion", () => {
	let shell: "self" | "default" = "self";
	const { renderer } = captureRenderer(() => shell);
	assert.equal(renderer.renderShell, "self");
	assert.equal(captureRenderer("default").renderer.renderShell, "self");
	const args = { code: 'text("live-layout-code");' };
	const context: any = {
		args, state: {}, toolCallId: "codemode-live-shell", cwd: process.cwd(),
		executionStarted: true, argsComplete: true, expanded: true, isPartial: false,
		isError: false, showImages: false, outputPad: 2, invalidate() {},
	};
	const call = renderer.renderCall(args, theme, context);
	const value = nativeResult([child("read")], "live-layout-output");
	const result = renderer.renderResult(value, { expanded: true, isPartial: false }, theme, context);
	const combined = () => [...call.render(80), ...result.render(80)];
	const plain = combined();
	assert.match(plain.join("\n"), /live-layout-code/);
	assert.match(plain.join("\n"), /live-layout-output/);
	assert.equal(call.render(80).length, 1);
	shell = "default";
	const framed = combined();
	assert.equal(renderer.renderShell, "self");
	assert.equal(framed[0], " ".repeat(80));
	assert.equal(framed.at(-1), " ".repeat(80));
	assert.match(framed[1], /^  Codemode /);
	assert.equal(framed.filter((line) => !line.trim()).length, 2, "one box has only outer top/bottom margins");
	assert.match(framed.join("\n"), /live-layout-output/);
	renderer.renderCall(args, theme, { ...context, expanded: false, lastComponent: call });
	renderer.renderResult(value, { expanded: false, isPartial: false }, theme, { ...context, expanded: false, lastComponent: result });
	assert.equal(combined().length, 3, "collapsed row owns only one header and two margins");
	assert.doesNotMatch(combined().join("\n"), /live-layout-code|live-layout-output/);
	shell = "self";
	assert.equal(combined().length, 1, "existing collapsed result relinquishes default bottom padding");
	renderer.renderCall(args, theme, { ...context, lastComponent: call });
	renderer.renderResult(value, { expanded: true, isPartial: false }, theme, { ...context, lastComponent: result });
	assert.deepEqual(combined(), plain, "expansion works again after a round trip without remounting");
});

test("pending, preparing, and running headers do not infer calls from JavaScript", () => {
	const f = fixture({ code: 'if (false) await tools.read({path:"never.ts"}); await tools.bash({command:"never"});' });
	const pending = text(f.call({ argsComplete: false, executionStarted: false }));
	assert.match(pending, /pending|preparing/i);
	const preparing = text(f.call({ argsComplete: true, executionStarted: false }));
	assert.match(preparing, /pending|preparing/i);
	const running = text(f.call({ executionStarted: true }));
	assert.match(running, /running/i);
	for (const header of [pending, preparing, running]) {
		assert.match(header, /codemode/i);
		assert.doesNotMatch(header, /never|tools\.|await|read\s*[×x]\s*1|bash\s*[×x]\s*1/i);
	}
});

test("collapsed results aggregate only observed names and never show code or output bodies", () => {
	const f = fixture();
	f.call();
	const result = f.result(nativeResult([
		child("read"), child("read"), child("bash"),
	]));
	assert.equal(text(result), "");
	const header = f.call();
	const rendered = text(header);
	assertCount(rendered, "read", 2);
	assert.match(rendered, /bash/i);
	assert.match(rendered, SUCCESS);
	assert.match(rendered, /1\.2\s*s/);
	assert.doesNotMatch(rendered, /secret-script-body|secret-output-body|Script completed|Wall time/);
	for (const width of [48, 64, 80, 120]) assertSingleLine(header, width);
});

test("partial results update actual running and completed child statuses then settle", () => {
	const f = fixture();
	const call = f.call();
	f.result({ content: [], details: { calls: [child("read"), child("bash", "running")] } }, { isPartial: true });
	const partial = text(f.call());
	assert.match(partial, /running/i);
	assert.match(partial, /1\s*(?:done|ok|completed)|(?:done|ok|completed)\s*1/i);
	assert.match(partial, /read/i);
	assert.match(partial, /bash/i);
	assert.doesNotMatch(partial, /\d+(?:\.\d+)?\s*s\b/);
	f.result(nativeResult([child("read"), child("bash")]), { isPartial: false, durationMs: 2400 });
	assert.match(text(f.call()), SUCCESS);
	assert.doesNotMatch(text(f.call()), /running/i);
	assert.match(text(f.call()), /2\.4\s*s/);
	assert.match(text(call), /read/i, "the original call component retains the latest observed summary");
});

test("a caught child error and cancellation do not turn a successful script into parent failure", () => {
	const f = fixture({ code: "await Promise.allSettled([]);" });
	f.call();
	const calls = [child("read", "error", '{"path":"missing.ts"}', { error: "ENOENT caught" }), child("bash", "cancelled")];
	f.result(nativeResult(calls));
	const header = text(f.call());
	assert.match(header, SUCCESS, "parent success remains explicit despite child failures");
	assert.match(header, /error|failed|✗/i);
	assert.match(header, /cancel|⊘/i);
	const expanded = text(f.result(nativeResult(calls), { expanded: true }));
	assert.match(expanded, /ENOENT caught/);
	assert.match(expanded, /cancel|⊘/i);
});

test("parent failure keeps partial output and child failure details in the expanded rail", () => {
	const f = fixture();
	f.call();
	const value = nativeResult([child("bash", "error", '{"command":"npm test"}', { error: "child rejected" })],
		"output-before-error\nScript error:\nscript-rejected", 1.2, true);
	assert.equal(text(f.result(value, { isError: true })), "");
	assert.match(text(f.call()), FAILURE);
	const expanded = text(f.result(value, { expanded: true }));
	assert.match(expanded, /child rejected/);
	assert.match(expanded, /output-before-error/);
	assert.match(expanded, /script-rejected/);
	assert.match(expanded, /├─ (?:output|error)/);
	assert.doesNotMatch(expanded, /Script failed\nWall time/);
});

test("a failed script never leaks its preceding output into collapsed metadata", () => {
	const f = fixture();
	const value = nativeResult([], "OUTPUT_BODY_NOT_AN_ERROR\nScript error:\nreal failure", 1.2, true);
	const initialCall = f.call();
	f.result(value, { isError: true });
	for (const component of [initialCall, f.call(), f.remountCall()]) {
		const header = text(component);
		assert.match(header, FAILURE);
		assert.doesNotMatch(header, /OUTPUT_BODY_NOT_AN_ERROR|Script error|real failure/);
		assertSingleLine(component, 48);
	}
	const expanded = text(f.result(value, { expanded: true }));
	assert.match(expanded, /OUTPUT_BODY_NOT_AN_ERROR/);
	assert.match(expanded, /real failure/);
});

test("invalid top-level arguments and failure before the first child remain renderable", () => {
	for (const args of [undefined, null, {}, { code: 42 }]) {
		const f = fixture(args);
		// fixture's default applies to undefined, so explicitly retain the malformed native input.
		f.context.args = args;
		assert.doesNotThrow(() => f.call());
		const value = { content: [{ type: "text", text: "Invalid options: timeout_ms must be positive" }], details: undefined };
		assert.doesNotThrow(() => f.result(value, { isError: true }));
		assert.match(text(f.call()), FAILURE);
		const expanded = text(f.result(value, { expanded: true }));
		assert.match(expanded, /Invalid options: timeout_ms must be positive/);
	}
});

test("scripts with zero observed calls settle without inventing tool names", () => {
	const f = fixture({ code: 'text("hello");' });
	f.call();
	f.result(nativeResult([], "hello"));
	const header = text(f.call());
	assert.match(header, ZERO_CALLS);
	assert.match(header, SUCCESS);
	assert.doesNotMatch(header, /read|bash|running/i);
});

test("expanded rendering uses the existing rail for calls, code, output, and collapse hint", () => {
	const f = fixture({ code: 'const value = await tools.read({path:"src/a.ts"});\ntext(value);' });
	assertSingleLine(f.call({ expanded: true }), 120);
	const value = nativeResult([
		child("read", "ok", '{"path":"src/a.ts","offset":3,"limit":2}', { durationMs: 8 }),
		child("bash", "running", '{"command":"npm run check"}'),
	], "actual-output-text");
	const expanded = text(f.result(value));
	assert.match(expanded, /├─ calls/);
	assert.match(expanded, /├─ code/);
	assert.match(expanded, /├─ output/);
	assert.match(expanded, /read\s+src\/a\.ts/i, "valid JSON path arguments should produce a readable child target");
	assert.match(expanded, /bash\s+npm run check/i, "valid JSON command arguments should produce a readable child target");
	assert.match(expanded, /8\s*ms/);
	assert.match(expanded, /running|…/i);
	assert.match(expanded, /const value = await/);
	assert.match(expanded, /actual-output-text/);
	assert.match(expanded, /╰─.*collapse/);
});

test("malformed and truncated JSON previews fall back safely without losing the original preview", () => {
	const truncated = `{"path":"src/${"nested/".repeat(20)}tail-without-closing-quote`;
	const malformed = 'not JSON: keep-this-preview\nnext-line\tand-tab\x1b[31mred\x1b[0m';
	const f = fixture();
	const expanded = text(f.result(nativeResult([
		child("read", "ok", truncated), child("mcp__search", "ok", malformed),
	]), { expanded: true }), 1200);
	assert.ok(expanded.includes(truncated), "all characters in the native truncated preview remain inspectable");
	assert.match(expanded, /not JSON: keep-this-preview/);
	assert.match(expanded, /next-line/);
	assert.match(expanded, /and-tab/);
	assert.match(expanded, /red/);
	assert.doesNotMatch(expanded, /\x1b|\t|\r/, "untrusted raw argument previews must be sanitized");
});

test("absent or malformed details do not throw or discard native output", () => {
	for (const details of [undefined, null, {}, { calls: null }, { calls: "invalid" }, { calls: [null, {}, 7, { name: "read", args: 42 }] }]) {
		const f = fixture();
		const value = { content: [{ type: "text", text: "output-kept-with-malformed-details" }], details };
		assert.doesNotThrow(() => f.result(value));
		assertSingleLine(f.call(), 64);
		assert.match(text(f.result(value, { expanded: true })), /output-kept-with-malformed-details/);
	}
});

test("native duration wins over the header and the header is the fallback", () => {
	const f = fixture();
	f.call();
	f.result(nativeResult([], "duration-output", 9.9), { durationMs: 2400 });
	assert.match(text(f.call()), /2\.4\s*s/);
	assert.doesNotMatch(text(f.call()), /9\.9\s*s/);
	const historical = fixture();
	historical.result(nativeResult([], "duration-output", 1.2));
	assert.match(text(historical.call()), /1\.2\s*s/);
});

test("historical results without timing metadata never invent elapsed time", () => {
	const f = fixture();
	f.call();
	const value = { content: [{ type: "text", text: "historical-output" }], details: { calls: [child("read")] } };
	f.result(value);
	for (const component of [f.call(), f.remountCall(), f.result(value, { expanded: true })]) {
		assert.doesNotMatch(text(component), /\b\d+(?:\.\d+)?\s*(?:ms|s|seconds)\b|Elapsed|Took/);
	}
});

test("a sub-second settled duration may be omitted but cannot become an invented longer duration", () => {
	const f = fixture();
	f.result(nativeResult([], "fast-output", 0.12), { durationMs: 120 });
	const header = text(f.call());
	assert.match(header, SUCCESS);
	assert.doesNotMatch(header, /\b(?:[1-9]\d*(?:\.\d+)?|0\.[2-9]\d*)\s*s\b/);
});

test("Codemode never starts live elapsed refresh timers", () => {
	const originalSetInterval = global.setInterval;
	const originalSetTimeout = global.setTimeout;
	let timers = 0;
	const countTimer = () => { timers++; return { fake: true }; };
	global.setInterval = countTimer as unknown as typeof setInterval;
	global.setTimeout = countTimer as unknown as typeof setTimeout;
	try {
		const f = fixture();
		f.call({ executionStarted: false, argsComplete: false });
		f.call({ executionStarted: true, argsComplete: true });
		f.result({ content: [], details: { calls: [child("bash", "running")] } }, { isPartial: true });
		f.result(nativeResult([child("bash")]), { expanded: true, isPartial: false });
		assert.equal(timers, 0);
	} finally {
		global.setInterval = originalSetInterval;
		global.setTimeout = originalSetTimeout;
	}
});

test("finishing while initially expanded survives collapse, invalidation, and component reconstruction", () => {
	const f = fixture();
	f.call({ expanded: true });
	f.result({ content: [], details: { calls: [child("read", "running")] } }, { isPartial: true });
	const value = nativeResult([child("read"), child("read"), child("bash")]);
	f.result(value, { isPartial: false, durationMs: 3400 });
	const collapsed = f.call({ expanded: false });
	collapsed?.invalidate?.();
	for (const component of [collapsed, f.remountCall()]) {
		const header = text(component);
		assertCount(header, "read", 2);
		assert.match(header, /bash/i);
		assert.match(header, /3\.4\s*s/);
		assert.match(header, SUCCESS);
		assert.doesNotMatch(header, /running|secret-script-body|secret-output-body/i);
		assertSingleLine(component, 48);
	}
	// Full row remount reconstructs from the replayed native result, not wall-clock guesses.
	f.context.state = {};
	f.result(value, { expanded: true });
	assertCount(text(f.call({ expanded: false })), "read", 2);
});

test("code is highlighted only after complete arguments, cached by source and theme identity", () => {
	const code = 'const cacheProbe = "codemode-highlight-cache";\ntext(cacheProbe);';
	const f = fixture({ code });
	const start = highlightCodeCalls.length;
	text(f.call({ expanded: true, argsComplete: false }));
	text(f.result(nativeResult(), { expanded: true }));
	assert.equal(highlightCodeCalls.length, start, "streaming arguments must not be syntax highlighted");
	f.call({ argsComplete: true });
	const value = nativeResult();
	const expanded = f.result(value);
	text(expanded);
	assert.equal(highlightCodeCalls.length, start + 1);
	assert.match(highlightCodeCalls[start]!.language ?? "", /javascript|^js$/);
	for (const width of [48, 80, 120, 80]) text(expanded, width);
	text(f.result(value));
	text(f.call({ expanded: false }));
	text(f.result(value));
	text(f.call({ expanded: true }));
	text(f.result(value));
	text(f.remountCall());
	text(f.result(value));
	assert.equal(highlightCodeCalls.length, start + 1, "width changes, result updates, and toggles reuse highlighting");
	const otherTheme = { ...theme };
	text(f.call({}, otherTheme));
	text(f.result(value, {}, otherTheme));
	assert.equal(highlightCodeCalls.length, start + 2, "new theme identity must rebuild highlighted source");
	f.context.args = { code: 'text("changed-source-cache-probe");' };
	text(f.call({}, otherTheme));
	text(f.result(value, {}, otherTheme));
	assert.equal(highlightCodeCalls.length, start + 3, "changed source must invalidate highlighting");
});

test("only the exact native first-block header is removed; ordinary or header-like text is preserved", () => {
	const value = nativeResult([], "body-after-native-header");
	const f = fixture();
	const rendered = text(f.result(value, { expanded: true }));
	assert.match(rendered, /body-after-native-header/);
	assert.doesNotMatch(rendered, /Script completed|Wall time 1\.2 seconds|Output:/);
	for (const body of [
		"plain error without native header",
		"Script completed\nWall time 1.2 seconds\nOutput:\nuser-output-in-same-block",
		"Script completed\nWall time unknown seconds\nOutput:\n",
	]) {
		const plain = fixture();
		const output = text(plain.result({ content: [{ type: "text", text: body }], details: undefined }, { expanded: true }));
		for (const line of body.trimEnd().split("\n")) assert.ok(output.includes(line), `output lost: ${line}`);
	}
});

test("images and full-output-file information remain available without mutating native results", () => {
	const value: any = nativeResult([child("models.generateImages", "ok", '{"provider":"test","id":"image-model"}', { cost: 0.02 })], "before-image");
	const image = { type: "image", mimeType: "image/png", data: "base64-image-payload" };
	value.content.push(image, { type: "text", text: "after-image" });
	value.details.fullOutputPath = "D:/tmp/codemode/full-output.txt";
	const snapshot = structuredClone(value);
	const content = value.content;
	const headerBlock = value.content[0];
	const calls = value.details.calls;
	for (const block of value.content) Object.freeze(block);
	for (const call of calls) Object.freeze(call);
	Object.freeze(content);
	Object.freeze(calls);
	Object.freeze(value.details);
	Object.freeze(value);
	const f = fixture();
	for (const showImages of [false, true]) {
		const expanded = text(f.result(value, { expanded: true, showImages }));
		assert.match(expanded, /before-image/);
		assert.match(expanded, /after-image/);
		assert.match(expanded, /image|png/i);
		assert.match(expanded, /D:\/tmp\/codemode\/full-output\.txt/);
		assert.doesNotMatch(expanded, /base64-image-payload/);
		assert.deepEqual(value, snapshot);
		assert.equal(value.content, content);
		assert.equal(value.content[0], headerBlock);
		assert.equal(value.content[2], image);
		assert.equal(value.details.calls, calls);
	}
	assert.equal(text(f.result(value, { expanded: false })), "");
});

test("model call names and reported cost stay inspectable in expanded calls", () => {
	const f = fixture();
	const value = nativeResult([
		child("models.classify", "ok", '{"provider":"test","id":"classifier"}', { cost: 0.0012, durationMs: 1200 }),
		child("models.generateImages", "ok", '{"provider":"test","id":"painter"}', { cost: 0.02, durationMs: 2400 }),
	]);
	const expanded = text(f.result(value, { expanded: true }));
	assert.match(expanded, /models\.classify/i);
	assert.match(expanded, /models\.generateImages/i);
	assert.match(expanded, /\$0\.0012/);
	assert.match(expanded, /\$0\.02/);
	assert.match(expanded, /1\.2\s*s/);
	assert.match(expanded, /2\.4\s*s/);
});

test("long previews, multiline code/output, and error text stay within common widths", () => {
	const f = fixture({ code: `text("${"long-code".repeat(30)}");\ntext("second-line");` });
	const value = nativeResult([
		child("read", "ok", JSON.stringify({ path: `src/${"nested/".repeat(30)}file.ts` })),
		child("bash", "error", JSON.stringify({ command: `printf '${"long-command".repeat(30)}'` }), { error: "long-error".repeat(30) }),
		child(`mcp__${"long-name".repeat(15)}`, "cancelled", "not-json-preview".repeat(20)),
	], "long-output".repeat(60), 1.2, true);
	f.call();
	f.result(value, { isError: true });
	for (const width of [48, 64, 80, 120]) {
		assertSingleLine(f.call({ expanded: false }), width);
		const expanded = f.result(value, { expanded: true });
		for (const line of expanded?.render(width) ?? []) {
			assert.ok(visibleWidth(line) <= width, `expanded line overflows ${width}: ${line}`);
		}
	}
});
