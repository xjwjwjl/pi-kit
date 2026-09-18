import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import compactToolUiExtension from "../index.js";

const theme = {
	fg(_token: string, text: string) {
		return text;
	},
	bold(text: string) {
		return text;
	},
};

function renderText(component: { render: (width: number) => string[] } | undefined, width = 200): string {
	return component ? component.render(width).join("\n") : "";
}

function createPiStub() {
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const handlers = new Map<string, any[]>();
	const toolRegistrations: any[] = [];
	return {
		api: {
			registerTool(definition: any) {
				toolRegistrations.push(definition);
				tools.set(definition.name, definition);
			},
			registerCommand(name: string, command: any) {
				commands.set(name, command);
			},
			on(event: string, handler: any) {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			},
		},
		tools,
		commands,
		handlers,
		toolRegistrations,
	};
}

test("extension registers compact renderer overrides while loading", async () => {
	const stub = createPiStub();
	await compactToolUiExtension(stub.api as any);

	assert.equal(stub.tools.size, 4);
	assert.equal(stub.toolRegistrations.length, 4);
	// Renderers must be registered at load time; the session_start handler only refreshes options.
	assert.equal(stub.handlers.get("session_start")?.length ?? 0, 1);
	assert.ok(stub.commands.get("compact-tool-ui-settings"), "settings command should be registered lazily on load");
});

async function withTempProject(fn: (cwd: string) => Promise<void>) {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "compact-tool-ui-project-"));
	try {
		await mkdir(path.join(cwd, ".pi"), { recursive: true });
		await writeFile(path.join(cwd, ".pi", "settings.json"), JSON.stringify({ compactToolUi: { renderShell: "default", bash: { tailPreview: "all" } } }));
		await fn(cwd);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
}

function sessionContext(cwd: string, projectTrusted: boolean) {
	return {
		cwd,
		hasUI: false,
		isProjectTrusted: () => projectTrusted,
		ui: { notify() {} },
	};
}

test("extension applies the project layer on session_start when the folder is trusted", async () => {
	const stub = createPiStub();
	await compactToolUiExtension(stub.api as any);
	const handler = stub.handlers.get("session_start")?.[0];

	await withTempProject(async (cwd) => {
		const before = stub.tools.get("bash").renderShell;
		await handler({ type: "session_start" }, sessionContext(cwd, true));
		assert.equal(stub.tools.get("bash").renderShell, "default");
		assert.notEqual(before, "default");
	});
});

test("extension ignores the project layer while the folder is untrusted", async () => {
	const stub = createPiStub();
	await compactToolUiExtension(stub.api as any);
	const handler = stub.handlers.get("session_start")?.[0];

	await withTempProject(async (cwd) => {
		const before = stub.tools.get("bash").renderShell;
		await handler({ type: "session_start" }, sessionContext(cwd, false));
		assert.equal(stub.tools.get("bash").renderShell, before);
	});
});

test("extension exposes compact renderers immediately after loading", async () => {
	const stub = createPiStub();
	await compactToolUiExtension(stub.api as any);

	const compactBashTool = stub.tools.get("bash");

	assert.ok(compactBashTool);
	assert.ok(stub.tools.get("read"));
	assert.ok(stub.tools.get("write"));
	assert.ok(stub.tools.get("edit"));
	assert.equal(compactBashTool.renderShell, "self");
	const rendered = compactBashTool.renderCall({ command: "echo hi" }, theme, {
		args: { command: "echo hi" },
		argsComplete: true,
		cwd: process.cwd(),
		executionStarted: false,
		expanded: false,
		invalidate() {},
		isError: false,
		isPartial: false,
		lastComponent: undefined,
		showImages: false,
		state: {},
		toolCallId: "bash-compact-load",
	});
	assert.match(renderText(rendered), /^Bash echo hi/);

	assert.equal(stub.tools.size, 4);
	assert.equal(stub.toolRegistrations.length, 4);
});

test("settings command does not open custom TUI outside TUI mode", async () => {
	const stub = createPiStub();
	await compactToolUiExtension(stub.api as any);

	const command = stub.commands.get("compact-tool-ui-settings");
	assert.ok(command);
	await command.handler("", {
		hasUI: true,
		mode: "rpc",
		ui: {
			custom() {
				throw new Error("custom UI should not open outside TUI mode");
			},
		},
	});
});
