# Pi Linear TodoList 架构说明

- **状态**：Confirmed
- **确认日期**：2026-09-15
- **关联需求**：[LINEAR_TODO_REQUIREMENTS.md](./LINEAR_TODO_REQUIREMENTS.md)
- **验收与评测**：[LINEAR_TODO_E2E_EVALUATION_PLAN.md](./LINEAR_TODO_E2E_EVALUATION_PLAN.md)
- **架构方案**：适度模块化 Pi Extension
- **自动续跑范围**：仅 TUI / RPC

## 1. 架构决策

采用一个 Session 级、主进程内运行的 Pi Extension。扩展通过单个 `todo` 工具维护线性计划，通过纯函数 reducer 保证状态合法，通过 Session 工具结果恢复状态，通过 `context` 事件提醒模型，并在 TUI/RPC 中通过 `agent_before_settle` 追加续跑 draft，提供一次性防早停续跑。

不引入数据库、外部 JSON 状态、子代理、任务调度器、Repository 层或通用工作流引擎。

产品定位是 Agent 的工作记忆与有限防早停提醒，而非需要用户维护的任务看板。Agent 自主建计划、推进、修订和结束；最新用户请求优先于旧计划，`/todos` 仅用于可选查看与紧急干预。

## 2. 架构目标

架构必须同时满足：

1. 状态转换可证明、可单元测试；
2. 当前任务唯一；
3. Session 恢复和分支切换后状态正确；
4. 上下文压缩后模型仍能恢复当前目标；
5. 提醒机制不会无限循环；
6. UI 故障不影响任务状态；
7. 不污染 Pi 内置工具行为；
8. 后续可以增加用户编辑、项目级计划等能力，而无需重写核心状态机。

## 3. 总体结构

```text
┌────────────────────────────────────────────────────────────┐
│                         index.ts                           │
│  Composition Root：注册工具、命令、事件，组织组件生命周期 │
└───────────────┬───────────────────────────────┬────────────┘
                │                               │
        ┌───────▼────────┐              ┌───────▼─────────┐
        │   todo tool    │              │ lifecycle hooks │
        │ Tool Adapter   │              │ context/settled │
        └───────┬────────┘              └───────┬─────────┘
                │                               │
        ┌───────▼───────────────────────────────▼─────────┐
        │                 state.ts                        │
        │ 当前状态、Session 恢复、提醒运行时控制状态      │
        └───────┬───────────────────────────────┬─────────┘
                │                               │
        ┌───────▼────────┐              ┌───────▼─────────┐
        │   reducer.ts   │              │  reminder.ts    │
        │ 纯领域状态机   │              │ 提醒策略与格式化 │
        └───────┬────────┘              └─────────────────┘
                │
        ┌───────▼────────┐
        │   schema.ts    │
        │ 类型、输入校验 │
        └────────────────┘

        ┌──────────────────┐       ┌──────────────────┐
        │    render.ts     │       │  src/widget.ts   │
        │ Tool history/list│       │ Model / TUI / RPC│
        └────────┬─────────┘       └─────────┬────────┘
                 └────────────┬──────────────┘
                   ┌──────────▼───────────┐
                   │ src/render-shared.ts │
                   │ Snapshot / sanitize  │
                   └──────────────────────┘
```

## 4. 模块职责

### 4.1 `index.ts`

唯一的 Composition Root。

负责：

- 创建 Session 级状态容器；
- 注册 `todo` 工具；
- 注册 `/todos` 命令；
- 注册生命周期事件；
- 将 reducer、状态恢复、提醒策略和渲染进行组合；
- 每次刷新从快照只构建一次 Widget 模型，交给 TUI 组件或 RPC 文本格式化器；
- 在 `session_shutdown` 时清理 Widget、Status 和运行时引用。

不得包含：

- 具体状态转换；
- Session 遍历算法；
- 大段渲染代码；
- 提醒判定细节。

### 4.2 `schema.ts`

负责静态类型和边界输入校验。

包含：

- `TodoState` / `isTodoState`；
- `TodoItem`；
- `TodoInput` TypeBox Schema；
- `TodoToolDetails`；
- action 枚举；
- 长度和任务数量常量：计划/任务 title 60、goal/任务 description/doneWhen 300、result 1000 字符；
- 必填计划 title/goal、任务唯一简短动作 title 与可选执行 description 的校验及克隆；新任务仅接受 title/description/doneWhen，result 只由 advance 完成记录写入；
- `TODO_SCHEMA_VERSION = 3` 及严格字段守卫；不保留 V2 类型别名或迁移。V1/V2、未知/损坏快照保护，显式 clear 后重建；拒绝旧 displayTitle、状态 createdAt/updatedAt 及其它未知属性，不改 SDK 消息/会话自身 timestamp。

要求使用 `StringEnum` 定义 action，保证 Google 模型工具 Schema 兼容性。

### 4.3 `reducer.ts`

领域核心，必须为纯函数。

建议接口：

