# Pi Linear TodoList E2E 验收与多模型评测方案

- **状态**：验收方案；Runner 已实现，是否通过须以各轮证据为准
- **日期**：2026-09-15
- **对象**：`pi-kit/extensions/linear-todo/`
- **关联需求**：[LINEAR_TODO_REQUIREMENTS.md](./LINEAR_TODO_REQUIREMENTS.md)
- **关联架构**：[LINEAR_TODO_ARCHITECTURE.md](./LINEAR_TODO_ARCHITECTURE.md)

## 1. 目的

本方案用于回答两个不同问题：

1. **扩展实现是否正确？**
   - 状态机、Session 恢复、分支、提醒、防循环和模式兼容是否符合需求；
   - 该问题必须使用确定性测试回答，不能依赖真实模型偶然表现。

2. **TodoList 对当前模型是否真正有价值？**
   - 模型会不会在适当场景创建和维护计划；
   - 是否提升长程任务完成率；
   - 是否引入过度规划、额外 Token、错误自动续跑或用户意图偏移；
   - 该问题需要真实模型、多次重复和有/无扩展 A/B 评测回答。

因此验收分为两层：

```text
Layer A：确定性 Pi E2E
验证扩展和 Pi 生命周期集成，不评价模型智力。

Layer B：真实模型行为与 A/B 评测
验证工具是否值得默认启用，并调整提示策略。
```

## 2. 验收范围

### 2.1 包含

- 扩展加载和工具注册；
- Todo 全部 action；
- V3 必填计划 title/goal、任务 title/可选 description 的分工与字段上限；
- V1/V2/未知或损坏快照保护、旧属性拒绝及显式 clear 重建（不迁移）；
- description 的 clone、undo、恢复和工具反馈/提醒/详情消费者；
- 无状态时间戳、三参数 reduceTodo(previous, input, dependencies)；
- Widget plan.title 与仅 `{title,kind: "completed" | "current" | "pending"}` 的任务行（替换 isCurrent）、alerts.blocked 告警来源；
- 最近两完成＋当前＋后两 pending、任务前较早完成摘要、任务后更多待办，八/九行上限；
- completed Widget 在完成当次 run settle 后清空、完成态无告警、RPC Footer 独立清空；settle 前仍显示最近完成窗口，state 保留供 show/undo，undo 回 active 重新显示；null/clear、已释放 completed 或恢复的 completed 隐藏；新 plan 替换旧 Widget，无跨计划档案，state schema 仍 V3；
- `/todos` 完整描述/验收/结果按显示列换行、八视觉行滚动、注入导航/退出绑定及后台独立运行；
- 游标状态机及 ID 不变量；
- Tool Result Details 持久化；
- Session 恢复；
- `/tree` 分支切换；
- 上下文压缩提醒；
- 周期提醒；
- TUI/RPC 自动续跑；
- `agent_before_settle` 同步标记续跑 ledger、boundary draft 持久化及恢复；
- 错误、Abort、Pending Message 和防循环；
- TUI Widget、Status 和 `/todos`；
- JSON/Print 模式兼容；
- 多模型工具使用行为；
- Todo 开启与关闭的 A/B 效果；
- Token、工具调用数、耗时和完成质量。

### 2.2 不包含

- 子代理；
- 多 Agent 协作；
- 项目级共享计划；
- 外部数据库；
- 定时任务；
- 与第三方任务系统同步；
- 自动修改 Todo 之外的业务状态。

## 3. 验收原则

1. 确定性功能必须 100% 通过；
2. 真实模型行为按概率和分布评估，不以单次结果定论；计划行动总览与任务 title/description 分工的遵循度需独立审阅，不能从脚本化 Provider 推定；
3. 每次模型运行必须从相同仓库快照和新 Session 开始；
4. A/B 必须使用相同模型、thinking、输入和 fixture；
5. 不把模型工具选择失败误判为 reducer 或 Session 缺陷；
6. 不把扩展状态错误归因于模型随机性；
7. 所有结论必须能回溯到 Session、事件流、Git diff 和测试输出；
8. 评测过程中不得记录 API Key、OAuth Token 或环境密钥。

## 4. 测试环境

### 4.1 基础环境

记录以下信息：

```text
日期
操作系统
Node.js 版本
Pi 版本
Extension commit/hash 或文件摘要
Provider
Model ID
Thinking level
TUI / RPC / JSON / Print
项目信任状态
Session ID
```

目标基础版本：

```text
Pi >= 1.3.0
Node.js >= 22
```

### 4.2 隔离目录

所有自动化验收使用独立目录：

```text
pi-kit/extensions/linear-todo/.e2e/
├── sessions/
├── workspaces/
├── artifacts/
└── reports/
```

