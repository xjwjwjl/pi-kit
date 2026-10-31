# Codex Usage

`codex-usage` 是 Codex 账号级扩展，提供：

- 状态栏中的 `openai-codex` OAuth 额度，优先显示短周期，短周期不可用时回退长周期；仅当前供应商为 `openai-codex` 时展示；
- `/codex-usage` 实时额度报告，以及对应真实额度窗口内的 Pi session token/cost 统计；
- `/codex-reset-credit` 查询并消费 Codex reset credits，重置限流额度窗口。

状态栏后台刷新使用 `~/.pi/agent/codex-usage-cache.json`，多个 Pi 进程共享目录锁和退避状态。`/codex-usage` 每次都直接请求最新额度，不读取缓存，并在报告完成后将本次结果提交给状态栏控制器。

## Reset credit

`/codex-reset-credit` 弹出交互面板，列出当前账号可用的 reset credits（含到期日期与剩余天数），支持选择并确认消费。消费前必须确认（TUI picker 内置确认；非 TUI 使用 `ctx.ui.confirm`），无 UI 的运行模式不会静默消费；每次消费使用 UUID 幂等键。消费成功后直接通知同一扩展内的 `QuotaController` 刷新状态栏，不再依赖跨包事件。

`/codex-usage` 与 `/codex-reset-credit` 共用 `src/codex-credential.ts` 的凭据读取和 `src/codex-http.ts` 的 curl 传输层；reset 端点需要时自动附带 `ChatGPT-Account-Id`。

将聚合包 `extensions/codex` 加入 `~/.pi/agent/settings.json` 的 `extensions` 后重启或执行 `/reload`。本仓库不会修改 `~/.pi/agent/settings.json`。

## 注意

reset-credit 接口是 Codex 的内部接口（`/backend-api/wham/rate-limit-reset-credits`），非公开稳定 API，字段可能随客户端版本变化。