```ts
interface TodoTransition {
  state: TodoState | null
  summary: string
  changed: boolean
}

function reduceTodo(
  previous: TodoState | null,
  input: TodoInput,
  dependencies: { createPlanId: () => string },
): TodoTransition
```

职责：

- action 级语义校验（含「字段是否适用于该 action」）；
- planId、Task ID 管理和 revision 变更计数；
- 校验唯一入口 `completions[].result`，从当前项连续推进一项或多项，不做旧参数归一化；
- insert/undo/block/resume/replan 状态转换；
- 按完成记录顺序保存每项可选 result；
- plan 必填 title/goal/tasks；replan 的 tasks 仍必填，规范化 goal 未变时可省略 title 并保留，改变 goal 必须显式给新 title，否则原子拒绝；
- 校验计划标题 `INVALID_PLAN_TITLE`、任务标题 `INVALID_TASK_TITLE` 和执行描述 `INVALID_DESCRIPTION`；无旧短标题/时间戳错误码；
- 生成简短 transition 摘要。

硬性约束：

- 只有 `advance` 正常推进 cursor；`completions.length` 是本次推进数量，不支持独立 count 或任意 ID 跳选；
- `advance` 必须显式提供非空 `completions` 且不超过剩余项数，每条记录只接受可选 result；不接受顶层结果字段、旧 outcome 或隐式单项回退；
- `TodoState` 保存任务 title/description/doneWhen/result，schemaVersion 为 3，无状态时间戳；V1/V2 不迁移，旧/损坏格式进入保护，仅显式 clear 后重建；
- 批量先校验所有记录再一次提交，只递增一次 revision、保存一次完整前像；`undo` 撤销整批，不产生中间快照或额外续跑位置；
- `insert` 只增加任务，不改 cursor，`nextItemSeq` 继续递增；
- `undo` 恢复单步快照并清空快照，最多连续撤销一次；
- 每个 action 只接受 `APPLICABLE_FIELDS` 中列出的字段，多余字段直接报 `INVALID_INPUT`，不允许静默忽略；
- `replan` 只替换当前及未来任务；没有已完成历史时不允许空 `replan`（会产出 completed + 0 items 的空计划）；
- `nextItemSeq` 永远只递增；
- 不原地修改输入对象；
- 不读写 Session、UI、时间或全局变量；
- 不依赖时钟，无 now 参数或时间戳校验；仅通过 dependencies.createPlanId 注入计划 ID 生成。

### 4.4 `state.ts`

维护当前扩展实例的 Session 级运行状态。

建议结构：

```ts
interface TodoRuntimeState {
  todo: TodoState | null
  forceReminder: boolean
  turnsSinceMutation: number
  skipNextContextReminder: boolean
  lastRunStopReason?: string
  nudgedStageKeys: Set<string>
}
```

负责：

- 获取和替换当前 Todo 快照；
- 从 Session Branch 恢复最近快照；
- 从已持久化的自动续跑 CustomMessage 恢复 nudge key；
- 按计划位置和该位置最近一次成功显式 `resume` 生成 stage key，并从当前 Branch 重建 resume revision；
- 记录 Todo 更新后的提醒节流状态；
- 触发 Widget 刷新回调。

状态容器必须创建在 Extension Factory 闭包内，不得使用进程级 singleton。

### 4.5 `reminder.ts`

只实现策略，不直接修改 TodoState。

建议接口：

```ts
function buildReminder(state: TodoState, mode: "compact" | "full"): string

function shouldInjectReminder(runtime: TodoRuntimeState): boolean

function shouldAutoContinue(input: {
  mode: ExtensionContext["mode"]
  state: TodoState | null
  hasPendingMessages: boolean
  lastRunStopReason?: string
  alreadyNudged: boolean
}): boolean
```

职责：

- 生成模型可见的短提醒，compact/full 均适当保留计划 title/goal 和任务 description；不把执行描述挪作验收条件或实际结果；
- 强制提醒和周期提醒判定；
- Todo 工具刚执行后的重复提醒抑制；
- `agent_before_settle` 自动续跑判定；
- 防循环 stage key 判定。

不得：

- 调用 reducer；
- 推进 cursor；
- 直接操作 UI；
- 在 JSON/Print 中触发自动续跑。

### 4.6 `render.ts`

负责工具历史行和完整列表；常驻 Widget 独立到 `src/widget.ts`，RPC Status 回退仍由 index.ts 维护。

包含：

