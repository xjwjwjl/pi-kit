import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export function sanitizeLabel(label: string): string {
	return stripSequences(label)
		.replace(/[\r\n\t\u2028\u2029]/g, " ")
		.replace(/[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
		.trim();
}

/** Strip terminal/control sequences but keep line breaks for multi-line transcript text. */
export function sanitizeMultilineText(text: string): string {
	return stripSequences(text.replace(/\r\n?/g, "\n"))
		.replace(/[\t\u2028\u2029]/g, " ")
		.replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");
}

function stripSequences(text: string): string {
	// Normalize C1 sequence introducers so the public stripper handles both forms.
	return stripTerminalSequences(text.replace(/[\x90\x9b\x9d\x9e\x9f]/g, (char) =>
		`\x1b${String.fromCharCode(char.charCodeAt(0) - 0x40)}`,
	).replace(/\x9c/g, "\x1b\\"));
}

/**
 * Render caller-provided tabs only; the caller includes status prefixes and Submit.
 * The optional style callback must preserve visible text, its width and line count;
 * its index always refers to the original caller-provided tab, including overflow.
 * Invalid widths render nothing; indices are floored/clamped (nonfinite means 0).
 * Overflow shows only the current tab, with index/count and navigation when space
 * permits. Very narrow widths omit padding to retain as much label as possible.
 */
export function renderTabBar(
	labels: readonly string[],
	activeIndex: number,
	width: number,
	style?: (text: string, active: boolean, index: number) => string,
): string {
	if (!labels.length || !Number.isFinite(width) || width < 1) return "";
	const columns = Math.floor(width);
	const current = Math.max(0, Math.min(labels.length - 1, Number.isFinite(activeIndex) ? Math.floor(activeIndex) : 0));
	const paint = style ?? ((text: string) => text);
	// Bound subsequent width/layout work even when a caller provides huge labels.
	const clean = labels.map((label) => stripTerminalSequences(truncateToWidth(sanitizeLabel(label), columns + 1, "…")));
	const tokens = clean.map((label) => ` ${label} `);
	const fullWidth = tokens.reduce((sum, token) => sum + visibleWidth(token), labels.length - 1 + 5);
	if (fullWidth <= columns) {
		return " ← " + tokens.map((token, index) => paint(token, index === current, index)).join(" ") + " →";
	}

	const position = `${current + 1}/${labels.length}`;
	const left = current > 0 ? " ← " : "";
	const right = current < labels.length - 1 ? " →" : "";
	// Reserve a useful current token before spending columns on metadata.
	const minimumToken = Math.min(visibleWidth(tokens[current]), Math.max(5, Math.min(columns, 10)));
	let prefix = "";
	let suffix = "";
	if (columns >= minimumToken + position.length + 1) {
		suffix = ` ${position}`;
		if (columns >= minimumToken + suffix.length + left.length + right.length) {
			prefix = left;
			suffix += right;
		}
	}
	const tokenWidth = columns - visibleWidth(prefix + suffix);
	const padding = tokenWidth >= 4 ? " " : "";
	const labelWidth = tokenWidth - padding.length * 2;
	const token = padding + stripTerminalSequences(truncateToWidth(clean[current], labelWidth, "…")) + padding;
	return prefix + paint(token, true, current) + suffix;
}
