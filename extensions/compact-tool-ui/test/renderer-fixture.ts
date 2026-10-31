import assert from "node:assert/strict";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";

export type RendererResolver = (name: string, next: () => any) => any;

/** Resolve against a downstream renderer, never an execution override. */
export function captureRegisteredRenderer(
	register: (pi: any, cwd: string) => void,
	handlers = new Map<string, any[]>(),
) {
	const resolvers: RendererResolver[] = [];
	register({
		registerTool() { assert.fail("compact presentation must not register tool definitions"); },
		registerToolRenderer(resolve: RendererResolver) { resolvers.push(resolve); },
		on(event: string, handler: any) { handlers.set(event, [...(handlers.get(event) ?? []), handler]); },
	}, process.cwd());
	assert.equal(resolvers.length, 1, "one renderer resolver should be registered");
	const definitions = [createBashToolDefinition, createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition];
	const matches: any[] = [];
	for (const create of definitions) {
		const downstream = create(process.cwd());
		const renderer = resolvers[0]!(downstream.name, () => downstream);
		if (renderer !== downstream) matches.push(renderer);
	}
	assert.equal(matches.length, 1, "resolver should replace only its matching renderer");
	assert.deepEqual(Object.keys(matches[0]).sort(), ["renderCall", "renderResult", "renderShell"]);
	return matches[0];
}
