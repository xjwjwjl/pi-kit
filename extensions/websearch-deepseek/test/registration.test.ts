import assert from "node:assert/strict";
import test from "node:test";
import deepSeekWebSearchExtension from "../index.ts";
import type { ToolLike } from "./helpers.ts";

function loadExtension(): { tools: ToolLike[]; events: string[] } {
	const tools: ToolLike[] = [];
	const events: string[] = [];
	deepSeekWebSearchExtension({
		on(event: string) {
			events.push(event);
		},
		registerTool(definition: unknown) {
			tools.push(definition as ToolLike);
		},
	} as never);
	return { tools, events };
}

test("registers two pure tools without system-prompt hooks", () => {
	const { tools, events } = loadExtension();
	assert.deepEqual(
		tools.map((tool) => tool.name),
		["deepseek_websearch", "deepseek_webfetch"],
	);
	assert.deepEqual(events, []);
});

test("declares structured output, annotations, and prompt guidance", () => {
	const { tools } = loadExtension();
	const search = tools[0];
	const fetch = tools[1];

	assert.equal(search.outputSchema?.type, "object");
	assert.equal(fetch.outputSchema?.type, "object");
	assert.deepEqual(search.annotations, { readOnlyHint: true, openWorldHint: true });
	assert.deepEqual(fetch.annotations, { readOnlyHint: true, openWorldHint: true });
	assert.match(search.promptSnippet ?? "", /ranked sources/i);
	assert.match(fetch.promptSnippet ?? "", /Markdown content/i);
	assert.match(search.description ?? "", /sources only/i);
	assert.match(fetch.description ?? "", /does not extract or summarize/i);
	assert.equal(typeof search.renderCall, "function");
	assert.equal(typeof search.renderResult, "function");
	assert.equal(typeof fetch.renderCall, "function");
	assert.equal(typeof fetch.renderResult, "function");
});
