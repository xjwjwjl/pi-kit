import type { SessionTreeNode } from "@earendil-works/pi-coding-agent";

export type OutlineFilterMode = "all" | "active" | "labeled" | "branches";

export type ToolActivity = {
	name: string;
	count: number;
};

export type TurnInsight = {
	model?: string;
	durationMs?: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	cost: number;
	toolCalls: number;
	toolErrors: number;
	tools: ToolActivity[];
	readFiles: string[];
	modifiedFiles: string[];
};

export type TurnTreeNode = {
	user: SessionTreeNode;
	assistant?: SessionTreeNode;
	entries: SessionTreeNode[];
	insight: TurnInsight;
	children: TurnTreeNode[];
};

type Gutter = { position: number; show: boolean };

export type TurnRow = {
	node: TurnTreeNode;
	indent: number;
	showConnector: boolean;
	isLast: boolean;
	gutters: Gutter[];
	multipleRoots: boolean;
	isVirtualRootChild: boolean;
	collapsed: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function rawMessage(node: SessionTreeNode): Record<string, unknown> | undefined {
	if (node.entry.type !== "message" || !isRecord(node.entry.message)) return undefined;
	return node.entry.message;
}

function rawMessageRole(node: SessionTreeNode): string | undefined {
	const message = rawMessage(node);
	return typeof message?.role === "string" ? message.role : undefined;
}

export function textContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(isRecord)
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text as string)
		.join("\n");
}

export function messageText(node: SessionTreeNode): string {
	return textContent(rawMessage(node)?.content);
}

export function userText(node: SessionTreeNode): string {
	return rawMessageRole(node) === "user" ? messageText(node) : "";
}

function isFinalAssistant(node: SessionTreeNode): boolean {
	const message = rawMessage(node);
	return message?.role === "assistant" && message.stopReason !== "toolUse" && messageText(node).trim().length > 0;
}

function addStringValues(target: Set<string>, value: unknown): void {
	if (!Array.isArray(value)) return;
	for (const item of value) {
		if (typeof item === "string" && item.trim()) target.add(item);
	}
}

function toolPath(args: Record<string, unknown>): string | undefined {
	const value = args.path ?? args.file_path;
	return typeof value === "string" && value.trim() ? value : undefined;
}

function collectTurnInsight(entries: SessionTreeNode[]): TurnInsight {
	let model: string | undefined;
	let inputTokens = 0;
	let outputTokens = 0;
	let cacheReadTokens = 0;
	let cacheWriteTokens = 0;
	let cost = 0;
	let toolCalls = 0;
	let toolErrors = 0;
	const toolCounts = new Map<string, number>();
	const readFiles = new Set<string>();
	const modifiedFiles = new Set<string>();

	for (const node of entries) {
		const message = rawMessage(node);
		if (message?.role === "assistant") {
			const provider = typeof message.provider === "string" ? message.provider : undefined;
			const modelId = typeof message.model === "string" ? message.model : undefined;
			if (modelId) model = provider ? `${provider}/${modelId}` : modelId;

			const usage = isRecord(message.usage) ? message.usage : undefined;
			inputTokens += finiteNumber(usage?.input);
			outputTokens += finiteNumber(usage?.output);
			cacheReadTokens += finiteNumber(usage?.cacheRead);
			cacheWriteTokens += finiteNumber(usage?.cacheWrite);
			const usageCost = isRecord(usage?.cost) ? usage.cost : undefined;
			cost += finiteNumber(usageCost?.total);

			if (Array.isArray(message.content)) {
				for (const block of message.content) {
					if (!isRecord(block) || block.type !== "toolCall" || typeof block.name !== "string") continue;
					toolCalls++;
					toolCounts.set(block.name, (toolCounts.get(block.name) ?? 0) + 1);
					const args = isRecord(block.arguments) ? block.arguments : {};
					const path = toolPath(args);
					if (!path) continue;
					if (block.name === "edit" || block.name === "write") modifiedFiles.add(path);
					else if (["read", "grep", "find", "ls"].includes(block.name)) readFiles.add(path);
				}
			}
		}

		if (message?.role === "toolResult" && message.isError === true) toolErrors++;
		if (node.entry.type === "compaction" || node.entry.type === "branch_summary") {
			const details = isRecord(node.entry.details) ? node.entry.details : undefined;
			addStringValues(readFiles, details?.readFiles);
			addStringValues(modifiedFiles, details?.modifiedFiles);
		}
	}

	const timedEntries = entries.filter((node) => node.entry.type === "message");
	const start = Date.parse(timedEntries[0]?.entry.timestamp ?? "");
	const end = Date.parse(timedEntries.at(-1)?.entry.timestamp ?? "");
	const durationMs = Number.isFinite(start) && Number.isFinite(end) && end > start ? end - start : undefined;

	return {
		model,
		durationMs,
		inputTokens,
		outputTokens,
		cacheReadTokens,
		cacheWriteTokens,
		cost,
		toolCalls,
		toolErrors,
		tools: [...toolCounts].map(([name, count]) => ({ name, count })),
		readFiles: [...readFiles],
		modifiedFiles: [...modifiedFiles],
	};
}

