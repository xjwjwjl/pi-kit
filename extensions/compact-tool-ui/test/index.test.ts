import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import compactToolUiExtension from "../index.js";
import type { RendererResolver } from "./renderer-fixture.js";

const theme = {
	fg(_token: string, text: string) { return text; },
	bg(_token: string, text: string) { return text; },
	bold(text: string) { return text; },
};
const TOOL_NAMES = ["bash", "read", "write", "edit", "codemode"];

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
let agentDir: string;
test.before(async () => {
	agentDir = await mkdtemp(path.join(os.tmpdir(), "compact-tool-ui-global-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ compactToolUi: { renderShell: "self", bash: { tailPreview: "all", previewLines: 100 } } }));
});
test.after(async () => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	await rm(agentDir, { recursive: true, force: true });
});

function renderText(component: { render: (width: number) => string[] } | undefined, width = 200): string {
	return component ? component.render(width).join("\n") : "";
}

function createPiStub() {
	const commands = new Map<string, any>();
	const handlers = new Map<string, any[]>();
	const toolRegistrations: any[] = [];
	const rendererResolvers: RendererResolver[] = [];
	return {
		api: {
			registerTool(definition: any) { toolRegistrations.push(definition); },
			registerToolRenderer(resolver: RendererResolver) { rendererResolvers.push(resolver); },
			registerCommand(name: string, command: any) { commands.set(name, command); },
			on(event: string, handler: any) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
		},
		commands, handlers, toolRegistrations, rendererResolvers,
		resolve(name: string, downstream: any = undefined) {
			const walk = (index: number): any => index < rendererResolvers.length
				? rendererResolvers[index]!(name, () => walk(index + 1)) : downstream;
			return walk(0);
		},
	};
}

function callContext(args: any, toolCallId: string) {
	return {
		args, argsComplete: true, cwd: process.cwd(), executionStarted: false,
		expanded: false, invalidate() {}, isError: false, isPartial: false,
		lastComponent: undefined, showImages: false, state: {}, toolCallId,
		// The host always passes its outputPad (1 by default); self mode now insets by it.
		outputPad: 1,
	};
}

function createExistingRows(stub: ReturnType<typeof createPiStub>) {
	return TOOL_NAMES.map((name) => {
		const renderer = stub.resolve(name);
		const args = { command: "echo hi", path: "src/a.ts", content: "hello", code: 'text("hi")' };
		const context = callContext(args, `project-${name}`);
		return { name, renderer, context, call: renderer.renderCall(args, theme, context) };
	});
}

test("extension registers five renderer-only resolvers and no tool definitions while loading", async () => {
	const stub = createPiStub();
	await compactToolUiExtension(stub.api as any);
	assert.equal(stub.toolRegistrations.length, 0);
	assert.equal(stub.rendererResolvers.length, 5);
	for (const name of TOOL_NAMES) {
		const renderer = stub.resolve(name);
		assert.ok(renderer, `${name} has a renderer at load time`);
		assert.deepEqual(Object.keys(renderer).sort(), ["renderCall", "renderResult", "renderShell"]);
		assert.equal(renderer.renderShell, "self");
		assert.equal(Object.getOwnPropertyDescriptor(renderer, "renderShell")?.get, undefined);
	}
	const matchedNames: string[] = [];
	for (const resolver of stub.rendererResolvers) {
		const matches: string[] = [];
		for (const name of TOOL_NAMES) {
			const downstream = { sentinel: name };
			if (resolver(name, () => downstream) !== downstream) matches.push(name);
		}
		assert.equal(matches.length, 1, "each resolver overrides exactly one of the five tools");
		matchedNames.push(matches[0]!);
		for (const name of ["unregistered", "mcp__server__tool", "codemode-other", ...TOOL_NAMES.filter((name) => name !== matches[0])]) {
			const downstream = { sentinel: name };
			let calls = 0;
			assert.equal(resolver(name, () => { calls++; return downstream; }), downstream);
			assert.equal(calls, 1, "unmatched names delegate exactly once");
			assert.equal(resolver(name, () => undefined), undefined);
		}
	}
	assert.deepEqual(matchedNames.sort(), [...TOOL_NAMES].sort());
	assert.equal(stub.handlers.get("session_start")?.length ?? 0, 1);
	assert.ok(stub.commands.get("compact-tool-ui-settings"), "settings command is registered on load");
});

async function withTempProject(fn: (cwd: string) => Promise<void>) {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "compact-tool-ui-project-"));
	try {
		await mkdir(path.join(cwd, ".pi"), { recursive: true });
		await writeFile(path.join(cwd, ".pi", "settings.json"), JSON.stringify({ compactToolUi: { renderShell: "default", bash: { tailPreview: "all", previewLines: 100 } } }));
		await fn(cwd);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
}

