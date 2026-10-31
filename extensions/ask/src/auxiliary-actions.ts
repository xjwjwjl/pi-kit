import { visibleWidth } from "@earendil-works/pi-tui";

export type AuxiliaryAction = "note" | "skip";

// Prefer complete controls and help; shorten both controls together, never truncate a row.
const layouts = [
	["[附加说明 Ctrl+N]", "[跳过 Ctrl+S]", "Tab切换 Enter确认"],
	["[附加说明]", "[跳过]", "Tab切换 Enter确认"],
	["[附加说明]", "[跳过]", "Tab/Enter"],
	["[附加说明]", "[跳过]", "Tab"],
	["[说明]", "[跳过]", "Tab"],
	["说明", "跳过", "Tab"],
	["注", "跳", "Tab"],
	["注", "跳", ""],
] as const;

/**
 * Render one fixed-label auxiliary row, independently of answer options.
 * Style callbacks must preserve visible text, width and line count. Help receives
 * no action and is never active; compact controls retain their original action.
 * `skippable: false` drops the Skip control, because a single-question flow has no
 * question left to keep the skip local to.
 */
export function renderAuxiliaryActions(
	width: number,
	focus: AuxiliaryAction | undefined,
	style?: (text: string, action: AuxiliaryAction | undefined, active: boolean) => string,
	{ skippable = true }: { skippable?: boolean } = {},
): string {
	if (!Number.isFinite(width) || width < 2) return "";
	const columns = Math.floor(width);
	const paint = style ?? ((text: string) => text);
	const tokensOf = (layout: readonly string[]) => layout.filter((token, index) => token !== "" && (skippable || index !== 1));
	const layout = layouts.find((candidate) => visibleWidth(tokensOf(candidate).join(" ")) <= columns);
	if (!layout) {
		// Only one control fits: it must represent the actual focus, not always note.
		const action = skippable ? focus ?? "note" : "note";
		return paint(action === "note" ? "注" : "跳", action, action === focus);
	}
	const [note, skip, help] = layout;
	const segments = [paint(note, "note", focus === "note")];
	if (skippable) segments.push(paint(skip, "skip", focus === "skip"));
	if (help) segments.push(paint(help, undefined, false));
	return segments.join(" ");
}