function collectLinearTurn(user: SessionTreeNode): { entries: SessionTreeNode[]; assistant?: SessionTreeNode } {
	const entries = [user];
	let current = user;
	let assistant: SessionTreeNode | undefined;

	while (current.children.length === 1) {
		current = current.children[0]!;
		if (rawMessageRole(current) === "user") return { entries, assistant };
		entries.push(current);
		if (isFinalAssistant(current)) assistant = current;
	}

	// A fork before the next user message makes a reply branch-specific.
	return current.children.length === 0 ? { entries, assistant } : { entries };
}

/** Collapse tool chains while retaining turn-level activity and a terminal assistant response. */
export function buildTurnForest(tree: SessionTreeNode[]): TurnTreeNode[] {
	const forest: TurnTreeNode[] = [];
	const stack: Array<{ node: SessionTreeNode; parent?: TurnTreeNode }> = [];
	for (let index = tree.length - 1; index >= 0; index--) stack.push({ node: tree[index]! });

	while (stack.length > 0) {
		const { node, parent } = stack.pop()!;
		let nextParent = parent;
		if (rawMessageRole(node) === "user") {
			const linear = collectLinearTurn(node);
			const turn: TurnTreeNode = {
				user: node,
				assistant: linear.assistant,
				entries: linear.entries,
				insight: collectTurnInsight(linear.entries),
				children: [],
			};
			if (parent) parent.children.push(turn);
			else forest.push(turn);
			nextParent = turn;
		}
		for (let index = node.children.length - 1; index >= 0; index--) {
			stack.push({ node: node.children[index]!, parent: nextParent });
		}
	}
	return forest;
}

/** Keep matching turns and their ancestors. */
export function filterTurnForest(
	forest: TurnTreeNode[],
	matches: (node: TurnTreeNode) => boolean,
): TurnTreeNode[] {
	const filtered = new Map<TurnTreeNode, TurnTreeNode | undefined>();
	const stack: Array<{ node: TurnTreeNode; visited: boolean }> = [];
	for (let index = forest.length - 1; index >= 0; index--) stack.push({ node: forest[index]!, visited: false });

	while (stack.length > 0) {
		const { node, visited } = stack.pop()!;
		if (!visited) {
			stack.push({ node, visited: true });
			for (let index = node.children.length - 1; index >= 0; index--) {
				stack.push({ node: node.children[index]!, visited: false });
			}
			continue;
		}

		const children = node.children.flatMap((child) => {
			const result = filtered.get(child);
			return result ? [result] : [];
		});
		if (matches(node) || children.length > 0) filtered.set(node, { ...node, children });
	}

	return forest.flatMap((node) => {
		const result = filtered.get(node);
		return result ? [result] : [];
	});
}

function activeFirst(nodes: TurnTreeNode[], activeIds: ReadonlySet<string>): TurnTreeNode[] {
	if (activeIds.size === 0) return nodes;
	return [...nodes].sort(
		(a, b) => Number(activeIds.has(b.user.entry.id)) - Number(activeIds.has(a.user.entry.id)),
	);
}

