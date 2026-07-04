import { chartTypeGuidance } from "./chart-types.js";

export type DrawRequestMode = "auto" | "excalidraw" | "mermaid";

export type DrawRequestPromptOptions = {
	scenePath?: string | null;
	openPreview?: boolean;
	mode?: DrawRequestMode;
};

export function buildDrawRequestPrompt(description: string, options: DrawRequestPromptOptions = {}): string {
	const mode = options.mode ?? "auto";
	const sceneInstruction = options.scenePath
		? [
				`当前场景文件：${options.scenePath}`,
				"- 如果这是调整请求，请先读取当前场景文件，理解已有元素后再更新。",
				"- 保存时可以覆盖当前场景文件，除非用户要求另存。",
			].join("\n")
		: "- 如果是新图，请创建新的 pi-draw 场景文件。";
	const modeInstruction =
		mode === "mermaid"
			? [
					"渲染模式：Mermaid",
					"- 生成 Mermaid DSL，并调用 pi_draw_save_mermaid_scene 保存。",
					"- Web 预览会以原生 Mermaid SVG 渲染，不要转换成 ExcalidrawElementSkeleton。",
					"- 不要调用 pi_draw_save_scene。",
				].join("\n")
			: mode === "excalidraw"
				? [
						"渲染模式：Excalidraw",
						"- 生成 ExcalidrawElementSkeleton JSON 数组，并调用 pi_draw_save_scene 保存。",
						"- 不要调用 pi_draw_save_mermaid_scene，即使用户提到了 Mermaid 风格或 DSL。",
					].join("\n")
				: [
						"渲染模式：auto",
						"- 如果用户明确要求 Mermaid 或提供 Mermaid DSL，调用 pi_draw_save_mermaid_scene。",
						"- 其他绘图需求默认生成 ExcalidrawElementSkeleton 并调用 pi_draw_save_scene。",
					].join("\n");
	const chartGuidance = mode === "mermaid" ? "" : chartTypeGuidance(description);

	return [
		"[pi-draw-request]",
		"请使用 pi-draw 处理下面的绘图需求。",
		"",
		"工作方式：",
		modeInstruction,
		"- 在完整场景准备好后调用一次对应的保存工具，不要保存半成品草稿。",
		options.openPreview ? "- 保存时设置 openPreview=true；预览页会在保存完成后打开，或在已打开的页面中自动更新。" : undefined,
		"- 不要把大段 JSON 或 Mermaid 源码直接输出给用户，保存成功后总结文件路径和图表内容。",
		sceneInstruction,
		"",
		chartGuidance,
		"",
		`用户需求：${description}`,
	]
		.filter((line): line is string => Boolean(line))
		.join("\n");
}
