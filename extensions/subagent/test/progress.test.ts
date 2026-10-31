import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { RunProgress, publishProgress, readProgress, toolTarget, type ProgressSnapshot } from "../src/progress.ts";

function fixture(t: TestContext, onUpdate?: (snapshot: ProgressSnapshot) => void) {
	t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
	let now = 0;
	const updates: ProgressSnapshot[] = [];
	const progress = new RunProgress((snapshot) => { updates.push(snapshot); onUpdate?.(snapshot); }, () => now);
	t.after(() => { progress.finish(); });
	return { progress, updates, advance: (ms: number) => { now += ms; t.mock.timers.tick(ms); } };
}

test("heartbeats measure the entire call and finish cancels all future publication", (t) => {
	const f = fixture(t);
	f.progress.update({ type: "phase", phase: "queued" });
	assert.equal(f.updates[0].elapsedMs, 0);
	f.advance(1_000);
	assert.equal(f.updates.at(-1)?.elapsedMs, 1_000);
	const final = f.progress.finish();
	const count = f.updates.length;
	f.advance(20_000);
	f.progress.update({ type: "tool-start", id: "late", name: "bash" });
	assert.equal(f.updates.length, count);
	assert.deepEqual(f.progress.finish(), final);
});

test("cleanup and result preparation keep elapsed time running until acknowledgement", (t) => {
	const f = fixture(t);
	f.progress.update({ type: "phase", phase: "running" });
	f.advance(1000);
	f.progress.update({ type: "phase", phase: "cleanup" });
	f.advance(1000);
	f.progress.update({ type: "phase", phase: "preparing" });
	f.advance(1000);
	assert.equal(f.updates.at(-1)?.phase, "preparing");
	assert.equal(f.progress.finish().elapsedMs, 3000);
});

test("snapshot text remains bounded even for pathological tool ids and arguments", (t) => {
	const f = fixture(t);
	f.progress.update({ type: "phase", phase: "running" });
	const id = "id".repeat(10_000);
	f.progress.update({ type: "tool-start", id, name: "x".repeat(10_000), target: "y".repeat(10_000) });
	f.progress.update({ type: "tool-end", id, isError: false });
	const snapshot = f.progress.finish();
	assert.equal(snapshot.tools[0].id.length, 200);
	assert.equal(snapshot.tools[0].name.length, 80);
	assert.equal(snapshot.tools[0].target?.length, 200);
	assert.equal(snapshot.tools[0].status, "done");
	assert.equal(snapshot.version, 2);
	assert.equal("activeCount" in snapshot, false);
	assert.equal("activeNames" in snapshot, false);
	assert.equal("activeGroups" in snapshot, false);
});

test("event bursts coalesce into one trailing snapshot within the 750ms budget", (t) => {
	const f = fixture(t);
	f.progress.update({ type: "phase", phase: "queued" });
	f.progress.update({ type: "phase", phase: "starting" });
	f.progress.update({ type: "phase", phase: "running" });
	f.progress.update({ type: "tool-count", count: 2 });
	f.progress.update({ type: "tool-start", id: "one", name: "read", target: "src/a.ts" });
	assert.equal(f.updates.length, 1);
	f.advance(749);
	assert.equal(f.updates.length, 1);
	f.advance(1);
	assert.equal(f.updates.length, 2);
	assert.equal(f.updates[1].phase, "running");
	assert.equal(f.updates[1].toolUses, 2);
	assert.equal(f.updates[1].slots[0]?.id, "one");
	assert.equal(f.updates[1].tools[0].target, "src/a.ts");
});

