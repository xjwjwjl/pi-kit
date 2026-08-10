import assert from "node:assert/strict";
import test from "node:test";
import type { SessionTreeNode } from "@earendil-works/pi-coding-agent";
import outlineExtension, {
	buildTurnForest,
	connectorGlyph,
	entryRows,
	filterTurnForest,
	flattenTurnForest,
	formatTurnInsight,
	matchesTurnFilter,
	matchesTurnQuery,
	navigateTargetId,
	parseTurnQuery,
	rowPrefix,
	sessionRollup,
	turnStatusGlyphs,
} from "../index.ts";

function node(entry: Record<string, unknown>, children: SessionTreeNode[] = []): SessionTreeNode {
	return { entry: entry as unknown as SessionTreeNode["entry"], children };
}

function message(
	id: string,
	parentId: string | null,
	role: string,
	content: unknown,
	extra: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		type: "message",
		id,
		parentId,
		timestamp: `2026-07-14T10:00:0${id.length}.000Z`,
		message: { role, content, ...extra },
	};
}

test("turn forest hides assistant and tool chains between user messages", () => {
	const next = node(message("next", "final", "user", "Continue"));
	const final = node(message("final", "tool", "assistant", "Done"), [next]);
	const tool = node(message("tool", "assistant", "toolResult", "output"), [final]);
	const assistant = node(message("assistant", "root", "assistant", "Working", { stopReason: "toolUse" }), [tool]);
	const forest = buildTurnForest([node(message("root", null, "user", "Start"), [assistant])]);

	assert.deepEqual(forest.map((turn) => turn.user.entry.id), ["root"]);
	assert.equal(forest[0]?.assistant?.entry.id, "final");
	assert.deepEqual(forest[0]?.children.map((turn) => turn.user.entry.id), ["next"]);
	assert.deepEqual(flattenTurnForest(forest).map((row) => row.indent), [0, 0]);
});

test("a final reply is omitted when it belongs to a forked continuation", () => {
	const primary = node(message("primary", "final", "user", "Primary path"));
	const alternate = node(message("alternate", "final", "user", "Alternate path"));
	const final = node(message("final", "root", "assistant", "Choose a path"), [primary, alternate]);
	const forest = buildTurnForest([node(message("root", null, "user", "Pick an approach"), [final])]);

	assert.equal(forest[0]?.assistant, undefined);
	assert.deepEqual(forest[0]?.children.map((turn) => turn.user.entry.id), ["primary", "alternate"]);
});

test("search filtering retains ancestors and reflows the visible user tree", () => {
	const child = node(message("child", "root", "user", "Needle"));
	const forest = buildTurnForest([node(message("root", null, "user", "Haystack"), [child])]);
	const filtered = filterTurnForest(forest, (turn) => turn.user.entry.id === "child");

	assert.deepEqual(flattenTurnForest(filtered).map((row) => row.node.user.entry.id), ["root", "child"]);
});

test("turn forest keeps sibling user branches", () => {
	const primary = node(message("primary", "root", "user", "Primary path"));
	const alternate = node(message("alternate", "root", "user", "Alternate path"));
	const forest = buildTurnForest([node(message("root", null, "user", "Choose path"), [primary, alternate])]);
	const rows = flattenTurnForest(forest);

	assert.deepEqual(rows.map((row) => row.node.user.entry.id), ["root", "primary", "alternate"]);
	assert.equal(rows[1]?.showConnector, true);
	assert.equal(rows[2]?.showConnector, true);
});

test("linear turns after a branch keep the branch indentation", () => {
	const continued = node(message("continued", "primary", "user", "Continue primary path"));
	const primary = node(message("primary", "root", "user", "Primary path"), [continued]);
	const alternate = node(message("alternate", "root", "user", "Alternate path"));
	const rows = flattenTurnForest(buildTurnForest([node(message("root", null, "user", "Choose path"), [primary, alternate])]));

	assert.deepEqual(rows.map((row) => row.indent), [0, 1, 1, 1]);
});

test("every branch connector uses Pi's expanded-node glyph", () => {
	const continued = node(message("continued", "primary", "user", "Continue primary path"));
	const primary = node(message("primary", "root", "user", "Primary path"), [continued]);
	const alternate = node(message("alternate", "root", "user", "Alternate path"));
	const rows = flattenTurnForest(buildTurnForest([node(message("root", null, "user", "Choose path"), [primary, alternate])]));

	const primaryRow = rows.find((row) => row.node.user.entry.id === "primary")!;
	const alternateRow = rows.find((row) => row.node.user.entry.id === "alternate")!;
	assert.equal(connectorGlyph(primaryRow), "⊟");
	assert.equal(connectorGlyph(alternateRow), "⊟");
	assert.match(rowPrefix(alternateRow), /├⊟/);
});

