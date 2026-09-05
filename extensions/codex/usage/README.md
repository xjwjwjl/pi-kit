# Codex Usage

`codex-usage` 提供：

- 状态栏中的 `openai-codex` OAuth 额度，优先显示短周期，短周期不可用时回退长周期；仅当前供应商为 `openai-codex` 时展示；
- `/codex-usage` 实时额度报告，以及对应真实额度窗口内的 Pi session token/cost 统计。

状态栏后台刷新使用 `~/.pi/agent/codex-usage-cache.json`，多个 Pi 进程共享目录锁和退避状态。`/codex-usage` 每次都直接请求最新额度，不读取缓存，并在报告完成后将本次结果提交给状态栏控制器。

需要 Codex reset-credit 操作时，另行加载聚合包内的 `extensions/codex/reset-credit`。两个扩展通过 `openai-codex:reset-credit-consumed` 事件联动，reset 成功后由本扩展刷新状态栏。

本仓库不会修改 `~/.pi/agent/settings.json`。
