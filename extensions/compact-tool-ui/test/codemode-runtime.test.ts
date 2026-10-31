import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Run outside the unit-test stub loader: use Pi's actual extension loader, theme and tool component.
const runtimeCheck = String.raw`
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { discoverAndLoadExtensions, highlightCode, initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { theme } from "./node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";

const root = await mkdtemp(join(tmpdir(), "compact-codemode-runtime-"));
const agentDir = join(root, "agent");
process.env.PI_CODING_AGENT_DIR = agentDir;
await mkdir(agentDir);
try {
	initTheme("dark", false);
	const loaded = await discoverAndLoadExtensions([process.argv[1]], root, agentDir);
	assert.deepEqual(loaded.errors, []);
	assert.equal(loaded.extensions.length, 1);
	const extension = loaded.extensions[0];
	assert.deepEqual([...extension.tools.keys()], []);
	assert.equal(extension.toolRenderers.length, 5);
	const resolver = (name, fallback) => {
		const next = (index) => index === extension.toolRenderers.length ? fallback() : extension.toolRenderers[index](name, () => next(index + 1));
		return next(0);
	};
	const sentinel = {};
	assert.equal(resolver("unrelated", () => sentinel), sentinel);
	const renderer = resolver("codemode", () => assert.fail("must not use the native renderer"));
	assert.deepEqual(Object.keys(renderer).sort(), ["renderCall", "renderResult", "renderShell"]);
	assert.equal(renderer.renderShell, "self");

	const code = 'const message = "你好 👋";\ntext(message);';
	const args = { code };
	const component = new ToolExecutionComponent("codemode", "native-codemode", args,
		{ showImages: false, outputPad: 0 }, renderer, { requestRender() {} }, root);
	component.setArgsComplete();
	component.markExecutionStarted();
	const plain = (row, width = 120) => stripVTControlCharacters(row.render(width).join("\n"));
	const checkWidths = (row, collapsed = false) => {
		for (const width of [48, 64, 80, 120]) {
			const lines = row.render(width);
			for (const line of lines) assert.ok(visibleWidth(line) <= width, "overflow at width " + width);
			if (collapsed) assert.equal(lines.filter((line) => stripVTControlCharacters(line).trim()).length, 1);
		}
	};
	component.updateResult({ content: [], details: { calls: [
		{ id: "native-codemode/1", name: "read", args: '{"path":"目录/文件.ts"}', status: "ok", durationMs: 5 },
		{ id: "native-codemode/2", name: "bash", args: '{"command":"npm run check"}', status: "running" },
	] } }, true);
	assert.match(plain(component), /1 done.*1 running/);
	checkWidths(component, true);

	const image = Object.freeze({ type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9S8AAAAASUVORK5CYII=" });
	const result = Object.freeze({
		content: Object.freeze([
			Object.freeze({ type: "text", text: "Script completed\nWall time 1.2 seconds\nOutput:\n" }),
			Object.freeze({ type: "text", text: "结果 🌍 ".repeat(60) }), image,
		]),
		details: Object.freeze({ calls: Object.freeze([
			Object.freeze({ id: "native-codemode/1", name: "read", args: '{"path":"目录/文件.ts"}', status: "error", durationMs: 5, error: "被捕获的错误\n".repeat(6) }),
			Object.freeze({ id: "native-codemode/2", name: "bash", args: '{"command":"npm run check"}', status: "ok", durationMs: 1200 }),
			Object.freeze({ id: "native-codemode/3", name: "models.classify", args: "test/classifier", status: "ok", durationMs: 7, cost: 0.0012 }),
		]), fullOutputPath: join(root, "完整输出.txt") }),
		durationMs: 2400, isError: false,
	});
	component.updateResult(result);
	assert.match(plain(component), /done.*1 failed/);
	assert.match(plain(component), /2\.4s/);
	assert.doesNotMatch(plain(component), /const message|结果|Wall time|running/);
	checkWidths(component, true);
	component.setExpanded(true);
	checkWidths(component);
	const expanded = plain(component);
	for (const section of ["calls", "code", "output", "images", "full output"]) assert.ok(expanded.includes("├─ " + section));
	assert.match(expanded, /目录\/文件.ts/);
	assert.match(expanded, /被捕获的错误/);
	assert.match(expanded, /完整输出.txt/);
	assert.match(expanded, /\$0\.0012/);
	assert.doesNotMatch(expanded, /Script completed|Wall time|iVBOR/);
	assert.equal(result.content[2], image);

	const darkCode = highlightCode(code, "javascript")[0];
	assert.ok(component.render(120).some((line) => line.includes(darkCode)));
	const stableThemeProxy = theme;
	initTheme("light", false);
	assert.equal(theme, stableThemeProxy);
	component.invalidate();
	const lightCode = highlightCode(code, "javascript")[0];
	assert.notEqual(darkCode, lightCode);
	assert.ok(component.render(120).some((line) => line.includes(lightCode)), "theme invalidation must refresh the cached highlighted source");
	checkWidths(component);
	component.setExpanded(false);
	assert.match(plain(component), /done.*1 failed/);
	checkWidths(component, true);

	// Replay a saved result into a fresh native component without a live execution or wall-clock timer.
	const replay = new ToolExecutionComponent("codemode", "replayed-codemode", args,
		{ showImages: false, outputPad: 0 }, renderer, { requestRender() {} }, root);
	replay.updateResult(result);
	assert.match(plain(replay), /done.*1 failed/);
	assert.match(plain(replay), /2\.4s/);
	checkWidths(replay, true);

	await mkdir(join(root, ".pi"));
	await writeFile(join(root, ".pi", "settings.json"), JSON.stringify({ compactToolUi: { renderShell: "default" } }));
	await extension.handlers.get("session_start")[0]({ type: "session_start" }, {
		cwd: root, hasUI: false, isProjectTrusted: () => true, ui: { notify() {} },
	});
	assert.equal(renderer.renderShell, "self", "native shell stays mounted while our layout hot-updates");
	component.invalidate();
	checkWidths(component, true);
	component.setExpanded(true);
	checkWidths(component);
	assert.match(plain(component), /├─ code/);
	component.setExpanded(false);
	assert.doesNotMatch(plain(component), /├─ code|结果/);
	const boxed = new ToolExecutionComponent("codemode", "boxed-codemode", args,
		{ showImages: false, outputPad: 1 }, renderer, { requestRender() {} }, root);
	boxed.updateResult(result);
	checkWidths(boxed, true);
	boxed.setExpanded(true);
	checkWidths(boxed);
	assert.match(plain(boxed), /├─ calls/);
	assert.equal((plain(boxed).match(/├─ code/g) ?? []).length, 1, "framing must not duplicate the details");
	await writeFile(join(root, ".pi", "settings.json"), JSON.stringify({ compactToolUi: { renderShell: "self" } }));
	await extension.handlers.get("session_start")[0]({ type: "session_start" }, {
		cwd: root, hasUI: false, isProjectTrusted: () => true, ui: { notify() {} },
	});
	boxed.invalidate();
	checkWidths(boxed);
	assert.match(plain(boxed), /├─ code/);
	boxed.setExpanded(false);
	checkWidths(boxed, true);
	assert.doesNotMatch(plain(boxed), /├─ code|结果/);
	console.log("native Pi codemode checks passed");
} finally {
	await rm(root, { recursive: true, force: true });
}
`;

test("Codemode loads and renders correctly with the real Pi runtime", { timeout: 90000 }, () => {
	const cwd = fileURLToPath(new URL("../", import.meta.url));
	const entry = fileURLToPath(new URL("../index.ts", import.meta.url));
	const result = spawnSync(process.execPath, ["--input-type=module", "--eval", runtimeCheck, entry], {
		cwd,
		encoding: "utf8",
		timeout: 60000,
		maxBuffer: 1024 * 1024,
	});
	assert.ifError(result.error);
	assert.equal(result.status, 0, result.stdout + result.stderr);
	assert.match(result.stdout, /native Pi codemode checks passed/);
});
