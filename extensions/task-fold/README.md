# task-fold

Pi 交互模式下的任务过程折叠扩展。任务执行时保持原来的展示；Pi 触发 `agent_settled` 后，把本次任务的 thinking 和工具调用折叠成该轮内容前的一条短轨道，保留用户消息和所有 assistant 正文。

```text
用户：帮我完成这个功能

 ▹ ────────────── Workings ──────────────

助手：已经完成……
```

第一次看到折叠行时，行尾会另附一次性的展开提示：

```text
 ▹ ────────────── Workings ────────────── · click or press Enter to expand
```

展开后只改变箭头，其余保持不变：

```text
 ▿ ────────────── Workings ──────────────
```

## 折叠轨道

- 轨道中居中显示 `Workings`；不显示工具总数或失败次数等文字。
- 收起为 `▹`，展开为 `▿`；左右细横线按 tool cell 可用宽度动态填充，但右侧比左侧长 2 列，用来抵消箭头占用的视觉宽度，使 `Workings` 居中；窄终端下线长自动缩短。
  - 整行渲染为 tool box/cell：使用 `toolPendingBg` 背景并铺满可用宽度，左右各 1 列内边距，类似 Pi 的 tool call 行；不额外绘制边框。
- 箭头使用 Muted Regular，`Workings` 使用 Muted Medium，轨道使用 Dim Regular。
- thinking 和工具都有、只有工具或只有 thinking 时都显示同一条轨道；两者都没有时不生成整行。
- 工具失败不改变折叠轨道颜色，也不显示失败次数；失败工具和错误内容只在展开后的原生内容中显示。

这是 Workings 居中轨道的原型版本。如果实际 transcript 中识别性不足，可以回退为独立 `Workings` 标题行方案。

## 展开区

展开后恢复 Pi 原生的 thinking 和工具组件，在原始位置按实际发生顺序显示；不再把内容聚合到轨道下方，也不重复输出摘要或统计。`compact-tool-ui` 等工具 renderer 按各自原有方式显示，失败工具和错误内容仍由原生 renderer 呈现。

任务成功结束但其中单次工具失败时，仍会折叠，并通过折叠轨道标出失败。中止、整轮失败、截断以及 pending/deferred 的批次不自动折叠。

## 位置与交互

- 轨道位于该轮内容之前，在用户消息之后保留一个空行；它附属于当前轮次，不放在两轮之间，下一轮沿用正常 turn 间距。
- 整个 tool cell 区域可点击；点击后可用 `Enter` 或 `Space` 切换，`Esc` 收起并把焦点还给编辑器。
- 每轮任务的展开状态独立。
- 展开后使用 Pi 原生 thinking 和工具组件，折叠期间只隐藏内容，不替换工具 renderer。`compact-tool-ui` 等其他工具 renderer 可以同时加载，不会被替换或破坏。

## 首次提示

首次提示在第一次成功展开后永久关闭。这个偏好只保存在扩展自己的状态文件：

```text
<agent-dir>/task-fold.json
```

默认 agent 目录是 `~/.pi/agent`。该文件不参与 Pi 设置解析，也不影响模型上下文。删除它会让首次提示重新出现。

## 使用

从本仓库根目录临时加载：

```bash
pi -e ./extensions/task-fold/index.ts
```

要长期使用，可将 `extensions/task-fold` 的**绝对路径**加入用户级 `~/.pi/agent/settings.json` 的 `extensions` 数组；保留其中已有的其他条目。此仓库是扩展源码，不需要修改 Pi 安装目录。

| 操作 | 效果 |
|---|---|
| `/task-fold` 或 `/task-fold toggle` | 切换当前 transcript 中最近一批任务的折叠状态 |
| `/task-fold show` | 展开当前 transcript 中所有由本扩展折叠的任务 |
| `/task-fold hide` | 折叠当前 transcript 中所有由本扩展管理的任务 |
| 点击摘要行 | 单独切换这一批任务，并获得键盘焦点 |

`/reload`、恢复会话或重新打开后，会从当前可见分支按用户消息边界重建已完成且包含 thinking/工具的历史轮次，并默认折叠；`/tree` 切换分支时也会补齐新分支中缺失的历史轮次，并按 assistant entry 去重。历史组批量恢复，只触发一次刷新。展开状态不写入 session，重建后恢复为收起。中止、整轮失败和截断的历史轮次不会重建折叠。新完成的任务仍会在 `agent_settled` 后自动折叠。

## 兼容性

此扩展不修改 Pi 安装文件，也不写 Pi 全局设置，但在当前进程中包装 Pi 内部 UI 方法。**仅启用在 Pi 1.4.0**；其他版本会提示并停用，直到适配和测试。检测到内部布局不兼容或运行出错时也会停用并尽力恢复原视图。卸载或 `/reload` 时会撤销属于本扩展的包装，不覆盖其他扩展后加的包装。

非 TUI 模式不启用渲染 patch。工具仍正常执行，session、模型上下文和导出数据不受影响。

### 无色终端降级

颜色由 Pi 主题的 ANSI 样式提供。在不支持颜色或关闭颜色的终端里，箭头和轨道字符仍然可辨认，但 tool cell 的背景色会丢失；展开后的失败工具和错误内容也会失去红色提示。当前原型没有增加额外的符号降级。

## 开发验证

```bash
cd extensions/task-fold
npm install --ignore-scripts
npm run check
npm run test:e2e  # macOS/Linux；需要 PATH 中有 Pi 1.4.0 和 Python 3
```

E2E 使用隔离的临时 agent 目录、伪终端和本地假 provider，不使用真实模型或凭据；覆盖 fullscreen、regular、连续多轮轨道，以及与 `compact-tool-ui` 同时加载的场景。可用 `PI_TASK_FOLD_PI=/path/to/pi npm run test:e2e` 指定要测试的 Pi。
