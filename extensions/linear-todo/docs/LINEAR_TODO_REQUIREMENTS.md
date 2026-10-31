# Pi Linear TodoList 工具需求文档

- **状态**：需求与架构已确认
- **日期**：2026-09-15
- **目标运行时**：Pi 1.3.0+
- **实现形态**：Pi Extension
- **执行模型**：单主代理、主进程内线性执行
- **架构说明**：[LINEAR_TODO_ARCHITECTURE.md](./LINEAR_TODO_ARCHITECTURE.md)
- **验收与评测**：[LINEAR_TODO_E2E_EVALUATION_PLAN.md](./LINEAR_TODO_E2E_EVALUATION_PLAN.md)

## 1. 背景

长程编码任务通常包含需求理解、代码探索、实现、测试、修复和验证等多个阶段。即使模型具备较强的规划和长上下文能力，任务仍可能因为以下因素失去连续性：

- 大量工具调用造成上下文污染；
- 自动压缩丢失部分计划细节；
- 用户中途插入新要求；
- 工具失败、重试或方向调整；
- Session 恢复或对话分支切换；
- 模型在完成部分工作后过早结束。

本需求不实现子代理或任务调度系统，而是在当前主代理中提供一个轻量、持久、分支感知的线性 TodoList，作为长程任务的外部状态和提醒机制。主要使用者是 Agent：自主建计划、推进、修订和结束，用户通常无需干预；最新用户请求优先于旧计划，用户命令仅为查看和紧急控制入口。

## 2. 产品定位

TodoList 不是替代模型推理的工作流引擎，也不负责自动执行任务。

其职责是：

1. 保存当前长期目标和剩余步骤；
2. 保证任务按顺序推进；
3. 在上下文压缩、恢复和长时间执行后重新提醒模型；
4. 防止遗漏测试、构建、验证等收尾步骤；
5. 向用户展示当前进度；
6. 在模型提前停止时进行有限度的续跑提醒。

## 3. 设计原则

### 3.1 简单优先

- 对简单任务不创建 TodoList；
- 不要求模型为每个文件读取、搜索或 Shell 命令创建任务；
- 默认维护 3–7 个结果级任务；
- 第一版不实现通用项目管理能力。

### 3.2 状态机优于自由维护

不允许模型自由设置多个任务为 `in_progress`。系统使用游标推导任务状态，从结构上保证最多只有一个当前任务。

### 3.3 外部状态优于上下文记忆

Todo 状态必须独立保存在 Session 中，并可在压缩、恢复和分支切换后重新构建，不依赖模型记住之前生成的计划。

### 3.4 软提醒优于无限强制

系统可以提醒模型继续，但不得形成无限自动续跑循环。相同计划阶段最多自动提醒一次。

### 3.5 模型提醒与用户 UI 分离

- 模型提醒通过上下文注入实现；
- 用户进度通过 Widget、命令和工具渲染实现；
- UI 内容本身不能被视为模型已经看到。

## 4. 目标

### 4.1 功能目标

- 提供一个模型可调用的 `todo` 工具；
- 支持创建、推进、修订、阻塞、恢复、查看和清理计划；
- 支持 Session 恢复和 `/tree` 分支状态恢复；
- 支持上下文压缩后的计划重新注入；
- 支持模型提前停止时的一次性续跑提醒；
- 在 TUI 中持续展示当前任务和总体进度；
- 在 RPC、JSON、Print 模式下无 UI 依赖地正常工作。

### 4.2 质量目标

- 状态转换确定且可测试；
- 不出现两个同时进行中的任务；
- 不因重复工具调用导致状态损坏；
- 提醒内容短小，不显著污染上下文；
- Todo 工具自身不访问网络、不执行 Shell、不修改业务文件。

## 5. 非目标

第一版明确不实现：

- 子代理或并行代理；
- Todo 项自动执行；
- 多 Agent owner、claim、抢占与任务分配；
- `blocks` / `blockedBy` 依赖图；
- 多进程文件锁；
- 项目级看板、时间估算、截止日期；
- 定时提醒或操作系统通知；
- 跨不同 Pi Session 自动共享任务；
- 自动提交、合并或回滚代码；
- 强制模型为所有请求创建计划。

## 6. 使用策略

### 6.1 建议创建 TodoList 的场景

满足任一条件时，模型应考虑创建计划：

- 存在 4 个及以上有意义的步骤；
- 预计需要 8 次以上工具调用；
- 涉及多个模块或多种类型的修改；
- 用户明确给出多个交付要求；
- 包含实现、测试、构建、验证等不同阶段；
- 任务可能跨上下文压缩或 Session 恢复继续；
- 用户明确要求维护任务列表。

以上数字是提示性阈值，不是硬编码限制。

### 6.2 不建议创建 TodoList 的场景

- 单文件小改动；
- 单次命令执行；
- 简单信息查询或解释；
- 已明确且可以直接完成的两三步修改；
- 纯对话、翻译或文本改写。

### 6.3 创建时机

- 需求和范围明确时可以直接创建；
- 对范围模糊的任务，允许先做一次轻量探索，再创建计划；
- 不应在尚不了解代码结构时生成过细、容易失效的计划。

## 7. 核心数据模型

```ts
interface TodoState {
  schemaVersion: 3
  planId: string
  title: string
  goal: string
  /** 状态变更计数：每次产生新快照的转换 +1 */
  revision: number
  cursor: number
  nextItemSeq: number
  phase: "active" | "blocked" | "completed"
  items: TodoItem[]
  blockedReason?: string
  /** 单步撤销快照；快照自身不保留撤销链 */
  undo?: { state: TodoState | null }
}

interface TodoItem {
  id: string
  title: string
  description?: string
  doneWhen?: string
  result?: string
}
```