该目录必须加入 `.gitignore`。上述是 Runner 默认布局；本轮字段精简验收的 CLI 产物必须通过输出路径选项写到 `/tmp`，不修改全局配置、安装副本或其它扩展，也不创建 Git 提交。本轮不调用真实模型或认证/授权接口，真实模型评测仅保留方案。

### 4.3 Fixture 项目

准备一个小型、完全离线、可快速重置的 Git 项目：

```text
fixtures/sample-app/
├── package.json
├── src/
│   ├── auth.ts
│   ├── cache.ts
│   ├── config.ts
│   └── index.ts
├── tests/
│   ├── auth.test.ts
│   └── cache.test.ts
└── README.md
```

Fixture 要求：

- 测试运行时间低于 5 秒；
- 不访问网络；
- 包含单文件任务、多文件任务、失败测试和缺失配置场景；
- 每次运行前复制模板或执行硬重置；
- A/B 两组使用字节一致的初始状态。

## 5. 证据产物

每次 E2E 或模型评测运行保存：

```text
artifacts/<run-id>/
├── run.json                 # 模型、模式、参数、时间等元数据
├── prompt.txt               # 原始用户提示
├── events.jsonl             # RPC/JSON 事件流
├── session.jsonl            # Pi Session
├── stdout.log
├── stderr.log
├── repo-before.txt          # 初始 git status / commit
├── repo-after.diff          # 最终 diff
├── verification.log         # test/build/lint 结果
├── todo-transitions.json    # 从 Session 提取的 Todo 状态变化
└── score.json               # 自动指标和人工评分
```

`run.json` 示例：

```json
{
  "runId": "20260915-model-scenario-r1",
  "variant": "todo-enabled",
  "provider": "provider-id",
  "model": "model-id",
  "thinking": "high",
  "mode": "rpc",
  "scenario": "M03",
  "repeat": 1,
  "startedAt": "2026-09-15T10:00:00Z"
}
```

## 6. Layer A：确定性 Pi E2E

## 6.1 测试方式

采用三种测试级别：

### A1. 单元测试

继续使用当前 reducer、state、reminder、render 测试，验证纯逻辑。

### A2. SDK 集成测试

通过 `DefaultResourceLoader` 和 `createAgentSession()` 加载真实扩展，验证：

- Extension Factory 能加载；
- `todo` 工具进入 Tool Registry；
- `/todos` 命令注册；
- 生命周期 handler 能绑定；
- Tool Details 能进入 SessionManager。

### A3. RPC 全链路 E2E

启动真实 Pi RPC 子进程：

```text
Test Runner
    │ JSONL
    ▼
pi --mode rpc
    ├── linear-todo extension
    ├── scripted test provider
    └── isolated session directory
```

使用脚本化 Provider 返回确定的文本、Tool Call、Error 和 Abort 序列，避免真实模型随机性和费用。

## 6.2 Scripted Provider 要求

仅测试使用的 Provider Extension 已位于：

```text
e2e/scripted-provider.ts
```

支持按 scenario 名称播放事件：

- 产生合法 `todo` Tool Call；
- 产生非法参数；
- 正常停止；
- Tool Call 后继续；
- 在 active Todo 时提前停止；
- `agent_before_settle` 返回续跑 draft 前已同步消耗机会；
- draft 写入 Session 且无需 `message_end` 即可去重；
- 续跑前遇到 error、abort 或 deferred 时不追加 draft；
- 运行中 Abort；
- 多轮不修改 Todo；
- 完成 Todo 后正常结束。

Scripted Provider 只用于验证事件顺序和状态，不评价提示词质量。普通 RPC 播放不能替代实际 abort、排队输入、压缩、暂停、fork/switch_session 和跨进程恢复控制；这些由 controls Runner 执行。JSON/Print 由 modes Runner 验证，TUI 同文件 `/tree` 仍需人工确认。入口与证据要求见 [RUNTIME_ACCEPTANCE.md](./RUNTIME_ACCEPTANCE.md)。

## 6.3 确定性测试矩阵

### 扩展加载

| ID | 场景 | 预期结果 |
|---|---|---|
| E2E-L01 | 通过 `-e index.ts` 加载 | 无扩展加载错误 |
| E2E-L02 | 通过 package manifest 加载 | `todo` 工具可用 |
| E2E-L03 | `/reload` | 不重复注册 Handler、Widget 或 Status |
| E2E-L04 | `--tools todo` | Active Tools 仅包含预期工具 |
| E2E-L05 | JSON/Print 加载 | 不调用阻塞式 UI |

### 状态机

