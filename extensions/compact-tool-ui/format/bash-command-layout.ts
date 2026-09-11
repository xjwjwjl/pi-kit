import type { BashCommandLayout, BashLayoutNode, BashCommandToken } from "./unbash-adapter.js";

export type BashCommandLayoutLine = {
	indent: number;
	tokens: BashCommandToken[];
	trailingOperator?: string;
	raw?: string;
};

export type BashCommandRenderLayout = {
	lines: BashCommandLayoutLine[];
	statementCount: number;
	pipelineStages: number;
	formatted: boolean;
};

function appendOperator(line: BashCommandLayoutLine | undefined, operator: string) {
	if (!line || line.raw !== undefined) return;
	line.trailingOperator = operator;
}

function countPipelineStages(node: BashLayoutNode): number {
	if (node.kind === "pipeline") return node.children.length;
	if (node.kind === "and-or") return node.children.reduce((total, child) => total + countPipelineStages(child), 0);
	return 0;
}

function layoutNode(node: BashLayoutNode, indent: number): BashCommandLayoutLine[] {
	if (node.kind === "raw") return [{ indent, tokens: [], raw: node.source }];
	if (node.kind === "simple") return [{ indent, tokens: node.tokens }];

	const lines: BashCommandLayoutLine[] = [];
	for (let index = 0; index < node.children.length; index++) {
		const child = node.children[index];
		if (!child) continue;
		const childLines = layoutNode(child, indent + (index === 0 ? 0 : 1));
		lines.push(...childLines);
		if (index < node.operators.length) appendOperator(lines[lines.length - 1], node.operators[index] ?? "");
	}
	return lines;
}

export function layoutBashCommand(model: BashCommandLayout): BashCommandRenderLayout {
	const lines: BashCommandLayoutLine[] = [];
	for (const statement of model.statements) {
		const statementLines = layoutNode(statement.node, 0);
		if (statement.terminator) appendOperator(statementLines[statementLines.length - 1], statement.terminator);
		lines.push(...statementLines);
	}
	const pipelineStages = model.statements.reduce((total, statement) => total + countPipelineStages(statement.node), 0);
	return { lines, statementCount: model.statementCount, pipelineStages, formatted: model.formatted };
}