### 7.1 派生状态

任务状态不直接持久化，由 `cursor` 和 `phase` 推导：

- `index < cursor`：`completed`；
- `index === cursor && phase === "active"`：`in_progress`；
- `index === cursor && phase === "blocked"`：`blocked`；
- `index > cursor`：`pending`；
- `cursor >= items.length`：计划为 `completed`。

### 7.2 约束

- 计划 `title` 必填、规范化后非空，硬上限 60 字符；是覆盖整组工作的稳定行动总览（动词＋对象），不得用当前步骤冒充；
- `goal` 必填、规范化后非空，硬上限 300 字符，保存完整目标与范围；
- 初始计划至少包含一个任务；
- 默认建议不超过 7 项，硬限制为 20 项；
- 任务 `title` 是唯一简短动作名，必填、规范化后非空，硬上限 60 字符；
- 任务 `description` 可选，提供时非空，硬上限 300 字符，保存路径、命令、参数及执行细节，不与验收条件混用；
- `doneWhen` 是可选事前验收条件，提供时非空，硬上限 300 字符；
- `result` 是可选事后实际观察结果，硬上限 1000 字符，只能通过 `advance.completions[].result` 写入，不代表独立验收证明；
- `TODO_SCHEMA_VERSION = 3`；类型/守卫为 `TodoState` / `isTodoState`，无 V2 别名或迁移；V1/V2、未知版本和损坏快照均进入非变更式保护，仅显式 `clear` 后重建；
- 不接受旧 `displayTitle`、状态 `createdAt`/`updatedAt` 或其它未知属性；状态无时间戳，不影响 SDK 消息/会话自身的 timestamp；
- title、goal、description 在 clone、undo、重启和分支恢复中完整保留，并在完整详情及有界模型提醒中有消费者；
- Task ID 由工具根据 `nextItemSeq` 生成，模型不负责生成；
- `nextItemSeq` 只递增，`replan` 和删除任务后也不得复用 ID；
- `revision` 是单调递增的状态变更计数，每次产生新快照的转换都必须 +1；
- 同一计划内 ID 不重复；
- 当前计划完成历史保留在原 V3 items/cursor 中，不新增历史归档字段或跨计划档案；显式 `clear` 清除当前状态，新 plan 替换旧计划视图。

## 8. Todo 工具接口

工具名称：`todo`

工具必须设置：

```ts
executionMode: "sequential"
exposure: "model-only"
```

确保同一模型消息中的多个 Todo 调用按顺序执行。只允许模型直接调用：codemode 等嵌套调用不单独持久化工具结果，无法满足 Session Branch 权威快照约定。

### 8.1 公共参数

```ts
interface TodoInput {
  action:
    | "plan"
    | "advance"
    | "replan"
    | "insert"
    | "undo"
    | "block"
    | "resume"
    | "show"
    | "clear"

  title?: string
  goal?: string
  tasks?: Array<{
    title: string
    description?: string
    doneWhen?: string
  }>
  position?: "next" | "end"
  completions?: Array<{ result?: string }>
  reason?: string
}
```

每个 action 只读取固定的字段集合；传入其它字段一律返回 `INVALID_INPUT`，不允许出现「schema 接受、reducer 忽略」的静默 no-op。

| action | 允许字段 |
|---|---|
| `plan` | `title`, `goal`, `tasks`（全部必填） |
| `advance` | `completions`（必填，每条记录可带 result） |
| `replan` | `title`, `goal`, `tasks`, `reason` |
| `insert` | `tasks`, `position` |
| `undo` | 无 |
| `block` | `reason` |
| `resume` / `show` / `clear` | 无 |

顶层 `title` 仅适用于 plan/replan；因共用多动作 schema 可标为 Optional，但 reducer 对 plan 强制必填。replan 改变规范化 goal 时也必须显式提供新 title；goal 未变时省略则保留。计划标题非法返回 `INVALID_PLAN_TITLE`，任务标题非法返回 `INVALID_TASK_TITLE`，执行描述非法返回 `INVALID_DESCRIPTION`，均不得部分更新。新任务只接受 title/description/doneWhen，不接受 result 或旧属性；不保留旧短标题/时间戳错误码。

### 8.2 `plan`

创建一个新计划。

必填：

- `title`
- `goal`
- `tasks`

行为：

1. 生成新的 `planId`；
2. 为每个任务生成稳定 ID；
3. 设置 `revision = 1`；
4. 设置 `cursor = 0`；
5. 第一项自动成为当前任务；
6. 如果已有未完成计划，返回错误并要求使用 `replan` 或 `clear`。

### 8.3 `advance`

从当前项开始，原子完成一项或连续多项，并进入下一项。

必填完成记录：

- `completions`：非空完成记录数组，每条记录对应一项，按当前游标向后连续映射；长度不能超过剩余任务数。
- 每条记录只接受可选 `result`，即做完后实际观察到的结果或关键事实；它不同于事前的 `doneWhen`，也不是独立验证证明。不需要结果说明时使用 `{}`，不强迫 Agent 编造文字。

唯一入口是 `completions[].result`；单项也必须传一条记录，例如 `[{}]`。不接受旧 `outcome`、顶层 result、独立 count、其它别名或记录内 task ID 跳选；没有隐式单项回退。

行为：