/** Flatten the user-turn tree, placing the active branch before inactive siblings. */
export function flattenTurnForest(
	forest: TurnTreeNode[],
	collapsedIds: ReadonlySet<string> = new Set(),
	activeIds: ReadonlySet<string> = new Set(),
): TurnRow[] {
	const rows: TurnRow[] = [];
	const orderedRoots = activeFirst(forest, activeIds);
	const multipleRoots = orderedRoots.length > 1;
	const stack: Array<{
		node: TurnTreeNode;
		indent: number;
		showConnector: boolean;
		isLast: boolean;
		gutters: Gutter[];
		isVirtualRootChild: boolean;
	}> = [];

	for (let index = orderedRoots.length - 1; index >= 0; index--) {
		stack.push({
			node: orderedRoots[index]!,
			indent: multipleRoots ? 1 : 0,
			showConnector: multipleRoots,
			isLast: index === orderedRoots.length - 1,
			gutters: [],
			isVirtualRootChild: multipleRoots,
		});
	}

	while (stack.length > 0) {
		const item = stack.pop()!;
		const collapsed = collapsedIds.has(item.node.user.entry.id);
		rows.push({ ...item, multipleRoots, collapsed });
		if (collapsed) continue;

		const children = activeFirst(item.node.children, activeIds);
		const branches = children.length > 1;
		const childIndent = branches ? item.indent + 1 : item.indent;
		const connectorDisplayed = item.showConnector && !item.isVirtualRootChild;
		const displayIndent = multipleRoots ? Math.max(0, item.indent - 1) : item.indent;
		const childGutters = connectorDisplayed
			? [...item.gutters, { position: Math.max(0, displayIndent - 1), show: true }]
			: item.gutters;

		for (let index = children.length - 1; index >= 0; index--) {
			stack.push({
				node: children[index]!,
				indent: childIndent,
				showConnector: branches,
				isLast: index === children.length - 1,
				gutters: childGutters,
				isVirtualRootChild: false,
			});
		}
	}
	return rows;
}

export function connectorGlyph(row: TurnRow): "⊞" | "⊟" {
	return row.collapsed ? "⊞" : "⊟";
}

export function rowPrefix(row: TurnRow): string {
	const displayIndent = row.multipleRoots ? Math.max(0, row.indent - 1) : row.indent;
	const connector = row.showConnector && !row.isVirtualRootChild;
	const connectorPosition = connector ? displayIndent - 1 : -1;
	let prefix = "";

	for (let level = 0; level < displayIndent; level++) {
		const gutter = row.gutters.find((item) => item.position === level);
		if (gutter) prefix += gutter.show ? "│  " : "   ";
		else if (level === connectorPosition) prefix += `├${connectorGlyph(row)} `;
		else prefix += "   ";
	}
	return prefix;
}

export type TurnQueryClause =
	| { kind: "text"; term: string }
	| { kind: "model"; term: string }
	| { kind: "file"; term: string }
	| { kind: "tool"; term: string }
	| { kind: "label"; term: string }
	| { kind: "cost"; op: ">" | "<"; value: number }
	| { kind: "branch"; active: boolean };

function facetValue(token: string, key: string): string | undefined {
	const prefix = `${key}:`;
	return token.startsWith(prefix) ? token.slice(prefix.length) || undefined : undefined;
}

/** Parse free text with facets: plain AND terms, quoted phrases, and model:/file:/tool:/label:/cost:>N/branch:active. */
export function parseTurnQuery(query: string): TurnQueryClause[] {
	const clauses: TurnQueryClause[] = [];
	for (const raw of query.match(/"[^"]+"|\S+/g) ?? []) {
		const token = raw.replace(/^"|"$/g, "").toLowerCase();
		if (!token) continue;

		const cost = /^cost:(>|<)([\d.]+)$/.exec(token);
		if (cost) {
			const value = Number(cost[2]);
			if (Number.isFinite(value)) {
				clauses.push({ kind: "cost", op: cost[1] === ">" ? ">" : "<", value });
				continue;
			}
		}

		const model = facetValue(token, "model");
		if (model) {
			clauses.push({ kind: "model", term: model });
			continue;
		}
		const file = facetValue(token, "file");
		if (file) {
			clauses.push({ kind: "file", term: file });
			continue;
		}
		const tool = facetValue(token, "tool");
		if (tool) {
			clauses.push({ kind: "tool", term: tool });
			continue;
		}
		const label = facetValue(token, "label");
		if (label) {
			clauses.push({ kind: "label", term: label });
			continue;
		}
		if (token.startsWith("branch:")) {
			const branch = token.slice("branch:".length);
			if (branch === "active") clauses.push({ kind: "branch", active: true });
			else if (branch === "inactive") clauses.push({ kind: "branch", active: false });
			continue;
		}

		clauses.push({ kind: "text", term: token });
	}
	return clauses;
}