test("branch rails persist through the last sibling's linear descendants", () => {
	const continued = node(message("continued", "primary", "user", "Continue primary path"));
	const primary = node(message("primary", "root", "user", "Primary path"), [continued]);
	const alternate = node(message("alternate", "root", "user", "Alternate path"));
	const rows = flattenTurnForest(buildTurnForest([node(message("root", null, "user", "Choose path"), [alternate, primary])]));
	const continuedRow = rows.find((row) => row.node.user.entry.id === "continued");

	assert.equal(continuedRow?.gutters[0]?.show, true);
});

test("collapsed turns hide descendants and use the native collapsed glyph", () => {
	const child = node(message("child", "root", "user", "Child turn"));
	const rows = flattenTurnForest(buildTurnForest([node(message("root", null, "user", "Root turn"), [child])]), new Set(["root"]));

	assert.deepEqual(rows.map((row) => row.node.user.entry.id), ["root"]);
	assert.equal(connectorGlyph(rows[0]!), "⊞");
});

test("active branches sort first while preserving inactive siblings", () => {
	const active = node(message("active", "root", "user", "Active path"));
	const inactive = node(message("inactive", "root", "user", "Old path"));
	const forest = buildTurnForest([node(message("root", null, "user", "Choose path"), [inactive, active])]);
	const rows = flattenTurnForest(forest, new Set(), new Set(["root", "active"]));

	assert.deepEqual(rows.map((row) => row.node.user.entry.id), ["root", "active", "inactive"]);
});

test("turn insights aggregate model usage, tools, errors, and files", () => {
	const final = node(message("final", "result", "assistant", "Done", {
		stopReason: "stop",
		provider: "test-provider",
		model: "test-model",
		usage: {
			input: 12_500,
			output: 800,
			cacheRead: 2_000,
			cacheWrite: 0,
			cost: { total: 0.0123 },
		},
	}));
	const result = node(message("result", "calls", "toolResult", "failed", { isError: true }), [final]);
	const calls = node(message("calls", "root", "assistant", [
		{ type: "toolCall", id: "1", name: "read", arguments: { path: "src/input.ts" } },
		{ type: "toolCall", id: "2", name: "edit", arguments: { path: "src/output.ts" } },
	], { stopReason: "toolUse" }), [result]);
	const turn = buildTurnForest([node(message("root", null, "user", "Inspect files"), [calls])])[0]!;

	assert.equal(turn.insight.model, "test-provider/test-model");
	assert.equal(turn.insight.toolCalls, 2);
	assert.equal(turn.insight.toolErrors, 1);
	assert.deepEqual(turn.insight.readFiles, ["src/input.ts"]);
	assert.deepEqual(turn.insight.modifiedFiles, ["src/output.ts"]);
	assert.match(formatTurnInsight(turn.insight), /tokens ↑13k ↓800/);
	assert.match(formatTurnInsight(turn.insight), /files R1\/W1/);
});

test("turn duration ignores later bookkeeping entries", () => {
	const bookkeeping = node({
		type: "model_change",
		id: "model",
		parentId: "final",
		timestamp: "2026-07-14T11:00:00.000Z",
		provider: "test",
		modelId: "next-model",
	});
	const finalEntry = message("final", "root", "assistant", "Done", { stopReason: "stop" });
	finalEntry.timestamp = "2026-07-14T10:00:02.000Z";
	const rootEntry = message("root", null, "user", "Start");
	rootEntry.timestamp = "2026-07-14T10:00:00.000Z";
	const turn = buildTurnForest([node(rootEntry, [node(finalEntry, [bookkeeping])])])[0]!;

	assert.equal(turn.insight.durationMs, 2_000);
});