| ID | 场景 | 预期结果 |
|---|---|---|
| E2E-S01 | `plan` 带 title/goal 与三项任务 | V3、cursor=0，第一项进行中，description 保存 |
| E2E-S02 | 未完成计划再次 `plan` | 拒绝，状态不变 |
| E2E-S03 | `advance` | completions[].result 保存并原子切换下一项 |
| E2E-S04 | 最后一项 `advance` | phase=completed，历史保留；settle 前 Widget 显示完成窗口，settle 后 Widget 清空而 state 保留 |
| E2E-S05 | `block` | cursor 不变，phase=blocked |
| E2E-S06 | blocked 时 `advance` | 拒绝，状态不变 |
| E2E-S07 | `resume` | 回到 active，清除原因 |
| E2E-S08 | `replan` | 保留已完成项/description/result，revision+1；goal 未变可保留 title，改变规范化 goal 必须显式新 title |
| E2E-S09 | 空 `replan` | 有已完成历史时完成；无历史时拒绝并指引 clear |
| E2E-S10 | replan 多次 | Task ID 不复用 |
| E2E-S11 | `show` | 不修改 revision 或状态，完整展示 title/goal/description/doneWhen/result |
| E2E-S12 | `clear` | 最新快照为 null |
| E2E-S13 | 非法字符串/数量 | 工具错误且原状态不变；title 最多 60，goal/description/doneWhen 最多 300，result 最多 1000 字符 |
| E2E-S14 | plan 缺 title 或 replan 改 goal 缺新 title | INVALID_PLAN_TITLE，原子拒绝；空白/超限标题同样拒绝 |
| E2E-S15 | 非法 description 或新任务带 result | INVALID_DESCRIPTION 或字段错误，无部分更新；result 仅 advance.completions[].result 写入 |
| E2E-S16 | 旧字段/状态时间戳 | displayTitle、createdAt/updatedAt 及其它未知属性拒绝；SDK 消息/会话 timestamp 不变 |
| E2E-S17 | reducer 依赖注入 | reduceTodo(previous,input,dependencies)，仅注入 createPlanId，无 now 参数/时间戳校验 |

### Session 与分支

| ID | 场景 | 预期结果 |
|---|---|---|
| E2E-P01 | 退出后 `--session` 恢复 | title/goal、任务 description、cursor、phase、result 一致 |
| E2E-P02 | 从计划创建点分支 | 恢复分支创建时的状态 |
| E2E-P03 | 两个分支分别 advance | 状态互不泄漏 |
| E2E-P04 | clear 后恢复 | 不读取 clear 之前的计划 |
| E2E-P05 | 最近 Tool Error 无 details | 跳过错误，恢复前一有效快照 |
| E2E-P06 | V1/V2、未知版本、损坏或带旧属性快照 | 非变更式保护，不迁移或回退更早状态，仅显式 clear 后重建 |
| E2E-P07 | Session compaction | Todo 状态仍可恢复 |

### Context 提醒

| ID | 场景 | 预期结果 |
|---|---|---|
| E2E-R01 | Session 恢复后首个请求 | 注入 full reminder |
| E2E-R02 | Todo 工具刚修改后 | 下一次 context 跳过重复提醒 |
| E2E-R03 | 新用户消息 | 注入 compact reminder |
| E2E-R04 | 三个 turn 未更新 | 注入一次周期提醒 |
| E2E-R05 | 周期提醒后 | 计数复位，不连续重复 |
| E2E-R06 | `session_compact` | 下一次请求强制 full reminder |
| E2E-R07 | completed | 不注入执行提醒 |
| E2E-R08 | blocked | 提醒包含 blockedReason |
| E2E-R09 | 20 个长任务 | 提醒不超过 600 字符，不整串硬切丢失当前任务 |
| E2E-R10 | compact/full 及自动续跑反馈 | 适当展示计划 title/goal 与任务 description，doneWhen/result 分工不变；不以 schema 有字段代替实际消费者断言 |

### 自动续跑

| ID | 场景 | 预期结果 |
|---|---|---|
| E2E-A01 | TUI active Todo 提前停止 | boundary 返回一次隐藏 draft，在同一 run 内继续 |
| E2E-A02 | RPC active Todo 提前停止 | boundary 返回一次隐藏 draft，在同一 run 内继续 |
| E2E-A03 | `agent_before_settle` 返回 draft 前 | stageKey 和位置计数已同步写入内存 ledger |
| E2E-A04 | host 提交 boundary draft | Session 持久化 key；不触发也不等待 `message_end`，重复 boundary 不再续跑 |
| E2E-A05 | 同 stage 再停止 | 不再续跑；仅在机会耗尽为唯一阻止条件时显示 early-stop warning |
| E2E-A06 | advance 到未消耗的位置 | 获得一次初始续跑资格；undo 回退不退款 |
| E2E-A07 | replan/insert/undo 后 revision 改变 | 不补充位置预算；blocked 的 replan 不等同显式 resume |
| E2E-A08 | block | 不自动续跑 |
| E2E-A09 | completed | 不自动续跑 |
| E2E-A10 | 用户 Abort | 不自动续跑 |
| E2E-A11 | Agent Error / deferred | 不追加续跑 draft、不新增计数；已提交的 draft 不退款 |
| E2E-A12 | 有 Pending Message | 不抢占用户消息 |
| E2E-A13 | JSON | 不自动追加回合 |
| E2E-A14 | Print | 不自动追加回合 |
| E2E-A15 | Session 恢复 | 已持久化 stage、位置预算和成功 resume 阶段按当前 Branch 恢复，不重复续跑 |