export function matchesTurnQuery(node: TurnTreeNode, query: string, activeIds?: ReadonlySet<string>): boolean {
	if (!query.trim()) return true;
	const clauses = parseTurnQuery(query);
	if (clauses.length === 0) return true;

	const document = [
		userText(node.user),
		messageText(node.assistant ?? node.user),
		node.user.label ?? "",
		node.insight.model ?? "",
		...node.insight.tools.map((tool) => tool.name),
		...node.insight.readFiles,
		...node.insight.modifiedFiles,
	]
		.join(" ")
		.toLowerCase();
	const files = [...node.insight.readFiles, ...node.insight.modifiedFiles].map((path) => path.toLowerCase());
	const tools = node.insight.tools.map((tool) => tool.name.toLowerCase());
	const label = (node.user.label ?? "").toLowerCase();
	const model = (node.insight.model ?? "").toLowerCase();

	for (const clause of clauses) {
		switch (clause.kind) {
			case "text":
				if (!document.includes(clause.term)) return false;
				break;
			case "model":
				if (!model.includes(clause.term)) return false;
				break;
			case "file":
				if (!files.some((path) => path.includes(clause.term))) return false;
				break;
			case "tool":
				if (!tools.some((name) => name.includes(clause.term))) return false;
				break;
			case "label":
				if (!label.includes(clause.term)) return false;
				break;
			case "cost":
				if (clause.op === ">" ? !(node.insight.cost > clause.value) : !(node.insight.cost < clause.value)) return false;
				break;
			case "branch":
				if (activeIds && clause.active !== activeIds.has(node.user.entry.id)) return false;
				break;
		}
	}
	return true;
}

export function matchesTurnFilter(
	node: TurnTreeNode,
	mode: OutlineFilterMode,
	activeIds: ReadonlySet<string>,
): boolean {
	if (mode === "active") return activeIds.has(node.user.entry.id);
	if (mode === "labeled") return node.user.label !== undefined;
	if (mode === "branches") return node.children.length > 1;
	return true;
}

/**
 * Resolve the entry id to navigate to for a turn.
 *
 * Continuing (`preferReply` true) targets the terminal assistant reply so the
 * Q+A pair stays on the active branch and the conversation resumes after the
 * answer; it falls back to the user message when the turn has no final reply.
 * Re-editing (`preferReply` false) always targets the user message, which makes
 * Pi open the editor pre-filled with the original prompt for re-asking.
 */
export function navigateTargetId(node: TurnTreeNode, preferReply: boolean): string {
	return preferReply ? (node.assistant?.entry.id ?? node.user.entry.id) : node.user.entry.id;
}

/** Cost threshold (USD) above which a turn is marked costly in the status glyphs. */
export const TURN_COST_THRESHOLD = 0.05;

/**
 * Single-character status glyphs for a turn: `!` errors, `$` costly, `+` wrote
 * files, `~` read-only, `★` labeled. Ordered by scanning priority.
 */
export function turnStatusGlyphs(node: TurnTreeNode): string {
	const glyphs: string[] = [];
	if (node.insight.toolErrors > 0) glyphs.push("!");
	if (node.insight.cost > TURN_COST_THRESHOLD) glyphs.push("$");
	if (node.insight.modifiedFiles.length > 0) glyphs.push("+");
	else if (node.insight.readFiles.length > 0) glyphs.push("~");
	if (node.user.label) glyphs.push("★");
	return glyphs.join("");
}

export type SessionRollup = {
	turns: number;
	branchPoints: number;
	cost: number;
	inputTokens: number;
	outputTokens: number;
	files: number;
	model?: string;
};

