# Codex Quota

在 Pi 状态栏显示当前 `openai-codex` OAuth 凭据的 ChatGPT/Codex 额度：优先展示短周期窗口，使用率达到 70%/90% 时变黄/红。会在会话启动、请求前后及空闲状态每 3 分钟刷新一次。

将 `extensions/codex-quota` 加入 `~/.pi/agent/settings.json` 的 `extensions` 后重启或执行 `/reload`。