- 工具使用 `renderShell: "self"`，按宿主 `outputPad` 做左右缩进（与 `compact-tool-ui` 的 self shell 一致），不绘制 pending/success/error 通栏背景，内容上下不加留白行，只保留宿主在工具行前插入的一行分隔；
- `renderCall`：参数流式写入时显示 `Todo …`，不泄露半写入 action；参数完整后展示正在处理的紧凑摘要，不推测进度；最终结果到达后返回零行，由结果槽独占事件行；
- `renderResult`：折叠摘要固定为一行，结构为“Todo ＋ 本次变化 ＋ ` · ` ＋ 进度”。摘要紧跟工具名，不设置独立操作名字段；状态图标只保留 `✓`/`!`/`✗` 三态（success/warning/error），其余动作直接用动词开头（`查看 …`、`已恢复 …`、`已撤销上次变更`、`补充 N 项任务`、`已清空当前计划`），不再为 `show/resume/undo/insert/clear` 自造符号；单项完成展示任务名，批量仅在批次数量与进度分子不同时追加“等 N 项”，全部完成时展示“计划完成”，且 `✓` 与“计划完成”同为 success 色，作为历史里的里程碑；进度紧跟摘要而非贴右边缘，宽终端不会把计数推远；仍先预留计数宽度再截断摘要，长摘要先丢字、计数保持完整；宽度不足 48 列时整体去掉计数，错误和无计划快照不显示计数，无法结构化解释的回退结果保留原始反馈；长 result 仅在展开态显示；兼容 partial 结果时不重复显示事件头（本工具自身不调用 `onUpdate`）；
- 展开结果只描述本次调用，采用 `compact-tool-ui` 的树枝：`borderMuted` 的 `  ├─ ` 引导 section 标签（bold muted），`  │ ` 在统一列承载内容，`  ╰─ ` 收尾并接 `/todos 查看完整计划`；标签不与值同行，保证只有一个内容列；主结果优先：`操作`（原始 action token，批量附本次数量）→ `结果`/`受阻`/`错误`（advance 列本次完成项及其 result，plan/replan/insert 只列本次新增任务及说明/验收）→ `计划`/`目标`/`原因` → `当前`（cursor 指向项或“计划完成”）→ `/todos 查看完整计划`；不重放无关任务；宽度不足 24 列时去掉导轨和收尾、保留同字段纯缩进；只读历史快照，不共享可变渲染状态，不修改模型可见 content；
- `/todos` 列表组件：关闭按键与提示文案来自注入的 `keybindings`（`app.interrupt`），未注入时才退回 Escape；
- `/todos` 完整列表 Component：只读打开时快照，完整 description/doneWhen/result 按显示列换行，以八个视觉行窗口滚动；方向键/PgUp/PgDn 与 Home/End 使用注入绑定，退出仍用 app.interrupt；滚动只改组件视口，不改 revision/undo、不等待 idle、不停止后台；RPC notify 完整无截断，JSON/print 静默；
- RPC Status 英文回退文本生成（TUI 不写 Footer 状态）；
- 宽度截断和主题颜色处理。

渲染必须只读取快照，不得修改状态；工具历史行继续使用该次调用的快照，不跟随常驻 Widget 更新。

### 4.7 `src/render-shared.ts`

保留 `TodoRenderSnapshot` 契约（state、兼容性错误、early-stop 警告、暂停与 completed release），并承载工具/列表与 Widget 共用的空白规范化、终端控制字符清洗。这里只做共享展示处理，不选择任务窗口、不读写 Session 或改变领域状态。

### 4.8 `src/widget.ts`

拥有导出的 `buildTodoWidgetModel(snapshot)`、判别式结构化模型（`hidden` / `unavailable` / `plan`）、`TodoWidget(model, theme)` 和 `formatTodoWidgetLines(model)`。

- builder 先处理兼容性保护，不访问未知状态；null/clear 或 `completedDismissed` 的 completed 生成 hidden，兼容性错误生成 unavailable，其余（含尚未 release 的 completed）生成 plan；completed 保留最后至多两条完成行及可选较早摘要，去除 blocked/paused/earlyStop 告警；
- plan 模型 `title` 直接来自 state.title，不使用 goal 命名、旧标签/goal 回退或渲染语义摘要；任务行仅 `{ title, kind: "completed" | "current" | "pending" }`，替换 isCurrent，不透传 id 或叠加重复 status；
- 只有 builder 选择最近两条 completed、当前项及后续两条 pending，计算未显示 completed/pending 数，并派生 `kind` 及合并告警；阻塞读取 plan.alerts.blocked，仅当前箭头变为 warning，当前阻塞标题仍 text+bold；不把派生字段写回任务；
- `TodoWidget` 只负责模型的 TUI 自适应左侧圆角半包、单行截断和 B 样式主题前景颜色；首行 `╭─ `、中间 `│  `、最后实际内容 `╰─ `，无右框、独立底边、额外空行或固定 40 列渲染上限；
- `formatTodoWidgetLines` 只将同一模型转成 RPC 文本行，精确保留原有无框、宽度无关的文本及缩进；不重新选窗，不使用终端宽度、ANSI、主题、框、独立底边、截断或人工右侧填充。

V3 计划保存必填 title/goal，任务保存 title/可选 description/doneWhen/result；description 穿过校验、clone、undo、恢复，适当进入工具反馈、compact/full 提醒、show、/todos 与历史详情。Widget 不承载执行细节，不能因此丢失其它消费者中的完整信息。计划 ID/游标/phase/推进及提醒续跑预算保持不变。

