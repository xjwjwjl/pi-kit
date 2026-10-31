import type { Usage } from "@earendil-works/pi-ai";

/** Plain data from one foreground invocation; never owns an SDK session. */
export type RunStatus = "finished" | "failed" | "aborted";

interface RunOutput {
	readonly responseText: string;
	readonly usage: { readonly tokens: number; readonly cost: number };
	readonly toolUses: number;
	/** Nested inference usage, for Pi's tool-result accounting. */
	readonly modelUsage?: Usage;
	readonly transcriptPath?: string;
	/** In-process cancellation cannot forcibly terminate an uncooperative tool. */
	readonly cleanupWarning?: string;
}

export type RunOutcome = RunOutput & (
	| { readonly status: "finished" }
	| { readonly status: "failed"; readonly error: string }
	| {
		readonly status: "aborted";
		readonly reason: "cancelled" | "turn_limit" | "sdk_abort";
		/** Present when a turn limit caused the abort. */
		readonly limit?: number;
	}
);

export function cancelledOutcome(): Extract<RunOutcome, { status: "aborted" }> {
	return { status: "aborted", reason: "cancelled", responseText: "", usage: { tokens: 0, cost: 0 }, toolUses: 0 };
}

/** Recheck at acknowledgement boundaries, without discarding output or spend. */
export function cancelIfRequested(outcome: RunOutcome, signal?: AbortSignal): RunOutcome {
	if (!signal?.aborted || (outcome.status === "aborted" && outcome.reason === "cancelled")) return outcome;
	const { limit: _limit, ...rest } = outcome as RunOutcome & { limit?: number };
	return { ...rest, status: "aborted", reason: "cancelled" };
}

export function failedOutcome(error: unknown): Extract<RunOutcome, { status: "failed" }> {
	const message = error instanceof Error ? error.message : String(error);
	return { status: "failed", error: message.trim() || "the agent failed",
		responseText: "", usage: { tokens: 0, cost: 0 }, toolUses: 0 };
}
