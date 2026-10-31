import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const runtimeCheck = String.raw`
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stripVTControlCharacters as strip } from "node:util";
import { DefaultResourceLoader, initTheme, SettingsManager } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { theme } from "./node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
const [entry, root] = process.argv.slice(1);
process.chdir(root);
const agentDir = process.env.PI_CODING_AGENT_DIR;
await mkdir(agentDir, { recursive: true });
await mkdir(join(root, ".pi"));
const globalPath = join(agentDir, "settings.json");
const projectPath = join(root, ".pi", "settings.json");
await writeFile(globalPath, '\uFEFF' + JSON.stringify({ defaultTools: [], compactToolUi: { renderShell: "self" } }));
const broken = "{ broken project JSON";
await writeFile(projectPath, broken);
const settings = SettingsManager.create(root, agentDir, { projectTrusted: false });
const loader = new DefaultResourceLoader({
	cwd: root, agentDir, settingsManager: settings, additionalExtensionPaths: [entry],
	noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
});
await loader.reload();
assert.deepEqual(loader.getExtensions().errors, []);
const extension = loader.getExtensions().extensions[0];
const command = extension.commands.get("compact-tool-ui-settings");
assert.ok(command);
initTheme("dark", false);
let panel;
const notices = [];
let saved;
const completed = new Promise((resolve) => { saved = resolve; });
const ctx = {
	mode: "tui", hasUI: true, cwd: root, isProjectTrusted: () => true,
	ui: {
		custom(callback) { panel = callback({ requestRender() {} }, theme, {}, () => {}); return Promise.resolve(); },
		notify(message) { notices.push(message); if (message.startsWith("Saved ")) saved(); },
	},
};
const resolve = (name, index = 0) => index === extension.toolRenderers.length ? undefined
	: extension.toolRenderers[index](name, () => resolve(name, index + 1));
const args = { command: "not executed" };
const context = { state: {}, args, argsComplete: true, cwd: root, expanded: false, executionStarted: false,
	isPartial: false, isError: false, showImages: false, invalidate() {}, outputPad: 1 };
const row = resolve("bash").renderCall(args, theme, context);
assert.equal(row.render(80).length, 1);
const plain = () => {
	const lines = panel.render(80);
	assert.ok(lines.every((line) => visibleWidth(line) <= 80), "real settings components must honor terminal width");
	return lines.map(strip).join(" ").replace(/\s+/g, " ");
};
await command.handler("", ctx);
assert.ok(notices[0].includes(projectPath));
assert.match(plain(), /Compact Tool UI Settings/);
panel.handleInput("\x1b[B"); // Scope -> renderShell.
assert.match(plain(), /Effective: self \(source: global\)/);
panel.handleInput("\x1b[C"); // self -> default.
assert.match(plain(), /pending save/);
assert.equal(row.render(80).length, 1, "a pending edit cannot change an existing tool row");
await completed;
assert.equal(JSON.parse(await readFile(globalPath, "utf8")).compactToolUi.renderShell, "default");
assert.equal(row.render(80).length, 3, "the real settings command must hot-apply to a mounted row");
assert.match(plain(), /Effective: default \(source: global\)/);
assert.doesNotMatch(plain(), /pending save/);
panel.handleInput("\t");
assert.match(plain(), /unavailable/);
for (const key of ["\x1b[C", "\x1b[D", "\r", " ", "\x7f", "\x1b[3~"]) panel.handleInput(key);
assert.equal(await readFile(projectPath, "utf8"), broken);
assert.equal(notices.filter((message) => message.startsWith("Saved ")).length, 1);
await writeFile(projectPath, JSON.stringify({ compactToolUi: { renderShell: "self" } }));
await command.handler("", ctx);
panel.handleInput("\x1b[B");
assert.match(plain(), /Effective: self \(source: project\)/);
assert.match(plain(), /overridden by project/);
assert.equal(row.render(80).length, 1, "reopening after repair must apply the newly readable layer");
assert.equal(extension.tools.size, 0);
console.log("PASS: real loader, native settings widgets, BOM, bad-layer keyboard guards, source hints and mounted-row hot application");
`;

test("settings command works with real Pi widgets and mounted rows, without execution overrides", () => {
	const root = mkdtempSync(join(tmpdir(), "compact-settings-panel-runtime-"));
	try {
		const result = spawnSync(process.execPath, ["--input-type=module", "--eval", runtimeCheck,
			fileURLToPath(new URL("../index.ts", import.meta.url)), root], {
			cwd: fileURLToPath(new URL("..", import.meta.url)),
			env: { ...process.env, PI_CODING_AGENT_DIR: join(root, "agent"), PI_OFFLINE: "1", JITI_FS_CACHE: "false" },
			encoding: "utf8", timeout: 30000,
		});
		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${result.error ?? ""}`);
		assert.match(result.stdout, /PASS: real loader/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