## 5. 依赖方向

依赖只能朝领域核心方向流动：

```text
index → tool adapter / hooks / render / src/widget
                  ↓
                state
                  ↓
               reducer
                  ↓
                schema

reminder          → schema
render            → src/render-shared → schema
src/widget        → src/render-shared → schema
```

禁止：

- reducer 依赖 Pi API；
- schema 依赖 UI；
- render 或 Widget 调用 reducer；
- render 与 Widget 互相依赖，或各自重复选择常驻 Widget 的任务窗口；
- reminder 修改 state.todo；
- state 依赖具体 TUI Component。

## 6. 工具调用流程

```text
LLM 调用 todo
    │
    ▼
TypeBox 结构校验
    │
    ▼
读取 state.todo
    │
    ▼
reduceTodo(previous, input, dependencies)
    │
    ├── 失败：抛出 TodoDomainError，状态保持不变
    │
    ▼
替换 state.todo
    │
    ├── turnsSinceMutation = 0
    ├── skipNextContextReminder = true
    ├── forceReminder = false
    └── 刷新 Widget/Status
    │
    ▼
返回 transition + 紧凑工作视图（show 返回完整计划）+ 完整 details.state
```

领域错误由 `execute()` 捕获并转换成 `isError: true` 的结构化结果，同时保留 `details.state`（拒绝前的快照）。不要改成抛出异常：host 会把抛出的错误包装成 `createErrorToolResult()` 的 `details: {}`，既丢失快照，又让恢复逻辑无法区分“没有状态信息”和“不支持的格式”。

`isError` 只有在 `@earendil-works/pi-coding-agent >= 1.3.0` 才会从工具结果透传；0.85.1 的 agent loop 硬编码 `isError: false`，所以扩展的 peer/dev 依赖不得低于 1.3.0。

工具必须声明 `executionMode: "sequential"`，使 Todo 调用与同批其他工具调用串行执行，避免状态读取和写入交错。

工具同时声明 `exposure: "model-only"`：只允许模型直接调用，不允许 codemode 或其它工具通过 `ctx.executeTool()` 嵌套调用。Pi 不把嵌套工具结果单独写入 Session，因此嵌套修改无法满足 `details.state` 作为 Branch 权威快照的约定。`show` 的模型可见 `content` 返回完整计划（含 title/goal、任务 description、状态、阻塞原因、验收条件和 result）；其它 action 返回简短 transition 加紧凑工作视图，包含计划 title/goal、当前任务及 description、完成条件、下一任务与阻塞。`advance` 回显本次每项已提供的 result，省略结果的记录不生成虚构文字，包括批量完成整个计划时；它是 Agent 报告的结果，而非独立验收证明。工作视图复用 `buildReminder()`，避免维护另一套模型状态摘要。

## 7. Session 持久化架构

### 7.1 Todo 权威状态

每次 Todo 调用的工具结果都保存完整 `details.state`。恢复时从当前 Branch 尾部反向查找最近的 Todo 工具结果。

host 自己生成的失败结果（抛出异常、参数校验失败、工具被拦截、调用被中断）会是 `isError: true` 且 `details: {}`，它们不携带状态信息，恢复时直接跳过；只有非错误却缺少 `state` 的结果才进入兼容性保护。

`toolName === "todo"` 本身不足以证明结果属于本扩展：其它扩展可以注册同名工具，其结果会被误读成损坏快照，从而把恢复永久锁死到 `clear`。因此还要求 `details` 带有本扩展的签名（`action` 属于已知 action 集合且 `transition` 为字符串，或存在 `compatibilityError`），否则整条结果被跳过。历史结果签名只用于识别本扩展，不代表格式兼容：识别出的 V1/V2 仍进入版本保护，不能回退读取更早的有效计划。

这样可以获得：

- 无额外文件；
- 与 Pi Session 同生命周期；
- `/tree` 天然分支隔离；
- 压缩后仍可从完整 Session Entry 恢复；
- 不需要重放所有历史 action。

### 7.2 自动续跑去重

自动续跑在 `agent_before_settle` 边界中完成：handler 返回一条 `custom_message` draft 和 `continue: true`，由 host 追加到 Session 并在**同一次 run** 内继续一次模型调用。

```ts
{
  type: "custom_message",
  customType: "linear-todo-auto-continue",
  content: "Continue the current Todo task now. ...",
  display: false,
  // planId/cursor 让重启后能重建「每个位置已用掉几次续跑」的预算
  details: { stageKey, planId, cursor },
}
```

`agent_settled` 只是通知事件，handler 返回值会被 host 丢弃，不能用于续跑。`agent_before_settle` 返回 `{ continue: true }` 时必须同时带上可续跑的 draft：host 的 `canContinue` 要求投影后的最后一条消息不是 assistant，单独的 `continue: true` 会被拒绝并记录 extension error。

该 draft 同时承担：

1. 让 host 在同一个 run 内继续一次模型调用；
2. 在 Session 中持久记录该阶段已经提醒过。

