# Codex Quota

在 Pi 状态栏显示当前 `openai-codex` OAuth 凭据的 ChatGPT/Codex 额度：优先展示短周期窗口，剩余额度低于 10% 时变红，低于等于 50% 时变黄。只在本地时间每个 5 分钟边界（如 `:00`、`:05`、`:10`）刷新；会话启动只读取缓存，并将最近一次成功结果缓存到 `~/.pi/agent/codex-quota-cache.json`。缓存记录最近一次成功时间和最近一次尝试时间，失败时不会把旧额度标记为新数据，并显示为不可用；缓存只保存凭据哈希和额度数据，不保存 OAuth token；多个 Pi 实例同时运行时使用同一刷新锁串行化请求和缓存写入，确保每个时间窗口最多尝试一次，并使用临时文件替换缓存。

将 `extensions/codex-quota` 加入 `~/.pi/agent/settings.json` 的 `extensions` 后重启或执行 `/reload`。
