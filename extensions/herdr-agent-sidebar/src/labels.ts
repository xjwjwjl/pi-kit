import { formatSettledStateLabel } from "./format.ts";

/**
 * Human-readable text for each Herdr agent lifecycle state.
 *
 * `report-metadata --state-label` replaces the whole label map for its source,
 * so every write has to send the complete set; writing one key drops the rest.
 */
export const BASE_STATE_LABELS: ReadonlyArray<readonly [string, string]> = [
  ["working", "working"],
  ["blocked", "reply needed"],
  ["idle", "idle"],
  ["done", "done"],
  ["unknown", "unknown"],
];

export function baseStateLabelArgs(): string[] {
  return BASE_STATE_LABELS.flatMap(([state, text]) => ["--state-label", `${state}=${text}`]);
}

/** Full label set with `done` replaced by the settled outcome label. */
export function settleStateLabelArgs(
  outcome: string | undefined,
  date: Date,
): string[] | undefined {
  const label = formatSettledStateLabel(outcome, date);
  if (!label) return undefined;

  return [...baseStateLabelArgs(), "--state-label", `done=${label}`];
}