boundary draft 提交时不会触发 `message_end`，因此 `stageKey` 必须在返回 draft 之前同步写入 `nudgedStageKeys`。恢复时扫描当前 Branch 中该 customType 的消息并重建 `nudgedStageKeys`，避免 Session 恢复后重复续跑。

### 7.3 early-stop 警告的生命周期

`earlyStopWarning` 只在两种情况下清除：

1. Todo 状态发生 `changed` 转换（`store.replace()` 内清除）；
2. `before_agent_start` 且 `messageType === "user"`。

第二种是必需的：用户重新发话后，上一轮的“agent 提前停止”警告已经过期；而 custom message 触发的运行（包括自动续跑本身）不得清除它。

### 7.4 Clear 语义

`clear` 的工具结果保存 `details.state = null`。反向恢复遇到该结果后即认定当前 Branch 无 Todo，不继续读取更早计划。

## 8. 生命周期事件设计

| Pi 事件 | 行为 |
|---|---|
| `session_start` | 恢复 Todo 和 nudge ledger，设置强制提醒，刷新 UI |
| `session_tree` | 按新 Branch 重新恢复状态和 ledger，刷新 UI |
| `session_compact` | 设置 `forceReminder = true` |
| `before_agent_start` | 仅 `messageType === "user"` 时设置用户回合提醒标记并清除 early-stop 警告 |
| `context` | 按策略追加非持久化 CustomMessage 提醒 |
| `turn_end` | 增加 `turnsSinceMutation` |
| `agent_end` | 记录最后 stopReason、error、aborted 信息 |
| `agent_before_settle` | 在 TUI/RPC 中追加一次性续跑 draft，并同步标记 ledger |
| `agent_settled` | 纯通知：completed 计划标记为已释放 Widget，刷新 Widget/Status |
| `session_shutdown` | 清除 Widget/Status，不启动后台资源 |

## 9. Context 提醒实现

`context` handler 修改事件提供的消息副本，不调用 `pi.sendMessage()`，因此普通提醒不会写入 Session。

提醒优先级：

1. `forceReminder`：完整展示所有未完成任务；
2. 用户新回合：展示当前、下一项和总体进度；
3. 周期提醒：Todo 三个 turn 未更新时展示短提醒；
4. Todo 工具刚返回：跳过一次，避免与工具结果重复；
5. completed：不注入执行提醒。

普通提醒使用隐藏 CustomMessage，限制在 600 字符内。

预算按结构分层分配，而不是把拼好的字符串硬切：

1. header（`[Todo n/m]`，可选 phase）必保留；
2. compact 模式保留 `Current:` 与 `Next:`，full 模式用带标记的任务列表代替它们，避免重复占用预算；
3. 按字段独立分配预算：适当保留 `Title:` 与 `Goal:`、当前/下一任务 title 和非空 description，完成条件、阻塞原因也独立限长；执行细节不借用 doneWhen/result 行。暂停时保留 `Auto-continue: paused.`，不向模型要求执行用户命令；
4. full 模式先为任务表预留预算，空间不足时以 cursor 为中心截取窗口并标注 `Tasks (a-b of n):`，至少保留当前任务。

这样在合法上限输入（计划 title 60 + goal 300，任务 title 60 + description 300 + doneWhen 300）下，compact 仍保留当前/下一任务及有界执行细节，full 仍能看到当前任务和 description，而不是整体截断成 0 个任务；完整信息仍在状态、show 与详情中。

## 10. 自动续跑架构

### 10.1 启用范围

- TUI：启用；
- RPC：启用；
- JSON：禁用；
- Print：禁用。

### 10.2 安全条件

只有以下条件全部成立时才触发：

- Todo phase 为 active；
- cursor 尚未结束；
- 没有 pending messages；
- 最后运行没有 error；
- 最后运行不是 aborted；
- 用户没有执行 `/todos pause`（runtime-only，新 session 默认恢复）；
- 当前 stageKey 尚未被提醒；
- 当前 `(planId, cursor)` 的续跑次数小于 3；
- Extension runtime 仍然有效；
- host 支持 `agent_before_settle` 边界（`@earendil-works/pi-coding-agent >= 1.3.0`）。

### 10.3 防循环

stageKey 是带协议版本的 JSON 元组，避免依赖易歧义的字符串拼接：

```text
["linear-todo-nudge", 1, planId, cursor, resumeRevision]
```

`resumeRevision` 为该位置最近一次成功显式 `todo resume` 的 revision，初始为 0。同一个 key 只纠偏一次：

- `advance` 到尚未消耗机会的位置后获得初始纠偏；
- `replan`、`insert`、`undo` 不补充机会，回退到已消耗的位置也不退款；
- 显式 `resume` 可在剩余位置预算内获得新机会；从 blocked 执行 replan 虽然解除了阻塞，但不等同于显式 resume；
- 失败调用、用户新消息和 `/todos pause/resume` 不补充机会。