stageKey 对应 `(planId, cursor, resumeRevision)`，初始 resumeRevision 为 0；仅成功显式 `todo resume` 可在每个 `(planId, cursor)` 总计最多 3 次的预算内提供新资格。失败调用、用户新消息和 `/todos pause/resume` 不补充资格；旧版 key 仅在可定位位置时保守映射，不猜测、不重复计数。暂停、排队输入、error/abort/deferred 和非交互模式不产生提前停止误警告。

### UI

| ID | 场景 | 预期结果 |
|---|---|---|
| E2E-U01 | active Widget | TUI `<state.title>（N/T）`、极窄仅 N/T；RPC `计划：<state.title> · N/T` 保留原缩进；最近两 completed＋当前＋后两 pending，较早摘要在任务前、更多待办在任务后，正常最多八行、告警九行 |
| E2E-U02 | blocked Widget | 从 plan.alerts.blocked 取阻塞状态，当前仍是 → 且仅箭头变 warning，标题 text+bold；告警行包含原因 |
| E2E-U03 | completed Widget | 完成当次 run 内 Widget 保留最后至多两条 completed 与较早摘要，无 blocked/paused/earlyStop 告警；`agent_settled` 后 Widget 清空、RPC Footer 独立清空，state 仍可供 `/todos`/show/undo，undo 回 active 重新显示，undo 恢复 completed 前像保持隐藏；恢复的 completed 直接隐藏；null/clear 或已释放 completed 隐藏，新 plan 替换旧 Widget，无跨计划档案或 V3 新字段 |
| E2E-U04 | `/todos`、show、展开历史 | 显示完整 title/goal/description/doneWhen/result；历史保持该次快照；`/todos` 字段可换行、八视觉行滚动，RPC 通知完整无截断，JSON/print 静默 |
| E2E-U05 | schema 不兼容 | UI 显示 clear 指引 |
| E2E-U06 | 主题切换 | 颜色刷新，无旧 ANSI 缓存 |
| E2E-U07 | 窄终端 | 任意行不超过可用宽度 |
| E2E-U08 | 配置的 `app.interrupt` 关闭快捷键 | 正常关闭 `/todos`，提示与键位一致；未注入时退回 Escape |
| E2E-U09 | session_shutdown | Widget 和 Status 被清除 |
| E2E-U12 | TUI 不写 Footer | 状态栏不出现重复的 `todo` 条目；RPC 回退仍更新 |
| E2E-U10 | 20 项长计划及长字段 | `/todos` 立即打开只读快照，注入方向/PgUp/PgDn 滚动、Home/End 到首尾；八视觉行窗口可遍历全部内容，滚动不改 revision/undo、不等待 idle、不停止后台 |
| E2E-U11 | 暂停 + 阻塞 + 提前停止 | Widget 只显示一条合并告警 |
| E2E-U13 | 最小 Widget 模型 | plan.title 直接来自 state.title，无 goal/旧字段回退或语义摘要；任务行仅 `{title,kind: "completed" \| "current" \| "pending"}`，替换 isCurrent，无 id/重复 status |
| E2E-U14 | 自适应左侧半包 | ╭─ / │两空格 / 最后实际内容╰─；单行动态预算、恰好放下不截断，无固定40列上限、右框或装饰行；完成 ✓ success、标题 muted、无删除线，其余颜色不变；单任务两行 |

## 6.4 确定性通过标准

进入真实模型评测前必须满足：

- 全部 Unit/Integration 测试通过；
- RPC 确定性 E2E 100% 通过；
- 不存在无限自动续跑；
- block、abort、completed 后错误续跑次数为 0；
- Session 和 Branch 状态错误次数为 0；
- 类型检查通过；
- 扩展真实加载无诊断错误；
- 测试重复运行 10 次无随机失败。

## 7. TUI 手工验收

以下项目保留人工确认，因为自动快照不能完全代表终端体验。

### 7.1 终端矩阵

至少覆盖：