1. 当前计划必须处于 `active`；
2. 先校验全部记录和每项 result；空数组、数量越界或非法记录返回错误，原状态不变；
3. 按顺序将已提供的 result 写入对应任务，省略的结果不生成文本；
4. 一次执行 `cursor += completions.length`、`revision += 1`，只产生一个状态快照和一个 undo 前像；
5. 若仍有任务，新的当前项自动成为 `in_progress`，不为中间位置触发额外续跑；
6. 若没有剩余任务，将计划 phase 设置为 `completed`；
7. 返回总体进度、本次完成任务及已报告的结果，并返回新的当前/下一任务；
8. `undo` 撤销整个批次，而不是最后一项；完成计划也可整批撤销；
9. 不自动清除完成计划，使用保存 result 的 V3 快照；V1/V2 不迁移，旧计划进入版本保护，可显式 clear 后重新创建。

### 8.4 `replan`

替换当前任务和所有待处理任务，同时保留已完成历史。

必填：

- `tasks`：新的剩余任务列表；
- `reason`：修订原因。

可选：

- `goal`：目标发生变化时更新。
- `title`：规范化 goal 未变时可省略并保留原值，提供则替换；goal 改变时必须显式提供新 title，缺少则整次拒绝，不能沿用旧标题。已完成任务的 title/description/doneWhen/result 保留；新任务提供自身 title 和可选 description。clone、undo 和恢复必须保留字段，且不得因此补充续跑机会。

行为：

1. 保留 `index < cursor` 的已完成任务及 result；
2. 删除旧的当前任务和待处理任务；
3. 添加新的剩余任务并生成新 ID；
4. `revision += 1`；
5. 新列表第一项成为当前任务；
6. 若新剩余列表为空且存在已完成历史，计划进入 `completed`；若没有任何已完成历史，返回 `INVALID_TASKS`（空计划没有意义，应使用 `clear`）；
7. 清除原有 blockedReason。

### 8.5 `insert`

在计划中间插入新任务，不移动 cursor。

必填：

- `tasks`：要插入的任务列表。

可选：

- `position`：`next`（默认，插到当前任务之后）或 `end`（插到计划末尾）。

行为：

1. 计划必须处于 `active`（blocked 需先 `resume`，completed 不可插入）；
2. 新任务使用 `nextItemSeq` 分配 ID，`nextItemSeq` 递增；
3. 现有任务（含已完成项及其 result）保持不变；
4. `cursor` 不变，当前任务仍是同一项；
5. 总任务数不得超过 20；
6. `revision += 1`。

用途：执行中发现必须先做的紧急任务，不需要 `replan` 重建剩余计划。

### 8.6 `undo`

撤销上一次状态变更。

行为：

1. 状态中保存单步快照 `undo.state`（上一次变更前的完整状态，`null` 表示当时没有计划）；
2. 每个产生 `changed: true` 的转换都会覆盖该快照（`show` 不覆盖）；
3. `undo` 恢复快照，非空状态的 `revision = 当前 revision + 1`，并清空 `undo`，因此最多连续撤销一次；同一计划保留 `nextItemSeq` 高水位，不撤销已分配 ID；
4. 没有快照时返回 `NOTHING_TO_UNDO`；
5. `clear` 之后状态为 `null`，没有可承载快照的载体，因此不支持撤销 `clear`。

### 8.7 `block`

标记当前任务被阻塞。

必填：

- `reason`

行为：

- phase 设置为 `blocked`；
- 当前任务和 cursor 不变；
- `revision += 1`；
- 禁止自动续跑提醒；
- 工具结果明确提示需要用户输入、环境修复或后续 `resume/replan`。

### 8.8 `resume`

解除当前阻塞。

行为：

- 仅允许从 `blocked` 转换为 `active`；
- 清除 blockedReason；
- 当前任务保持不变；
- `revision += 1`；成功显式 resume 的 revision 作为该位置新的纠偏阶段标记，在位置总预算内重新获得一次续跑资格。

### 8.9 `show`

读取当前完整 Todo 状态。

行为：

- 只读；
- 不修改 revision 或其它状态；
- 返回计划 title/goal、进度、当前任务、阻塞原因和所有项目，包含 description/doneWhen/result。

### 8.10 `clear`

显式删除当前 Todo 状态。

行为：

- 允许清除已完成或未完成计划；
- 未完成计划清除时，工具结果应明确说明还有多少任务未完成；
- 不自动创建新计划。

## 9. 工具返回内容

每次工具调用都必须在 `details` 中保存完整快照：

```ts
interface TodoToolDetails {
  action: TodoInput["action"]
  state: TodoState | null
  transition: string
  error?: string
}
```

模型可见的 `content` 保持简短。变更反馈适当展示计划 title/goal、当前及下一任务的 title/description、doneWhen 与阻塞状态；`show`、`/todos` 和展开历史展示完整字段。description 不能仅保存于 schema 而不呈现给模型。工具折叠行固定一行，摘要在前、进度以 ` · N/T` 紧跟其后（不贴右边缘）；展开只描述本次调用，使用 `compact-tool-ui` 树枝：`├─` 引导 section 标签、`│ ` 在统一列承载内容、`╰─ /todos 查看完整计划` 收尾；标签不与值同行；`操作/结果/受阻/错误/计划/目标/当前` 主结果优先；不重放无关任务。

工具拒绝调用时（领域错误、兼容性保护）必须返回 `isError: true`，并保留 `details.state` 为拒绝前的快照；模型因此看到错误结果而不是成功。

示例：

```text
Completed 2/5: Implement cache invalidation
Title: Add and verify Redis caching
Goal: Add Redis caching with configurable invalidation and integration coverage
Current: Run integration tests
Description: Exercise cache hit, miss and invalidation paths in the integration suite
Done when: All cache-related tests pass
```

