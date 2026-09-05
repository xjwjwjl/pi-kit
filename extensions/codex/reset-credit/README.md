# Codex Reset Credit

`codex-reset-credit` 是独立的 reset-credit 操作包，使用 `/codex-reset-credit` 命令触发：

弹出交互面板，列出当前 `openai-codex` OAuth 账号可用的 Codex reset credits（含到期日期与剩余天数），支持选择并确认消费，重置 Codex 限流额度窗口。

消费前必须确认（`ctx.ui.confirm`），无 UI 的运行模式不会静默消费；每次消费使用 UUID 幂等键，不会作为 LLM 工具自动调用。该命令复用 Pi 的 `openai-codex` OAuth 凭据，消费成功后会发出 `openai-codex:reset-credit-consumed` 事件，供 `codex-usage` 刷新状态栏额度。

需要状态栏额度或 `/codex-usage` 用量报告时，另行注册 `extensions/codex/usage`。

将聚合包 `extensions/codex` 加入 `~/.pi/agent/settings.json` 的 `extensions` 后重启或执行 `/reload`。本仓库不会修改 `~/.pi/agent/settings.json`。

## 注意

reset-credit 接口是 Codex 的内部接口（`/backend-api/wham/rate-limit-reset-credits`），非公开稳定 API，字段可能随客户端版本变化。
