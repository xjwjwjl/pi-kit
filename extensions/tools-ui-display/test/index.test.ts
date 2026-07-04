import assert from "node:assert/strict";
import test from "node:test";
import toolsUiDisplayExtension from "../index.js";

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
	return {
		api: {
			registerTool(definition: any) {
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
	};
}

async function emitSessionStart(stub: ReturnType<typeof createPiStub>, ctx: { hasUI: boolean; mode: string }) {
	for (const handler of stub.handlers.get("session_start") ?? []) {
		await handler({ type: "session_start", reason: "startup" }, ctx);
	}
}

test("extension does not override built-in tools outside TUI sessions", async () => {
	const stub = createPiStub();
	await toolsUiDisplayExtension(stub.api as any);

	assert.equal(stub.tools.size, 0);
	assert.ok(stub.commands.get("tools-ui-settings"), "settings command should be registered lazily on load");

	await emitSessionStart(stub, { hasUI: true, mode: "rpc" });
	assert.equal(stub.tools.size, 0);

	await emitSessionStart(stub, { hasUI: false, mode: "print" });
	assert.equal(stub.tools.size, 0);
});

test("extension loads compact renderers only for TUI sessions", async () => {
	const stub = createPiStub();
	await toolsUiDisplayExtension(stub.api as any);

	await emitSessionStart(stub, { hasUI: true, mode: "tui" });
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
});

test("settings command does not open custom TUI outside TUI mode", async () => {
	const stub = createPiStub();
	await toolsUiDisplayExtension(stub.api as any);

	const command = stub.commands.get("tools-ui-settings");
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
