import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { customRange } from "../src/time-range.ts";
import { TokenMonitorComponent } from "../src/token-monitor-component.ts";
import type { ScanResult, TokenEvent } from "../src/types.ts";

function event(id: string, provider: string, model: string, scope: string): TokenEvent {
	return {
		entryId: id,
		sessionId: "session",
		sessionFile: "C:\\sessions\\session.jsonl",
		sessionCreatedAt: 1,
		timestampMs: Date.parse("2026-07-22T10:00:00.000Z"),
		scope,
		provider,
		model,
		inputTokens: 100,
		outputTokens: 20,
		cacheReadTokens: 10,
		cacheWriteTokens: 5,
		cost: 0.25,
		stopReason: "stop",
	};
}

const scan: ScanResult = {
	aborted: false,
	events: [event("one", "openai", "gpt-test", "C:\\workspace\\api"), event("two", "anthropic", "sonnet", "C:\\workspace\\web")],
	totalFiles: 2,
	loadedFiles: 2,
	skippedFiles: 0,
	deduplicatedEvents: 0,
	malformedLines: 0,
	scannedAt: Date.now(),
};

function createComponent(done: () => void = () => undefined): TokenMonitorComponent {
	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	};
	const keybindings = { matches: () => false };
	return new TokenMonitorComponent(
		{ terminal: { rows: 24 }, requestRender: () => undefined },
		theme as never,
		keybindings as never,
		customRange(Date.parse("2026-07-22T00:00:00.000Z"), Date.parse("2026-07-23T00:00:00.000Z")),
		scan,
		done,
		async () => scan,
		async () => undefined,
	);
}

test("monitor renders within narrow and wide terminal widths", () => {
	const component = createComponent();
	for (const width of [32, 48, 80, 120]) {
		const lines = component.render(width);
		assert.ok(lines.length > 0);
		assert.ok(lines.every((line) => visibleWidth(line) <= width), `line exceeds width ${width}`);
	}
});

test("monitor switches tabs, expands a provider, and closes", () => {
	let closed = false;
	const component = createComponent(() => {
		closed = true;
	});
	component.handleInput("2");
	component.handleInput("\r");
	const rendered = component.render(80);
	assert.ok(rendered.some((line) => line.includes("sonnet")), rendered.join("\\n"));
	component.handleInput("q");
	assert.equal(closed, true);
});

test("tab cycles views and numeric tabs work from request detail", () => {
	const component = createComponent();
	component.handleInput("2");
	component.handleInput("\t");
	assert.ok(component.render(80).some((line) => line.includes("MODEL")));

	component.handleInput("5");
	component.handleInput("\r");
	assert.ok(component.render(80).some((line) => line.includes("Request Detail")));
	component.handleInput("2");
	const rendered = component.render(80);
	assert.ok(rendered.some((line) => line.includes("NAME")), rendered.join("\\n"));
	assert.ok(!rendered.some((line) => line.includes("Request Detail")));
});

test("q exits from request detail", () => {
	let closed = false;
	const component = createComponent(() => {
		closed = true;
	});
	component.handleInput("5");
	component.handleInput("\r");
	component.handleInput("q");
	assert.equal(closed, true);
});
