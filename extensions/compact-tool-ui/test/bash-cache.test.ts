import assert from "node:assert/strict";
import path from "node:path";
import { stripVTControlCharacters as strip } from "node:util";
import test from "node:test";
import { getCapabilities, setCapabilities, visibleWidth } from "@earendil-works/pi-tui";
import { LineNumberedCodeBlock } from "../components/line-numbered-code-block.js";
import { ShellCommandBlock } from "../components/shell-command-block.js";
import { unwrapToolShellComponent } from "../components/compact-tool-shell.js";
import { registerCompactBash } from "../renderers/bash.js";
import { captureRegisteredRenderer } from "./renderer-fixture.js";

function makeTheme() {
	return {
		colors: { muted: "\x1b[31m", dim: "\x1b[36m" } as Record<string, string>,
		fg(token: string, value: string) { return `${this.colors[token] ?? ""}${value}\x1b[0m`; },
		bg(_token: string, value: string) { return value; },
		bold(value: string) { return value; },
	} as any;
}

for (const kind of ["command", "code"] as const) {
	test(`${kind} layout caches one width and palette, and explicit invalidation clears it`, () => {
		const theme = makeTheme();
		const source = "first\tvalue\n" + "wrapped value ".repeat(20);
		const block = kind === "command" ? new ShellCommandBlock(source, theme) : new LineNumberedCodeBlock(source, theme);
		const wide = block.render(80);
		assert.equal(block.render(80), wide);
		assert.deepEqual(block.render(0), []);
		assert.equal(block.render(80), wide, "hidden rendering does not discard a valid layout");
		const narrow = block.render(24);
		assert.notEqual(narrow, wide);
		assert.ok(narrow.every((line) => visibleWidth(line) <= 24));
		const restored = block.render(80);
		assert.notEqual(restored, wide, "only the latest width is retained");
		assert.deepEqual(restored, wide);
		theme.colors = { muted: "\x1b[32m", dim: "\x1b[35m" };
		const recolored = block.render(80);
		assert.notEqual(recolored, restored);
		assert.notDeepEqual(recolored, restored);
		assert.equal(block.render(80), recolored);
		block.invalidate();
		const rebuilt = block.render(80);
		assert.notEqual(rebuilt, recolored);
		assert.deepEqual(rebuilt, recolored);
	});
}

function fixture() {
	const tool = captureRegisteredRenderer(registerCompactBash);
	const state: any = {};
	let theme = makeTheme();
	let args: Readonly<{ command: string }> = Object.freeze({ command: "printf original-command" });
	let call: any;
	let result: any;
	const context: any = {
		expanded: true, state, toolCallId: "cache-fixture", executionStarted: false,
		argsComplete: true, isPartial: true, isError: false, showImages: false,
		cwd: process.cwd(), invalidate() {}, outputPad: 0,
	};
	return {
		state,
		get theme() { return theme; },
		setTheme(value: any) { theme = value; },
		setCommand(command: string) { args = Object.freeze({ command }); },
		update(text: string, options: { isPartial?: boolean; isError?: boolean; details?: any; cwd?: string; expanded?: boolean } = {}) {
			const isPartial = options.isPartial ?? true;
			const ctx = { ...context, ...options, isPartial, args, lastComponent: call };
			call = tool.renderCall(args, theme, ctx);
			const content = Object.freeze([Object.freeze({ type: "text", text })]);
			const value = Object.freeze({ content, details: options.details });
			const snapshot = JSON.stringify(value);
			result = tool.renderResult(value, { expanded: ctx.expanded, isPartial }, theme, { ...ctx, lastComponent: result });
			assert.equal(JSON.stringify(value), snapshot, "cache construction cannot rewrite native output");
			return {
				component: unwrapToolShellComponent(result)!,
				header: () => call.render(80).map(strip).join("\n"),
				text: () => result.render(1000).map(strip).join("\n"),
			};
		},
	};
}

test("elapsed-only refresh reuses expanded content and block layouts without freezing the header", () => {
	const f = fixture();
	f.state.compactStartedAt = Date.now() - 2000;
	const first = f.update("alpha\nbeta\ngamma");
	const header = first.header();
	first.component.render(80);
	const command = f.state.expandedContentCache.command;
	const output = f.state.expandedContentCache.output.component;
	const commandLayout = command.render(76);
	const outputLayout = output.render(76);
	f.state.compactStartedAt -= 2000;
	first.component.invalidate?.();
	const tick = f.update("alpha\nbeta\ngamma");
	assert.equal(tick.component, first.component);
	assert.notEqual(tick.header(), header);
	assert.equal(command.render(76), commandLayout);
	assert.equal(output.render(76), outputLayout);
});

