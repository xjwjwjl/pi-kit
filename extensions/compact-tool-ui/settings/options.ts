export type EditDisplayOptions = {
	inlineDiffMaxLines?: number;
};

/** `inlineDiffMaxLines` sentinel: never render a diff inline, whatever its size. */
export const INLINE_DIFF_NEVER = -1;

/** `inlineDiffMaxLines` sentinel: render every diff inline, whatever its size. */
export const INLINE_DIFF_UNLIMITED = 0;

export const DEFAULT_EDIT_DISPLAY_OPTIONS: Required<EditDisplayOptions> = {
	inlineDiffMaxLines: 64,
};

/**
 * Single place where the `-1` sentinel is understood: any negative value collapses to
 * `INLINE_DIFF_NEVER` so a raw `-5` can never leak into a renderer.
 */
export function normalizeInlineDiffMaxLines(value: number): number {
	const lines = Math.floor(value);
	if (!Number.isFinite(lines)) return DEFAULT_EDIT_DISPLAY_OPTIONS.inlineDiffMaxLines;
	return lines < 0 ? INLINE_DIFF_NEVER : lines;
}

export type ToolRenderShell = "self" | "default";

export const DEFAULT_TOOL_RENDER_SHELL: ToolRenderShell = "self";

/** Fully resolved options: every field defaults are applied, renderers read these directly. */
export type EffectiveCompactToolUiOptions = {
	edit: Required<EditDisplayOptions>;
	renderShell: ToolRenderShell;
};

/**
 * Mutable handle shared with the live renderers. The settings command swaps `current` wholesale
 * after a save so hot-reload needs no field-by-field copying.
 */
export type CompactToolUiOptionsRef = { current: EffectiveCompactToolUiOptions };
