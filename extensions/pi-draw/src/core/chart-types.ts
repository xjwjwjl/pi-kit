export const CHART_TYPES = {
	auto: "auto",
	flowchart: "flowchart",
	mindmap: "mindmap",
	orgchart: "orgchart",
	sequence: "sequence",
	class: "class",
	er: "er",
	gantt: "gantt",
	timeline: "timeline",
	tree: "tree",
	network: "network",
	architecture: "architecture",
	dataflow: "dataflow",
	state: "state",
	swimlane: "swimlane",
	concept: "concept",
	fishbone: "fishbone",
	swot: "swot",
	pyramid: "pyramid",
	funnel: "funnel",
	venn: "venn",
	matrix: "matrix",
	infographic: "infographic",
} as const;

export type ChartType = keyof typeof CHART_TYPES;

export const CHART_TYPE_NAMES: Record<ChartType, string> = {
	auto: "自动",
	flowchart: "流程图",
	mindmap: "思维导图",
	orgchart: "组织架构图",
	sequence: "时序图",
	class: "UML 类图",
	er: "ER 图",
	gantt: "甘特图",
	timeline: "时间线",
	tree: "树形图",
	network: "网络拓扑图",
	architecture: "架构图",
	dataflow: "数据流图",
	state: "状态图",
	swimlane: "泳道图",
	concept: "概念图",
	fishbone: "鱼骨图",
	swot: "SWOT 分析图",
	pyramid: "金字塔图",
	funnel: "漏斗图",
	venn: "韦恩图",
	matrix: "矩阵图",
	infographic: "信息图",
};

export const CHART_VISUAL_SPECS: Partial<Record<Exclude<ChartType, "auto">, string>> = {
	flowchart: `### 流程图视觉规范
- 形状约定：开始/结束用 ellipse，处理步骤用 rectangle，判断用 diamond。
- 连接：使用 arrow 连接各节点，箭头需绑定到元素。
- 布局：自上而下或从左到右的流向，保持清晰的流程方向。
- 色彩：使用蓝色系作为主色调，决策点可用橙色突出。`,

	mindmap: `### 思维导图视觉规范
- 结构：中心主题用 ellipse，分支用 rectangle。
- 层级：通过尺寸和颜色深浅体现层级关系。
- 布局：放射状布局，主分支均匀分布在中心周围。
- 色彩：每个主分支使用不同色系，便于区分主题。`,

	orgchart: `### 组织架构图视觉规范
- 形状：统一使用 rectangle 表示人员或职位。
- 层级：通过颜色深浅和尺寸体现职级高低。
- 布局：严格的树形层级结构，自上而下。
- 连接：使用 arrow 垂直向下连接上下级关系。`,

	sequence: `### 时序图视觉规范
- 参与者：顶部使用 rectangle 表示各参与者。
- 生命线：使用虚线 line 从参与者向下延伸。
- 消息：使用 arrow 表示消息传递，label 标注消息内容。
- 布局：参与者横向排列，消息按时间从上到下。`,

	class: `### UML 类图视觉规范
- 类：使用 rectangle 分三部分展示类名、属性、方法。
- 关系：继承用空心三角箭头，关联用普通箭头，聚合/组合用菱形箭头。
- 布局：父类在上，子类在下，相关类横向排列。`,

	er: `### ER 图视觉规范
- 实体：使用 rectangle 表示实体。
- 属性：使用 ellipse 表示属性，主键可用特殊样式标识。
- 关系：使用 diamond 表示关系，用 arrow 连接。
- 基数：在连接线上标注关系基数，如 1、N、M。`,

	gantt: `### 甘特图视觉规范
- 时间轴：顶部标注时间刻度。
- 任务条：使用 rectangle 表示任务，长度表示时间跨度。
- 状态：用不同颜色区分任务状态，如未开始、进行中、已完成。
- 布局：任务纵向排列，时间横向展开。`,

	timeline: `### 时间线视觉规范
- 主轴：使用 line 作为时间主轴。
- 节点：使用 ellipse 标记时间节点。
- 事件：使用 rectangle 展示事件内容。
- 布局：时间轴居中，事件卡片交错分布在两侧。`,

	tree: `### 树形图视觉规范
- 节点：根节点用 ellipse，其他节点用 rectangle。
- 层级：通过颜色渐变体现层级深度。
- 连接：使用 arrow 从父节点指向子节点。
- 布局：根节点在顶部，子节点均匀分布。`,

	network: `### 网络拓扑图视觉规范
- 设备：不同设备类型使用不同形状，如 rectangle、ellipse、diamond。
- 层级：通过颜色和尺寸区分设备重要性。
- 连接：使用 line 表示网络连接，线宽可表示带宽。
- 布局：核心设备居中，其他设备按层级或功能分组。`,

	architecture: `### 架构图视觉规范
- 分层：使用 rectangle 区分不同层级，如表示层、业务层、数据层。
- 组件：使用 rectangle 表示组件或服务。
- 连接：使用 arrow 表示调用、依赖或数据流向。
- 布局：优先采用分层布局，自上而下或从左到右。`,

	dataflow: `### 数据流图视觉规范
- 实体：外部实体用 rectangle，处理过程用 ellipse。
- 存储：数据存储用特殊样式的 rectangle。
- 数据流：使用 arrow 表示数据流向，label 标注数据名称。
- 布局：外部实体在边缘，处理过程居中。`,

	state: `### 状态图视觉规范
- 状态：使用带圆角的 rectangle 表示状态。
- 初始/终止：初始状态用实心圆，终止状态用双圆圈。
- 转换：使用 arrow 表示状态转换，label 标注触发条件。
- 布局：按状态转换的逻辑流程排列。`,

	swimlane: `### 泳道图视觉规范
- 泳道：使用 rectangle 或 frame 划分泳道，每个泳道代表一个角色或部门。
- 活动：使用 rectangle 表示活动，diamond 表示决策。
- 流程：使用 arrow 连接活动，可跨越泳道。
- 布局：泳道平行排列，活动按时间顺序排列。`,

	concept: `### 概念图视觉规范
- 概念：核心概念用 ellipse，其他概念用 rectangle。
- 关系：使用 arrow 连接概念，label 标注关系类型。
- 层级：通过尺寸和颜色体现概念的重要性。
- 布局：核心概念居中，相关概念围绕分布。`,

	fishbone: `### 鱼骨图视觉规范
- 主干：使用粗 arrow 作为主干，指向问题或结果。
- 分支：使用 arrow 作为分支，斜向连接到主干。
- 分类：主要分支使用不同颜色区分类别。
- 布局：从左到右，分支交替分布在主干上下。`,

	swot: `### SWOT 分析图视觉规范
- 四象限：使用 rectangle 创建四个象限。
- 分类：优势 S、劣势 W、机会 O、威胁 T 使用不同颜色。
- 内容：每个象限内列出相关要点。
- 布局：2x2 矩阵布局，四个象限等大。`,

	pyramid: `### 金字塔图视觉规范
- 层级：使用 rectangle 表示各层，宽度从上到下递增。
- 颜色：使用渐变色体现层级关系。
- 文本：每层居中放置核心标签，避免过长文本。
- 布局：垂直居中对齐，形成金字塔形状。`,

	funnel: `### 漏斗图视觉规范
- 层级：使用 rectangle 表示各阶段，宽度从上到下递减。
- 数据：标注每层的数量或百分比。
- 颜色：使用渐变色表示转化过程。
- 布局：垂直居中，形成漏斗形状。`,

	venn: `### 韦恩图视觉规范
- 集合：使用 ellipse 表示集合，部分重叠。
- 颜色：使用半透明背景色，交集区域需要清晰可读。
- 标签：标注集合名称和元素。
- 布局：圆形适当重叠，形成明显的交集区域。`,

	matrix: `### 矩阵图视觉规范
- 网格：使用 rectangle 创建行列网格。
- 表头：使用深色背景区分表头。
- 数据：单元格可用颜色深浅表示数值大小。
- 布局：规整的矩阵结构，行列对齐。`,

	infographic: `### 信息图视觉规范
- 模块化：使用 frame 和 rectangle 创建独立的信息模块。
- 视觉层次：通过尺寸、颜色和位置建立清晰的信息层次。
- 数据可视化：包含图表、图标、数字等视觉元素。
- 色彩：可使用多种颜色区分信息模块，但保持整体一致。
- 布局：根据内容采用网格、卡片或自由布局。`,
};

