export type BashDisplayOptions = {
	successfulOutputSummary?: boolean;
	runningTailPreview?: boolean;
	successfulTailPreview?: boolean;
	previewLines?: number;
};

export const DEFAULT_BASH_DISPLAY_OPTIONS: Required<BashDisplayOptions> = {
	successfulOutputSummary: true,
	runningTailPreview: false,
	successfulTailPreview: false,
	previewLines: 2,
};

export type MutableBashDisplayOptions = Required<BashDisplayOptions>;

export type EditDisplayOptions = {
	inlineDiffMaxLines?: number;
};

export const DEFAULT_EDIT_DISPLAY_OPTIONS: Required<EditDisplayOptions> = {
	inlineDiffMaxLines: 64,
};

export type MutableEditDisplayOptions = Required<EditDisplayOptions>;

export type ToolRenderShell = "self" | "default";

export const DEFAULT_TOOL_RENDER_SHELL: ToolRenderShell = "self";

export type MutableToolsUiDisplayOptions = {
	bash: MutableBashDisplayOptions;
	edit: MutableEditDisplayOptions;
	renderShell: ToolRenderShell;
};