test("parallel activity keeps bounded history and stable slots without inventing call counts", (t) => {
	const f = fixture(t);
	f.progress.update({ type: "phase", phase: "running" });
	f.progress.update({ type: "tool-count", count: 12 });
	for (let i = 0; i < 9; i++) f.progress.update({ type: "tool-start", id: String(i), name: `tool-${i}` });
	f.advance(750);
	assert.deepEqual(f.updates.at(-1)?.slots.map((tool) => tool?.id ?? null), ["0", "1"]);
	assert.deepEqual(f.updates.at(-1)?.tools.map((tool) => tool.id), ["4", "5", "6", "7", "8"]);
	f.progress.update({ type: "tool-end", id: "0", isError: false });
	f.progress.update({ type: "tool-end", id: "8", isError: true, durationMs: 3_000 });
	f.advance(750);
	assert.deepEqual(f.updates.at(-1)?.slots.map((tool) => tool?.id ?? null), ["2", "1"]);
	assert.equal(f.updates.at(-1)?.toolUses, 12);
	const final = f.progress.finish();
	assert.equal(final.tools.length, 5);
	assert.equal(final.tools.at(-1)?.status, "failed");
	assert.equal(final.tools.at(-1)?.durationMs, 3_000);
	assert.ok(final.tools.slice(0, -1).every((tool) => tool.status === "unfinished"));
	assert.deepEqual(final.slots.map((tool) => tool?.status), ["unfinished", "unfinished"]);
});

test("tool start/end updates stay in place and never infer the model-issued count", (t) => {
	const f = fixture(t);
	f.progress.update({ type: "phase", phase: "running" });
	f.progress.update({ type: "tool-start", id: "one", name: "read" });
	f.progress.update({ type: "tool-start", id: "one", name: "duplicate" });
	f.progress.update({ type: "tool-end", id: "unknown", isError: false });
	f.progress.update({ type: "tool-end", id: "one", isError: false, durationMs: NaN });
	f.progress.update({ type: "tool-end", id: "one", isError: true });
	const final = f.progress.finish();
	assert.equal(final.toolUses, 0);
	assert.equal(final.tools.length, 1);
	assert.equal(final.tools[0].name, "read");
	assert.equal(final.tools[0].status, "done");
	assert.equal(final.tools[0].durationMs, undefined);
});

test("invalid or backwards counters do not corrupt observed accounting", (t) => {
	const f = fixture(t);
	f.progress.update({ type: "tool-count", count: 3 });
	for (const count of [-1, NaN, Infinity, 1.5, 2]) f.progress.update({ type: "tool-count", count });
	assert.equal(f.progress.finish().toolUses, 3);
});

test("cleanup fences tool events and phase regressions without claiming unfinished work is done", (t) => {
	const f = fixture(t);
	f.progress.update({ type: "phase", phase: "running" });
	f.progress.update({ type: "tool-start", id: "one", name: "bash" });
	f.progress.update({ type: "phase", phase: "cleanup" });
	f.progress.update({ type: "phase", phase: "running" });
	f.progress.update({ type: "tool-start", id: "late", name: "write" });
	f.progress.update({ type: "tool-end", id: "one", isError: false });
	f.progress.update({ type: "phase", phase: "preparing" });
	f.progress.update({ type: "phase", phase: "cleanup" });
	const final = f.progress.finish();
	assert.equal(final.phase, "preparing");
	assert.equal(final.tools.length, 1);
	assert.equal(final.tools[0].status, "unfinished");
});

test("callbacks receive detached snapshots and observer failures are isolated", (t) => {
	const f = fixture(t, (snapshot) => {
		if (snapshot.tools[0]) snapshot.tools[0].name = "MUTATED";
		if (snapshot.slots[0]) snapshot.slots[0].name = "MUTATED";
		throw new Error("renderer failed");
	});
	assert.doesNotThrow(() => f.progress.update({ type: "phase", phase: "running" }));
	f.progress.update({ type: "tool-start", id: "one", name: "read" });
	f.advance(750);
	assert.equal(f.progress.finish().tools[0].name, "read");
	assert.doesNotThrow(() => publishProgress(() => { throw new Error("observer failed"); }, { type: "phase", phase: "queued" }));
});

test("only bounded file targets are retained, never arbitrary commands or output", () => {
	assert.equal(toolTarget("read", { path: "src/a.ts", secret: "HIDDEN" }), "src/a.ts");
	assert.equal(toolTarget("edit", { path: "\x1b[31ma.ts\x1b[0m\nnext" }), "a.ts next");
	assert.equal(toolTarget("write", { path: "x".repeat(1_000) })?.length, 200);
	for (const name of ["bash", "custom", "codemode"]) assert.equal(toolTarget(name, { path: "HIDDEN", command: "HIDDEN" }), undefined);
	for (const args of [undefined, null, "path", { path: 42 }]) assert.equal(toolTarget("read", args), undefined);
});