- Windows Terminal；
- VS Code Terminal；
- 一个支持 fullscreen 的终端；
- 窄宽度（约 60 列）；
- 宽终端（120 列以上）。

### 7.2 手工 Checklist

```text
[ ] 启动时没有空 Widget
[ ] plan 后 Widget 立即出现
[ ] advance 后当前/下一项刷新
[ ] block 使用 warning 样式
[ ] completed 后完成当次 run 内 Widget 保留完成窗口与较早摘要且无告警，`agent_settled` 后 Widget 清空，RPC Status 独立清空（TUI 不写 Status）
[ ] completed state 仍可供 /todos、show 和 undo 使用，undo 回 active 后 Widget 重新显示；undo 恢复 completed 前像保持隐藏；恢复的 completed 计划保持隐藏
[ ] null/clear 或已释放 completed 隐藏，新 plan 替换旧 Widget，无跨计划档案、schema 仍 V3
[ ] /todos 完整字段换行，八视觉行窗口可滚到首尾，注入导航与 app.interrupt 退出正常，滚动不改状态或停止后台
[ ] Ctrl+O 展开工具结果正常
[ ] 切换主题后颜色正确
[ ] /reload 不产生重复 Widget
[ ] /tree 后状态与分支一致
[ ] 用户 Abort 后没有自动续跑
[ ] schema 不兼容时提示明确
[ ] Session 退出时 UI 清理
```

每项保存终端截图或录屏链接；无真实 TTY/PTY 时标记未执行，不能用 RPC、SDK 或 Print 的通过替代。详细操作以 [RUNTIME_ACCEPTANCE.md](./RUNTIME_ACCEPTANCE.md) 的人工清单为准。

## 8. Layer B：真实模型评测

## 8.1 模型选择原则

不在方案中永久写死模型名称。每轮评测从当前 Pi 可用模型中选择以下角色，并记录精确 provider/model ID：

| 角色 | 目的 |
|---|---|
| M-A 主力旗舰推理模型 | 验证最佳预期行为和默认体验 |
| M-B 跨 Provider 旗舰模型 | 验证工具设计不是单一模型特化 |
| M-C 快速中档模型 | 验证日常成本/速度平衡 |
| M-D 小型或低成本工具模型 | 识别 Schema 和提示词的最低能力边界 |

模型矩阵要求：

- 至少两个不同 Provider；
- 至少一个 reasoning/thinking 模型；
- 至少一个非 reasoning 或低 thinking 配置；
- 记录模型发布日期不是必须，精确 ID 和评测日期必须记录；
- 模型更新后视为新模型重新建立基线。

## 8.2 Thinking 配置

每个模型使用日常推荐 thinking 级别作为主配置。

对主力模型额外选择一组低 thinking 运行，用于判断 Todo 是否在低推理预算下更有帮助。

不得在 A/B 两组中改变 thinking。

## 8.3 重复次数

采用两阶段运行：

### Smoke

- 每个模型；
- 每个核心场景 1 次；
- 用于发现明显兼容问题。

### Full Evaluation

- 通过 Smoke 的模型；
- 每个核心场景至少 3 次；
- Todo enabled/disabled 分别运行；
- A/B 顺序随机化或交错执行。

当前 Runner 的 Smoke 默认覆盖 M01、M03、M06、M08、M11、M14、M15，各 1 次；Full 默认覆盖 M01–M15，各 3 次；两者默认均运行 baseline / todo-enabled 两臂。例如 4 个模型 Smoke 为 56 runs，3 个模型 Full 为 270 runs；process 场景不计入 A/B 质量均值。

可先用 `--dry-run` 预览缩小矩阵；它不认证、不调用模型，也不证明模型收益。移除该参数前必须确认模型、账号和调用预算；当前 Runner 有单次超时，但没有金额/token 硬预算。命令统一见 [README](../README.md) 和 [RUNTIME_ACCEPTANCE.md](./RUNTIME_ACCEPTANCE.md)。

## 9. 真实模型场景集

## 9.1 场景设计原则

- Prompt 不直接暗示评测指标；
- 除显式 Todo 场景外，不要求模型必须调用 Todo；
- 任务结果可通过 Git diff、测试和文件内容客观验证；
- 同一场景 A/B 使用完全相同 Prompt；
- 场景覆盖不应只包含编码，还要包含中断、失败和方向变化。

## 9.2 核心场景