计划完成时：

```text
Plan completed: 5/5 tasks finished.
Keep the completed plan for the final summary; clear it only when no longer needed.
```

## 10. 状态持久化与恢复

### 10.1 数据来源

Todo 的权威状态为当前 Session 分支上最近一次 `todo` 工具结果中的 `details.state`。

第一版不额外写独立 JSON 文件。

### 10.2 恢复事件

在以下事件中重建状态：

- `session_start`
- `session_tree`

重建算法：

1. 从后向前遍历 `ctx.sessionManager.getBranch()`；
2. 查找最近的 `role === "toolResult" && toolName === "todo"`；
3. 该工具结果中的有效 `details.state` 为当前权威状态；
4. `state === null` 表示当前分支没有活动 Todo；
5. V1/V2、未知 schemaVersion、损坏快照或带旧属性的快照保持保护并显示诊断，不迁移；必须显式 clear 才能重建；
6. `isError === true` 且不携带 `state` 的工具结果不包含状态信息，直接跳过并继续向前查找；非错误的工具结果缺少 `state` 仍视为不支持的格式。

### 10.3 分支语义

- 从较早节点创建分支后，只恢复该分支可见的 Todo 状态；
- 其他分支之后发生的 Todo 更新不得泄漏到当前分支；
- 完成任务后回退分支，应恢复到回退点的任务进度。

### 10.4 上下文压缩

压缩不能删除 Todo 的持久状态。即使旧工具结果不再进入模型上下文，扩展仍须从完整 Session 分支恢复状态，并通过提醒机制重新注入当前计划。

## 11. 模型提醒策略

### 11.1 提醒内容

普通提醒只包含：

```text
[Todo 2/5]
Title: Add and verify Redis caching
Goal: Add Redis caching with configurable invalidation and integration coverage
Current: Implement cache invalidation
Description: Invalidate cached values when the underlying record changes
Done when: Unit and integration tests pass
Next: Run the full test suite
```

要求：

- 默认不超过 600 字符；compact/full 均适当保留 title/goal 与任务 description，为当前任务和验收条件预留预算，不整串硬切造成执行信息丢失；
- 不包含所有已完成项目；
- 不重复注入 result 历史；
- blocked 状态必须包含阻塞原因；
- 暂停自动续跑时明确显示暂停状态，不要求 Agent 执行用户命令；
- 状态变更工具结果复用同一紧凑工作视图，`advance` 额外回显实际记录的 result；result 不等于独立验证结果。

### 11.2 强制提醒场景

以下事件后的下一次模型请求必须注入提醒：

- Session 恢复；
- `/tree` 切换；
- 上下文压缩完成；
- 用户提交新消息且当前存在未完成计划。

`replan`、`block`、`resume` 等状态变更通过工具结果立即返回工作视图，下一次请求无需重复注入。

### 11.3 周期提醒

当 Todo 长时间未更新时：

- 每 3 个 agent turn 最多注入一次；
- Todo 工具刚刚返回时不重复注入，因为工具结果已经包含当前状态；
- completed 状态不再注入执行提醒。

周期值第一版可以是常量，后续再开放配置。

## 12. 提前结束与自动续跑

### 12.1 触发条件

监听 `agent_before_settle` 边界（不是 `agent_settled`：后者是纯通知，返回值会被丢弃）。自动续跑仅在 TUI 和 RPC 模式启用。

`before_agent_start` 同时会为用户消息和 `triggerTurn` 的 custom message 触发：只有 `event.messageType === "user"` 才算新的用户回合（重新武装 `userTurnReminder`、清除 early-stop 警告），否则自动续跑自身会被误判为新一轮用户输入。

满足全部条件时，可以追加一条 draft 并在同一个 run 内继续：

- `ctx.mode` 为 `tui` 或 `rpc`；
- 存在未完成计划；
- phase 为 `active`；
- 当前没有排队中的用户消息；
- 本轮不是用户主动 abort；
- 本次结束不是 error、aborted 或 deferred；
- 用户没有暂停自动续跑（`/todos pause`）；
- 当前 `(planId, cursor, resumeRevision)` 尚未自动提醒过；
- 当前 `(planId, cursor)` 的自动续跑次数小于 3。

### 12.2 提醒消息

```text
Continue the current Todo task for the latest user request. Check its completion condition, finish the work, then call todo advance with completions for consecutive tasks already completed and optional observed results. If the request supersedes this plan, revise or clear it instead of executing obsolete tasks. If genuinely blocked or waiting for user input, call todo block with the concrete reason. Do not claim unrun checks or stop just to summarize.
```

文案明确期望完成当前工作并 `advance`，但不能强迫模型执行已被最新请求取代的旧任务。追加紧凑工作视图，包含计划 title/goal、当前任务及 description、完成条件和下一任务；真正阻塞或等待用户输入时记录具体原因，不伪造进展。

发送方式：返回 boundary 结果，由 host 追加 `custom_message` 并在当前 run 内继续一次模型调用：

```ts
{
  entries: [
    ...event.entries,
    {
      type: "custom_message",
      customType: "linear-todo-auto-continue",
      content: buildAutoContinueText(state),
      display: false,
      details: { stageKey, planId: state.planId, cursor: state.cursor },
    },
  ],
  continue: true,
}
```

不能只返回 `{ continue: true }`：host 会检查投影后的上下文，最后一条不是 assistant 消息（或存在待发自定义消息）时才接受续跑。

### 12.3 防循环规则