test("two calls retain their row identity through completion and oldest-completed replacement", (t) => {
	const f = fixture(t);
	f.progress.update({ type: "phase", phase: "running" });
	for (const id of ["A", "B"]) f.progress.update({ type: "tool-start", id, name: "bash" });
	f.advance(750);
	assert.deepEqual(f.updates.at(-1)?.slots?.map((tool) => tool?.id), ["A", "B"]);
	f.progress.update({ type: "tool-end", id: "B", isError: false, durationMs: 120 });
	f.advance(750);
	assert.deepEqual(f.updates.at(-1)?.slots?.map((tool) => tool?.status), ["running", "done"]);
	f.progress.update({ type: "tool-end", id: "A", isError: false });
	f.progress.update({ type: "tool-start", id: "C", name: "read" });
	f.advance(750);
	assert.deepEqual(f.updates.at(-1)?.slots?.map((tool) => tool?.id), ["A", "C"], "B completed first, so only its slot is replaced");
	f.progress.update({ type: "tool-start", id: "D", name: "write" });
	f.advance(750);
	assert.deepEqual(f.updates.at(-1)?.slots?.map((tool) => tool?.id), ["D", "C"]);
});

test("active slots stay pinned outside the recent-history window and overflow fills freed slots FIFO", (t) => {
	const f = fixture(t);
	f.progress.update({ type: "phase", phase: "running" });
	for (let i = 0; i < 8; i++) f.progress.update({ type: "tool-start", id: String(i), name: "read", target: `src/${i}.ts` });
	f.advance(750);
	assert.deepEqual(f.updates.at(-1)?.slots?.map((tool) => tool?.id), ["0", "1"]);
	assert.deepEqual(f.updates.at(-1)?.tools.map((tool) => tool.id), ["3", "4", "5", "6", "7"]);
	assert.equal(f.updates.at(-1)?.slots.length, 2);
	f.progress.update({ type: "tool-end", id: "4", isError: false });
	f.progress.update({ type: "tool-end", id: "0", isError: false });
	f.advance(750);
	assert.deepEqual(f.updates.at(-1)?.slots?.map((tool) => tool?.id), ["2", "1"]);
	f.progress.update({ type: "tool-end", id: "1", isError: true });
	f.advance(750);
	assert.deepEqual(f.updates.at(-1)?.slots?.map((tool) => tool?.id), ["2", "3"]);
	const final = f.progress.finish();
	assert.deepEqual(final.slots?.map((tool) => tool?.status), ["unfinished", "unfinished"]);
	assert.equal(final.slots?.[0]?.target, "src/2.ts");
});

test("rapid short calls publish a readable completed snapshot instead of clearing rows between events", (t) => {
	const f = fixture(t);
	f.progress.update({ type: "phase", phase: "running" });
	for (let i = 0; i < 5; i++) {
		f.progress.update({ type: "tool-start", id: String(i), name: "read" });
		f.progress.update({ type: "tool-end", id: String(i), isError: false, durationMs: 20 });
	}
	assert.equal(f.updates.length, 1);
	f.advance(749);
	assert.equal(f.updates.length, 1);
	f.advance(1);
	assert.equal(f.updates.length, 2);
	assert.deepEqual(f.updates[1].slots?.map((tool) => tool?.id), ["4", "3"]);
	assert.ok(f.updates[1].slots?.every((tool) => tool?.status === "done"));
	const final = f.progress.finish();
	f.advance(10_000);
	assert.deepEqual(f.progress.finish().slots, final.slots);
	assert.equal(f.updates.length, 2);
});