function sessionContext(cwd: string, projectTrusted: boolean) {
	return { cwd, hasUI: false, isProjectTrusted: () => projectTrusted, ui: { notify() {} } };
}

test("trusted session_start hot-updates layouts without reviving legacy Bash previews or re-registering tools", async () => {
	const stub = createPiStub();
	await compactToolUiExtension(stub.api as any);
	const rows = createExistingRows(stub);
	const before = rows.map(({ call }) => call.render(80));
	await withTempProject(async (cwd) => {
		await stub.handlers.get("session_start")![0]({ type: "session_start" }, sessionContext(cwd, true));
		for (const { name, renderer, context, call } of rows) {
			assert.equal(renderer.renderShell, "self", `${name}: host shell stays fixed`);
			const lines = call.render(80);
			assert.equal(lines[0], " ".repeat(80), `${name}: existing row gains top padding`);
			assert.equal(lines.at(-1), " ".repeat(80), `${name}: existing row gains bottom padding`);
			assert.match(lines[1], /^ [A-Z]/);
			const result = renderer.renderResult({ content: [{ type: "text", text: "alpha\nbeta\n" }], details: { calls: [] } },
				{ expanded: false, isPartial: false }, theme, { ...context, executionStarted: true });
			if (name === "bash") {
				assert.deepEqual(result.render(80), [" ".repeat(80)], "legacy preview options add only the default-shell bottom margin");
				assert.equal([...call.render(80), ...result.render(80)].length, 3);
			}
		}
		assert.equal(stub.rendererResolvers.length, 5, "session refresh does not register more resolvers");
		assert.equal(stub.toolRegistrations.length, 0);
		assert.ok(before.every((lines) => lines.length === 1), "initial rows use the compact self layout");
	});
});

test("extension ignores project layout and options while the folder is untrusted", async () => {
	const stub = createPiStub();
	await compactToolUiExtension(stub.api as any);
	const rows = createExistingRows(stub);
	const before = rows.map(({ call }) => call.render(80));
	await withTempProject(async (cwd) => {
		await stub.handlers.get("session_start")![0]({ type: "session_start" }, sessionContext(cwd, false));
		rows.forEach(({ name, renderer, context, call }, index) => {
			assert.equal(renderer.renderShell, "self");
			assert.deepEqual(call.render(80), before[index]);
			if (name === "bash") {
				const result = renderer.renderResult({ content: [{ type: "text", text: "alpha\nbeta\n" }], details: undefined },
					{ expanded: false, isPartial: false }, theme, context);
				assert.equal(renderText(result), "", "untrusted project cannot enable tailPreview");
			}
		});
	});
});

test("legacy Bash settings never enable collapsed output before or after repeated trusted hot loads", async () => {
	const stub = createPiStub();
	await compactToolUiExtension(stub.api as any);
	const renderer = stub.resolve("bash");
	const args = { command: "fixture-only command" };
	const context = callContext(args, "legacy-hot-load");
	const call = renderer.renderCall(args, theme, context);
	const check = (shell: "self" | "default") => {
		for (const [isPartial, isError, text] of [
			[true, false, ""], [true, false, "alpha\nbeta\n"],
			[true, false, "long".repeat(5000)], [false, false, "complete\n"],
			[true, true, "partial failure"], [false, true, "diagnostic\nCommand exited with code 7\n"],
		] as const) {
			const result = renderer.renderResult({ content: [{ type: "text", text }], details: undefined },
				{ expanded: false, isPartial }, theme, { ...context, isPartial, isError });
			assert.deepEqual(result.render(80), shell === "self" ? [] : [" ".repeat(80)]);
			assert.equal([...call.render(80), ...result.render(80)].length, shell === "self" ? 1 : 3);
		}
	};
	check("self"); // Global legacy all/100 must already be inert at extension load.
	await withTempProject(async (cwd) => {
		for (const tailPreview of ["all", "running", "failed", "off"]) {
			for (const renderShell of ["default", "self"] as const) {
				await writeFile(path.join(cwd, ".pi", "settings.json"), JSON.stringify({ compactToolUi: {
					renderShell, bash: { tailPreview, previewLines: 100 },
				} }));
				await stub.handlers.get("session_start")![0]({ type: "session_start" }, sessionContext(cwd, true));
				check(renderShell);
			}
		}
	});
	assert.equal(stub.rendererResolvers.length, 5);
	assert.equal(stub.toolRegistrations.length, 0);
});