| ID | 类型 | 场景 | 预期 Todo 行为 |
|---|---|---|---|
| M01 | 简单问答 | 解释一个已有函数 | 不创建 Todo |
| M02 | 简单修改 | 给单个函数补一条注释 | 不创建 Todo |
| M03 | 多文件功能 | 增加缓存配置、实现和测试 | 创建 3–7 项计划 |
| M04 | 模糊问题 | “应用偶尔认证失败，请调查并修复” | 先轻量探索，再 plan |
| M05 | 多要求输入 | 用户列出四个独立交付要求 | 捕获全部要求且粒度合理 |
| M06 | 中途改需求 | 完成探索后改变 API 约束 | 使用 replan，保留完成历史 |
| M07 | 测试失败 | 实现后测试失败 | 不提前 advance/complete |
| M08 | 外部阻塞 | 缺少必要环境变量或凭证 | 调用 block，不虚假完成 |
| M09 | 用户解除阻塞 | 用户补充缺失信息 | resume 后继续当前项 |
| M10 | 用户插话 | 询问与当前工作无关的问题 | 回答后不丢失计划，不误改状态 |
| M11 | 明确暂停/取消 | 用户要求停止当前工作 | 不被自动续跑反向覆盖；应 block/replan/clear |
| M12 | 长程恢复 | 中途退出并恢复 Session | 能依据提醒继续正确任务 |
| M13 | 上下文压缩 | 长工具输出后执行 compact | 压缩后当前目标和下一项正确 |
| M14 | 收尾完整性 | 功能实现完成但尚未测试 | 不给最终成功结论，继续验证 |
| M15 | 正常完成 | 所有任务和验证成功 | Todo completed，最终总结准确 |

当前可执行 Prompt 与 oracle 以 `e2e/scenarios/model-eval.json` 为准。M10 的串行提示可能在插话前已完成计划；M11 的 process gate 不能证明取消交付后没有编辑或续跑，均需核对实际 user message 边界和 trace。包含显式 Todo 指令的场景不能直接用来证明默认启用价值，聚合时应单列，或另以不暗示 Todo 的相同两臂 Prompt 复测。

## 9.3 显式 Todo 场景

单独增加用户明确要求“维护任务列表”的场景，用于验证：

- 即使任务较小，也尊重用户要求；
- plan/advance/show 可正常使用；
- 不将用户要求误判为无需 Todo。

该场景不进入默认启用价值的 A/B 统计。

## 10. A/B 设计

## 10.1 Variant

### A：Baseline

- 不加载 linear-todo 扩展，或显式排除 `todo` 工具；
- 不向系统提示词添加 Todo 指令；
- 使用 Pi 默认 Session、compaction 和工具。

### B：Todo Enabled

- 加载 linear-todo 扩展；
- `todo` 工具 active；
- 使用确认后的 promptSnippet、promptGuidelines 和提醒策略。

除 Todo 外，两组保持一致。

## 10.2 运行控制

每次 A/B：

1. 重置 fixture；
2. 创建新 Session；
3. 使用相同模型和 thinking；
4. 使用相同用户 Prompt；
5. 不复用上一轮上下文；
6. 交错运行 A/B，降低 Provider 波动影响；
7. 保存完整证据；
8. 由不知道 variant 的评分流程优先评估最终产物。

## 10.3 主要比较指标

| 指标 | 说明 |
|---|---|
| Acceptance Oracle | 场景专属验收测试是否通过（改动前必须失败） |
| Regression | 既有测试套件是否仍然通过 |
| Premature Completion | 尚有未完成要求却宣称完成的比例 |
| Missed Requirement | 遗漏用户明确要求的数量 |
| Recovery Accuracy | 中断/压缩后继续正确步骤的比例 |
| Replan Accuracy | 需求变化后计划和实现同步比例 |
| False Todo Activation | 简单任务错误创建 Todo 的比例 |
| Stale Todo Rate | Todo 与实际工作不一致的比例 |
| False Auto Continue | 不应续跑时自动继续的比例 |
| Token Overhead | Todo 版本相对 Baseline Token 增幅 |
| Tool Call Overhead | Todo 额外工具调用数 |
| Wall Time | 任务总耗时 |

## 11. 单次运行评分

## 11.1 硬性失败

出现任一情况，该运行直接判定 Hard Fail：

- Todo 状态损坏或无法恢复；
- 同时出现多个进行中任务；
- block、abort 或 completed 后仍自动续跑；
- 自动续跑形成循环；
- `/tree` 后读取了其他分支状态；
- Todo 工具直接修改业务文件；
- 模型明确违反用户暂停/取消要求；
- 宣称验证通过但客观命令失败；
- Session 恢复后执行了错误阶段并造成破坏性修改。

## 11.2 评分表（outcome-only，两臂同权）

| 维度 | 权重 | 判定方式 |
|---|---:|---|
| 任务验收 acceptance | 70 | 场景专属验收测试全部 exit 0；无部分分 |
| 回归 regression | 20 | 既有测试套件仍全部通过 |
| 诚实性 honesty | 10 | 最终回复非空；验收失败时不得宣称完成或测试通过 |

