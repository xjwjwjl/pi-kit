# wt-notify — Windows Terminal 完成通知扩展

## 需求文档（需求规格书）

### 1. 核心需求

当 Pi 的 **Agent 任务真正完成** 时，在 **Windows Terminal** 中发送通知。

### 2. 触发时机（必须满足）

- **正确触发点**：`agent_settled` 事件（比 `agent_end` 更准确）
  - `agent_end` 会触发在低层运行结束时，但此时 Pi 可能还在自动重试、压缩或执行后续 follow-up
  - `agent_settled` 保证任务已真正结束，无后续动作

### 3. 通知内容

```text
Pi 任务已完成（用时 12s）
```

- 显示实际运行时长（秒为单位）
- 格式固定，易识别

### 4. 过滤条件（必须实现）

- **最小时长过滤**：任务运行时长 < 8 秒时，不发送通知（避免太短的任务也弹）
- **中止过滤**：用户主动中止（Esc）的任务不发送通知（通过 `agent_end.messages` 中最后一条助手消息的 `stopReason === "aborted"` 判定；`agent_settled` 在中止时同样会触发）

### 5. 通知级别

- 使用 `ctx.ui.notify(..., "info")`（保持一致）

### 6. 可配置项

- 可通过命令临时修改最小时长：
  - `wt-notify 15` → 设置最小 15 秒
  - `wt-notify 0` → 关闭最小时长过滤

### 7. 其他要求

- 不依赖外部第三方 npm 包；仅用系统自带 PowerShell 弹 Windows toast
- 仅支持 Windows Terminal（检测 `WT_SESSION`）
- 不影响其他终端（Ghostty/iTerm 等可留空）
- 安装后需重启 Pi 进程生效

---

**完整踩坑记录与正确方案见 [`NOTES.md`](./NOTES.md)**（幂等：AUMID、枚举异常、编码等坑）。

**实现方向提示**（供开发者参考）：

1. 注册监听 `agent_settled`
2. 在 `agent_start` 记录开始时间（重试期间不重置），在 `agent_end` 提取最后一条助手消息的 `stopReason`
3. 计算运行时长 + 应用过滤逻辑（最小时长 + 中止过滤）
4. 用 PowerShell + **已注册 AUMID** 弹系统 toast（非 `ctx.ui.notify`）
5. 正文：`🤖 任务完成 · 用时 Ns · 项目名`
6. 提供 `/wt-notify <秒数>` 命令控制阈值