/** Aggregate the whole turn forest into session-level statistics. */
export function sessionRollup(forest: TurnTreeNode[], activeIds?: ReadonlySet<string>): SessionRollup {
	let turns = 0;
	let branchPoints = 0;
	let cost = 0;
	let inputTokens = 0;
	let outputTokens = 0;
	const files = new Set<string>();
	let traversalModel: string | undefined;
	let activeModel: string | undefined;
	const stack = [...forest].reverse();
	while (stack.length > 0) {
		const node = stack.pop()!;
		turns++;
		if (node.children.length > 1) branchPoints++;
		cost += node.insight.cost;
		inputTokens += node.insight.inputTokens;
		outputTokens += node.insight.outputTokens;
		for (const path of node.insight.readFiles) files.add(path);
		for (const path of node.insight.modifiedFiles) files.add(path);
		if (node.insight.model) {
			traversalModel = node.insight.model;
			if (activeIds && activeIds.has(node.user.entry.id)) activeModel = node.insight.model;
		}
		for (let index = node.children.length - 1; index >= 0; index--) stack.push(node.children[index]!);
	}
	return { turns, branchPoints, cost, inputTokens, outputTokens, files: files.size, model: activeModel ?? traversalModel };
}

export function formatSessionRollup(rollup: SessionRollup): string {
	const parts = [`${rollup.turns} turns`, `${rollup.branchPoints} forks`];
	if (rollup.cost > 0) parts.push(`$${rollup.cost.toFixed(rollup.cost < 0.01 ? 4 : 2)}`);
	if (rollup.inputTokens || rollup.outputTokens) {
		parts.push(`tokens ↑${compactNumber(rollup.inputTokens)} ↓${compactNumber(rollup.outputTokens)}`);
	}
	parts.push(`${rollup.files} files`);
	if (rollup.model) parts.push(rollup.model);
	return parts.join(" · ");
}

export type EntryRow = {
	entryId: string;
	role: string;
	tool?: string;
	path?: string;
	text: string;
	isError: boolean;
};

/** Flatten a turn's internal message chain (user message through tool calls to the final reply) for drill-down. */
export function entryRows(node: TurnTreeNode): EntryRow[] {
	return node.entries
		.filter((entry) => entry.entry.type === "message")
		.map((entry) => {
			const message = rawMessage(entry);
			const role = typeof message?.role === "string" ? message.role : entry.entry.type;
			let tool: string | undefined;
			let path: string | undefined;
			if (message && Array.isArray(message.content)) {
				const toolCalls = message.content.filter(
					(block): block is Record<string, unknown> => isRecord(block) && block.type === "toolCall" && typeof block.name === "string",
				);
				if (toolCalls.length > 0) {
					tool = toolCalls.map((block) => block.name as string).join(", ");
					const firstArgs = isRecord(toolCalls[0]!.arguments) ? toolCalls[0]!.arguments : {};
					path = toolPath(firstArgs);
				}
			}
			return {
				entryId: entry.entry.id,
				role,
				tool,
				path,
				text: messageText(entry),
				isError: message?.isError === true,
			};
		});
}

function compactNumber(value: number): string {
	if (value < 1_000) return String(Math.round(value));
	if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`;
	return `${(value / 1_000_000).toFixed(1)}m`;
}

function formatDuration(durationMs: number): string {
	if (durationMs < 1_000) return `${durationMs}ms`;
	if (durationMs < 60_000) return `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0)}s`;
	return `${Math.floor(durationMs / 60_000)}m${Math.round((durationMs % 60_000) / 1_000)}s`;
}

export function formatTurnInsight(insight: TurnInsight): string {
	const parts: string[] = [];
	if (insight.model) parts.push(insight.model);
	if (insight.durationMs !== undefined) parts.push(formatDuration(insight.durationMs));
	if (insight.inputTokens || insight.outputTokens) {
		parts.push(`tokens ↑${compactNumber(insight.inputTokens)} ↓${compactNumber(insight.outputTokens)}`);
	}
	if (insight.cost > 0) parts.push(`$${insight.cost.toFixed(insight.cost < 0.01 ? 4 : 3)}`);
	if (insight.toolCalls > 0) {
		parts.push(`tools ${insight.toolCalls}${insight.toolErrors ? ` !${insight.toolErrors}` : ""}`);
	}
	if (insight.readFiles.length || insight.modifiedFiles.length) {
		parts.push(`files R${insight.readFiles.length}/W${insight.modifiedFiles.length}`);
	}
	return parts.join(" · ") || "no activity yet";
}
