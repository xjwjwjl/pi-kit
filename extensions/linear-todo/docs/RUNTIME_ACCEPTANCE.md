# 运行验收与 Agent 行为校准

确定性测试证明插件边界正确；真实模型对照才用于判断它是否减少遗忘、漏验证和过早结束。两者不可互相替代。

## 1. 模型无关的运行验收

在 `extensions/linear-todo/` 执行：

```bash
npm run check
npm run test:e2e
npm run test:e2e:controls
npm run test:e2e:modes
npm run test:e2e -- --scenario batch-complete
npm run test:e2e:modes -- --scenario batch-complete
npm run check:eval
```

- 普通 RPC 播放只验证脚本与状态，不执行同名场景的压缩、重启、暂停或分支控制。
- controls 才实际执行 abort、排队输入、压缩、暂停、fork/switch_session、跨进程恢复和错误恢复。
- abort-during-model / abort-during-tool 先确认已有活动计划并收到目标就绪信号，再调用真实 RPC abort：要求 aborted settle、计划/游标/完成条件不变、没有自动续跑或额外 provider 请求、无误警告或隐式暂停；显式提交新请求后仍可使用该位置原有的一次纠偏。
- 工具中止使用有界、响应 AbortSignal 的专用 fixture，不创建子进程或修改业务文件；这不代表所有第三方工具都正确处理信号，也不代替内置 bash 子进程树取消的测试。工具中止后宿主可能输出空的终止错误消息，是否新增模型调用以 provider trace 为准。
- compact 必须检查压缩返回后恢复请求的首个 provider context，并得到预期正常回答；压缩前的提醒不能替代这个断言。
- pause-during-model 在已收到一次纠偏后暂停，要求响应正常结束、不新增纠偏、不出现提前停止误警告。
- fork-switch-recovery 覆盖不同 session 文件间的原生 fork/switch_session；它不等于 TUI 同文件 `/tree` 导航。
- JSON/print 不自动续跑，stdout 必须保持各自格式。
- RPC Widget 与 TUI 共用 builder 选窗：最近两条 completed＋当前＋后续两条 pending，任务前为可选 `  … 较早已完成 N 项`，任务后为可选 `  … 另有 N 项待办`，再接至多一条合并告警；正常最多八行、告警九行。标题仅去掉“已完成”文字，为 `计划：<state.title> · N/T`，任务缩进保留，标记为 `  ✓ ...`、`  → ...`、`  ○ ...`，告警为 `  ! ...`。无左线、框、ANSI、主题、终端宽度布局、截断、额外底行或右填充。两种省略数分别只计未显示 completed 与 pending，不含当前或可见任务。完成当次 run 内仍可显示最近完成窗口，无任何 blocked/paused/earlyStop 告警；`agent_settled` 后 completed Widget 清空，仅保留 state。RPC 英文 Footer Status（如 `todo 0/2 done`）也在 completed 时独立清空。
- `batch-complete` 校验连续多项单次完成、整批 undo 和最终批量完成；单测/SDK 另核对只产生一次 revision、逐项可选结果、失败不产生半批状态，以及 V1/V2 拒绝后仅显式 clear 才可重建。
- V3 字段验收须覆盖必填计划 title/goal、任务 title/可选 description、三参数 reduceTodo(previous, input, dependencies) 与注入 createPlanId；无状态时间戳，不改 SDK 消息/会话 timestamp。旧 displayTitle/状态 createdAt/updatedAt 必须拒绝，不以克隆时丢字段代替校验。
- 核对改变规范化 goal 的 replan 未提供新 title 时原子拒绝，goal 不变时可保留；任务创建拒绝 result，只允许 advance.completions[].result。description 须经 clone、undo、重启、分支恢复，并实际进入 show、/todos、展开历史及 compact/full 模型反馈/提醒。
- Widget plan.title 必须来自 state.title，任务行仅 `{title,kind: "completed" | "current" | "pending"}`，替换 isCurrent，无 id/重复 status 或 goal 回退；阻塞来自 plan.alerts.blocked，仅当前箭头使用阻塞色，当前标题 text+bold。
- 所有 fixture Git 操作仅作用于隔离工作目录：使用 index/tree baseline，不创建提交。脚本耗尽必须判失败；有意设计的 provider error/abort 保持可测试。

关键流程可重复执行：

```bash
npm run test:e2e:controls -- --scenario abort-during-model --repeat 10
npm run test:e2e:controls -- --scenario abort-during-tool --repeat 10
npm run test:e2e:controls -- --scenario compact --repeat 10
npm run test:e2e:controls -- --scenario pause-during-model --repeat 10
npm run test:e2e:controls -- --scenario fork-switch-recovery --repeat 10
```

