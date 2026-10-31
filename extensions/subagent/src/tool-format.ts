/** Shared formatting for foreground tool calls and result-file previews. */

/** The slice of the theme a row needs, so tests need no terminal theme. */
export interface RowTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
	//
	// Optional because only the markdown body needs them, and a theme that cannot do italic
	// should leave the text alone rather than be handed styling it never asked for. Pi's own
	// theme has all three.
	italic?(text: string): string;
	underline?(text: string): string;
	strikethrough?(text: string): string;
}

/**
 * Text as one terminal line, with escape sequences and control characters removed.
 *
 * A value from outside can carry a newline, a tab, or a bare `\x1b[0m`, and any of
 * them makes a measured-to-fit line paint differently from how it measured.
 *
 * The escape pattern matches **whole** sequences, including the string forms (OSC, DCS,
 * APC, SOS, PM). An unterminated one is consumed to the end of its line: stripping only
 * the ESC byte leaves `8;;http://…` or `Gi=1;AAAA` on screen as literal text.
 */
const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b[\]PX^_][^\x07\x1b\n]*(?:\x07|\x1b\\|(?=\n|$))|\x1b[@-_]/g;
/** Control characters that move the cursor instead of taking up cells. */
const CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

export function singleLine(text: string): string {
	return text
		.replace(ANSI_PATTERN, "")
		.replace(/\t/g, "    ")
		.replace(/\r/g, "")
		.replace(/\n/g, " ")
		.replace(CONTROL_PATTERN, "");
}

/**
 * Compact token count: `850`, `12.3k`, `1.2M`.
 *
 * Tokens rather than cost wherever a single figure has to fit, because cost is
 * zero for a model with no pricing and a column of `$0.00` says nothing.
 *
 * The unit is chosen after rounding: `999_999` is `1.0M`, not `1000.0k`.
 */
export function formatTokens(tokens: number): string {
	if (tokens < 1_000) return `${tokens}`;
	if (tokens < 1_000_000) {
		const thousands = Math.round(tokens / 100) / 10;
		if (thousands < 1_000) return `${thousands.toFixed(1)}k`;
	}
	return `${(tokens / 1_000_000).toFixed(1)}M`;
}
