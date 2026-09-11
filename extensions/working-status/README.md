# Working Status

适配新版 Pi working 状态区域的运行指标扩展。

指标通过 `ctx.ui.setWorkingMessage()` 展示在内置 working 指示器中，并保留原有的 `Working` 文案；不再创建编辑器上方的 widget。

## 指标

- `◷ 1.2s`：本轮运行墙钟时间。
- `↑` / `↓` / 成本：运行累计 input、output 与费用；`↓` 在流式期间带 `~` 前缀，表示本地估算值。
- `CH`：缓存。实时行只显示命中率（`CH88%`，即 cache / (input + cache)）；input 为 0、无法计算命中率时退回累计缓存 token（`CH3.4k`）。结束汇总与实时行不同，固定显示 `CH3.4k·88%`（数量 · 命中率）。
- `first 1.2s`：首次输出等待（TTFT）。**不含传输握手**，两条路径口径一致：
  - HTTP/SSE：从成功的响应头到达（2xx）起算，不含连接、重试退避与失败尝试。
  - WebSocket（无 HTTP 响应头，openai-codex 默认路径）：从流建立（`message_start`）起算。
  - 超过 10s 转为 warning 色。
- `~48 tok/s`：稳定 TPS，高亮显示，来自通过置信度校验的滑动窗口；只统计流式 `text_delta` / `thinking_delta`。
- `≈48 tok/s`：临时 TPS，弱化显示，第 2 个 delta 起即可出现，但可能受缓冲 chunk 干扰。
- 检测到 burst 时临时值会被抑制，避免把成批下发的 chunk 当成真实速率。
- 稳定值失效后（burst 或断流），最近一次的稳定 TPS 会以弱化样式继续显示，而不是直接消失；直到断流后再次出现有效输出才重置。

## TPS 计算

- 实时 TPS 只由流式 `text_delta` / `thinking_delta` 的本地字符估算得出，工具调用 JSON 不参与计算；provider 的 usage 不参与实时显示。
- 本地估算按 delta 增量累加（text 用 `auto`、thinking 用 `prose`、tool-call 用 `structured`），不对累计文本做全文重估；实时 `↓` 的待定值与 TPS 共用同一套 per-delta 估算口径。
- 首个 delta 仅作为基线。其后：
  - 临时 TPS：跨度 ≥250ms 且基线后 ≥2 token。
  - 稳定 TPS：跨度 ≥400ms、基线后 ≥2 个 delta 且 ≥4 token，且单个 chunk 占比 <85%（拦截成批下发）。
- 窗口为最近 1.2s；超过 2s 无输出则判定断流并重置。

## 结束汇总

运行 settle 后通过 `ctx.ui.notify()` 输出一次汇总，working 区域保留 3s 后清除：

```text
◷ 32s | ↑1.1k ↓3.4k CH7.9k·88% $0.1200 | avg first 1.2s · ~48 tok/s
```

- `avg first`：各成功请求首次输出等待的均值。
- `~48 tok/s`：吞吐 = 本地估算的流式 `text_delta + thinking_delta` ÷ 流动时间（`~` 表示估算口径）。
  - **分子**不使用 provider `usage.output`，避免把隐藏推理和工具调用参数混入用户可观察的输出速度；provider 用量仍用于 `↓` 总 token。
  - **分母**只累计相邻 text/thinking delta 间隔 ≤2s 的区间；超过 2s 的停顿是死时间，不计入（与实时 TPS 的 rebase 规则一致）。每个分段的首个 delta 只作为基准，不贡献 token 或时长。
  - tool-call JSON 会切断该输出分段；工具执行发生在两次模型请求之间，因此 tool-call 下发与工具执行耗时均不计入 TPS。
  - 被 burst 置信度规则判定污染的输出分段不纳入汇总，避免结束时重新引入无效 chunk。
  - 流动时间 <250ms 的请求不纳入。
- 失败请求保留 token/成本总额，但不参与以上平均值。

## 窄屏

宽度不足时依次保留：`时间 → output → input → cache → cost → TPS → first`，即 TPS 优先于 `first` 被裁掉。