续跑文案包含计划 title/goal、当前任务及 description 和完成条件，要求记录实际观察结果；旧计划被最新用户请求取代时先修订或清理，不继续执行过期任务。再次停在同一纠偏阶段时不继续触发模型，只显示提前停止警告。

### 10.4 按位置计数与恢复

另维护 `nudgeCounts: Map<"<planId>:<cursor>", number>`：每个位置总计最多 3 次，包括显式 block/resume 带来的新机会，防止反复解除阻塞绕过限额。replan 替换该位置的任务仍继承预算，不引入任务身份匹配系统。

恢复按 Branch 时间顺序重建成功 resume 和 nudge，使用每条 nudge 当时的 resume revision，而非分支最终值。旧版 `<planId>:<revision>` nudge 有位置元数据时映射为规范 key；仅有旧 key 时，只有前一个有效快照精确匹配才推断位置。无法定位的历史 key 保留但不猜测；每条消息只计数一次。无需修改 `TodoState` 或重放领域变更；此 ledger 防重复处理不构成 V1/V2 状态迁移。

用户可通过 `/todos pause` 暂停后续自动续跑（运行时不持久化），但不因此中止当前工具或模型调用。`pause`/`resume` 必须立即更新运行时标记，不等待 idle；`/todos`、`list` 和 `show` 查看入口也不得等待 idle。TUI 立即打开当时的只读快照，关闭时不回滚计划或中止后台模型/工具；RPC 立即通知当前清单，JSON/print 不输出 UI 也不等待。列表保持打开时的快照，Widget 继续反映最新进度，重新打开列表可刷新。模型无法调用该命令，因此不会成为模型自己的逃生口。

## 11. ID 策略

- planId 使用 `crypto.randomUUID()`；
- Todo Item ID 使用 `t${nextItemSeq}`；
- 初始 `nextItemSeq = items.length + 1`；
- replan 新增任务继续使用现有 nextItemSeq；
- 删除、替换或清理任务不得在同一 planId 内复用 ID；
- `undo` 恢复同一计划时保留 `nextItemSeq` 高水位（撤销前与快照中值的较大者）；恢复另一个 planId 时使用该计划自己的序号；
- 新 planId 可以重新从 `t1` 开始。

模型正常操作不需要传 taskId，ID 主要用于 UI、日志和未来兼容。

## 12. 错误边界

### 12.1 Domain Error

reducer 对非法状态转换抛出 `TodoDomainError`：

- code：稳定机器码；
- message：模型可理解说明；
- previous state：不修改。

该异常在 `execute()` 内被转成 `isError: true` 的工具结果（见 §6），模型因此看到失败而不是成功。

### 12.2 UI Error

Widget、Footer 或自定义 Component 渲染失败时：

- 不回滚 Todo 状态；
- Pi 使用工具 fallback rendering；
- 错误只进入扩展日志或 notify。

### 12.3 Reminder Error

context 提醒构建失败时跳过本次提醒。自动续跑不再经过异步发送：stageKey 在返回 boundary draft 之前同步标记；即使 host 随后拒绝 `continue`，draft 仍已写入 Session，不会重复续跑。

### 12.4 未知 Schema

V1/V2、未知 schemaVersion、损坏快照或旧属性：

- 不尝试迁移；
- Todo 工具进入只读保护；
- `/todos` 显示兼容性错误；
- 用户可以显式 clear 后创建新计划。

## 13. UI 架构

`index.ts` 每次刷新调用一次 `buildTodoWidgetModel(snapshot)`；TUI 工厂接收当前 theme 后创建 `TodoWidget(model, theme)`，RPC 使用 `formatTodoWidgetLines(model)`。模型不含终端布局间距或主题 ANSI 文本，避免窗口、计数和状态在两条展示路径间漂移。

用户确认采用**左侧圆角半包**：首行 `╭─ `、中间内容行 `│  `、最后实际内容行 `╰─ `。不生成右线或延伸的上下横线，保留配色和有界任务窗口：

```text
╭─ 检查并整理 wifi-audit（1/6）
│  ✓ 梳理文档与脚本
│  → 语法与静态检查
│  ○ 核对文档与实现
│  ○ 检查跨脚本约定
╰─ 另有 2 项待办
```

