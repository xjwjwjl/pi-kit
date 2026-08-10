import assert from "node:assert/strict";
import test from "node:test";
import { KeyedMutationQueue } from "../src/runtime/mutation-queue.js";

test("serializes tasks for the same key and continues after failure", async () => {
	const queue = new KeyedMutationQueue();
	const events: string[] = [];
	let releaseFirst: (() => void) | undefined;
	const firstGate = new Promise<void>((resolve) => {
		releaseFirst = resolve;
	});

	const first = queue.run("prod", async () => {
		events.push("first:start");
		await firstGate;
		events.push("first:end");
		throw new Error("expected");
	});
	const second = queue.run("prod", async () => {
		events.push("second:start");
		events.push("second:end");
		return "ok";
	});

	for (let attempt = 0; events.length === 0 && attempt < 10; attempt++) {
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	assert.deepEqual(events, ["first:start"]);
	releaseFirst?.();
	await assert.rejects(first, /expected/);
	assert.equal(await second, "ok");
	assert.deepEqual(events, ["first:start", "first:end", "second:start", "second:end"]);
});