- 每个 `(planId, cursor, resumeRevision)` 最多自动续跑一次；resumeRevision 初始为 0，仅成功显式 `todo resume` 后更新；
- 每个 `(planId, cursor)` 总计最多自动续跑 3 次，包含显式 block/resume 带来的恢复机会；
- `replan`、`insert`、`undo` 不重置机会，回退到已消耗的位置不退款；blocked 状态的 replan 不等同显式 resume；
- 计数与纠偏 key 随 `custom_message.details` 持久化，成功 resume 从工具结果恢复，并按 branch 时间顺序重建，旧版 key 可定位时保守映射，不重复计数；
- `advance` 到新的位置可获得初始提醒；用户新消息、失败调用和 `/todos pause/resume` 不补充机会；
- stageKey 在返回 draft 之前同步标记，不依赖 `message_end`（boundary draft 不会触发该事件）；
- 如果模型在状态不变的情况下再次停止，不再自动触发；
- 只有已消耗的机会是唯一阻止续跑的条件时，才显示 early-stop 警告；暂停、排队输入、error/abort/deferred 和非交互模式不产生该警告；
- blocked 和 completed 状态永不自动续跑。

## 13. TUI 交互

### 13.1 常驻 Widget

使用 `ctx.ui.setWidget("linear-todo", ...)` 展示目标、完成进度和有界任务窗口。`src/widget.ts` 的 `buildTodoWidgetModel(snapshot)` 生成以 `hidden` / `unavailable` / `plan` 区分的结构化模型；`index.ts` 每次刷新只构建一次，交给 `TodoWidget(model, theme)` 或 `formatTodoWidgetLines(model)`，TUI 与 RPC 不各自选择任务窗口。

用户确认采用**左侧圆角半包**：首行 `╭─ `、中间内容行 `│  `、最后实际内容行 `╰─ `。不生成右线或延伸的上下横线，保留配色和有界任务窗口：

```text
╭─ 检查并整理 wifi-audit（1/6）
│  ✓ 梳理文档与脚本
│  → 语法与静态检查
│  ○ 核对文档与实现
│  ○ 检查跨脚本约定
╰─ 另有 2 项待办
```

- Widget plan 模型的 `title` 直接来自 `state.title`，不叫 goal，无 goal/旧标签回退或渲染语义摘要。任务行只保留 `{ title, kind: "completed" | "current" | "pending" }`，以 kind 替换 isCurrent，不透传 id 或叠加重复 status；执行 description 保留在 `/todos`、工具历史、模型反馈和提醒，不挤入 Widget 任务行。
- plan 分支在可用宽度至少 12 列时，使用 dim 的三列前缀：首行 `╭─ `、中间 `│  `、末行 `╰─ `，正文预算 `available - 3`。小于 12 列去掉全部装饰并使用全宽。末行是实际更多提示、任务或告警；没有更多提示就由最后任务收尾，有告警则告警收尾。不增加纯底线或装饰行，不延伸上下横线，不画右线、背景或右补齐，没有 72 列上限。
- TUI 首行为 `<行动式总览>（N/T）`，不加“计划：”或中点分段。总览概括整组工作，例如“检查并整理 wifi-audit”，不与当前条目混同。标题预算为 Widget 可用列减去半包前缀及完整括号进度后缀，无固定目标上限；仅真实超宽时省略，保持单行，极窄仅显示 `N/T`。
- 窗口为最近两条 completed＋当前项＋后续两条 pending，最多五条任务行。更早完成项以 `… 较早已完成 N 项` 摘要放在所有任务之前，N 只计未显示的 completed；`另有 N 项待办` 放在任务之后、告警之前，N 排除当前与可见 pending。正常最多八行，有一条合并告警最多九行；只有一个任务的计划无告警时为标题＋任务两行（适用告警时三行），仅剩一个未完成任务不排除其上方的完成历史。
- 当前只表示计划 cursor，不是实际执行遥测。窗口及 `kind` 只由 builder 派生，阻塞由 `plan.alerts.blocked` 决定，不读取重复行 status；TUI 不重选任务或改写状态。当前 `→` 为 accent、blocked 时 warning，未来 `○` 为 muted；正常当前标题 accent+bold，blocked 当前标题 text+bold，未来任务标题 text。完成 `✓` 为 success、完成标题 muted，不加删除线；较早完成摘要 muted；进度括号 muted，计划 title 为 text、不加粗，完成数大于零时数字计数 success，零进度计数 text、不加粗；更多提示、恢复提示 muted，只有半包线条 dim。
- 告警仍只追加一行，信号与状态标签 warning、原因 text、恢复提示 muted。单阻塞为 `阻塞：<reason>`；单暂停为 `自动续跑已暂停 · /todos resume`；单提前停止为 `提前停止`。多状态先合并标签，再追加原因，例如 `! 阻塞 · 自动续跑已暂停 · 提前停止 · 原因：<reason>`，不追加恢复提示；能放入正文宽度时优先保留完整状态。暂停只禁止后续自动续跑，不中止当前模型/工具调用，提前停止触发语义不变。
- 所有行使用终端单元格测量，长文本以 Unicode `…` 单行截断，不换行。任务仅使用左侧完成勾/箭头/圆圈，不引入“当前”文字后缀、折叠控件、新快捷键、Widget 配置或遥测字段、计时器、动画、spinner 或进度条。
- 创建计划必填 title/goal；改变规范化 goal 的 replan 必须显式提供新 title。计划 title 是覆盖整组工作的稳定行动短句（动词＋对象，例如“检查并整理 wifi-audit”），不写成当前步骤、项目/类别/状态碎片或需求复述；任务 title 是唯一简短动作名，细节放 description。title 均最多 60 字符，建议最多 40 显示列仅为生成软要求，不是固定渲染宽度上限；完整范围在 goal，执行细节在 description，验收条件在 doneWhen。
- 不为外观自动 replan、猜测标题或回填旧状态；`/reload` 不迁移 V1/V2，必须显式 clear 后重建。验收用 V3 正式字段，检查长短标题、完整详情和旧属性拒绝，不能用旧字段回退场景代替。
- RPC `formatTodoWidgetLines(model)` 保留原有无框与缩进，标题仅移除“已完成”文字，为 `计划：<state.title> · N/T`；任务前可有 `  … 较早已完成 N 项`，任务行为 `  ✓ ...`、`  → ...`、`  ○ ...`，任务后为 `  … 另有 N 项待办`、`  ! ...`。更多行仍在告警前；不受终端宽度影响，不带 ANSI、主题、边线、截断或右填充。TUI 与 RPC 共用选择窗口、计数和告警内容。
- hidden 不输出；null/clear 或已释放的 completed 隐藏 Widget。completed 在完成当次 run 内显示最后至多两条 completed 及可选较早完成摘要，不显示 blocked/paused/earlyStop 告警；`agent_settled` 后只释放 Widget，state 仍供 `/todos`、show 和 undo 使用，undo 回 active 会重新显示，undo 恢复 completed 前像仍保持隐藏，恢复的 completed 计划直接隐藏。新 plan 替换旧 Widget，不做跨计划归档。unavailable 在读取未知状态前受保护，只输出单行无框诊断，前缀 warning、说明 text，不附正常任务。
- V3 使用必填计划 title/goal 与任务 title/可选 description，无时间戳或旧字段兼容；完整执行信息应传递到 clone、undo、恢复、工具历史、模型反馈和提醒。任务 ID、原子推进及续跑预算不变。TUI 不写重复 Footer；RPC 英文 Status、非交互行为及工作中立即打开 `/todos` 只读快照的行为不变。