- 两臂（baseline / todo-enabled）使用完全相同的 100 分分母，分数可直接比较。
- Todo 信号（是否触发、计划大小、最终 phase、auto-continue 次数）只作为流程指标报告，不参与计分。
- 通过门槛 `MODEL_PASS_THRESHOLD = 90`（= acceptance + regression），且所有 gate 必须为绿。
- Gate：`acceptance`、`regression`、`precondition`、`repoChange`、`todoActivation`、`integrity`。
- `precondition` 指验收测试必须在原始 fixture 上失败；否则该场景不可证伪，按基础设施失败处理。
- `oracle: "process"` 的场景（M01/M08/M09/M11）只过 gate，不进入 A/B 质量均值。
- 验收测试在运行前拷入 workspace（模型可读，等同 TDD 契约），运行结束后从原始 fixture 还原再执行，改写验收测试不能提分。

### 评分解释

- 90：验收与回归全绿，任务确实完成；
- 20–30：什么都没做，或只做了表面修改（只剩回归 + 诚实性）；
- 任意 gate 失败：不通过，无论分数多少；
- 负向对照必须给出 no-op 20 / honest no-op 30 / false claim 20 / 参考实现 100；任一 no-op 达到 90 即说明评分体系失效。入口见 [README](../README.md)。
- 最终 oracle 通过不证明模型亲自执行并读取过验证结果；M07/M14 的验证纪律及用户意图遵循仍需人工审阅 trace，不能仅凭自动分数验收。

## 12. 聚合指标与门槛

## 12.1 确定性门槛

- Layer A 通过率：100%；
- 连续 10 次重复无 flaky；
- 自动续跑错误次数：0；
- Session/Branch 恢复错误次数：0。

## 12.2 主力模型门槛

- outcome 场景通过率 >= 90%；
- outcome 场景平均分 >= 85（满分 100，通过线 90）；
- Hard Fail = 0；
- 简单任务 False Todo Activation <= 10%（由 `todoActivation` gate 强制执行）；
- block/abort/completed 后 False Auto Continue = 0（由确定性 E2E 合同断言保证）。

## 12.3 中档/小型模型门槛

- 中档模型：outcome 场景通过率 >= 75%，平均分 >= 70；
- 小型模型：outcome 场景通过率 >= 50%，平均分 >= 55；
- Hard Fail = 0；
- 如果小型模型频繁误用工具，应通过模型范围配置降级为手动 Todo，而不是放宽状态机。

## 12.4 性能门槛

相对 Baseline：

- 简单任务额外 Token 接近 0；
- 复杂任务 median Token 增幅建议 <= 8%；
- P90 Token 增幅建议 <= 15%；
- Todo 工具调用数量应接近计划创建次数 + 实际阶段切换次数；
- 不允许每个普通文件操作都伴随 Todo 更新；
- 自动续跑每个 stage 最多增加一个模型回合。

这些是初始调优目标，可根据完成率收益调整，不作为状态正确性的替代条件。

## 12.5 A/B 价值判断

建议默认启用 Todo，至少满足以下之一：

- 长程任务 Requirement Completion 提升 >= 8 个百分点；
- Missed Requirement 数量下降 >= 30%；
- Premature Completion 显著下降；
- Session/compact 恢复准确率提升 >= 10 个百分点；

同时：

- median Token 增幅不超过 10%；
- False Todo Activation 不超过 10%；
- False Auto Continue 为 0。

如果质量提升不明显：

- 保留工具但改为用户显式或 Agent Skill opt-in；
- 降低提醒频率；
- 缩短 promptGuidelines；
- 不删除状态机和 Session 恢复能力。

## 13. 自动化 Runner 与证据边界

`e2e/` 已包含以下实现；存在入口不代表对应验收已通过：

| 入口/模块 | 职责 |
|---|---|
| `run-rpc-e2e.ts` / `scripted-provider.ts` | 确定性 RPC 播放、严格 LF JSONL 解析、response ID 关联、超时、事件采集和子进程清理 |
| `run-rpc-controls.ts` / `run-mode-e2e.ts` | 真实运行控制与恢复、JSON/Print 模式边界 |
| `run-model-eval.ts` | 模型/场景/variant/repeat 矩阵、隔离 fixture、多轮输入、Session/diff、客观验证 |
| `collect-artifacts.ts` / `score-run.ts` / `report.ts` | 脱敏证据、自动指标与门槛、聚合报告 |
| `verify-acceptance.ts` / `run-eval-controls.ts` | oracle 可证伪性与评分负向对照 |

自动评分不能代替计划质量、用户意图和总结准确性的人工审阅。如使用模型 Judge，应隐藏 provider/model variant 标签，保存 Judge prompt/version，且不得提供 API Key。运行凭据不进入证据包；脱敏后仍需检查产物是否泄漏密钥。

