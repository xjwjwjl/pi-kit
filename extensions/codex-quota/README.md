# Codex Quota

在 Pi 状态栏显示当前 `openai-codex` OAuth 凭据的 ChatGPT/Codex 额度：优先展示短周期窗口，使用率达到 70%/90% 时变黄/红。只在本地时间每个 5 分钟边界（如 `:00`、`:05`、`:10`）且 Pi 空闲时刷新；会话启动只读取缓存，并将最近一次成功结果缓存到 `~/.pi/agent/codex-quota-cache.json`。缓存只保存凭据哈希和额度数据，不保存 OAuth token；多个 Pi 实例同时运行时使用锁和原子写入避免互相覆盖。

将 `extensions/codex-quota` 加入 `~/.pi/agent/settings.json` 的 `extensions` 后重启或执行 `/reload`。