test("command and output changes replace only their own immutable content", () => {
	const f = fixture();
	const first = f.update("alpha\nbeta\ngamma");
	const snapshot = first.component.render(80);
	const firstCommand = f.state.expandedContentCache.command;
	const firstOutput = f.state.expandedContentCache.output.component;
	f.setCommand("printf changed-command");
	const changedCommand = f.update("alpha\nbeta\ngamma");
	assert.notEqual(changedCommand.component, first.component);
	assert.notEqual(f.state.expandedContentCache.command, firstCommand);
	assert.equal(f.state.expandedContentCache.output.component, firstOutput);
	assert.match(changedCommand.text(), /changed-command/);
	const command = f.state.expandedContentCache.command;
	const changedOutput = f.update("new-alpha\nnew-beta\nnew-gamma");
	assert.notEqual(changedOutput.component, changedCommand.component);
	assert.equal(f.state.expandedContentCache.command, command);
	assert.notEqual(f.state.expandedContentCache.output.component, firstOutput);
	assert.match(changedOutput.text(), /new-gamma/);
	assert.deepEqual(first.component.render(80), snapshot, "new content cannot mutate an old view");
});

test("an unchanged streaming tail retains its layout while total-line metadata stays current", () => {
	const f = fixture();
	const tail = Array.from({ length: 28 }, (_, index) => `tail-${index}`).join("\n");
	const first = f.update(`old-head\n${tail}`);
	const output = f.state.expandedContentCache.output.component;
	assert.match(first.text(), /tail 28\/29 lines/);
	const next = f.update(`old-head\nnew-head\n${tail}`);
	assert.notEqual(next.component, first.component);
	assert.equal(f.state.expandedContentCache.output.component, output);
	assert.match(next.text(), /tail 28\/30 lines/);
	assert.doesNotMatch(next.text(), /old-head|new-head/);
	assert.equal(f.update(`old-head\nnew-head\n${tail}`).component, next.component);
});

test("partial settlement and empty output cannot retain a stale cap or streaming footer", () => {
	const f = fixture();
	const stream = f.update("first\nsecond");
	const output = f.state.expandedContentCache.output.component;
	const settled = f.update("first\nsecond", { isPartial: false });
	assert.notEqual(settled.component, stream.component);
	assert.notEqual(f.state.expandedContentCache.output.component, output);
	assert.doesNotMatch(settled.text(), /streaming/);
	for (const isError of [false, true]) {
		const empty = fixture();
		empty.update("previous output");
		const pending = empty.update("");
		assert.equal(empty.state.expandedContentCache.output, undefined);
		assert.doesNotMatch(pending.text(), /previous output|├─ output/);
		assert.match(pending.text(), /streaming/);
		assert.equal(empty.update("").component, pending.component);
		const final = empty.update("", { isPartial: false, isError });
		assert.notEqual(final.component, pending.component);
		assert.doesNotMatch(final.text(), /streaming|previous output/);
	}
});

test("footer fields and cwd remain current even with identical output and details identity", (t) => {
	const previous = getCapabilities();
	setCapabilities({ ...previous, hyperlinks: true });
	t.after(() => setCapabilities(previous));
	const f = fixture();
	const details = { fullOutputPath: "logs/latest.log", truncation: { truncated: true, outputLines: 3, totalLines: 20 } };
	const first = f.update("alpha\nbeta\ngamma", { details, cwd: path.resolve("cache-cwd-a") });
	const command = f.state.expandedContentCache.command;
	const output = f.state.expandedContentCache.output.component;
	const firstAnsi = first.component.render(1000).join("\n");
	details.truncation.totalLines = 30;
	const truncated = f.update("alpha\nbeta\ngamma", { details, cwd: path.resolve("cache-cwd-a") });
	assert.notEqual(truncated.component, first.component);
	assert.match(truncated.text(), /3\/30 lines/);
	const moved = f.update("alpha\nbeta\ngamma", { details, cwd: path.resolve("cache-cwd-b") });
	assert.notEqual(moved.component, truncated.component);
	assert.notEqual(moved.component.render(1000).join("\n"), firstAnsi);
	assert.match(moved.component.render(1000).join("\n"), /cache-cwd-b/);
	assert.equal(f.state.expandedContentCache.command, command);
	assert.equal(f.state.expandedContentCache.output.component, output);
	details.fullOutputPath = "logs/updated.log";
	assert.match(f.update("alpha\nbeta\ngamma", { details }).text(), /updated\.log/);
});

test("palette and theme replacement rebuild content; collapsed updates and tool states stay isolated", () => {
	const f = fixture();
	const first = f.update("alpha\nbeta\ngamma");
	const cache = f.state.expandedContentCache;
	f.theme.colors = { muted: "\x1b[32m", dim: "\x1b[35m" };
	const recolored = f.update("alpha\nbeta\ngamma");
	assert.notEqual(f.state.expandedContentCache, cache);
	assert.notEqual(recolored.component, first.component);
	assert.notEqual(f.state.expandedContentCache.command, cache.command);
	const paletteCache = f.state.expandedContentCache;
	f.setTheme({ ...f.theme });
	assert.notEqual(f.update("alpha\nbeta\ngamma").component, recolored.component);
	assert.notEqual(f.state.expandedContentCache, paletteCache);
	const current = f.state.expandedContentCache;
	const collapsed = f.update("changed while collapsed", { expanded: false });
	assert.deepEqual(collapsed.component.render(80), []);
	assert.equal(f.state.expandedContentCache, current, "collapsed updates do not build detail components");
	const reopened = f.update("changed while collapsed");
	assert.match(reopened.text(), /changed while collapsed/);
	assert.doesNotMatch(reopened.text(), /alpha|beta|gamma/);
	assert.notEqual(fixture().update("changed while collapsed").component, reopened.component);
});
