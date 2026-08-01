import assert from "node:assert/strict";
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
	assert.equal(stub.handlers.get("session_start")?.length ?? 0, 0);
	assert.ok(stub.commands.get("compact-tool-ui-settings"), "settings command should be registered lazily on load");
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