test("search uses AND terms across prompts, tools, files, replies, and labels", () => {
	const assistant = node(message("assistant", "root", "assistant", [
		{ type: "text", text: "Migration complete" },
		{ type: "toolCall", id: "1", name: "read", arguments: { path: "src/schema.sql" } },
	], { stopReason: "stop" }));
	const root = node(message("root", null, "user", "Database migration"), [assistant]);
	root.label = "checkpoint";
	const turn = buildTurnForest([root])[0]!;

	assert.equal(matchesTurnQuery(turn, "database schema.sql"), true);
	assert.equal(matchesTurnQuery(turn, 'checkpoint "migration complete"'), true);
	assert.equal(matchesTurnQuery(turn, "database missing"), false);
	assert.equal(matchesTurnFilter(turn, "labeled", new Set()), true);
});

test("navigate target prefers the terminal assistant reply when continuing", () => {
	const final = node(message("final", "calls", "assistant", "Done", { stopReason: "stop" }));
	const calls = node(message("calls", "root", "assistant", "Working", { stopReason: "toolUse" }), [final]);
	const turn = buildTurnForest([node(message("root", null, "user", "Start"), [calls])])[0]!;

	assert.equal(turn.assistant?.entry.id, "final");
	assert.equal(navigateTargetId(turn, true), "final");
	assert.equal(navigateTargetId(turn, false), "root");
});

test("navigate target falls back to the user message when a turn has no final reply", () => {
	const primary = node(message("primary", "final", "user", "Primary path"));
	const alternate = node(message("alternate", "final", "user", "Alternate path"));
	const final = node(message("final", "root", "assistant", "Choose a path"), [primary, alternate]);
	const turn = buildTurnForest([node(message("root", null, "user", "Pick an approach"), [final])])[0]!;

	assert.equal(turn.assistant, undefined);
	assert.equal(navigateTargetId(turn, true), "root");
	assert.equal(navigateTargetId(turn, false), "root");
});

test("parseTurnQuery splits text terms and facets", () => {
	assert.deepEqual(parseTurnQuery('migration "tests pass" model:sonnet file:src/a.ts cost:>0.05 branch:active'), [
		{ kind: "text", term: "migration" },
		{ kind: "text", term: "tests pass" },
		{ kind: "model", term: "sonnet" },
		{ kind: "file", term: "src/a.ts" },
		{ kind: "cost", op: ">", value: 0.05 },
		{ kind: "branch", active: true },
	]);
});

test("facet search filters by model, file, tool, label, cost, and branch", () => {
	const assistant = node(message("assistant", "root", "assistant", [
		{ type: "text", text: "Migration complete" },
		{ type: "toolCall", id: "1", name: "read", arguments: { path: "src/schema.sql" } },
	], { stopReason: "stop", provider: "test", model: "sonnet", usage: { cost: { total: 0.08 } } }));
	const root = node(message("root", null, "user", "Database migration"), [assistant]);
	root.label = "checkpoint";
	const turn = buildTurnForest([root])[0]!;

	assert.equal(matchesTurnQuery(turn, "model:sonnet"), true);
	assert.equal(matchesTurnQuery(turn, "model:gpt"), false);
	assert.equal(matchesTurnQuery(turn, "file:schema"), true);
	assert.equal(matchesTurnQuery(turn, "tool:read"), true);
	assert.equal(matchesTurnQuery(turn, "label:checkpoint"), true);
	assert.equal(matchesTurnQuery(turn, "cost:>0.05"), true);
	assert.equal(matchesTurnQuery(turn, "cost:<0.05"), false);
	assert.equal(matchesTurnQuery(turn, "branch:active", new Set(["root"])), true);
	assert.equal(matchesTurnQuery(turn, "branch:inactive", new Set(["root"])), false);
	assert.equal(matchesTurnQuery(turn, "file:schema model:sonnet"), true);
	assert.equal(matchesTurnQuery(turn, "file:schema model:gpt"), false);
});

test("turn status glyphs encode errors, cost, writes, reads, and labels", () => {
	const labeled = node(message("root", null, "user", "Start"));
	labeled.label = "checkpoint";
	assert.equal(turnStatusGlyphs(buildTurnForest([labeled])[0]!), "★");

	const turn = buildTurnForest([
		node(message("root", null, "user", "Start"), [
			node(message("a", "root", "assistant", [
				{ type: "toolCall", id: "1", name: "edit", arguments: { path: "src/a.ts" } },
			], { stopReason: "toolUse" }), [
				node(message("r", "a", "toolResult", "x", { isError: true }), [
					node(message("f", "r", "assistant", "Done", { stopReason: "stop", usage: { cost: { total: 0.1 } } })),
				]),
			]),
		]),
	])[0]!;
	assert.equal(turnStatusGlyphs(turn), "!$+");
});

