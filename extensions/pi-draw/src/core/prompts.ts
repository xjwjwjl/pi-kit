import { chartTypeListText } from "./chart-types.js";

export const PI_DRAW_SYSTEM_PROMPT = `## pi-draw diagram generation protocol

When the user asks to create, draw, convert, visualize, or update a diagram, use pi-draw.

Goal:
- For Excalidraw-style diagrams, generate an ExcalidrawElementSkeleton JSON array and save it with pi_draw_save_scene.
- For Mermaid diagrams, generate Mermaid DSL and save it with pi_draw_save_mermaid_scene.
- Keep Mermaid and Excalidraw separate: do not convert Mermaid into Excalidraw elements.
- Reply with a concise summary and the saved file path.

Do not output a large JSON array directly in the final answer unless the user explicitly asks for raw JSON.
Do not call pi_draw_save_scene with a partial draft. Plan first, then call pi_draw_save_scene once the full scene is ready.

Element format:
- Output an array of plain objects.
- Supported element types: rectangle, ellipse, diamond, text, arrow, line, freedraw, frame.
- Prefer stable ids for meaningful nodes.
- Bind arrows with start/end ids whenever connecting existing elements.
- For node labels, prefer label: { text, fontSize } on rectangle/ellipse/diamond.
- For standalone text, use { type: "text", x, y, text, fontSize }.
- Use 2-4 coherent colors and enough spacing to avoid overlap.
- Give every labeled node enough width and height for its text; pi-draw can expand undersized labels, but you should still plan spacing around the expanded node.
- Keep at least 32px visual gap between independent nodes and avoid placing standalone text over unrelated shapes.
- Plan the canvas coordinates before producing elements.

Chart type rules:
- If a chart type guidance block is provided, follow it.
- If the user did not specify a chart type, choose the most suitable type from this list:
${chartTypeListText()}
- You may combine chart types only when the user's content genuinely needs a mixed view.

Arrow rules:
- Use type: "arrow" for semantic connections.
- Prefer start: { id: "node-a" } and end: { id: "node-b" }.
- Bind arrows when both endpoints are in the same frame or both are outside frames.
- For arrows crossing between frames, do not put the arrow in frame.children; pi-draw will render it as a standalone connector after optimizing coordinates.
- Do not include points; pi-draw and Excalidraw derive them.
- Use label.text only when the relation needs a readable label.

Frame/group rules:
- Prefer rectangle background containers for visual lanes/zones; use frame only when true Excalidraw frame grouping is useful.
- A frame should reference children by id.
- Keep frame.children limited to elements that belong inside that frame; avoid listing cross-frame connector arrows as children.
- Do not use groupIds to attach elements to a frame; use frame.children instead.

Use pi_draw_save_scene with:
- elements: the JSON array of skeleton elements.
- title: a short diagram title.
- file: optional relative path under the project.
- optimize: true unless the user asks to preserve exact coordinates.
- openPreview: true when the user asks to see/open/preview the diagram.
- Call it once per complete scene, not once per partial group of elements.

Use pi_draw_save_mermaid_scene with:
- definition: the Mermaid diagram definition.
- title: a short diagram title.
- file: optional relative path under the project.
- openPreview: true when the user asks to see/open/preview the diagram.
- Prefer this tool only for Mermaid DSL input or explicit Mermaid diagram requests.
- Do not use pi_draw_save_scene for Mermaid output.
`;

const DRAW_REQUEST_PATTERNS = [
	/(?:画|绘制|生成|创建|设计|转换|转成|可视化).{0,40}(?:图|图表|流程|架构|结构|关系|拓扑|excalidraw)/i,
	/(?:流程图|架构图|思维导图|时序图|ER\s*图|UML|甘特图|泳道图|拓扑图|状态图|关系图|信息图)/i,
	/(?:mermaid|graph\s+(?:TD|TB|BT|RL|LR)|flowchart\s+(?:TD|TB|BT|RL|LR)|sequenceDiagram|classDiagram|erDiagram|stateDiagram)/i,
	/(?:draw|render|generate|create|convert|visualize).{0,40}(?:diagram|chart|flowchart|architecture|excalidraw)/i,
	/(?:diagram|chart|flowchart|architecture|excalidraw).{0,40}(?:draw|render|generate|create|convert|visualize)/i,
];

const META_PATTERNS = [
	/怎么实现|如何实现|实现方案|技术栈|迁移方案|代码 review|review|bug|报错|调试|修改.*代码|解释.*代码/i,
	/how to implement|implementation plan|tech stack|code review|bug|debug|fix/i,
];

export function isPiDrawRequest(prompt: string): boolean {
	const text = prompt.trim();
	if (!text) return false;
	if (text.includes("[pi-draw-request]")) return true;
	if (META_PATTERNS.some((pattern) => pattern.test(text))) return false;
	if (text.includes("pi_draw_save_scene") || text.includes("pi_draw_save_mermaid_scene")) return true;
	return DRAW_REQUEST_PATTERNS.some((pattern) => pattern.test(text));
}