### 13.2 Footer 状态

TUI 不写 Footer：Widget 已经显示相同的进度、阶段和暂停状态，而 Footer 空间需要与其他扩展共享。仅在 `rpc` 模式设置状态，作为忽略 Widget 的客户端的回退：

```text
todo 2/5 done
todo 2/5 done paused
todo 2/5 done · blocked
todo unavailable
```

RPC Status 保持现有英文回退文案 `todo <已完成>/<总数> done` 及其状态后缀，不随 Widget 改为中文或右对齐；进度仍表示已完成数量而非当前项序号。无计划或 completed 后清除 Footer，与 completed Widget 在 settle 后清空相互独立。

### 13.3 `/todos` 命令

提供查看与运行时控制命令：

```text
/todos            # 显示完整计划
/todos list       # 同上
/todos pause      # 暂停自动续跑
/todos resume     # 恢复自动续跑
```

要求：

- 命令参数不得被丢弃：未知参数要给出明确提示；
- 关闭提示与关闭按键必须来自注入的 `keybindings`（`app.interrupt`），不得硬编码 Escape；未注入时退回 Escape；
- TUI 模式以打开时的只读快照显示完整列表，description/doneWhen/result 可换行，不做截断；以八个视觉行窗口滚动，不是八个任务窗口；
- 方向键/PgUp/PgDn 滚动、Home/End 到首尾，均使用注入的 keybindings，退出仍使用 app.interrupt；滚动不修改 revision/undo，不等待 idle、不停止后台模型或工具；
- RPC 模式立即 notify 完整、无截断的清单，不套用 TUI 八视觉行窗口；
- Print/JSON 模式不得报错；
- `pause` 只是用户的逃生口，运行时不持久化：新 session 默认恢复自动续跑；
- `/todos pause/resume` 立即生效，不等待 idle、不打断当前工具或模型调用，也不补充续跑机会；
- `/todos`、`/todos list` 和 `/todos show` 在工作中也立即响应，不等待 idle；TUI 展示打开时的只读快照，关闭不回滚后台进度，重新打开可刷新；RPC 立即通知清单，JSON/print 不输出 UI；
- 第一版不允许用户在该界面直接编辑计划内容。

## 14. 工具提示词要求

`promptSnippet` 应保持简短：

```text
Maintain a short ordered Todo plan for long, multi-step work.
```

`promptGuidelines` 应包括：

- 仅在复杂、多步骤或明确要求时使用 todo；
- 计划 title 写稳定的动词＋对象总览，覆盖整组工作，不用当前步骤代替；goal 保存完整目标/范围；
- 任务 title 写简短动作，description 保存执行细节，doneWhen 保存验收条件，result 只报告完成后的实际结果；不为每次文件读取或命令建立任务；
- 使用 `advance` 的 `completions` 原子报告从当前项开始已完成的一项或连续多项，逐项 result 可选，不跳过未完成任务；
- 遇到阻塞时调用 `block`，不要虚假标记完成；
- 需求或实现方向变化时调用 `replan`；
- 对代码修改，计划通常应包含测试或验证步骤；
- 所有项目完成后再给出最终完成结论。

不得包含：

- “有疑问时总是使用 Todo”；
- “任何时候必须至少有一个 in_progress”；
- 要求简单任务也创建计划；
- 要求每次工具调用后都更新 Todo。

## 15. 错误处理

以下输入必须返回可理解的工具错误，且不得破坏原状态：