- Widget plan.title 直接来自 state.title，不叫 goal，不回退旧标签/goal，也不生成语义摘要；任务行只保留 `{ title, kind: "completed" | "current" | "pending" }`，以 kind 替换 isCurrent，无 id 或重复 status。完整 goal/任务 description/doneWhen/result 继续用于 `/todos`、工具历史、模型反馈和提醒。
- plan 分支在可用宽度至少 12 列时，使用 dim 的三列前缀：首行 `╭─ `、中间 `│  `、末行 `╰─ `，正文预算 `available - 3`。小于 12 列去掉全部装饰并使用全宽。末行是实际更多提示、任务或告警；没有更多提示就由最后任务收尾，有告警则告警收尾。不增加纯底线或装饰行，不延伸上下横线，不画右线、背景或右补齐，没有 72 列上限。
- TUI 首行为 `<行动式总览>（N/T）`，不加“计划：”或中点分段。总览概括整组工作，例如“检查并整理 wifi-audit”，不与当前条目混同。标题预算为 Widget 可用列减去半包前缀及完整括号进度后缀，无固定目标上限；仅真实超宽时省略，保持单行，极窄仅保留 `N/T`。
- 最近两条 completed＋当前项＋后续两条 pending，最多五条任务行。较早完成摘要 `… 较早已完成 N 项` 在所有任务前，N 为未显示 completed 数；`另有 N 项待办` 在任务后、告警前，N 排除当前和可见 pending。正常最多八行、合并告警时九行；只有一个任务的计划无告警为标题＋任务两行（适用告警时三行），只剩一项未完成仍可有完成历史。
- 当前只表示计划 cursor，不是实际执行遥测。窗口及 `kind` 只由 builder 派生，阻塞来自 plan.alerts.blocked，不读取重复行 status；TUI 不重选任务或改写状态。当前 `→` 为 accent、blocked 时 warning，未来 `○` 为 muted；正常当前标题 accent+bold，blocked 当前标题 text+bold，未来任务标题 text。完成 `✓` 为 success、标题 muted、无删除线，较早摘要 muted；进度括号 muted，计划 title 为 text、不加粗，完成数大于零时数字计数 success，零进度计数 text、不加粗；更多提示、恢复提示 muted，只有半包线条 dim。
- 告警仍只追加一行，信号与状态标签 warning、原因 text、恢复提示 muted。单阻塞为 `阻塞：<reason>`；单暂停为 `自动续跑已暂停 · /todos resume`；单提前停止为 `提前停止`。多状态先合并标签，再追加原因，例如 `! 阻塞 · 自动续跑已暂停 · 提前停止 · 原因：<reason>`，不追加恢复提示；能放入正文宽度时优先保留完整状态。暂停只禁止后续自动续跑，不中止当前模型/工具调用，提前停止触发语义不变。
- 所有行使用终端单元格测量，长文本以 Unicode `…` 单行截断，不换行。任务仅有左侧完成勾/箭头/圆圈，不引入“当前”文字后缀、折叠控件、新快捷键、Widget 配置或遥测字段、计时器、动画、spinner 或进度条。
- 创建计划必填 title/goal；改变规范化 goal 时 replan 必须显式给新 title。计划总览为覆盖整组工作的稳定行动短句（动词＋对象，例如“检查并整理 wifi-audit”），不写成当前步骤、项目/类别/状态碎片或需求复述；任务 title 是简短动作，细节写 description。title 最多 60 字符，40 显示列只是生成建议，不是渲染宽度上限。完整范围在 goal，执行描述在 description，验收在 doneWhen，实际结果仅由 completions[].result 写入。
- 不为外观自动 replan、猜测标题或回填旧状态；/reload 不做迁移，V1/V2 必须显式 clear 后重建。验收用 V3 正式字段，核对长短标题、描述消费者及旧字段拒绝，不再做旧标签/原文回退验收。
- RPC `formatTodoWidgetLines(model)` 保留原有无框与缩进，标题仅去掉“已完成”文字：`计划：<state.title> · N/T`。任务前可有 `  … 较早已完成 N 项`；任务行为 `  ✓ ...`、`  → ...`、`  ○ ...`，任务后为 `  … 另有 N 项待办`、`  ! ...`。更多行仍在告警前；不受终端宽度影响，不带 ANSI、主题、边线、截断或右填充。TUI 与 RPC 共用选择窗口、计数和告警内容。
- hidden 不输出；null/clear 或已释放的 completed 隐藏 Widget。completed 在完成当次 run 内保留最后至多两条完成行及可选较早完成摘要，无 blocked/paused/earlyStop 告警；`agent_settled` 后只隐藏 Widget，completed state 仍供 `/todos`、show 和 undo 使用，undo 回 active 会重新显示，undo 恢复 completed 前像仍保持隐藏，恢复的 completed 计划直接视为已释放而隐藏。新 plan 替换旧 Widget，不做跨计划档案、不新增持久化历史字段，state schema 仍为 V3。unavailable 在读取未知状态前受保护，只输出单行无框诊断，前缀 warning、说明 text，不附正常任务。
- V3 正式字段无旧属性兼容或状态时间戳；title/goal/description 在 clone、undo、恢复和模型/详情消费者中保留，任务 ID、原子推进及续跑预算不变。TUI 不写重复 Footer；RPC 英文 Footer Status 仍在 completed 时独立清空；非交互行为及工作中立即打开 `/todos` 只读快照的行为不变。

完整列表只在：

- `/todos`；
- Todo `show` 的模型可见 content 和展开结果；
- context 强制完整提醒。