test("completed and unconfirmed calls remain distinct after cleanup and observer mutation", (t) => {
	const f = fixture(t, (snapshot) => { if (snapshot.slots?.[0]) snapshot.slots[0].name = "MUTATED"; });
	f.progress.update({ type: "phase", phase: "running" });
	f.progress.update({ type: "tool-start", id: "A", name: "read" });
	f.progress.update({ type: "tool-start", id: "B", name: "bash" });
	f.progress.update({ type: "tool-end", id: "A", isError: false, durationMs: 120 });
	f.advance(750);
	f.progress.update({ type: "phase", phase: "cleanup" });
	const final = f.progress.finish();
	assert.equal(final.slots?.[0]?.name, "read");
	assert.equal(final.slots?.[0]?.status, "done");
	assert.equal(final.slots?.[0]?.durationMs, 120);
	assert.equal(final.slots?.[1]?.status, "unfinished");
	assert.equal(final.slots?.[1]?.durationMs, undefined);
});

test("version 2 snapshots require explicit stable slots and reject older shapes", () => {
	const base = { version: 2, elapsedMs: 1000, toolUses: 1, tools: [] };
	const known = { id: "A", name: "read", status: "running", target: "src/a.ts" };
	const snapshot = readProgress({ ...base, slots: [null, known] })!;
	assert.equal(snapshot.slots[0], null);
	assert.equal(snapshot.slots[1]?.id, "A");
	assert.equal(readProgress({ ...base, slots: [known, known] })?.slots[1], null);
	assert.equal(readProgress(base), undefined);
	assert.equal(readProgress({ ...base, slots: "bad" }), undefined);
	assert.equal(readProgress({ ...base, slots: [known] }), undefined);
	assert.equal(readProgress({ ...base, version: 1, slots: [null, known] }), undefined);
});

test("bash targets are constant classifications and never contain arguments or credentials", () => {
	for (const [command, expected] of [
		["rg SECRET /private/customer", "rg"], ["npm test -- --token=SECRET", "npm test"],
		["npm run check --secret SECRET", "npm run check"], ["pnpm test", "pnpm test"],
		["pytest SECRET.py", "pytest"], ["  fd SECRET  ", "fd"],
	]) {
		const target = toolTarget("bash", { command });
		assert.equal(target, expected);
		assert.doesNotMatch(target!, /SECRET|private|customer/);
	}
	for (const command of [
		"TOKEN=SECRET npm test", "env TOKEN=SECRET npm test", "sudo npm test",
		"curl -H SECRET", "node -e SECRET", "python SECRET.py", "bash -c SECRET",
		"npm run customer-secret", "rgSECRET", "npm testSECRET", "toString", "__proto__",
		"rg SECRET | head", "rg SECRET; npm test", "rg $(SECRET)", "rg `SECRET`",
		"rg SECRET > /private/file", "cat <<EOF\nSECRET\nEOF", "rg\nSECRET",
		"rg \"SECRET\"", "rg SECRET\\file", "\x1b[31mrg SECRET", "rg\tSECRET", "rg " + "SECRET".repeat(1000),
	]) assert.equal(toolTarget("bash", { command }), undefined, command);
});

test("current progress metadata is versioned, bounded, and contains only rendered activity", () => {
	for (const input of [undefined, null, [], {}, { version: 1 }, { version: 3 }, { version: 2, elapsedMs: NaN },
		{ version: 2, elapsedMs: 3, toolUses: -1, tools: [], slots: [null, null] }]) assert.equal(readProgress(input), undefined);
	const snapshot = readProgress({ version: 2, elapsedMs: 200, toolUses: 7,
		phase: "invented", tools: Array.from({ length: 20 }, (_, i) => ({
			id: String(i), name: "read\x1b[31m", status: "done", target: "x".repeat(300), durationMs: Infinity,
		})), slots: [null, null],
	});
	assert.ok(snapshot);
	assert.equal(snapshot.phase, undefined);
	assert.equal(snapshot.tools.length, 5);
	assert.equal(snapshot.tools[0].id, "15");
	assert.equal(snapshot.tools[0].name, "read");
	assert.equal(snapshot.tools[0].target?.length, 200);
	assert.equal(snapshot.tools[0].durationMs, undefined);
});