- 没有计划时调用 `advance/block/resume/replan`；
- blocked 状态下调用 `advance`；
- active 状态下调用 `resume`；
- 已完成计划再次 `advance`；
- `completions` 为空、超过剩余数量、包含非法记录/结果或额外字段；
- 缺少 `completions`，提交已移除的 outcome / 顶层 result / 别名，或为其它 action 提交完成记录；
- plan 缺少 title/goal/tasks，标题/目标为空，或改变规范化 goal 的 replan 未显式提供新 title；
- 非法 description，或新任务携带 result/旧属性；
- 任务超过数量或字段长度限制；
- 已有未完成计划时再次调用 `plan`；
- 无法解析旧版本状态。

工具执行错误必须让模型看到错误结果：领域校验失败返回 `isError: true` 的结构化结果并保持状态不变；不要改为抛出异常，因为 host 会丢弃 `details` 并以 `{}` 记录，既丢失快照又可能被误判为不支持的格式。

## 16. 并发和一致性

- Todo 工具执行模式固定为 sequential；
- 所有状态修改必须经过纯函数 reducer；
- reducer 签名为 `reduceTodo(previous, input, dependencies)`，dependencies 注入 `createPlanId`，无 now 参数、时间戳生成或校验；
- reducer 输出为新快照，不原地修改旧快照；
- UI 更新失败不得导致 Todo 状态修改失败；
- reminder hook 只能读取状态，不得隐式推进 cursor；
- `advance` 是唯一正常推进 cursor 的操作；
- `replan` 可以重新建立剩余列表，但必须增加 revision；
- 同一计划产生非空新快照的 `advance/replan/insert/undo/block/resume` 必须使 revision += 1；新 `plan` 从 1 开始，`clear` 或撤销到无计划时快照为 null；

## 17. 模式兼容性

### 17.1 TUI

- 完整支持工具渲染、Widget 和 `/todos`；TUI 不写重复 Footer，Status 仅作 RPC 回退。

### 17.2 RPC

- Todo 工具正常调用；
- 状态进入 Session；
- 不依赖 `ctx.ui.custom()`；
- Widget 请求可以被客户端忽略。

### 17.3 JSON / Print

- Todo 工具正常调用；
- 不执行任何阻塞式 UI；
- 保留上下文提醒，但不通过 `agent_before_settle` 自动续跑；
- 最终输出中不强制打印完整 Todo 列表。

## 18. 可观测性

第一版不上传遥测，但应在 `details` 中保留：

- action；
- planId；
- revision；
- cursor；
- phase；
- transition；
- new state。

调试日志可以记录状态转换，不记录超出 Session 原有内容范围的敏感数据。

## 19. 验收标准

### AC-01 创建计划

创建 3 项计划后：

- cursor 为 0；
- 第一项为 in_progress；
- 其余项目为 pending；
- Widget 首行显示 `<state.title>（0/3）`（极窄仅 `0/3`），随后显示当前项及两条 pending 项；当前项仅用左侧 `→`，不加文字标签；此时尚无完成历史，推进后展示最近两条 completed。窗口、截断、颜色和告警遵守 §13.1。

### AC-02 原子推进

调用一次 `advance` 后：

- 第一项变为 completed；
- result 正确保存；
- 第二项自动变为 in_progress；
- 不存在无当前任务的中间状态。

连续多项一次提交后：

- 按记录数一次推进，逐项可选结果一一保存；
- revision 只增加一次；失败记录在末尾时也不得部分完成；
- 一次 undo 恢复整个批次及其结果，完成计划时也适用；
- 单项也显式提交完成记录；旧字段、顶层结果和裸 advance 均被拒绝；
- V1/V2 不迁移为 V3，旧/损坏快照进入保护，仅显式 clear 后重建；旧属性不得偷偷接受。

### AC-03 完成计划

最后一项 advance 后：

- phase 为 completed；
- cursor 等于任务总数；
- 不再自动注入执行提醒；
- Widget 在完成当次 run 内不隐藏，保留最后至多两条 completed 与较早完成摘要，无 blocked/paused/earlyStop 告警；`agent_settled` 后 Widget 清空但 completed state 保留，show、`/todos` 和 undo 仍可用；RPC Footer status 独立清空；
- 完成历史仍可通过 `/todos` 的八视觉行窗口滚动查看完整描述、验收和结果；滚动不改变 revision/undo；
- clear 后 Widget 隐藏，新 plan 替换旧 Widget；undo 回 active 会重新显示 Widget，undo 恢复 completed 前像保持隐藏；恢复的 completed 计划直接隐藏；不新增历史归档或更改 V3。

### AC-04 阻塞

调用 `block` 后：

- phase 为 blocked；
- cursor 不变；
- Widget 当前项仍只用左侧 `→`，箭头 warning，标题 text+bold；合并告警仅信号为 warning、原因为 text，不新增当前文字标签；
- `agent_before_settle` 不追加续跑 draft。

### AC-05 修订计划

完成前两项后调用 `replan`：

- 前两项及 result 保留；
- 原当前项和待处理项被替换；
- revision 增加；
- 新剩余列表第一项成为当前任务；
- goal 未变且省略 title 时保留原值，改变规范化 goal 时缺少新 title 必须原子拒绝；
- 新任务 description 经持久化、clone、undo、恢复后仍可在详情和模型反馈/提醒中看到。

### AC-06 Session 恢复

退出并恢复 Session 后：

- Todo 状态与退出前一致；
- 下一次模型请求收到当前任务提醒；
- Widget 正确恢复。

### AC-07 分支恢复

从历史节点创建或切换分支后：

- Todo 状态恢复到该节点可见的最后快照；
- 其他分支上的后续进度不可见。