test("extension exposes all compact renderers immediately after loading", async () => {
	const stub = createPiStub();
	await compactToolUiExtension(stub.api as any);
	for (const name of TOOL_NAMES) assert.ok(stub.resolve(name));
	const compactBash = stub.resolve("bash");
	assert.equal(compactBash.renderShell, "self");
	const args = { command: "echo hi" };
	const rendered = compactBash.renderCall(args, theme, callContext(args, "bash-compact-load"));
	assert.match(renderText(rendered), /^ Bash echo hi/, "self mode applies the host outputPad");
	assert.equal(stub.toolRegistrations.length, 0);
	assert.equal(stub.rendererResolvers.length, 5);
});

test("settings command does not open custom TUI outside TUI mode", async () => {
	const stub = createPiStub();
	await compactToolUiExtension(stub.api as any);
	const command = stub.commands.get("compact-tool-ui-settings");
	assert.ok(command);
	await command.handler("", {
		hasUI: true, mode: "rpc",
		ui: { custom() { throw new Error("custom UI should not open outside TUI mode"); } },
	});
});

test("a newly invalid project layer drops stale overrides, keeps global settings and reports its path", async () => {
	const stub = createPiStub();
	await compactToolUiExtension(stub.api as any);
	const rows = createExistingRows(stub);
	await withTempProject(async (cwd) => {
		const notices: string[] = [];
		const context = { ...sessionContext(cwd, true), hasUI: true, ui: { notify(message: string) { notices.push(message); } } };
		await stub.handlers.get("session_start")![0]({ type: "session_start" }, context);
		assert.ok(rows.every(({ call }) => call.render(80).length === 3));
		const projectPath = path.join(cwd, ".pi", "settings.json");
		const invalid = "{ broken project JSON";
		await writeFile(projectPath, invalid);
		await stub.handlers.get("session_start")![0]({ type: "session_start" }, context);
		assert.ok(rows.every(({ call }) => call.render(80).length === 1), "all five renderers must drop the invalid project's boxed layout");
		assert.equal(notices.length, 1);
		assert.match(notices[0]!, /Failed to load compact-tool-ui project settings/);
		assert.ok(notices[0]!.includes(projectPath));
		assert.equal(await readFile(projectPath, "utf8"), invalid);
		assert.equal(stub.toolRegistrations.length, 0);
		assert.equal(stub.rendererResolvers.length, 5);
	});
});

test("invalid global settings do not prevent a healthy trusted project from being applied", async () => {
	const globalPath = path.join(agentDir, "settings.json");
	const original = await readFile(globalPath, "utf8");
	const warnings: unknown[][] = [];
	const warn = console.warn;
	console.warn = (...args) => { warnings.push(args); };
	try {
		await writeFile(globalPath, "{ broken global JSON");
		const stub = createPiStub();
		await compactToolUiExtension(stub.api as any);
		const rows = createExistingRows(stub);
		assert.ok(rows.every(({ call }) => call.render(80).length === 1));
		assert.ok(warnings.some((entry) => String(entry[0]).includes(globalPath)));
		await withTempProject(async (cwd) => {
			const notices: string[] = [];
			const context = { ...sessionContext(cwd, true), hasUI: true, ui: { notify(message: string) { notices.push(message); } } };
			await stub.handlers.get("session_start")![0]({ type: "session_start" }, context);
			assert.ok(rows.every(({ call }) => call.render(80).length === 3));
			assert.equal(notices.length, 1);
			assert.match(notices[0]!, /Failed to load compact-tool-ui global settings/);
			assert.ok(notices[0]!.includes(globalPath));
			assert.equal(await readFile(globalPath, "utf8"), "{ broken global JSON");
		});
	} finally {
		console.warn = warn;
		await writeFile(globalPath, original);
	}
});