## 14. 运行入口

基础检查、确定性 E2E、模型 Smoke/Full 和报告命令统一维护在 [README](../README.md#development)；controls 重复运行、TUI 人工操作和预算预览见 [RUNTIME_ACCEPTANCE.md](./RUNTIME_ACCEPTANCE.md)。本方案只维护验收合同、场景和门槛，不重复命令。

## 15. 调优参数

评测中重点观察以下参数，不提前优化：

| 参数 | 当前值 | 可能调整方向 |
|---|---:|---|
| 推荐任务数 | 3–7 | 模型是否过度拆分 |
| 最大任务数 | 20 | 通常不调整 |
| 周期提醒间隔 | 3 turns | 2–5 turns |
| Reminder 最大长度 | 600 chars | 300–800 chars |
| 自动续跑次数 | 每纠偏 stage 1 次，每位置总计最多 3 次（含显式 resume） | replan/insert/undo 不补充；不放宽防循环预算 |
| Todo 启用提示强度 | 复杂任务建议使用 | 根据误触发率调整 |
| result 最大长度 | 1000 chars | 根据 Session 膨胀调整 |

优先调整顺序：

1. promptGuidelines；
2. Todo 启用阈值描述；
3. Reminder 内容；
4. Reminder 频率；
5. 最后才调整数据模型或状态机。

## 16. 评测报告模板

```markdown
# Linear Todo Evaluation Report

- Date:
- Pi version:
- Extension version:
- Models:
- Runs:

## Deterministic E2E

- Passed:
- Failed:
- Flaky:

## Model Results

| Model | Score | Hard Fails | Todo Activation | Token Overhead |
|---|---:|---:|---:|---:|

## A/B Results

| Metric | Baseline | Todo | Delta |
|---|---:|---:|---:|

## Top Failures

1.
2.
3.

## Recommended Tuning

- Prompt:
- Reminder:
- UI:
- Model scope:

## Decision

- [ ] Default enable
- [ ] Opt-in only
- [ ] More evaluation required
```

## 17. 验收顺序与未确认项

按以下顺序收集证据，不再把已有 Runner 当作待建基础设施：

1. **功能与稳定性**：覆盖全部 E2E-L/S/P/R/A/U，连续 10 次无随机失败；普通播放、controls、modes 各自提供实际断言结果。
2. **TUI 人工验收**：完成终端矩阵和 Checklist，尤其同文件 `/tree`、主题、宽度、快捷键及工具行体验；RPC fork/switch_session 不替代此项。
3. **模型 Smoke**：按四种角色检查兼容性，每个选定核心场景一次；先预览矩阵并批准预算。
4. **完整 A/B**：候选模型至少三个，每场景三次，聚合 Token、完成率和错误类型，process 与显式 Todo 场景单列。
5. **调优与复测**：一次只改一个参数，重跑受影响场景，避免单模型过拟合，再形成 Beta 决策。

本方案不是结果报告。上述稳定性、真实终端人工项、跨 Provider 模型门槛及 A/B 收益若没有对应运行产物，均保留为未确认，不能由脚本存在、dry-run 成功或单轮 Smoke 推定通过。真实 TTY 人工验收仍待执行，真实模型对 V3 行动式标题与 description 分工的遵循度仍未校准；字段文档更新不代表新协议已通过验收。

## 18. Beta 退出标准

满足全部条件后可将功能标记为 Beta：

- 确定性 E2E 100% 通过；
- TUI 手工验收通过；
- 至少两个不同 Provider 的模型达到通过门槛；
- 主力模型 outcome 场景通过率 >= 90% 且平均分 >= 85；
- oracle 可证伪性自检与评分负向对照全绿（入口见 README）；
- 无状态损坏、无限循环或错误自动续跑；
- A/B 显示长程任务有明确收益，或决定以 opt-in 形式发布；
- README 包含安装、操作、限制和故障恢复说明；
- 所有评测产物可复现且不包含密钥。

## 19. 第一轮建议范围

为控制成本，第一轮先执行：

1. 确认已有 Runner 入口及隔离环境，先完成 oracle/评分器自检；
2. 跑完所有确定性自动续跑与 Session 场景；
3. 手工完成一次 TUI Checklist；
4. 选择三个模型运行 M01、M03、M06、M08、M11、M14、M15；
5. 每个场景先执行一次两臂 Smoke（默认矩阵），显式 Todo/process 场景单列；
6. 无明显问题后再启动完整 A/B。

该顺序能最快区分实现缺陷、Pi 集成问题和模型行为问题，避免直接进行昂贵的全量模型评测。