### AC-08 压缩恢复

发生上下文压缩后：

- Todo 状态不丢失；
- 下一次模型请求重新获得当前任务和下一任务；
- 无需把全部旧工具结果重新放入上下文。

### AC-09 提前结束提醒

模型在未完成计划时停止：

- 自动触发一次 follow-up；
- 如果状态未变化后再次停止，不继续循环；
- `advance` 到未消耗的位置后获得初始提醒资格；`replan/insert/undo` 不补充机会；
- 成功显式 `todo resume` 在同一位置总计最多 3 次的预算内提供新资格，重启和分支恢复不得重复发放。

### AC-10 简单任务

处理简单单步请求时：

- 系统不强制创建 Todo；
- 不产生 Todo Widget 或额外提醒。

### AC-11 并发调用

模型同一消息产生多个 Todo 工具调用时：

- 调用按顺序执行；
- 后一个调用读取前一个调用完成后的状态；
- 状态不发生覆盖或重复推进。

### AC-12 非 TUI 模式

在 RPC、JSON 和 Print 模式执行时：

- 不因缺少 UI 崩溃；
- Todo 状态和模型提醒继续有效。

## 20. 测试要求

### 20.1 单元测试

- reducer 的全部状态转换；
- 非法转换不修改状态；
- 任务数量和字段长度校验；
- advance 原子推进；
- replan 保留完成历史；
- reminder 内容生成；
- 自动续跑去重键；
- V3 严格字段校验、V1/V2/损坏快照保护及显式 clear 重建；
- 标题/描述边界、三参数 reducer、无状态时间戳及旧属性拒绝；
- Widget plan.title 与 `{ title, kind: "completed" | "current" | "pending" }` 最小行模型（替换 isCurrent）、alerts.blocked 样式来源；
- 最近两完成＋当前＋后两 pending、较早完成摘要与更多待办顺序、八/九行上限及完成态保留；
- `/todos` 完整字段换行、八视觉行滚动与注入的导航/退出绑定，RPC 完整通知及 JSON/print 静默；
- description 穿过工具反馈、提醒、详情、clone/undo/恢复的端到端消费。

### 20.2 集成测试

- 工具调用结果 details 持久化；
- session_start 重建；
- session_tree 重建；
- session_compact 后提醒；
- `agent_before_settle` 在 TUI/RPC 中一次性续跑；
- 被拒绝的 Todo 调用返回 `isError: true` 且保留快照；
- host 生成的错误结果（`details: {}`）不锁定恢复；
- JSON/Print 不自动续跑；
- sequential 工具执行；
- TUI Widget 更新和清理。

### 20.3 回归测试

- Todo 扩展不改变 read/bash/edit/write 行为；
- 无 Todo 状态时不修改模型上下文；
- clear 后不再产生提醒；
- reload 后不产生重复 Widget 或重复监听器。

## 21. 模块结构

```text
pi-kit/extensions/linear-todo/
├── index.ts
├── schema.ts
├── reducer.ts
├── state.ts
├── reminder.ts
├── render.ts
├── src/
│   ├── render-shared.ts
│   └── widget.ts
├── docs/
├── e2e/
└── tests/
```

职责划分：

- `index.ts`：注册工具、命令和生命周期事件，每次刷新构建一次 Widget 模型供 TUI/RPC 使用；
- `schema.ts`：TypeBox 输入和持久化类型；
- `reducer.ts`：纯状态转换；
- `state.ts`：Session 重建和当前状态访问；
- `reminder.ts`：上下文提醒及自动续跑策略；
- `render.ts`：保留工具历史结果和 `/todos` UI；RPC Status 回退仍在 index.ts；
- `src/render-shared.ts`：保留不变的 `TodoRenderSnapshot`，共享空白及终端控制字符清洗；
- `src/widget.ts`：拥有 `buildTodoWidgetModel(snapshot)`、判别式结构化模型、`TodoWidget(model, theme)` 和 `formatTodoWidgetLines(model)`；仅 builder 选择完成/当前/未来任务窗口并派生 kind，plan.title 来自 state.title，行无 id/isCurrent/重复 status。

## 22. 验收入口

实现与 Runner 已存在；运行命令统一见 [README](../README.md) 和 [RUNTIME_ACCEPTANCE.md](./RUNTIME_ACCEPTANCE.md)。脚本存在不等于验收通过：确定性稳定性、真实 TUI/同文件 `/tree` 人工验收及真实模型 A/B 仍须分别提供运行证据，未执行项不得标为通过。

## 23. 后续可选能力

不进入第一版，但设计上可以预留：

- 用户在 `/todos` 中交互式 replan；
- 项目级持久计划；
- `paused` 状态；
- 根据上下文占用动态调整提醒频率；
- 为 advance 增加可选 evidence 字段；
- 计划模板；
- 导出为 Markdown；
- 统计计划创建、修订和提前停止次数，用于调整提示策略。

## 24. 最终决策摘要

1. 使用单工具、单状态机，不移植多 Agent Task CRUD；
2. 使用游标自动推导任务状态；
3. 使用 `advance` 的 `completions` 原子完成当前项起的连续任务，再启动新的当前项；
4. 完成历史不自动清理；
5. Todo 状态保存在工具结果 details 中，天然支持 Session 分支；
6. 模型提醒采用短摘要、按需注入；
7. 模型提前停止时，每个任务阶段最多自动续跑一次，且仅在 TUI/RPC 模式启用；
8. 使用 `nextItemSeq` 保证任务 ID 永不复用；
9. Todo 仅服务复杂长程任务，不强制用于简单请求。
