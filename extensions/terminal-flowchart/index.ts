import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const FLOWCHART_STYLE_PROMPT = `
## TERMINAL UI FLOWCHART SPEC

For the current request, render flowcharts in a terminal-style Unicode TUI layout.

OUTPUT RULES:
- Output ONLY the diagram inside one fenced plain-text code block.
- Never use Mermaid, Graphviz, PlantUML, Markdown tables, HTML, or images.
- Use Unicode box-drawing characters for borders and connectors.
- Keep alignment valid in monospace terminals.
- Prefer compact vertical layouts with one node per row.
- Avoid excessive diagram width.
- Avoid long horizontal chains of boxes.

VISUAL STYLE:
- Use a terminal title panel.
- Use title format: MAIN FLOW :: MODULE.
- If no title is provided, infer one from the process.
- If no clear title can be inferred, use FLOWCHART :: TUI.
- Use single-line boxes for actions.
- Use double-line boxes for decisions.
- Use ▼ and │ for vertical flow.
- Use YES / NO branch labels.
- Use ↺ for retries or loops.
- Avoid decorative Unicode or emojis except approved flow markers: ◎ ◆ ▼ ↺.

EXAMPLES:
- Title panel:

  ╔════════════════════════════╗
  ║      FLOWCHART :: TUI      ║
  ╚════════════════════════════╝

- Action node:

  ┌──────────────┐
  │ 输入用户名密码 │
  └──────┬───────┘

- Decision node:

     ╔════════════╗
     ║ 登录成功?  ║
     ╚═══╤════╤═══╝
       YES    NO

BOX ALIGNMENT RULES:
- Treat CJK characters as 2 display columns and ASCII characters as 1 display column.
- For each box, make the top/bottom border inner width equal to the visible width between side borders.
- Add trailing spaces after shorter labels so the right border aligns with the top and bottom borders.
- For Chinese labels, choose a box inner width at least label_display_width + 2 spaces.
- If unsure, make the box wider rather than narrower.

FLOW SEMANTICS:
- One node = one action or one decision.
- Preserve user-provided key steps and their order.
- Keep node text concise.
- Prefer verb-led action labels when practical.
- Use questions for decisions.
- Split long labels into multiple lines.
- Prefer abstraction over exhaustive detail.

LAYOUT RULES:
- Prefer one node per row; only place nodes side-by-side for short YES/NO branches.
- Do not snake long pipelines horizontally across the screen.
- Keep connectors straight.
- Avoid diagonal lines.
- Avoid long horizontal connectors like repeated ──── between many boxes.
- Keep nearby node widths visually consistent.
- Keep loops local and readable.
- Merge branches when they share the same next step.

COMPLEXITY CONTROL:
- Simplify overly complex systems into major phases.
- Merge low-priority steps without losing critical user-provided steps.
- If needed, split into multiple smaller diagrams.

LANGUAGE RULES:
- Prefer Chinese labels if the user writes Chinese.
- Prefer uppercase English titles.

START/END RULES:
- Use ◎ START / ◎ DONE
  or ◆ START / ◆ END.
- Render START and DONE/END as standalone marker lines, not as boxed action nodes.
`;

const FLOWCHART_NOUN_PATTERN = /流程\s*(?:图|圖|示意图|示意圖)|流程圖|flow\s*chart|flowchart/i;

const EXPLICIT_FLOWCHART_REQUEST_PATTERNS = [
	/(?:画|绘制|生成|输出|展示|渲染|整理|设计|做(?:一个|一张|一份)?|来(?:一个|一张|一份)?).{0,30}(?:流程\s*(?:图|圖|示意图|示意圖)|流程圖)/i,
	/(?:流程\s*(?:图|圖|示意图|示意圖)|流程圖).{0,30}(?:画|绘制|生成|输出|展示|渲染|整理|设计)/i,
	/(?:画|绘制|画出|输出|展示|整理).{0,30}流程(?!\s*(?:图|圖))/i,
	/(?:把|将).{0,60}流程.{0,20}(?:转成|转换成|改成|做成|画成|整理成|输出成).{0,20}图/i,
	/(?:把|将).{0,60}流程.{0,20}(?:画出来|画出|可视化|图示化)/i,
	/(?:终端风|炫酷终端|TUI|Unicode).{0,30}(?:画|绘制|生成|输出|展示).{0,40}流程/i,
	/(?:画|绘制|生成|输出|展示).{0,40}流程.{0,30}(?:终端风|炫酷终端|TUI|Unicode)/i,
	/(?:draw|render|generate|create|convert|format|show|produce).{0,40}(?:flow\s*chart|flowchart)/i,
	/(?:flow\s*chart|flowchart).{0,40}(?:draw|render|generate|create|convert|format|show|produce)/i,
];

const EXPLICIT_OTHER_FORMAT_PATTERN =
	/\bmermaid\b|plantuml|graphviz|\bdot\b|draw\.io|\bascii\b|asciiflow|markdown\s*表格/i;

