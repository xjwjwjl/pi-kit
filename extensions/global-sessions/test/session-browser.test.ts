import assert from "node:assert/strict";
import test from "node:test";
import { SessionBrowserComponent } from "../src/session-browser.ts";
import type { GlobalSession, SessionTranscript } from "../src/types.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

const keybindings = {
	matches(data: string, id: string): boolean {
		const keys: Record<string, string> = {
			"tui.select.up": "up",
			"tui.select.down": "down",
			"tui.select.pageUp": "pageUp",
			"tui.select.pageDown": "pageDown",
			"tui.select.confirm": "enter",
			"tui.select.cancel": "escape",
			"tui.input.tab": "tab",
		};
		return keys[id] === data;
	},
};

function session(): GlobalSession {
	return {
		path: "C:/tmp/session.jsonl",
		id: "session",
		cwd: "D:/code/demo",
		name: "Demo",
		created: new Date("2026-07-01T00:00:00.000Z"),
		modified: new Date("2026-07-01T00:00:00.000Z"),
		messageCount: 5,
		firstPrompt: "Stale first prompt",
		lastReply: "Stale reply from an abandoned branch",
		model: "old/model",
		allMessagesText: "Stale reply from an abandoned branch",
		searchText: "demo stale reply old/model",
	};
}

function flush(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

test("summary reads the active branch instead of scanner metadata from an abandoned branch", async () => {
	const transcript: SessionTranscript = {
		model: "active/model",
		alternateBranchCount: 1,
		messages: [
			{ id: "u", role: "user", content: "Active prompt" },
			{ id: "a", role: "assistant", content: "Active branch reply" },
		],
	};
	const component = new SessionBrowserComponent(
		{ requestRender() {}, terminal: { rows: 30 } },
		theme as never,
		keybindings as never,
		[session()],
		{ totalFiles: 1, skippedFiles: 0 },
		() => {},
		async () => transcript,
		"D:/code/demo",
	);
	component.focused = true;
	component.handleInput("enter");
	await flush();

	const preview = component.render(100).join("\n");
	assert.match(preview, /active\/model/);
	assert.match(preview, /Active branch reply/);
	assert.doesNotMatch(preview, /Stale reply from an abandoned branch/);
});

test("transcript view renders only the active viewport and can jump to a later segment", async () => {
	const longReply = `${"a".repeat(20_000)} needle`;
	const transcript: SessionTranscript = {
		alternateBranchCount: 0,
		messages: [{ id: "a", role: "assistant", content: longReply }],
	};
	const component = new SessionBrowserComponent(
		{ requestRender() {}, terminal: { rows: 30 } },
		theme as never,
		keybindings as never,
		[session()],
		{ totalFiles: 1, skippedFiles: 0 },
		() => {},
		async () => transcript,
		"D:/code/demo",
	);
	component.handleInput("enter");
	await flush();
	component.handleInput("tab");
	const firstViewport = component.render(80).join("\n");
	assert.doesNotMatch(firstViewport, /needle/);
	assert.ok(firstViewport.length < 5_000);

	component.handleInput("G");
	const lastViewport = component.render(80).join("\n");
	assert.match(lastViewport, /needle/);
	assert.ok(lastViewport.length < 5_000);
});