const CHART_TYPE_PATTERNS: Array<[Exclude<ChartType, "auto">, RegExp]> = [
	["swimlane", /泳道图|swim\s*lane/i],
	["flowchart", /流程图|flow\s*chart|flowchart/i],
	["mindmap", /思维导图|mind\s*map|mindmap/i],
	["orgchart", /组织架构图|组织结构图|org(?:anization)?\s*chart/i],
	["sequence", /时序图|序列图|sequence\s*diagram/i],
	["class", /UML\s*类图|类图|class\s*diagram/i],
	["er", /ER\s*图|实体关系图|entity\s*relationship|er\s*diagram/i],
	["gantt", /甘特图|gantt/i],
	["timeline", /时间线|timeline/i],
	["tree", /树形图|树状图|tree\s*diagram/i],
	["network", /网络拓扑图|拓扑图|network\s*topology|topology/i],
	["architecture", /架构图|architecture\s*diagram|system\s*architecture/i],
	["dataflow", /数据流图|data\s*flow|DFD/i],
	["state", /状态图|state\s*diagram/i],
	["concept", /概念图|concept\s*map|concept\s*diagram/i],
	["fishbone", /鱼骨图|因果图|fishbone|ishikawa/i],
	["swot", /SWOT/i],
	["pyramid", /金字塔图|pyramid/i],
	["funnel", /漏斗图|funnel/i],
	["venn", /韦恩图|venn/i],
	["matrix", /矩阵图|matrix/i],
	["infographic", /信息图|infographic/i],
];

export function detectChartType(input: string): Exclude<ChartType, "auto"> | undefined {
	for (const [chartType, pattern] of CHART_TYPE_PATTERNS) {
		if (pattern.test(input)) return chartType;
	}
	return undefined;
}

export function chartTypeListText(): string {
	return (Object.keys(CHART_TYPES) as ChartType[])
		.filter((chartType) => chartType !== "auto")
		.map((chartType) => `- ${CHART_TYPE_NAMES[chartType]} (${chartType})`)
		.join("\n");
}

export function chartTypeGuidance(inputOrType?: string | ChartType): string {
	const chartType = inputOrType && inputOrType in CHART_TYPES ? (inputOrType as ChartType) : detectChartType(inputOrType ?? "");
	if (chartType && chartType !== "auto") {
		const spec = CHART_VISUAL_SPECS[chartType];
		return [
			`## 图表类型指导：${CHART_TYPE_NAMES[chartType]} (${chartType})`,
			spec,
			"请严格遵循以上视觉规范，并结合用户具体内容调整布局、颜色和节点数量。",
		]
			.filter((line): line is string => Boolean(line))
			.join("\n\n");
	}

	return [
		"## 图表类型选择指导",
		"如果用户未指定图表类型，请根据需求选择最合适的一种或多种图表类型。可选类型：",
		chartTypeListText(),
		"选择后应遵循该类型常见视觉约定，确保图表可以独立传达信息。",
	].join("\n");
}