test("session rollup aggregates turns, forks, cost, tokens, files, and model", () => {
	const continued = node(message("continued", "primary", "user", "Continue primary path"));
	const primary = node(message("primary", "root", "user", "Primary path"), [continued]);
	const alternate = node(message("alternate", "root", "user", "Alternate path"));
	const forest = buildTurnForest([node(message("root", null, "user", "Choose path"), [primary, alternate])]);
	const rollup = sessionRollup(forest);

	assert.equal(rollup.turns, 4);
	assert.equal(rollup.branchPoints, 1);
	assert.equal(rollup.cost, 0);
	assert.equal(rollup.inputTokens, 0);
	assert.equal(rollup.outputTokens, 0);
	assert.equal(rollup.files, 0);
	assert.equal(rollup.model, undefined);
});

test("session rollup prefers the active branch model", () => {
	const activeAssistant = node(message("a2", "active", "assistant", "Active done", { stopReason: "stop", provider: "a", model: "active-model" }));
	const active = node(message("active", "root", "user", "Active path"), [activeAssistant]);
	const inactiveAssistant = node(message("i2", "inactive", "assistant", "Inactive done", { stopReason: "stop", provider: "i", model: "inactive-model" }));
	const inactive = node(message("inactive", "root", "user", "Inactive path"), [inactiveAssistant]);
	const forest = buildTurnForest([node(message("root", null, "user", "Choose"), [inactive, active])]);

	assert.equal(sessionRollup(forest).model, "a/active-model");
	assert.equal(sessionRollup(forest, new Set(["root", "active"])).model, "a/active-model");
	assert.equal(sessionRollup(forest, new Set(["root", "inactive"])).model, "i/inactive-model");
});

test("entry rows expose the turn chain for drill-down jumps", () => {
	const final = node(message("final", "result", "assistant", "Done", { stopReason: "stop" }));
	const result = node(message("result", "calls", "toolResult", "ok"), [final]);
	const calls = node(message("calls", "root", "assistant", [
		{ type: "toolCall", id: "1", name: "edit", arguments: { path: "src/a.ts" } },
	], { stopReason: "toolUse" }), [result]);
	const turn = buildTurnForest([node(message("root", null, "user", "Start"), [calls])])[0]!;
	const rows = entryRows(turn);

	assert.deepEqual(rows.map((row) => row.entryId), [turn.user.entry.id, "calls", "result", "final"]);
	assert.deepEqual(rows.map((row) => row.role), ["user", "assistant", "toolResult", "assistant"]);
	assert.equal(rows[1]?.tool, "edit");
	assert.equal(rows[1]?.path, "src/a.ts");
	assert.equal(rows[2]?.isError, false);
});

test("entry rows skip non-message bookkeeping entries", () => {
	const label = node({
		type: "label",
		id: "lbl",
		parentId: "final",
		timestamp: "2026-07-14T10:00:03.000Z",
		targetId: "root",
		label: "x",
	});
	const final = node(message("final", "root", "assistant", "Done", { stopReason: "stop" }), [label]);
	const turn = buildTurnForest([node(message("root", null, "user", "Start"), [final])])[0]!;
	const rows = entryRows(turn);

	assert.deepEqual(rows.map((row) => row.entryId), [turn.user.entry.id, "final"]);
});

test("deep sessions build, filter, and flatten without recursion overflow", () => {
	const depth = 20_000;
	let root: SessionTreeNode | undefined;
	for (let index = depth - 1; index >= 0; index--) {
		const role = index % 2 === 0 ? "user" : "assistant";
		root = node(
			message(String(index), index === 0 ? null : String(index - 1), role, `message ${index}`, role === "assistant" ? { stopReason: "stop" } : {}),
			root ? [root] : [],
		);
	}

	const forest = buildTurnForest([root!]);
	let matchCalls = 0;
	const filtered = filterTurnForest(forest, () => {
		matchCalls++;
		return true;
	});
	const rows = flattenTurnForest(filtered);

	assert.equal(rows.length, depth / 2);
	assert.equal(matchCalls, depth / 2);
});

test("extension registers the outline command", () => {
	const commands = new Map<string, unknown>();
	outlineExtension({
		registerCommand(name: string, command: unknown) {
			commands.set(name, command);
		},
	} as never);

	assert.ok(commands.has("outline"));
});
