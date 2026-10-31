import type { AskUserAnswer } from "./schema.ts";

/** Fixed UI copy only. Caller text and model-facing result content stay unchanged. */
export const UI_TEXT = {
	defaultTitle: "请确认",
	customAnswer: "自定义回答",
	optional: "（可选）",
	defaultSource: "（默认）",
	customSource: "（自填）",
	emptyAnswer: "（未填写）",
	emptySelection: "（未选择）",
	skipped: "已跳过",
	skippedRequired: "已跳过 · 仍待确认",
	noteEditor: "附加说明（可选，留空清除）：",
	notePrefix: "附加说明：",
	previewPrefix: "预览：",
	previewTruncated: "…（预览已截断）",
	emptyInput: "请先填写内容。",
	editorHelp: "Enter 保存 · Esc 返回",
	auxiliaryHelp: "Tab 切换 · Enter 确认 · ↑↓ 返回答案 · ←→ 切题 · Esc 取消",
	singleHelp: "↑↓ 选择 · Enter 确认并下一题 · ←→ 切题",
	singleHelpSubmit: "↑↓ 选择 · Enter 确认并提交",
	multiHelp: "↑↓ 选择 · Space 勾选 · Enter 完成并下一题 · ←→ 切题",
	multiHelpSubmit: "↑↓ 选择 · Space 勾选 · Enter 提交",
	singleHelpLast: "↑↓ 选择 · Enter 确认并预览",
	multiHelpLast: "↑↓ 选择 · Space 勾选 · Enter 完成并预览",
	requiredSelection: "请先选择一项，或按 Ctrl+S 跳过。",
	requiredSelectionSingle: "请先选择一项。",
	previewHelp: " · Ctrl+O 预览",
	cancelHelp: " · Esc 取消",
	scrollHelp: "Alt+↑↓ 滚动 · ",
	cancelled: "已取消",
	errorPrefix: "错误：",
} as const;

export function answerSourceLabel(answer: Pick<AskUserAnswer, "wasDefault" | "wasCustom">): string {
	return answer.wasDefault ? UI_TEXT.defaultSource : answer.wasCustom ? UI_TEXT.customSource : "";
}

export function unresolvedWarning(ids: readonly string[]): string {
	return `待确认：${ids.join(", ")}。跳过和附加说明不代表批准。`;
}
