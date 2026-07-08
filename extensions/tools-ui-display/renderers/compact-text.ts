import { Text } from "@earendil-works/pi-tui";
import { CompactToolRow, type CompactToolRowSuffixCandidate } from "../components/compact-tool-row.js";
import type { ToolUiStatus } from "../style.js";

/** Shared compact renderer state for a persisted call row. */
export type CompactState<TComponent = Text> = {
	compactCallText?: TComponent;
	compactStatus?: ToolUiStatus;
};

/** Compact state for renderers whose collapsed row is a width-aware segmented row. */
export type CompactToolRowState = CompactState<CompactToolRow>;

/** Compact state that also persists a summary string for later reconstruction. */
export type CompactSummaryState<TComponent = Text> = CompactState<TComponent> & {
	compactSummary?: string;
};

/** Summary-bearing compact state for segmented compact tool rows. */
export type CompactSummaryRowState = CompactSummaryState<CompactToolRow>;

export function ensureCompactToolRow<TState extends CompactState<CompactToolRow>>(state: TState, component: unknown): CompactToolRow {
	const row = component instanceof CompactToolRow ? component : state.compactCallText ?? new CompactToolRow();
	state.compactCallText = row as TState["compactCallText"];
	return row;
}

export function getCompactCallText<TState extends { compactCallText?: unknown }>(state: TState): TState["compactCallText"] {
	return state.compactCallText;
}

export function setCompactRow<TComponent extends CompactToolRow | undefined>(
	component: TComponent,
	prefix: string,
	body: string,
	suffix = "",
	suffixCandidates: CompactToolRowSuffixCandidate[] = [],
): TComponent {
	component?.setParts(prefix, body, suffix, suffixCandidates);
	return component;
}

export function settleCompactState<TState extends Pick<CompactSummaryState, "compactStatus" | "compactSummary">>(
	state: TState,
	status: ToolUiStatus,
	summary?: string,
) {
	state.compactStatus = status;
	state.compactSummary = summary;
}

export function settleCompactRow<TState extends Pick<CompactState, "compactStatus">>(
	state: TState,
	component: CompactToolRow | undefined,
	status: ToolUiStatus,
	prefix: string,
	body: string,
	suffix = "",
	suffixCandidates: CompactToolRowSuffixCandidate[] = [],
) {
	state.compactStatus = status;
	setCompactRow(component, prefix, body, suffix, suffixCandidates);
}

export function settleCompactSummaryRow<TState extends Pick<CompactSummaryState, "compactStatus" | "compactSummary">>(
	state: TState,
	component: CompactToolRow | undefined,
	status: ToolUiStatus,
	summary: string | undefined,
	prefix: string,
	body: string,
	suffix = "",
	suffixCandidates: CompactToolRowSuffixCandidate[] = [],
) {
	settleCompactState(state, status, summary);
	setCompactRow(component, prefix, body, suffix, suffixCandidates);
}
