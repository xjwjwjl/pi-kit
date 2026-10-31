import type { AgentToolResult, CodemodeToolDetails } from "@earendil-works/pi-coding-agent";
import { sanitizeInlineText, stripAnsi, textBlocks } from "../core-utils.js";
import { summarizeBashCommand } from "../format/bash-command-summary.js";
import { summarizePath } from "../format/path-summary.js";

type NativeCall = CodemodeToolDetails["calls"][number];

export type CodemodeCallPreview = Pick<NativeCall, "name" | "args" | "durationMs" | "error" | "cost"> & {
	status: NativeCall["status"] | "unknown";
};

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function nonnegativeNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Normalize display snapshots without assuming saved or partial details have the latest shape. */
export function codemodeCallPreviews(details: unknown): CodemodeCallPreview[] | undefined {
	const calls = record(details)?.calls;
	if (!Array.isArray(calls)) return undefined;
	return calls.map((value) => {
		const call = record(value);
		const status = call?.status;
		return {
			name: typeof call?.name === "string" && call.name ? sanitizeInlineText(call.name) : "unknown tool",
			args: typeof call?.args === "string" ? sanitizeInlineText(call.args) : "",
			status: status === "running" || status === "ok" || status === "error" || status === "cancelled" ? status : "unknown",
			durationMs: nonnegativeNumber(call?.durationMs),
			error: typeof call?.error === "string" ? stripAnsi(call.error) : undefined,
			cost: nonnegativeNumber(call?.cost),
		};
	});
}

export function codemodeFullOutputPath(details: unknown): string | undefined {
	const value = record(details)?.fullOutputPath;
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** `args` is a bounded preview, not a JSON contract; truncated previews must remain readable. */
export function codemodeCallTarget(call: CodemodeCallPreview): string {
	let args: Record<string, unknown> | undefined;
	try {
		args = record(JSON.parse(call.args));
	} catch {
		return call.args;
	}
	if (!args) return call.args;
	if (["read", "write", "edit"].includes(call.name)) {
		const path = args.path ?? args.file_path;
		if (typeof path === "string") return summarizePath(path);
	}
	if (call.name === "bash" && typeof args.command === "string") return summarizeBashCommand(args.command).text;
	return call.args;
}

export function codemodeCallGroups(calls: CodemodeCallPreview[] | undefined): Array<[string, number]> {
	const counts = new Map<string, number>();
	for (const call of calls ?? []) counts.set(call.name, (counts.get(call.name) ?? 0) + 1);
	return [...counts];
}

export function codemodeCallCounts(calls: CodemodeCallPreview[] | undefined) {
	const counts = { running: 0, ok: 0, error: 0, cancelled: 0, unknown: 0 };
	for (const call of calls ?? []) counts[call.status]++;
	return counts;
}

// Match only the standalone native header block, never a header-like string inside user output.
const SCRIPT_HEADER = /^Script (completed|failed)\r?\nWall time (\d+(?:\.\d+)?) seconds\r?\nOutput:\r?\n$/;

export function codemodeOutput(result: AgentToolResult<unknown>) {
	const first = result.content[0];
	const header = first?.type === "text" ? first.text.match(SCRIPT_HEADER) : undefined;
	const content = header ? result.content.slice(1) : result.content;
	return {
		text: stripAnsi(textBlocks({ content })).trimEnd(),
		durationMs: header ? nonnegativeNumber(Number(header[2]) * 1000) : undefined,
		failed: header?.[1] === "failed",
	};
}

export function codemodeModelCost(calls: CodemodeCallPreview[] | undefined): number | undefined {
	const total = (calls ?? []).reduce((sum, call) => sum + (call.cost ?? 0), 0);
	return total > 0 && Number.isFinite(total) ? total : undefined;
}

export function formatCodemodeCost(cost: number): string {
	return `$${cost >= 0.01 ? cost.toFixed(2) : cost.toPrecision(2)}`;
}

export function formatCodemodeCallDuration(ms: number | undefined): string | undefined {
	if (ms === undefined) return undefined;
	return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}