const NEGATED_OTHER_FORMAT_PATTERN =
	/(?:不要|不用|别用|无需|非|不是|not|without).{0,20}(?:\bmermaid\b|plantuml|graphviz|\bdot\b|draw\.io|\bascii\b|asciiflow|markdown\s*表格)|(?:\bmermaid\b|plantuml|graphviz|\bdot\b|draw\.io|\bascii\b|asciiflow|markdown\s*表格).{0,20}(?:不要|不用|别用|无需|非|不是|not|without)/i;

const NEGATIVE_FLOWCHART_PATTERN =
	/(?:不要|不用|别用|无需).{0,6}流程\s*(?:图|圖)|(?:不是|非)\s*流程\s*(?:图|圖)|(?:不要|不用|别用|无需).{0,6}终端风|not\s+(?:a\s+)?flow\s*chart|no\s+flow\s*chart/i;

const META_DISCUSSION_PATTERN = /特点|规则|prompt|提示词|extension|扩展|插件|注入|实现方式|怎么做|如何做|是什么|什么是/i;

const CODING_CONTEXT_PATTERN =
	/(?:修复|修改|重构|调试|测试|编译|构建|运行|实现|开发|封装|编写|编辑|生成|创建).{0,30}(?:流程\s*(?:图|圖)|flow\s*chart|flowchart).{0,30}(?:组件|代码(?!块)|功能|编辑器|插件|扩展|库|模块|文件|API|component|code(?!\s*block)|editor|extension|plugin|library|module|file)|(?:流程\s*(?:图|圖)|flow\s*chart|flowchart).{0,30}(?:组件|代码(?!块)|功能|编辑器|插件|扩展|库|模块|文件|API|component|code(?!\s*block)|editor|extension|plugin|library|module|file).{0,30}(?:修复|修改|重构|调试|测试|编译|构建|运行|实现|开发|封装|编写|编辑|生成|创建|broken|bug|error)|(?:flowchart|流程图)[\w.-]*\.(?:ts|tsx|js|jsx|mjs|cjs|vue|svelte)|(?:流程\s*(?:图|圖)|flow\s*chart|flowchart).{0,20}(?:bug|报错|错误|异常|broken|error)/i;

const SHORTHAND_BLOCKING_CONTEXT_PATTERN =
	/bug|报错|错误|异常|broken|error|代码(?!块)|源码|文件|目录|项目|仓库|实现|开发|修改|修复|重构|插件|扩展|extension|component.*bug|code(?!\s*block)|file|repo|repository/i;

const REFERENCE_ONLY_PATTERN = /^(?:这个|那个|当前|现有|已有|上面|前面|刚才|之前).*(?:流程\s*(?:图|圖)|flow\s*chart|flowchart)/i;

const FLOWCHART_NOUN_AT_END_PATTERN = /(?:流程\s*(?:图|圖|示意图|示意圖)|流程圖|flow\s*chart|flowchart)[？?！!。.]*$/i;

function isExplicitFlowchartRequest(text: string): boolean {
	return EXPLICIT_FLOWCHART_REQUEST_PATTERNS.some((pattern) => pattern.test(text));
}

function isShorthandFlowchartRequest(text: string): boolean {
	if (!FLOWCHART_NOUN_PATTERN.test(text)) return false;
	if (REFERENCE_ONLY_PATTERN.test(text)) return false;

	const compact = text.replace(/\s+/g, "");
	if (compact.length > 50) return false;

	// Allow terse requests like "登录流程图" or "React 组件生命周期流程图",
	// but avoid coding/debugging shorthand like "流程图组件 bug".
	if (SHORTHAND_BLOCKING_CONTEXT_PATTERN.test(text) && !FLOWCHART_NOUN_AT_END_PATTERN.test(compact)) return false;

	return true;
}

export function isTerminalFlowchartRequest(prompt: string): boolean {
	const text = prompt.trim();
	if (!text) return false;

	if (EXPLICIT_OTHER_FORMAT_PATTERN.test(text) && !NEGATED_OTHER_FORMAT_PATTERN.test(text)) return false;
	if (NEGATIVE_FLOWCHART_PATTERN.test(text)) return false;
	if (CODING_CONTEXT_PATTERN.test(text)) return false;

	const explicitRequest = isExplicitFlowchartRequest(text);
	const shorthandRequest = isShorthandFlowchartRequest(text);
	if (!explicitRequest && !shorthandRequest) return false;

	// Avoid injecting style guidance for meta discussion, unless the user is explicitly
	// asking to generate/convert/render a flowchart in that same request.
	if (META_DISCUSSION_PATTERN.test(text) && !explicitRequest) return false;

	return true;
}

export default function terminalFlowchartExtension(pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event) => {
		if (!isTerminalFlowchartRequest(event.prompt)) return undefined;

		return {
			systemPrompt: `${event.systemPrompt}\n\n${FLOWCHART_STYLE_PROMPT}`,
		};
	});
}