Runner 产物默认写入 `.e2e/artifacts/`；本轮字段精简验收必须用 `--artifacts`、`--workspaces`、`--sessions` 将支持的输出路径指定到 `/tmp` 下，报告也只写 `/tmp`。本轮不调用真实模型或认证/授权网络接口，不消耗实际评估预算。不要把单测、RPC、SDK 的通过描述成 TUI 人工验收；本清单不是本轮已通过记录。

## 2. TUI 人工清单

以下是待执行的真实 TTY 人工验收清单，不是已通过记录。在真实终端中，使用隔离 agent/session 目录、scripted provider 和 `todo` 工具；不要为此修改用户状态或全局配置。没有 TTY/PTY 时明确标记未执行，不以 print 模式代替 TUI。

使用 V3 正式字段构造同一套真实计划 `title`/`goal`、任务 `title`/`description`/`doneWhen`/`result` 和进度，分别检查短标题、接近 60 字符上限的长标题与完整执行详情。Widget 只取 state.title 和任务 title，无旧标签/goal 回退；渲染器不得猜摘要，也不得为纯外观自动 replan 或补写字段。另核对 V1/V2 与损坏快照受保护，/reload 不迁移，只有显式 clear 才能重建。不能拿短文案草图代替真实内容验收。

1. 播放 `plan-and-stop`，确认 `available >= 12` 时采用**左侧圆角半包**：首行 dim `╭─ `，中间内容 dim `│  `，末条实际内容 dim `╰─ `。首行采用行动式总览作为这次 Todo 的标题，不是项目/类别/进度状态栏；格式为 `<state.title>（N/T）`，去掉 `计划：` 及中点分段，进度紧跟总览；最近两完成＋当前加后两项，箭头只表示游标，不是执行中。更多提示没有后续行时用底角；若有告警，则更多提示为中间行，告警用底角，只有一项时直接用 `╰─ → <任务>` 收尾。

   本插件借鉴设计的 V3 标题示例（不是 ClaudeCode 原生 UI、不是执行记录，不能代替真实内容验收）：

   ```text
   ╭─ 检查并整理 wifi-audit（1/6）
   │  ✓ 梳理文档与脚本
   │  → 语法与静态检查
   │  ○ 核对文档与实现
   │  ○ 检查跨脚本约定
   ╰─ 另有 2 项待办
   ```

   仅保留左侧短圆角和竖线，不延伸上下横线、不画右线、背景、右补齐、空行或纯底线。末条实际内容负责收尾；更多提示在告警之前，正常最多八行、告警最多九行。
2. 在模型或工具运行时执行 `/todos pause`，确认立即显示 `自动续跑已暂停 · /todos resume`，只阻止后续自动续跑、不暂停或中止当前工作，也不误报提前停止。打开 `/todos` 检查完整计划 title/goal、任务 description、完成条件和 result，关闭后仍保持自动续跑暂停。
3. 执行 `/todos resume`，确认不凭空补充已消耗的纠偏机会；分别在模型流式输出和工具执行期间输入 `/todos`（以及 list/show 别名），确认列表立即打开，配置的关闭按键只关闭列表、不停止后台工作，关闭后仍保留期间发生的新进度。列表是打开时的只读快照，重新打开应看到最新状态。用长 description/doneWhen/result 检查完整换行、无截断，以八个视觉行窗口滚动；方向/PgUp/PgDn 及 Home/End 均使用注入绑定，Home/End 可到首尾，app.interrupt 仅退出列表。滚动不改变 revision/undo、不等待 idle、不停止后台；RPC 立即通知完整无截断清单，JSON/print 静默。
4. 在宽屏、小屏及极窄终端间缩放（包括 11、12、40、72、80、120 可用列），切换明暗主题并使用配置的关闭快捷键，确认 Widget/list 无错位或卡住；对短标题和长标题两组都执行：
   - `available >= 12` 时三列前缀占用相同宽度，正文使用 `available - 3` 列；小于 12 列无框使用全宽。没有 72 列上限或等宽补齐；短内容自然结束，长内容按可用宽度截断。只保留两个短圆角，不延伸上下横线、不画右线、背景、空行或纯底线。
   - 标题预算完全由 Widget 可用列减去半包 3 列（有框时），再减去完整括号进度后缀 `（N/T）` 的显示列动态计算，不新增固定 40 列或其它宽度上限；宽屏显示完整标题，只有真实超宽才用 Unicode `…`，窄屏优先保留进度。验证恰好放下、少一列和扩宽后再缩窄，中文、emoji、ANSI 均按显示列计算。进度紧跟标题，不填充到屏幕右侧。任务、更多行、告警使用完整正文预算，单行截断、不换行；极窄时标题仅为 `N/T`，任务保留各自标记，不折叠内容或切换单行/双行状态带。中文、emoji、长计划/任务标题、空白及终端控制字符均不造成越界、自动换行或控制字符泄漏；任务标题在标记后单行截断，不用文字标签代替箭头。
   - 检查 B 样式单焦点前景层级保持不变：半包前缀 `╭─ ` / `│  ` / `╰─ ` dim；`（` 和 `）` muted，行动式总览（state.title）text、不加粗，数字计数在已有完成项时 success、零进度时 text、不加粗；完成勾 `✓` success、完成标题 muted 且无删除线，较早摘要 muted；正常当前标题 accent+bold，blocked 当前标题 text+bold，未来标题 text；当前箭头 accent，pending 圆圈、更多待办文字及恢复提示 muted（不是 dim）。blocked 时箭头仍为 `→` 但变为 warning，标题保持 text+bold；加粗不是执行指示。没有展开/折叠控件、新快捷键、Widget 配置或遥测字段、计时器、执行遥测、动画活动、spinner 或进度条。
   - 分别检查阻塞、暂停、提前停止及组合状态：只在可选更多行之后增加一条末行告警 `╰─ ! <告警>`（窄屏去掉左线）。信号与状态标签 warning、原因 text、恢复提示 muted，不把整行染成警告色。单独状态分别为 `阻塞：<reason>`、`自动续跑已暂停 · /todos resume`、`提前停止`；组合内容为适用标签后接长原因，例如 `! 阻塞 · 自动续跑已暂停 · 提前停止 · 原因：<reason>`，不附恢复提示。用极长原因验证：标签能放入内容宽度时必须优先完整保留，不得为原因的省略号挤掉标签末字。