Widget 渲染使用 `visibleWidth()` 按单元格测量与 `truncateToWidth()` 截断（包括中文、emoji 和 ANSI 样式），保证任何终端宽度下不超过可用列数；`/todos` 完整字段按显示列换行而非截断，并以八视觉行窗口滚动。按当前宽度重新布局，主题变化重新取色，不缓存旧主题 ANSI 文本。`/todos` 在工作中仍立即打开当时的只读快照，关闭不回滚后台进度，Widget 继续反映实时状态。

## 14. 包与运行方式

开发目录：

```text
pi-kit/extensions/linear-todo/
```

开发运行：

```bash
pi -e ./pi-kit/extensions/linear-todo/index.ts
```

建议包结构：

```text
linear-todo/
├── package.json
├── index.ts
├── schema.ts
├── reducer.ts
├── state.ts
├── reminder.ts
├── render.ts
├── src/
│   ├── render-shared.ts
│   └── widget.ts
└── tests/
```

`package.json`：

- Pi 核心包放入 `peerDependencies`；
- 测试运行器放入 `devDependencies`；
- `pi.extensions` 指向 `./index.ts`；
- 第一版不引入运行时第三方依赖。

## 15. 测试切面

### 15.1 Reducer

纯函数测试覆盖全部 action 和非法转换，是最高优先级测试。

### 15.2 State Recovery

使用构造的 Session Entry 数组验证：

- 正常恢复；
- clear 截断；
- Branch 切换；
- V1/V2、未知版本、损坏/旧属性快照保护及 clear 重建；
- title/goal/description 在 clone、undo、重启及分支中的保留；
- nudge ledger 恢复。

### 15.3 Reminder Policy

表驱动测试覆盖模式、phase、stopReason、pending message 和 stageKey 组合。

### 15.4 Extension Integration

验证工具 details、context 注入、`agent_before_settle` 续跑和 Widget 刷新，不调用真实模型。核对 description 实际进入反馈、compact/full 提醒、show、/todos 和历史详情；检查 Widget title、最小行模型与 alerts.blocked，不以仅有 schema 字段替代消费者验收。

## 16. 被否决方案

### 16.1 单文件 Extension

优点是实现快，但状态机、Session 恢复、提醒策略和 UI 会集中在一个文件，难以测试和维护，因此不采用。

### 16.2 完整 Controller/Repository 分层

当前只有一个 Session 内状态源，引入 Repository 接口、DI 容器和通用事件总线属于过度设计，因此不采用。

### 16.3 Claude TaskCreate/List/Get/Update 模型

owner、依赖图和文件锁服务于多 Agent，不符合单主代理线性执行目标，因此不采用。

### 16.4 外部 JSON 文件作为权威状态

会破坏 `/tree` 分支语义，并增加文件锁、清理和路径管理问题，因此不采用。

### 16.5 每次 LLM 请求都注入完整列表

会持续消耗注意力和 Token，增加模型对过期计划的依赖，因此采用短提醒和按需完整提醒。

### 16.6 所有模式自动续跑

Print/JSON 常用于自动化或一次性调用，隐式增加模型回合可能造成成本和运行时间失控，因此仅在 TUI/RPC 中启用。

## 17. 架构不变量

实现和 Review 必须持续验证以下不变量：

1. 当前计划最多一个 in_progress；
2. reducer 是唯一 TodoState 修改入口；
3. reminder 不得推进任务；
4. render、共享渲染处理和 Widget 不得修改状态；Widget 窗口只由 builder 选择；
5. Todo 工具调用严格串行；
6. Session Branch 最近快照是 Todo 权威状态；
7. clear 后更早状态不得重新出现；
8. 同一 stageKey 最多自动续跑一次，同一 `(planId, cursor)` 最多 3 次；
9. JSON/Print 永不自动续跑；
10. UI 失败不影响状态提交；
11. nextItemSeq 在同一 planId 内永不回退或复用；
12. completed 计划在完成当次 run settle 后释放 Widget，但保留 state；null/clear、已释放或恢复的 completed 隐藏 Widget；undo 回 active 重新显示，新计划替换旧 Widget、Branch 切换恢复相应计划，不做跨计划历史归档；schema 保持 V3。

## 18. 实施顺序

1. `schema.ts` 和 `reducer.ts`；
2. reducer 单元测试；
3. `state.ts` 及 Session 恢复测试；
4. `todo` 工具适配器；
5. `reminder.ts` 和事件接线；
6. 自动续跑防循环测试；
7. `render.ts` 的历史行及 `/todos`、`src/render-shared.ts` 和独立 `src/widget.ts`；
8. 集成验证和代码审查。

## 19. 确认结果

以下架构决策已确认，不再作为实现阶段的开放问题：

- 使用适度模块化结构；
- 使用单个 `todo` 工具；
- 使用游标式线性状态机；
- 使用 Tool Result Details 作为 Todo 权威状态；
- 使用隐藏 CustomMessage 持久记录自动续跑；
- 自动续跑只在 TUI/RPC 启用；
- JSON/Print 只接受上下文提醒；
- 第一版不引入外部存储和第三方运行时依赖。
