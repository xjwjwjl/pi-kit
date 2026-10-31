import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// A clean child bypasses register-ts-loader.mjs: every Pi import, renderer and component is real.
const runtimeCheck = String.raw`
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { stripVTControlCharacters as strip } from "node:util";
import {
	createAgentSession, DefaultResourceLoader, highlightCode, initTheme,
	SessionManager, SettingsManager, ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { Box, Container, Text, TuiAltScreen, getKeybindings, setKeybindings, KeybindingsManager, visibleWidth } from "@earendil-works/pi-tui";
import { createChatViewport } from "./node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/chat-viewport.js";
import { theme } from "./node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { withBuiltInRenderers } from "./node_modules/@earendil-works/pi-coding-agent/dist/core/tools/renderers/index.js";

const entry = process.argv[1];
const root = process.argv[2];
const agentDir = process.env.PI_CODING_AGENT_DIR;
assert.equal(process.env.PI_OFFLINE, "1");
assert.equal(process.env.JITI_FS_CACHE, "false");
process.chdir(root);
await mkdir(agentDir, { recursive: true });
await mkdir(join(root, ".pi"));
const globalSettings = {
	defaultTools: [], shellCommandPrefix: "export COMPACT_RUNTIME_PREFIX=preserved",
	images: { autoResize: false },
	compactToolUi: { renderShell: "self", bash: { tailPreview: "off" }, edit: { inlineDiffMaxLines: -1 } },
};
const globalSettingsPath = join(agentDir, "settings.json");
await writeFile(globalSettingsPath, JSON.stringify(globalSettings));
const settings = SettingsManager.create(root, agentDir);
const resourceLoader = new DefaultResourceLoader({
	cwd: root, agentDir, settingsManager: settings, additionalExtensionPaths: [entry],
	noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
});
await resourceLoader.reload();
const loaded = resourceLoader.getExtensions();
assert.deepEqual(loaded.errors, []);
assert.equal(loaded.extensions.length, 1);
const extension = loaded.extensions[0];
const sessions = [];
const shutdown = async () => {
	for (const handler of extension.handlers.get("session_shutdown") ?? []) {
		await handler({ type: "session_shutdown", reason: "exit" }, {});
	}
};
try {
	initTheme("dark", false);
	const { session } = await createAgentSession({
		cwd: root, agentDir, settingsManager: settings, resourceLoader,
		sessionManager: SessionManager.inMemory(root),
	});
	sessions.push(session);
	assert.deepEqual(session.getActiveToolNames(), []);
	assert.deepEqual(session.getCallableToolNames(), []);
	assert.deepEqual([...extension.tools.keys()], [], "a UI extension must not register execution overrides");
	assert.equal(extension.toolRenderers.length, 5);
	const resolve = (name, fallback = () => withBuiltInRenderers(name, session.getToolDefinition(name))) => {
		const next = (index) => index === extension.toolRenderers.length
			? fallback() : extension.toolRenderers[index](name, () => next(index + 1));
		return next(0);
	};
	const sentinel = {};
	assert.equal(resolve("unrelated", () => sentinel), sentinel);
	assert.equal(resolve("ls", () => sentinel), sentinel);
	const names = ["bash", "read", "write", "edit"];
	const definitions = new Map(names.map((name) => [name, session.getToolDefinition(name)]));
	const renderers = Object.fromEntries([...names, "codemode"].map((name) => [name, resolve(name)]));
	for (const [name, renderer] of Object.entries(renderers)) {
		assert.deepEqual(Object.keys(renderer).sort(), ["renderCall", "renderResult", "renderShell"], name);
		assert.equal(renderer.renderShell, "self");
		assert.equal(extension.toolRenderers.filter((hook) => hook(name, () => sentinel) !== sentinel).length, 1,
			"exactly one hook owns " + name);
	}
	for (const name of names) {
		const definition = session.getToolDefinition(name);
		assert.equal(definition, definitions.get(name));
		assert.equal(typeof definition.execute, "function");
		assert.ok(definition.parameters);
		assert.equal(session.getAllTools().find((tool) => tool.name === name).exposure, "direct");
		assert.notEqual(definition.renderCall, renderers[name].renderCall);
	}
	assert.equal(settings.getImageAutoResize(), false);
	const executionCtx = { cwd: root, sessionManager: session.sessionManager };
	let id = 0;
	const execute = (name, args) => definitions.get(name).execute("headless-" + (++id), args, undefined, undefined, executionCtx);
	const textResult = (text, extra = {}) => ({ content: [{ type: "text", text }], details: undefined, ...extra });
	const textOf = (result) => result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
	const freeze = (value) => {
		if (value && typeof value === "object") {
			for (const child of Object.values(value)) freeze(child);
			Object.freeze(value);
		}
		return value;
	};
	// These are the SDK host's definitions, not freshly constructed tool replacements.
	const prefix = await execute("bash", { command: 'printf "%s" "$COMPACT_RUNTIME_PREFIX"', timeout: 5 });
	assert.equal(textOf(prefix), "preserved");
	for (let n = 0; n < 3; n++) {
		assert.equal(textOf(await execute("bash", { command: "printf 'headless'", timeout: 5 })), "headless");
	}
	assert.deepEqual(session.getActiveToolNames(), [], "headless calls and resolver use must not activate tools");
	assert.deepEqual([...extension.tools.keys()], []);
	console.log("PASS: real loader/SDK preserve tool activation, definitions, prefix and image settings");

	const plainLines = (row, width = 120) => row.render(width).map(strip);
	const plain = (row, width = 120) => plainLines(row, width).join("\n");
	const widths = [48, 64, 80, 120];
	const checkWidths = (row) => {
		for (const width of widths) {
			for (const line of row.render(width)) {
				assert.ok(visibleWidth(line) <= width, "overflow at " + width + ": " + strip(line));
				assert.doesNotMatch(strip(line), /[\x00-\x09\x0b-\x1f\x7f]/, "unsafe control or literal tab in rendered output");
			}
		}
	};
	const makeRow = (name, args, result, options = {}) => {
		const row = new ToolExecutionComponent(name, "runtime-" + (++id), args,
			{ showImages: false, outputPad: 0, ...options }, renderers[name], { requestRender() {} }, root);
		row.setArgsComplete();
		if (result) row.updateResult(result);
		return row;
	};
	const assertSingleHeader = (name, row) => {
		assert.equal(plainLines(row).filter((line) => new RegExp("^" + name + "\\s", "i").test(line.trim())).length, 1, name + " header duplicated");
	};
	const code = 'const greeting = "你好 👋";\n\tconsole.log(greeting, "展开内容 🌍");';
	const readArgs = freeze({ path: "读取-你好-👋.ts" });
	await writeFile(join(root, readArgs.path), code);
	const readResult = freeze(await execute("read", readArgs));
	const writeArgs = freeze({ path: "写入-你好-👋.ts", content: code });
	const writeResult = freeze(await execute("write", writeArgs));
	assert.equal(await readFile(join(root, writeArgs.path), "utf8"), code);
	const bashArgs = freeze({ command: "printf '你好 👋\\tTAIL_MARKER\\nCommand exited with code 7\\n'", timeout: 5 });
	const bashResult = freeze({ ...await execute("bash", bashArgs), durationMs: 3400 });
	const bash = makeRow("bash", bashArgs, bashResult);
	assert.match(plain(bash), /3\.4s/);
	bash.setExpanded(true);
	assert.match(plain(bash), /Command exited with code 7/);
	assert.match(plain(bash), /TAIL_MARKER/);
	checkWidths(bash);
	const replayWithoutDuration = makeRow("bash", bashArgs, textResult("replayed output"));
	assert.doesNotMatch(plain(replayWithoutDuration), /\b\d+(?:\.\d+)?s\b/, "history without a duration must not fabricate one");
	const streaming = makeRow("bash", bashArgs);
	streaming.updateResult(textResult("Command exited with code 7\n部分输出 👋"), true);
	streaming.setExpanded(true);
	assert.match(plain(streaming), /Command exited with code 7/);
	checkWidths(streaming);
	const failure = freeze(await execute("bash", { command: "printf 'diagnostic 诊断 👋\\n'; exit 7", timeout: 5 }));
	assert.equal(failure.isError, true);
	assert.match(textOf(failure), /Command exited with code 7/);
	const failedBash = makeRow("bash", { command: "temporary failure" }, failure);
	failedBash.setExpanded(true);
	assert.match(plain(failedBash), /diagnostic 诊断 👋/);
	assert.doesNotMatch(plain(failedBash), /Command exited with code 7/);
	checkWidths(failedBash);
	for (const [suffix, status] of [
		["command aborted", "aborted"],
		["  Command exited with code 7  ", "exit 7"],
		["Command timed out after 1 second", "timeout 1s"],
		["command aborted\r\n\r\n", "aborted"],
		["command aborted\n \t\n", "aborted"],
	]) {
		const preserved = makeRow("bash", { command: "third-party command" },
			freeze(textResult("diagnostic before\n" + suffix, { isError: true })));
		assert.ok(plain(preserved).includes(status), "normalized failure classification must remain correct: " + suffix);
		preserved.setExpanded(true);
		assert.match(plain(preserved), /├─ output/);
		assert.ok(plain(preserved).includes(suffix.trimEnd()), "non-native error text must remain visible: " + suffix);
		checkWidths(preserved);
	}

	// Native downstream Edit computes its pending preview asynchronously from the temp file.
	const editPath = "编辑-你好-👋.ts";
	await writeFile(join(root, editPath), 'const value = "原始 👋";\n');
	const editArgs = freeze({ path: editPath, edits: [{ oldText: '"原始 👋"', newText: '"PREVIEW_ONLY 🌍"' }] });
	let edit;
	let previewListener = () => {};
	edit = new ToolExecutionComponent("edit", "runtime-edit-preview", editArgs,
		{ showImages: false, outputPad: 0 }, renderers.edit, { requestRender() { previewListener(); } }, root);
	let previewTimeout;
	const previewReady = new Promise((resolve, reject) => {
		previewTimeout = setTimeout(() => reject(new Error("native Edit preview did not request a render within 5s")), 5000);
		previewListener = () => {
			if (/\+1\s+-1/.test(plain(edit))) resolve();
		};
	});
	try {
		edit.setArgsComplete();
		assert.match(plain(edit), /previewing/);
		await previewReady;
	} finally {
		clearTimeout(previewTimeout);
		previewListener = () => {};
	}
	assert.match(plain(edit), /\+1\s+-1/);
	// Execute a different replacement, so stale preview text cannot accidentally pass as final diff.
	const finalEditArgs = { path: editPath, edits: [{ oldText: '"原始 👋"', newText: '"FINAL_AUTHORITATIVE 🌍"' }] };
	const editResult = freeze(await execute("edit", finalEditArgs));
	assert.match(editResult.details.diff, /FINAL_AUTHORITATIVE/);
	edit.updateResult(editResult);
	edit.setExpanded(true);
	assert.match(plain(edit), /FINAL_AUTHORITATIVE 🌍/);
	assert.doesNotMatch(plain(edit), /PREVIEW_ONLY/);
	checkWidths(edit);
	assert.equal(await readFile(join(root, editPath), "utf8"), 'const value = "FINAL_AUTHORITATIVE 🌍";\n');

	const read = makeRow("read", readArgs, readResult);
	const write = makeRow("write", writeArgs, writeResult);
	const rows = { bash, read, write, edit };
	for (const [name, row] of Object.entries(rows)) {
		row.setExpanded(true);
		checkWidths(row);
		assertSingleHeader(name, row);
		const section = name === "bash" ? "command" : name === "edit" ? "diff" : "content";
		assert.equal((plain(row).match(new RegExp("├─ " + section, "g")) ?? []).length, 1);
		row.setExpanded(false);
		checkWidths(row);
		for (const width of widths) assert.equal(plainLines(row, width).filter((line) => line.trim()).length, 1, name + " must collapse");
		assert.doesNotMatch(plain(row), /├─ |展开内容|FINAL_AUTHORITATIVE/);
		const error = makeRow(name, name === "edit" ? { path: "missing.ts" } : name === "bash" ? { command: "failure" } : { path: "missing.ts", content: code },
			textResult("ENOENT: 临时文件不存在 👋\nERROR_DETAIL_ONLY", { isError: true }));
		error.setExpanded(true);
		assert.match(plain(error), /ERROR_DETAIL_ONLY/);
		checkWidths(error);
		error.setExpanded(false);
		checkWidths(error);
		assert.doesNotMatch(plain(error), /ERROR_DETAIL_ONLY|├─ /);
	}
	console.log("PASS: four native components wrap ANSI/Chinese/emoji, expand/collapse, errors, async Edit and authoritative final diff");

	// Read/Write must invalidate against colors, because Pi's theme proxy retains its identity.
	const stableProxy = theme;
	const darkSource = highlightCode(code.replace(/\t/g, "   "), "typescript")[0];
	const darkCaches = new Map();
	for (const row of [read, write]) {
		row.setExpanded(true);
		assert.ok(row.render(120).some((line) => line.includes(darkSource)));
		const cache = row.rendererState.expandedHighlightCache;
		assert.ok(cache?.lines.length > 1, "cache must hold the complete source, not just a viewport");
		row.render(48);
		row.invalidate();
		row.render(120);
		assert.equal(row.rendererState.expandedHighlightCache, cache, "same-theme full-source highlight cache must be reused");
		darkCaches.set(row, cache);
	}
	initTheme("light", false);
	assert.equal(theme, stableProxy);
	const lightSource = highlightCode(code.replace(/\t/g, "   "), "typescript")[0];
	assert.notEqual(lightSource, darkSource);
	for (const row of [read, write]) {
		row.invalidate();
		const lines = row.render(120);
		assert.ok(lines.some((line) => line.includes(lightSource)), "new light highlighting must replace cached dark colors");
		assert.ok(!lines.some((line) => line.includes(darkSource)), "dark source must not survive invalidation");
		assert.notEqual(row.rendererState.expandedHighlightCache, darkCaches.get(row));
		const lightCache = row.rendererState.expandedHighlightCache;
		row.invalidate();
		checkWidths(row);
		assert.equal(row.rendererState.expandedHighlightCache, lightCache);
	}
	const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9S8AAAAASUVORK5CYII=";
	await writeFile(join(root, "original.png"), Buffer.from(png, "base64"));
	const imageResult = freeze(await execute("read", { path: "original.png" }));
	const image = imageResult.content.find((part) => part.type === "image");
	assert.ok(image, "native Read must return the original PNG attachment");
	assert.equal(image.data, png);
	assert.equal(image.mimeType, "image/png");
	const imageSnapshot = JSON.stringify(imageResult);
	const imageRow = makeRow("read", { path: "original.png" }, imageResult);
	imageRow.setExpanded(true);
	assert.match(plain(imageRow), /├─ image/);
	assert.doesNotMatch(plain(imageRow), /iVBOR/);
	checkWidths(imageRow);
	imageRow.setExpanded(false);
	checkWidths(imageRow);
	assert.equal(JSON.stringify(imageResult), imageSnapshot);
	assert.equal(imageResult.content.find((part) => part.type === "image"), image);
	console.log("PASS: stable theme proxy refreshes Read/Write caches; native image contents survive rendering unchanged");

	const applyOptions = async (renderShell, tailPreview = "off") => {
		await writeFile(join(root, ".pi", "settings.json"), JSON.stringify({ compactToolUi: {
			renderShell, bash: { tailPreview, previewLines: 100 }, edit: { inlineDiffMaxLines: -1 },
		} }));
		for (const handler of extension.handlers.get("session_start") ?? []) {
			await handler({ type: "session_start", reason: "reload" }, {
				cwd: root, hasUI: false, isProjectTrusted: () => true, ui: { notify() {} },
			});
		}
		for (const renderer of Object.values(renderers)) assert.equal(renderer.renderShell, "self", "native mount must stay stable");
	};
	// Keep exactly these instances mounted through every switch, including separate call/result slots.
	for (const expanded of [false, true]) {
		for (const pad of [0, 1, 2]) {
			await applyOptions("self");
			const expected = new Map();
			const baseline = new Map();
			for (const [name, row] of Object.entries(rows)) {
				row.setOutputPad(pad);
				row.setExpanded(expanded);
				row.invalidate();
				checkWidths(row);
				baseline.set(row, widths.map((width) => plainLines(row, width)));
				for (const width of widths) {
					// Self mode already applies the same outputPad inset; the default shell only adds
					// the Box's vertical margins and right-fills each line to the terminal width.
					const inner = row.render(width).slice(1).map((line) => {
						const text = strip(line);
						return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
					});
					expected.set(name + ":" + width, ["", " ".repeat(width), ...inner, " ".repeat(width)]);
				}
			}
			await applyOptions("default");
			for (const [name, row] of Object.entries(rows)) {
				row.invalidate();
				checkWidths(row);
				assertSingleHeader(name, row);
				for (const width of widths) {
					assert.deepEqual(plainLines(row, width), expected.get(name + ":" + width),
						name + " must have exactly one Box's top/bottom and horizontal padding " + pad);
				}
				if (expanded) {
					const section = name === "bash" ? "command" : name === "edit" ? "diff" : "content";
					assert.equal((plain(row).match(new RegExp("├─ " + section, "g")) ?? []).length, 1);
				} else assert.doesNotMatch(plain(row), /├─ |展开内容|FINAL_AUTHORITATIVE/);
			}
			await applyOptions("self");
			for (const [name, row] of Object.entries(rows)) {
				row.invalidate();
				assert.deepEqual(widths.map((width) => plainLines(row, width)), baseline.get(row), name + " must recover on the same row");
				row.setExpanded(!expanded);
				row.setExpanded(false);
				checkWidths(row);
				assert.doesNotMatch(plain(row), /├─ |展开内容|FINAL_AUTHORITATIVE/);
			}
		}
	}
	assert.equal(writeArgs.content, code);
	console.log("PASS: existing rows survive self/default/self with one Box at pads 0/1/2");

	// Reproduce the real 80x24 fullscreen layout entirely in memory: no ProcessTerminal,
	// GUI, ANSI stdout, or Bash execution is involved in this rendering regression.
	await applyOptions("self", "all"); // Legacy all/100 remains inert after a trusted hot load.
	for (const isError of [false, true]) {
		const writes = [];
		const terminal = {
			columns: 80, rows: 24, kittyProtocolActive: false,
			start() {}, stop() {}, async drainInput() {},
			write(data) { writes.push(data); },
			moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {},
			clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {}, setProgramStatus() {},
		};
		const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
		const document = new Container();
		document.addChild(new Text(Array.from({ length: 60 }, (_, index) => "history " + (index + 1)).join("\n"), 0, 0));
		const row = new ToolExecutionComponent("bash", "fullscreen-" + isError,
			freeze({ command: "fixture-only command; never executed" }),
			{ showImages: false, outputPad: 0 }, renderers.bash, tui, root);
		row.setArgsComplete();
		document.addChild(row);
		const viewport = createChatViewport({
			document, pendingMessages: new Container(), status: new Text("fixed status", 0, 0),
			editor: new Text("fixed editor 1\nfixed editor 2\nfixed editor 3", 0, 0),
			footer: new Text("fixed footer", 0, 0),
		});
		tui.setLayoutRoot(viewport.root);
		tui.start();
		try {
			tui.renderNow();
			assert.equal(viewport.transcript.viewportHeight, 19, "native fixed dock leaves a 19-row transcript");
			assert.equal(row.render(80).length, 2, "pending row is native Spacer plus one header");
			const top = tui.viewportTop;
			assert.equal(top, 60 + 2 - 19);
			assert.equal(tui.isFollowingOutput, true);
			const redraws = tui.fullRedrawCount;
			assert.equal(redraws, 1);
			let previous = tui.getScreenLines();
			assert.equal(previous.length, 24);
			assert.match(previous.map(strip).join("\n"), /history 44/);
			const dock = previous.slice(19);
			const checkFrame = (label, update) => {
				writes.length = 0;
				update();
				tui.renderNow();
				const screen = tui.getScreenLines();
				assert.equal(row.render(80).length, 2, label + ": collapsed height must never grow");
				if (row.resultRendererComponent) assert.deepEqual(row.resultRendererComponent.render(80), []);
				assert.equal(tui.viewportTop, top, label + ": historical transcript must not shift");
				assert.equal(viewport.transcript.viewportHeight, 19);
				assert.deepEqual(screen.slice(19), dock, label + ": dock is fixed");
				assert.equal(tui.fullRedrawCount, redraws);
				assert.equal(screen.length, 24);
				const changed = screen.flatMap((line, index) => line !== previous[index] ? [index] : []);
				assert.ok(changed.length <= 1, label + ": changed rows " + changed.join(","));
				assert.ok(changed.every((index) => index === 18), label + ": only the header may change");
				const ansi = writes.join("");
				assert.doesNotMatch(ansi, /\x1b\[(?:[0123])?J/, label + ": no full clear after the initial frame");
				const written = [...ansi.matchAll(/\x1b\[(\d+);1H\x1b\[2K/g)].map((match) => Number(match[1]));
				assert.ok(written.length <= 1, label + ": wrote " + written.length + " rows");
				assert.deepEqual(written, changed.map((index) => index + 1), label + ": physical writes match screen diffs");
				previous = screen;
			};
			checkFrame("start without output", () => row.markExecutionStarted());
			const many = Array.from({ length: 100 }, (_, index) => "output-only-" + (index + 1)).join("\n");
			for (const [label, text] of [
				["empty partial", ""], ["short partial", "short output"],
				["many logical lines", many], ["very long logical line", "wrapped-only-".repeat(2000)],
				["many long logical lines", Array.from({ length: 40 }, () => "long-only-".repeat(500)).join("\n")],
			]) {
				const result = freeze(textResult(text));
				const snapshot = JSON.stringify(result);
				checkFrame(label, () => row.updateResult(result, true));
				assert.equal(JSON.stringify(result), snapshot);
			}
			const final = freeze(textResult(many + (isError ? "\nCommand exited with code 7\n" : "\n"), { isError, durationMs: 3400 }));
			const snapshot = JSON.stringify(final);
			checkFrame(isError ? "final failure" : "final success", () => row.updateResult(final));
			assert.equal(row.rendererState.compactStatus, isError ? "failed" : "success");
			assert.match(plain(row), isError ? /exit 7/ : /100L/);
			assert.match(plain(row), /3\.4s/);
			row.setExpanded(true);
			const expanded = plain(row);
			assert.match(expanded, /├─ command/);
			assert.equal(plainLines(row).filter((line) => /^  │ output-only-\d+$/.test(line)).length, 100,
				"manual expansion keeps the complete settled output for either outcome");
			assert.doesNotMatch(expanded, /Command exited with code 7/, "native error trailer is header metadata, not output");
			assert.equal(JSON.stringify(final), snapshot);
		} finally {
			tui.stop({ preserveScreen: true });
		}
	}
	// A user's expanded streaming row must not be forced closed by subsequent updates or settlement.
	for (const isError of [false, true]) {
		const row = makeRow("bash", { command: "expanded fixture; never executed" });
		row.markExecutionStarted();
		row.setExpanded(true);
		for (const text of [
			Array.from({ length: 80 }, (_, index) => "manual-" + (index + 1)).join("\n"),
			"wrapped-only-".repeat(2000),
		]) {
			row.updateResult(freeze(textResult(text)), true);
			const lines = plainLines(row, 80);
			assert.match(lines.join("\n"), /├─ command/);
			assert.match(lines.join("\n"), /streaming/);
			const start = lines.findIndex((line) => line.includes("├─ output"));
			const end = lines.findIndex((line) => line.includes("╰─"));
			assert.equal(end - start - 1, 28, "streaming output is capped at 28 visual rows, even for one very long logical line");
			checkWidths(row);
		}
		const complete = Array.from({ length: 80 }, (_, index) => "manual-" + (index + 1)).join("\n");
		row.updateResult(freeze(textResult(complete, { isError })));
		assert.match(plain(row), /├─ command/);
		assert.equal(plainLines(row).filter((line) => /^  │ manual-\d+$/.test(line)).length, 80);
		assert.doesNotMatch(plain(row), /streaming|tail 28/);
		row.setExpanded(false);
		assert.equal(row.render(80).length, 2);
	}
	console.log("PASS: native 80x24 fullscreen keeps collapsed Bash at 2 rows, viewport fixed, <=1 changed/written row; manual expansion survives streaming and settlement");

	// Cached content must still refresh with real host keybindings and a stable theme proxy.
	const previousBindings = getKeybindings();
	const bindings = new KeybindingsManager({ "app.tools.expand": { defaultKeys: "ctrl+o" } });
	setKeybindings(bindings);
	try {
		const nativeTheme = theme;
		const cachedRow = makeRow("bash", { command: "cached command; never executed" }, textResult("cache-alpha\ncache-beta"));
		cachedRow.setExpanded(true);
		assert.match(plain(cachedRow), /ctrl\+o collapse/);
		const cache = cachedRow.rendererState.expandedContentCache;
		const view = cache.view.component;
		const output = cache.output.component;
		bindings.setUserBindings({ "app.tools.expand": "ctrl+g" });
		cachedRow.invalidate();
		assert.match(plain(cachedRow), /ctrl\+g collapse/);
		assert.notEqual(cache.view.component, view, "keybinding changes must replace the footer view");
		assert.equal(cache.output.component, output, "keybinding changes must not discard output layout");
		initTheme("dark", false);
		cachedRow.invalidate();
		const recolored = cachedRow.rendererState.expandedContentCache;
		assert.equal(theme, nativeTheme);
		assert.notEqual(recolored, cache, "actual palette replacement must refresh cached content");
		assert.notEqual(recolored.command, cache.command);
		assert.notEqual(recolored.output.component, output);
		checkWidths(cachedRow);
	} finally {
		setKeybindings(previousBindings);
	}

	// Observe actual requestRender callbacks, not private timer maps or patched clocks.
	await applyOptions("self");
	const requests = [0, 0, 0];
	const timerRows = requests.map((_, index) => new ToolExecutionComponent("bash", "timer-" + index,
		{ command: "printf timer" }, { showImages: false }, renderers.bash,
		{ requestRender() { requests[index]++; } }, root));
	for (const row of timerRows) row.markExecutionStarted();
	timerRows[0].setExpanded(true);
	timerRows[0].updateResult(textResult("unchanged runtime output\nsecond line"), true);
	timerRows[0].render(80);
	const timedCache = timerRows[0].rendererState.expandedContentCache;
	const timedView = timedCache.view.component;
	const timedCommandLayout = timedCache.command.render(76);
	const timedOutputLayout = timedCache.output.component.render(76);
	const beforeTick = [...requests];
	await sleep(1150);
	for (let index = 0; index < requests.length; index++) assert.ok(requests[index] > beforeTick[index], "rendered running timer must refresh");
	assert.equal(timerRows[0].rendererState.expandedContentCache, timedCache);
	assert.equal(timedCache.view.component, timedView, "an actual elapsed tick must reuse the expanded view");
	assert.equal(timedCache.command.render(76), timedCommandLayout);
	assert.equal(timedCache.output.component.render(76), timedOutputLayout);
	assert.match(plain(timerRows[0]), /\b\d+\.\ds\b/, "the elapsed header must not freeze with its cached body");
	timerRows[0].updateResult(textResult("done", { durationMs: 3400 }));
	timerRows[1].updateResult(textResult("failed", { isError: true }));
	const settledCounts = requests.slice(0, 2);
	await sleep(1150);
	assert.deepEqual(requests.slice(0, 2), settledCounts, "final/error results must stop refreshes");
	await shutdown();
	const shutdownCounts = [...requests];
	await sleep(1150);
	assert.deepEqual(requests, shutdownCounts, "shutdown must stop the remaining live refresh");
	assert.match(plain(timerRows[0]), /3\.4s/);
	await shutdown(); // cleanup must be idempotent
	assert.deepEqual([...extension.tools.keys()], []);
	assert.deepEqual(session.getActiveToolNames(), []);
	session.dispose();
	sessions.pop();
	await writeFile(globalSettingsPath, JSON.stringify({ ...globalSettings, defaultTools: ["read"] }));
	await settings.reload();
	const { session: readOnlySession } = await createAgentSession({
		cwd: root, agentDir, settingsManager: settings, resourceLoader,
		sessionManager: SessionManager.inMemory(root),
	});
	sessions.push(readOnlySession);
	assert.deepEqual(readOnlySession.getActiveToolNames(), ["read"], "renderer-only loading must not deactivate a selected native tool");
	assert.deepEqual(readOnlySession.getCallableToolNames(), ["read"]);
	console.log("PASS: Bash final/error/shutdown clean up live refreshes and read-only default loadout remains intact");

	const tabArgs = freeze({ command: "printf\t'你好 👋\\tTAIL_MARKER\\n'", timeout: 5 });
	const tabResult = freeze(await execute("bash", tabArgs));
	const tabRow = makeRow("bash", tabArgs, tabResult);
	const argsSnapshot = JSON.stringify(tabArgs);
	const resultSnapshot = JSON.stringify(tabResult);
	for (const shell of ["default", "self"]) {
		await applyOptions(shell, "all");
		tabRow.invalidate();
		tabRow.setExpanded(false);
		assert.match(plain(tabRow), /TAIL_MARKER/, "short stdout can still contribute to header summary");
		assert.equal(plainLines(tabRow).length, shell === "default" ? 4 : 2);
		assert.deepEqual(tabRow.resultRendererComponent.render(80).map(strip), shell === "default" ? [" ".repeat(80)] : []);
		assert.doesNotMatch(plain(tabRow), /│ |├─ |╰─/);
		checkWidths(tabRow);
		tabRow.setExpanded(true);
		assert.match(plain(tabRow), /├─ command/);
		checkWidths(tabRow);
	}
	assert.ok(tabArgs.command.includes("\t"), "the source command fixture must contain a literal tab");
	assert.equal(JSON.stringify(tabArgs), argsSnapshot, "display normalization must not rewrite arguments");
	assert.equal(JSON.stringify(tabResult), resultSnapshot, "display normalization must not rewrite stdout");
	console.log("PASS: tabs normalize only in display; legacy all/100 cannot enable collapsed output after self/default hot loads");
	console.log("native Pi original-tool runtime checks passed");
} finally {
	await shutdown();
	for (const session of sessions) session.dispose();
}
`;

test("Original tools preserve native SDK execution and render correctly with the real Pi runtime", { timeout: 90000 }, () => {
	const cwd = fileURLToPath(new URL("../", import.meta.url));
	const entry = fileURLToPath(new URL("../index.ts", import.meta.url));
	const root = mkdtempSync(join(tmpdir(), "compact-tools-runtime-"));
	try {
		const result = spawnSync(process.execPath, ["--input-type=module", "--eval", runtimeCheck, entry, root], {
			cwd,
			env: { ...process.env, JITI_FS_CACHE: "false", PI_CODING_AGENT_DIR: join(root, "agent"), PI_OFFLINE: "1" },
			encoding: "utf8",
			timeout: 60000,
			maxBuffer: 1024 * 1024,
		});
		assert.ifError(result.error);
		assert.equal(result.status, 0, result.stdout + result.stderr);
		assert.match(result.stdout, /native Pi original-tool runtime checks passed/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