5. null/clear，或已释放的 completed 计划（完成当次 run 通过 `agent_settled`，或 undo 恢复 completed 前像），Widget 隐藏，`hidden` = 0 行；settle 前计划完成仍显示最后至多两条 completed 和可选较早完成摘要，blocked/paused/earlyStop 告警全部消失。settle 只释放 Widget，completed state 保留，`/todos` 仍可滚动查看完整完成清单和 result，`show` 仍返回快照，`undo` 回到 active 会重新显示，`undo` 恢复 completed 前像则保持隐藏。恢复已 completed 的计划视为已 settle，直接隐藏；新 plan 替换旧 Widget；不做跨计划档案、不新增持久化历史字段，schema 仍 V3。RPC Footer Status completed 时独立清空。非变更式兼容性保护先于未知状态访问，`unavailable` 仍只显示一条**无框、无左线**诊断行 `Todo 不可用：<error>`，前缀 warning、说明 text，不得读取或修改未知状态，TUI 仍按宽度单行截断；TUI 状态栏不应出现 `todo` 条目。
6. 用 20 项计划推进到中段，确认 Widget 显示最近两条 completed、当前及后续两条 pending；任务前 `… 较早已完成 N 项` 只计更早的完成项，任务后独立 `另有 N 项待办` 只计未显示 pending，更多在告警前。正常最多八行，一条合并告警后最多九行。分别推进到仅剩一、二、三项及全部完成，核对完成窗口随 cursor 移动、完成数不重算为当前序号；完成当次 run 内无当前/未来/告警行且 Widget 保留，`agent_settled` 后 Widget 清空而 state 保留。只有一个任务的计划在 active 或完成当次 run 内均为标题＋任务两行（适用告警时三行），无额外空行或底线。对照同一快照 RPC 输出，标题 `计划：<title> · N/T`，保留原缩进及 `  … 另有 N 项待办`、`  ! ...`；新增完成行 `  ✓ ...` 和任务前摘要 `  … 较早已完成 N 项`。RPC 无左线、边框、ANSI、截断或额外底行，不受终端宽度/主题影响。`/todos` 保留完整字段并以八视觉行窗口从首滚到尾，不能只显示八项而无法翻页。
7. 使用已有不同 Todo 进度的 session，在同文件 `/tree` 来回导航，核对游标、result、阻塞原因及对应阶段的续跑记录；不得串到其它分支。
8. 检查对话流中的工具行：折叠摘要采用“Todo ＋ 本次变化 ＋ ` · ` ＋ 进度”，例如 `Todo ✓ 梳理渲染路径 · 1/3`，不显示独立的 `advance` 等操作名字段；在 160 列宽终端确认计数仍紧跟摘要、不贴右边缘；把计数从个位数推进到两位数，确认摘要先被截断、计数保持完整；把终端缩到 48 列以下，确认计数先消失、摘要保留。确认不绘制通栏背景块、内容上下没有留白行、内容按 `outputPad` 缩进（与 `compact-tool-ui` 一致），行前只有宿主自带的一行分隔；长 result 在折叠态不展开；状态图标只有 `✓ ! ✗` 三种，`show/resume/undo/insert/clear` 以动词开头而非符号；批量完成在“本次批次 ≠ 进度分子”时才追加“等 N 项”；阻塞为警告、失败为错误且不显示过期计数。通过工具展开快捷键，以及 fullscreen 模式点击事件行，核对树枝为 `├─ 标签 / │ 内容 / ╰─ 收尾`：`操作/结果/计划/目标/当前` 各由 `├─` 引导、内容统一在 `│ ` 列、标签不与值同行，原始操作名在首段、本次完成或新增的任务及其 result/说明/验收紧随其后，计划 title/goal 在结果之后，最后一行固定为 `╰─ /todos 查看完整计划`；确认展开不再重放无关任务；在 24 列以下确认轨道消失但字段保留，在 40/80/120 列和明暗主题间切换，确认历史行内容不会跟随新进度改变。

9. 一次 `advance` 提交两条 `completions`，其中一条为 `{}`：确认折叠行显示“最后一项 等 2 项”且右栏为 `2/3`，展开的 `结果` 段逐项列出本次完成项，实际提供的 result 缩进显示在其标题下；下一项立即成为当前任务。执行一次 `undo` 应恢复整批；再一次性完成全部剩余项，确认 Widget 保留最后至多两条完成行及较早摘要、无完成态告警，工具行显示 `✓ 计划完成`，展开仍可查看本次各项结果及操作类型。

10. V3 计划必填 title（最多 60 字符）与 goal（最多 300）；创建任务必填唯一简短动作 title（最多 60），可选 description（最多 300）记录执行细节；doneWhen 是验收条件，result 是完成后实际结果。计划 title 必须是稳定、覆盖整组工作的行动短句（动词＋对象，例如“检查并整理 wifi-audit”），不用当前步骤、项目/类别/状态碎片或复述需求；路径、命令、参数等细节放 description，不塞进标题。尽量在 40 显示列内是生成建议，不替代硬字符上限，也不限制渲染宽度。
    - plan 缺 title/goal/tasks、标题空白或超限、description 非法/超限都应原子拒绝。检查 INVALID_PLAN_TITLE、INVALID_TASK_TITLE、INVALID_DESCRIPTION；旧短标题/时间戳错误码不再存在。
    - replan 必须提供 tasks；goal 规范化后不变且未给 title 时保留原值；goal 改变且没有显式新 title 时必须拒绝，而非沿用旧标题或清空必填值。有完成历史时 tasks 可空以结束剩余工作。
    - 通过有实际执行细节的任务检查 clone、undo、恢复及所有消费者：Widget 仅展示 title，/todos、show 与展开历史保留完整 title/goal/description/doneWhen/result，compact/full 反馈与提醒适当显示计划 title/goal 与任务 description。模型不应把描述、验收条件和实际结果混用。
    - V1/V2、未知版本与损坏快照不迁移，旧 displayTitle/状态时间戳被拒绝，仅显式 clear 后重建；/reload 不回填或猜摘要。真实 TTY 人工验收仍未执行，真实模型对行动式标题与 description 分工的遵循度仍未校准，不能因文档或自动测试而标记通过。

## 3. 真实模型校准：先预览，后批准预算

以下只生成 10 次运行的矩阵，不认证、不创建 fixture、不调用模型：

```bash
npm run eval:smoke -- --models "<provider>/<model>" --scenarios M01,M07,M10,M11,M14 --repeats 1 --variants both --dry-run
```

移除 `--dry-run` 前必须确认模型、账号和调用预算。当前 runner 有每次运行超时，但没有金额/token 硬预算；一次 smoke 也不能证明收益，重复对照应在预算确认后进行。

| 场景 | 重点人工核对 | 不能从现有自动分数推出什么 |
|---|---|---|
| M01 | 简单问题不创建或维护 Todo | 其它复杂任务也一定会合理使用 Todo |
| M07/M14 | 实际执行并读取验证结果；失败时不宣称通过 | 最终 oracle 通过不等于模型亲自运行过测试 |
| M10 | 若插话时计划仍 active，应优先回答临时问题，不自行继续旧工作 | 当前三轮 prompt 串行 settle，可能在插话前已完成任务；没有 active 计划的运行不能当作“无关插话不抢跑”的证据 |
| M11 | 找到取消消息实际交付的 user message 边界，检查之后的编辑、纠偏和回答 | process 场景及 `repoChange: either` 不自动证明取消后没有编辑或续跑；未在工作期间交付的取消也不能证明中断行为 |

评判以任务结果为主：成功率、漏验证、虚假完成和过早结束；另记录 Todo 维护调用、提醒和 token 开销。不能用“Todo 调用更多”证明更好。当前固定三轮提醒和字段长度先保持，只有 trace 显示重复打扰或必要上下文不足时才调整。

真实模型仓库变化以最终内容对 captured tree 的 diff 及未跟踪文件判断，不把 fixture 自身的 staged 状态或 Git 诊断文本算成模型修改。
